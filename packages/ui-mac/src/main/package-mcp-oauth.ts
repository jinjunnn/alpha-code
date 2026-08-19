import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { ServerReadyData } from "../preload/types"
import {
  evaluatePackageMcpOauthStatusV1,
  type PackageMcpOauthAttemptV1,
  type PackageMcpOauthEngineStatusV1,
  type PackageMcpOauthEvaluationV1,
  type PackageMcpOauthPrerequisiteItemV1,
  type PackageMcpOauthReasonCodeV1,
} from "../shared/package-mcp-oauth"
import {
  evaluatePackageForHost,
  validateCatalogPackageShape,
  type PackageAcceptedFactsV1,
  type PackageInstallabilityDeps,
} from "./package-installability"
import { canonicalJson, sha256Hex } from "./ext-manifest-v2"

/**
 * The main-owned MCP OAuth lifecycle: begin → (loopback redirect) → status, and the separate
 * cancel. The protocol itself — discovery, DCR, PKCE, the state nonce, the token exchange and the
 * token store — stays in the engine and is reached only through its authenticated typed routes.
 * What lives here is the *attempt*: main resolves the signed prerequisite, provisions the engine's
 * in-memory MCP config for the signed URL (`POST /mcp` writes instance state only, nothing
 * durable), asks the engine to start OAuth, hands the engine's own authorization URL to the
 * renderer, and receives the loopback redirect so it can check the state nonce against *this*
 * attempt before driving the engine's `auth/callback` route with the code.
 *
 * Why main receives the redirect at all: the engine's `startAuth` registers a pending transport
 * (PKCE verifier and all) but registers no callback waiter — that only happens inside its
 * browser-opening `authenticate` flow, which cannot hand the renderer a URL. Pointing the signed
 * config's `oauth.redirectUri` at a per-attempt loopback listener keeps browser control in the
 * renderer, gives every attempt its own port (a mixed-up callback knocks on the wrong door *and*
 * carries the wrong state), and leaves the engine holding every secret: the only bytes main ever
 * forwards are the authorization code and the state the provider echoed back.
 *
 * Every failure consumes its attempt. Retrying means starting a fresh one — there is no half-live
 * attempt to resume into, which is what keeps "fail closed" from turning into "stuck".
 */
export type PackageMcpOauthEngineV1 = {
  /**
   * `POST /mcp` — provision the engine's **instance-state** config for this name and connect.
   * Nothing durable is written; a config the install transaction later lands replaces it.
   */
  add(
    name: string,
    config: { type: "remote"; url: string; enabled: true; oauth?: { redirectUri: string } },
  ): Promise<{ ok: true; status: PackageMcpOauthEngineStatusV1 } | { ok: false; reason: string }>
  /** `POST /mcp/:name/auth` — engine runs discovery/DCR/PKCE and returns its authorization URL. */
  authStart(
    name: string,
  ): Promise<{ ok: true; authorizationUrl: string; oauthState: string } | { ok: false; reason: string }>
  /** `POST /mcp/:name/auth/callback` — engine exchanges the code over its pending PKCE transport. */
  authCallback(
    name: string,
    code: string,
  ): Promise<{ ok: true; status: PackageMcpOauthEngineStatusV1 } | { ok: false; reason: string }>
}

export type PackageMcpOauthCoordinatorDeps = {
  loadVerifiedCatalog: () => Promise<
    { source: "none"; error: string } | { source: "remote" | "cache"; catalog: unknown; snapshotDigest?: string }
  >
  engine: PackageMcpOauthEngineV1
  installability?: PackageInstallabilityDeps
  attemptId?: () => string
  now?: () => Date
}

export type PackageMcpOauthBeginOutcome =
  | { ok: true; attemptId: string; state: "pending"; browserUrl: string }
  /** The engine already holds valid tokens for this exact server URL: no browser round needed. */
  | { ok: true; attemptId: string; state: "ready" }
  | { ok: false; reasonCode: PackageMcpOauthReasonCodeV1; reason: string }

export type PackageMcpOauthStatusOutcome =
  | { ok: true; state: "pending" }
  | { ok: true; state: "ready"; serviceId: string; serverUrl: string; prerequisiteId: string }
  | { ok: false; reasonCode: PackageMcpOauthReasonCodeV1; reason: string }

export type PackageMcpOauthCancelOutcome =
  | { ok: true; cancelled: boolean }
  | { ok: false; reasonCode: PackageMcpOauthReasonCodeV1; reason: string }

const BEGIN_KEYS = new Set(["catalogId", "prerequisiteId"])
const ATTEMPT_KEYS = new Set(["attemptId"])
const ATTEMPT_ID_RE = /^a-[0-9a-f]{32}$/
const MAX_ATTEMPTS = 16
const CALLBACK_PATH = "/callback"

type Terminal =
  | { state: "ready" }
  | { state: "failed"; reasonCode: PackageMcpOauthReasonCodeV1; reason: string }

type LiveAttempt = PackageMcpOauthAttemptV1 & {
  oauthState?: string
  listener?: Server
  terminal?: Terminal
  /** Settles when the loopback redirect has been fully handled (engine exchange included). */
  settled?: Promise<void>
}

export function createPackageMcpOauthCoordinator(deps: PackageMcpOauthCoordinatorDeps) {
  const attempts = new Map<string, LiveAttempt>()
  const clock = () => deps.now?.() ?? new Date()

  async function begin(rawIntent: unknown): Promise<PackageMcpOauthBeginOutcome> {
    const intent = decodeIntent(rawIntent, BEGIN_KEYS, ["catalogId", "prerequisiteId"])
    if (!intent.ok) return refuse("mcp-oauth-profile-invalid", intent.reason)

    const resolved = await resolveSignedMcpOauthPrerequisite(
      intent.values.catalogId!,
      intent.values.prerequisiteId!,
      deps,
    )
    if (!resolved.ok) return refuse(resolved.reasonCode, resolved.reason)

    // One live flow per service: the engine keys its pending OAuth transport and state nonce by
    // MCP name, so a second concurrent attempt would silently invalidate the first one's exchange.
    // Refusing here keeps that impossibility visible instead of letting two browser tabs race.
    for (const live of attempts.values())
      if (live.serviceId === resolved.item.serviceId && !live.terminal)
        return refuse(
          "mcp-oauth-attempt-conflict",
          `mcp oauth: an attempt for "${resolved.item.serviceId}" is already in flight — cancel it or finish it first`,
        )

    const attemptId = (deps.attemptId ?? mintAttemptId)()
    if (!ATTEMPT_ID_RE.test(attemptId)) return refuse("mcp-oauth-engine-error", "mcp oauth: invalid attempt id")
    const attempt: LiveAttempt = {
      attemptId,
      prerequisiteId: resolved.item.prerequisiteId,
      componentId: resolved.item.componentId,
      serviceId: resolved.item.serviceId,
      serverUrl: resolved.item.serverUrl,
      catalogId: intent.values.catalogId!,
      envelopeDigest: resolved.envelopeDigest,
      createdAt: clock().toISOString(),
    }

    // The listener must be live *before* the engine sees the redirect URI: the engine's callback
    // server helper checks whether the port is in use and stands down when it is — that check is
    // what hands callback ownership to this attempt, and it only works in this order.
    const listener = await listenLoopback().catch(() => undefined)
    if (!listener) return refuse("mcp-oauth-engine-error", "mcp oauth: could not open a loopback callback listener")
    const redirectUri = `http://127.0.0.1:${(listener.address() as AddressInfo).port}${CALLBACK_PATH}`

    const added = await deps.engine.add(attempt.serviceId, {
      type: "remote",
      url: attempt.serverUrl,
      enabled: true,
      oauth: { redirectUri },
    })
    if (!added.ok) {
      listener.close()
      return refuse("mcp-oauth-engine-unavailable", `mcp oauth: ${added.reason}`)
    }
    if (added.status === "connected") {
      // Stored tokens for this exact name+URL are still valid; the engine connected without auth.
      listener.close()
      attempt.terminal = { state: "ready" }
      remember(attempt)
      return { ok: true, attemptId, state: "ready" }
    }

    const started = await deps.engine.authStart(attempt.serviceId)
    if (!started.ok) {
      listener.close()
      return refuse("mcp-oauth-engine-error", `mcp oauth: ${started.reason}`)
    }
    if (started.authorizationUrl === "") {
      // The engine connected during startAuth (server needed no authorization after all).
      listener.close()
      attempt.terminal = { state: "ready" }
      remember(attempt)
      return { ok: true, attemptId, state: "ready" }
    }
    const browserUrl = safeBrowserUrl(started.authorizationUrl)
    if (!browserUrl) {
      listener.close()
      return refuse("mcp-oauth-engine-error", "mcp oauth: engine returned an unusable authorization URL")
    }

    attempt.oauthState = started.oauthState
    attempt.listener = listener
    listener.on("request", (request, response) => {
      attempt.settled = handleCallback(attempt, request, response, deps.engine)
    })
    remember(attempt)
    return { ok: true, attemptId, state: "pending", browserUrl }
  }

  async function status(rawIntent: unknown): Promise<PackageMcpOauthStatusOutcome> {
    const intent = decodeIntent(rawIntent, ATTEMPT_KEYS, ["attemptId"])
    if (!intent.ok) return refuse("mcp-oauth-profile-invalid", intent.reason)
    const attempt = attempts.get(intent.values.attemptId!)
    if (!attempt) return refuse("mcp-oauth-attempt-stale", "mcp oauth: stale or replayed attempt")
    if (!attempt.terminal) return { ok: true, state: "pending" }
    attempts.delete(attempt.attemptId)
    if (attempt.terminal.state === "ready")
      return {
        ok: true,
        state: "ready",
        serviceId: attempt.serviceId,
        serverUrl: attempt.serverUrl,
        prerequisiteId: attempt.prerequisiteId,
      }
    return refuse(attempt.terminal.reasonCode, attempt.terminal.reason)
  }

  /**
   * Cancel is main-side only, on purpose: it closes the loopback listener (a late redirect now has
   * nowhere to land) and consumes the attempt. It deliberately does **not** call the engine's
   * credential-removal route — that route deletes the whole `mcp-auth.json` entry, so cancelling a
   * *re*-authorization would destroy the still-usable credential it was trying to refresh. The
   * engine's leftover pending transport is inert in-memory state: nothing but this coordinator can
   * feed it a code, and the next attempt's `authStart` replaces it.
   */
  async function cancel(rawIntent: unknown): Promise<PackageMcpOauthCancelOutcome> {
    const intent = decodeIntent(rawIntent, ATTEMPT_KEYS, ["attemptId"])
    if (!intent.ok) return refuse("mcp-oauth-profile-invalid", intent.reason)
    const attempt = attempts.get(intent.values.attemptId!)
    if (!attempt) return refuse("mcp-oauth-attempt-stale", "mcp oauth: stale or replayed attempt")
    attempt.listener?.close()
    attempts.delete(attempt.attemptId)
    return { ok: true, cancelled: !attempt.terminal }
  }

  function remember(attempt: LiveAttempt) {
    attempts.set(attempt.attemptId, attempt)
    if (attempts.size > MAX_ATTEMPTS) {
      const eldest = attempts.keys().next().value!
      attempts.get(eldest)?.listener?.close()
      attempts.delete(eldest)
    }
  }

  return { begin, status, cancel }
}

/**
 * Handle the provider's loopback redirect for one attempt. The state check is the whole point:
 * a redirect carrying anything but *this attempt's* engine-issued state nonce is answered 400 and
 * changes nothing — the attempt keeps waiting for its real callback, so a stray local request
 * cannot end someone's flow. Only a state match may consume the one-shot exchange.
 */
async function handleCallback(
  attempt: LiveAttempt,
  request: IncomingMessage,
  response: ServerResponse,
  engine: PackageMcpOauthEngineV1,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1")
  if (url.pathname !== CALLBACK_PATH) {
    response.writeHead(404).end("Not found")
    return
  }
  const state = url.searchParams.get("state")
  if (!state || state !== attempt.oauthState || attempt.terminal) {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" })
    response.end("This authorization response does not belong to the current attempt.")
    return
  }
  const error = url.searchParams.get("error")
  if (error) {
    attempt.terminal = {
      state: "failed",
      reasonCode: "mcp-oauth-cancelled",
      reason: `mcp oauth: the provider refused authorization (${url.searchParams.get("error_description") ?? error})`,
    }
    attempt.listener?.close()
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" })
    response.end("Authorization was not granted. You can close this window and retry from Alpha.")
    return
  }
  const code = url.searchParams.get("code")
  if (!code) {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" })
    response.end("No authorization code was provided.")
    return
  }

  // The exchange itself is the engine's: the code travels to the typed callback route verbatim and
  // the PKCE verifier never leaves the engine. Responding *after* the exchange keeps the browser
  // page honest about the outcome.
  const finished = await engine.authCallback(attempt.serviceId, code)
  attempt.terminal =
    finished.ok && finished.status === "connected"
      ? { state: "ready" }
      : {
          state: "failed",
          reasonCode: "mcp-oauth-engine-error",
          reason: `mcp oauth: ${finished.ok ? `service ended ${finished.status} after authorization` : finished.reason}`,
        }
  attempt.listener?.close()
  response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" })
  response.end(
    attempt.terminal.state === "ready"
      ? "Authorization complete. You can close this window and return to Alpha."
      : "Authorization could not be completed. You can close this window and retry from Alpha.",
  )
}

/**
 * Answer, for one signed prerequisite, whether the engine is ready **right now**. Deliberately not
 * a main-owned record: the durable truth is the engine's token store, and asking it each time is
 * what makes token↔server binding fail closed — the probe's URL comes from the re-validated signed
 * envelope, and the engine's `getForUrl` refuses tokens bound to any other URL.
 */
export async function probePackageMcpOauthPrerequisiteV1(
  engine: PackageMcpOauthEngineV1,
  item: PackageMcpOauthPrerequisiteItemV1,
): Promise<PackageMcpOauthEvaluationV1> {
  const added = await engine.add(item.serviceId, { type: "remote", url: item.serverUrl, enabled: true })
  if (!added.ok) return { state: "blocked", reasonCode: "mcp-oauth-engine-unavailable" }
  return evaluatePackageMcpOauthStatusV1(added.status)
}

/**
 * The production engine seam: the authenticated local sidecar typed routes, nothing else. Same
 * client construction as `ext-mcp-activation.ts` — Basic credentials from the awaited server —
 * so "main talks to an authenticated engine" is one shape everywhere.
 */
export function createPackageMcpOauthEngineV1(
  awaitServer: () => Promise<ServerReadyData>,
  fetchImpl: typeof fetch = fetch,
): PackageMcpOauthEngineV1 {
  async function client() {
    const server = await awaitServer()
    return createOpencodeClient({
      baseUrl: server.url,
      fetch: fetchImpl,
      headers:
        server.username || server.password
          ? {
              Authorization: `Basic ${Buffer.from(`${server.username ?? ""}:${server.password ?? ""}`).toString(
                "base64",
              )}`,
            }
          : undefined,
    })
  }

  return {
    add: async (name, config) => {
      try {
        const response = await (await client()).mcp.add({ name, config })
        const data = payload(response)
        if (!data.ok) return { ok: false, reason: `engine add failed: ${data.reason}` }
        const status = statusOf(data.value, name)
        if (!status) return { ok: false, reason: "engine add returned no status for the service" }
        return { ok: true, status }
      } catch (cause) {
        return { ok: false, reason: message(cause) }
      }
    },
    authStart: async (name) => {
      try {
        const response = await (await client()).mcp.auth.start({ name })
        const data = payload(response)
        if (!data.ok) return { ok: false, reason: `engine auth start failed: ${data.reason}` }
        const value = data.value as { authorizationUrl?: unknown; oauthState?: unknown }
        if (typeof value?.authorizationUrl !== "string" || typeof value?.oauthState !== "string")
          return { ok: false, reason: "engine auth start returned an unusable shape" }
        return { ok: true, authorizationUrl: value.authorizationUrl, oauthState: value.oauthState }
      } catch (cause) {
        return { ok: false, reason: message(cause) }
      }
    },
    authCallback: async (name, code) => {
      try {
        const response = await (await client()).mcp.auth.callback({ name, code })
        const data = payload(response)
        if (!data.ok) return { ok: false, reason: `engine auth callback failed: ${data.reason}` }
        const status = (data.value as { status?: unknown })?.status
        if (!isEngineStatus(status)) return { ok: false, reason: "engine auth callback returned an unusable shape" }
        return { ok: true, status }
      } catch (cause) {
        return { ok: false, reason: message(cause) }
      }
    },
  }
}

/**
 * Resolve one signed MCP OAuth prerequisite. Service identity, server URL and the envelope digest
 * all come from the re-fetched, re-evaluated signed envelope — the renderer only said *which*
 * prerequisite, and even that is checked against the signed set rather than trusted.
 */
async function resolveSignedMcpOauthPrerequisite(
  catalogId: string,
  prerequisiteId: string,
  deps: PackageMcpOauthCoordinatorDeps,
): Promise<
  | { ok: true; item: PackageMcpOauthPrerequisiteItemV1; envelopeDigest: string }
  | { ok: false; reasonCode: PackageMcpOauthReasonCodeV1; reason: string }
> {
  const loaded = await deps.loadVerifiedCatalog()
  if (loaded.source === "none")
    return {
      ok: false,
      reasonCode: "mcp-oauth-profile-invalid",
      reason: `mcp oauth: verified Catalog unavailable (${loaded.error})`,
    }
  const validated = validateCatalogPackageShape(loaded.catalog)
  if (!validated.ok)
    return { ok: false, reasonCode: "mcp-oauth-profile-invalid", reason: `mcp oauth: ${validated.error}` }
  const selected = validated.packages.find((item) => item.prelude.packageId === catalogId)
  if (!selected)
    return {
      ok: false,
      reasonCode: "mcp-oauth-profile-invalid",
      reason: "mcp oauth: catalogId not found in verified Catalog",
    }

  let accepted: PackageAcceptedFactsV1 | undefined
  const view = await evaluatePackageForHost(selected.envelope, {
    ...deps.installability,
    accepted: (facts) => {
      accepted = facts
    },
  })
  if (!accepted)
    return { ok: false, reasonCode: "mcp-oauth-profile-invalid", reason: `mcp oauth: ${view.action.reasonCode}` }
  const item = accepted.components
    .flatMap((component) => component.oauth.items)
    .find((candidate) => candidate.prerequisiteId === prerequisiteId)
  if (!item)
    return {
      ok: false,
      reasonCode: "mcp-oauth-profile-invalid",
      reason: "mcp oauth: prerequisiteId is not declared by this package",
    }
  return { ok: true, item, envelopeDigest: sha256Hex(canonicalJson(accepted.envelope)) }
}

function listenLoopback(): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve(server))
  })
}

function decodeIntent(
  input: unknown,
  allowed: Set<string>,
  required: string[],
): { ok: true; values: Record<string, string | undefined> } | { ok: false; reason: string } {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return { ok: false, reason: "mcp oauth: intent must be an object" }
  const record = input as Record<string, unknown>
  const unknown = Object.keys(record).find((key) => !allowed.has(key))
  if (unknown) return { ok: false, reason: `mcp oauth: renderer-supplied key "${unknown}" is refused` }
  const values: Record<string, string | undefined> = {}
  for (const key of required) {
    const value = record[key]
    if (typeof value !== "string" || value.length === 0 || value.length > 256)
      return { ok: false, reason: `mcp oauth: invalid ${key}` }
    values[key] = value
  }
  return { ok: true, values }
}

function safeBrowserUrl(value: string): string | undefined {
  if (value.length === 0 || value.length > 2048) return
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return
    return url.toString()
  } catch {
    return
  }
}

function payload(response: unknown): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (!response || typeof response !== "object") return { ok: false, reason: "no response" }
  const record = response as { data?: unknown; error?: unknown }
  if (record.error !== undefined) return { ok: false, reason: describeError(record.error) }
  if (!Object.hasOwn(record, "data")) return { ok: false, reason: "no response data" }
  return { ok: true, value: record.data }
}

function statusOf(data: unknown, name: string): PackageMcpOauthEngineStatusV1 | undefined {
  if (!data || typeof data !== "object") return
  const entry = (data as Record<string, unknown>)[name]
  if (!entry || typeof entry !== "object") return
  const status = (entry as { status?: unknown }).status
  return isEngineStatus(status) ? status : undefined
}

function isEngineStatus(value: unknown): value is PackageMcpOauthEngineStatusV1 {
  return (
    value === "connected" ||
    value === "disabled" ||
    value === "failed" ||
    value === "needs_auth" ||
    value === "needs_client_registration"
  )
}

function describeError(error: unknown): string {
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error) ?? "unknown engine error"
  } catch {
    return "unknown engine error"
  }
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function mintAttemptId(): string {
  return `a-${randomBytes(16).toString("hex")}`
}

function refuse(
  reasonCode: PackageMcpOauthReasonCodeV1,
  reason: string,
): { ok: false; reasonCode: PackageMcpOauthReasonCodeV1; reason: string } {
  return { ok: false, reasonCode, reason }
}
