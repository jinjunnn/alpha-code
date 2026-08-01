import { randomBytes } from "node:crypto"
import { canonicalJson, sha256Hex } from "./ext-manifest-v2"
import {
  lookupAlphaConnectionHandlerV1,
  ALPHA_CONNECTION_HANDLERS_V1,
} from "./alpha-connection-handlers"
import {
  readAlphaConnectionRecordsV1,
  removeAlphaConnectionRecordV1,
  upsertAlphaConnectionRecordV1,
  type AlphaConnectionStoreScope,
} from "./alpha-connection-store"
import {
  evaluatePackageForHost,
  validateCatalogPackageShape,
  type PackageAcceptedFactsV1,
  type PackageInstallabilityDeps,
} from "./package-installability"
import {
  ALPHA_CONNECTION_ID_RE,
  decodeAlphaConnectionResultV1,
  nextConnectionRecordV1,
  type AlphaConnectionHandlerTableV1,
  type PackageConnectionAttemptV1,
  type PackageConnectionPrerequisiteItemV1,
  type PackageConnectionReasonCodeV1,
} from "../shared/package-alpha-connection"

/**
 * The main-owned Alpha Connection lifecycle: begin → status → (record) and the separate disconnect.
 *
 * The renderer's entire vocabulary here is three key sets, each an exact allowlist: which package
 * prerequisite to satisfy, which attempt to poll, which connection to drop. It cannot name a
 * service, a reuse key, or a connection id at connect time — those are decided from the signed
 * envelope and the handler's bounded result, so tampering with them is not "rejected", it is
 * unsayable. That is the same shape as the agent-import two-stage flow (`ext-ipc.ts`): main mints
 * the opaque id and keeps the real content, the renderer only carries the id back.
 *
 * Every failure consumes its attempt. Retrying means starting a fresh one, which is what keeps
 * "fail closed" from turning into "stuck": there is no half-live attempt to resume into.
 */
export type AlphaConnectionCoordinatorDeps = {
  loadVerifiedCatalog: () => Promise<
    { source: "none"; error: string } | { source: "remote" | "cache"; catalog: unknown; snapshotDigest?: string }
  >
  scope: () => AlphaConnectionStoreScope
  handlers?: AlphaConnectionHandlerTableV1
  installability?: PackageInstallabilityDeps
  connectionId?: () => string
  attemptId?: () => string
  now?: () => Date
}

export type AlphaConnectionBeginOutcome =
  | { ok: true; attemptId: string; state: "pending"; browserUrl?: string }
  | { ok: false; reasonCode: PackageConnectionReasonCodeV1; reason: string }

export type AlphaConnectionStatusOutcome =
  | { ok: true; state: "pending" }
  | { ok: true; state: "ready"; connectionId: string; serviceId: string; accountLabel: string; reused: boolean }
  | { ok: false; reasonCode: PackageConnectionReasonCodeV1; reason: string }

export type AlphaConnectionDisconnectOutcome =
  | { ok: true; disconnected: boolean }
  | { ok: false; reasonCode: PackageConnectionReasonCodeV1; reason: string }

const BEGIN_KEYS = new Set(["catalogId", "prerequisiteId"])
const STATUS_KEYS = new Set(["attemptId"])
const DISCONNECT_KEYS = new Set(["connectionId"])
const ATTEMPT_ID_RE = /^a-[0-9a-f]{32}$/
const MAX_ATTEMPTS = 16
const MAX_BROWSER_URL = 2048

type LiveAttempt = PackageConnectionAttemptV1 & { item: PackageConnectionPrerequisiteItemV1 }

export function createAlphaConnectionCoordinator(deps: AlphaConnectionCoordinatorDeps) {
  const attempts = new Map<string, LiveAttempt>()
  const table = deps.handlers ?? ALPHA_CONNECTION_HANDLERS_V1
  const clock = () => deps.now?.() ?? new Date()

  async function begin(rawIntent: unknown): Promise<AlphaConnectionBeginOutcome> {
    const intent = decodeIntent(rawIntent, BEGIN_KEYS, ["catalogId", "prerequisiteId"])
    if (!intent.ok) return refuse("connection-profile-invalid", intent.reason)

    const resolved = await resolveSignedPrerequisite(intent.values.catalogId!, intent.values.prerequisiteId!, deps, table)
    if (!resolved.ok) return refuse(resolved.reasonCode, resolved.reason)

    // Unknown handler is answered here, before a single external interaction: no handler call, no
    // browser window, no store write. The signed package can name any id it likes; only this table
    // decides whether the id means anything, and it never parses the id to find out.
    const handler = lookupAlphaConnectionHandlerV1(resolved.item.handlerId, table)
    if (!handler.ok)
      return refuse(
        "connection-handler-unknown",
        `alpha connection: handler "${resolved.item.handlerId}" is not in this build — update Alpha`,
      )

    const attemptId = (deps.attemptId ?? mintAttemptId)()
    if (!ATTEMPT_ID_RE.test(attemptId)) return refuse("connection-handler-error", "alpha connection: invalid attempt id")
    const attempt: LiveAttempt = {
      attemptId,
      handlerId: resolved.item.handlerId,
      prerequisiteId: resolved.item.prerequisiteId,
      componentId: resolved.item.componentId,
      catalogId: intent.values.catalogId!,
      envelopeDigest: resolved.envelopeDigest,
      createdAt: clock().toISOString(),
      item: resolved.item,
    }
    const started = await handler.handler
      .begin({
        attemptId: attempt.attemptId,
        handlerId: attempt.handlerId,
        prerequisiteId: attempt.prerequisiteId,
        componentId: attempt.componentId,
        catalogId: attempt.catalogId,
        envelopeDigest: attempt.envelopeDigest,
        createdAt: attempt.createdAt,
      })
      .catch(() => ({ ok: false as const, reasonCode: "connection-handler-error" as const }))
    if (!started.ok) return refuse(started.reasonCode, "alpha connection: handler could not start the attempt")
    const browserUrl = safeBrowserUrl(started.browserUrl)
    if (started.browserUrl !== undefined && !browserUrl)
      return refuse("connection-handler-error", "alpha connection: handler returned an unusable browser URL")

    attempts.set(attemptId, attempt)
    if (attempts.size > MAX_ATTEMPTS) attempts.delete(attempts.keys().next().value!)
    return { ok: true, attemptId, state: "pending", ...(browserUrl ? { browserUrl } : {}) }
  }

  async function status(rawIntent: unknown): Promise<AlphaConnectionStatusOutcome> {
    const intent = decodeIntent(rawIntent, STATUS_KEYS, ["attemptId"])
    if (!intent.ok) return refuse("connection-profile-invalid", intent.reason)
    const attempt = attempts.get(intent.values.attemptId!)
    if (!attempt) return refuse("connection-attempt-stale", "alpha connection: stale or replayed attempt")

    const handler = lookupAlphaConnectionHandlerV1(attempt.handlerId, table)
    if (!handler.ok) {
      attempts.delete(attempt.attemptId)
      return refuse("connection-handler-unknown", "alpha connection: handler is not in this build — update Alpha")
    }
    const reported = await handler.handler
      .status(attempt.attemptId)
      .catch(() => ({ ok: false as const, reasonCode: "connection-handler-error" as const }))
    if (!reported.ok) {
      attempts.delete(attempt.attemptId)
      return refuse(reported.reasonCode, "alpha connection: handler ended the attempt")
    }
    if (reported.state === "pending") return { ok: true, state: "pending" }

    // Handler output is untrusted from here down. The record is built only from what survives the
    // strict decode, so a handler that returns a token cannot get one written to disk.
    const decoded = decodeAlphaConnectionResultV1(reported.result)
    if (!decoded.ok) {
      attempts.delete(attempt.attemptId)
      return refuse(decoded.reasonCode, `alpha connection: ${decoded.errors.join("; ")}`)
    }
    const scope = deps.scope()
    const existing = readAlphaConnectionRecordsV1(scope)
    if (!existing.ok) {
      attempts.delete(attempt.attemptId)
      return refuse("connection-handler-error", `alpha connection: ${existing.reason}`)
    }
    const now = clock().toISOString()
    const next = nextConnectionRecordV1(existing.records, attempt, decoded.result, {
      connectionId: (deps.connectionId ?? mintConnectionId)(),
      now,
    })
    if (!next.ok) {
      attempts.delete(attempt.attemptId)
      return refuse(next.reasonCode, "alpha connection: another connection for this handler is already in use")
    }
    const written = upsertAlphaConnectionRecordV1(scope, next.record)
    if (!written.ok) {
      attempts.delete(attempt.attemptId)
      return refuse("connection-handler-error", `alpha connection: ${written.reason}`)
    }
    attempts.delete(attempt.attemptId)
    return {
      ok: true,
      state: "ready",
      connectionId: next.record.connectionId,
      serviceId: next.record.serviceId,
      accountLabel: next.record.accountLabel,
      reused: next.reused,
    }
  }

  /**
   * The explicit user action. It is the only way a record leaves the store, and it is deliberately
   * allowed while packages are still bound: a user who wants their provider access back gets it,
   * and those packages then show as unavailable rather than pretending they still work.
   */
  async function disconnect(rawIntent: unknown): Promise<AlphaConnectionDisconnectOutcome> {
    const intent = decodeIntent(rawIntent, DISCONNECT_KEYS, ["connectionId"])
    if (!intent.ok) return refuse("connection-profile-invalid", intent.reason)
    const connectionId = intent.values.connectionId!
    if (!ALPHA_CONNECTION_ID_RE.test(connectionId))
      return refuse("connection-profile-invalid", "alpha connection: invalid connectionId")
    const scope = deps.scope()
    const existing = readAlphaConnectionRecordsV1(scope)
    if (!existing.ok) return refuse("connection-handler-error", `alpha connection: ${existing.reason}`)
    const record = existing.records.find((candidate) => candidate.connectionId === connectionId)
    if (!record) return { ok: true, disconnected: false }
    const handler = lookupAlphaConnectionHandlerV1(record.handlerId, table)
    if (!handler.ok)
      return refuse("connection-handler-unknown", "alpha connection: handler is not in this build — update Alpha")
    const result = await handler.handler
      .disconnect(connectionId)
      .catch(() => ({ ok: false as const, reasonCode: "connection-handler-error" as const }))
    if (!result.ok) return refuse(result.reasonCode, "alpha connection: handler could not revoke the connection")
    const removed = removeAlphaConnectionRecordV1(scope, connectionId)
    if (!removed.ok) return refuse("connection-handler-error", `alpha connection: ${removed.reason}`)
    return { ok: true, disconnected: true }
  }

  return { begin, status, disconnect }
}

/**
 * Resolve one signed connection prerequisite. The handler id, the component and the envelope digest
 * all come from the re-fetched, re-evaluated signed envelope — the renderer only said *which*
 * prerequisite, and even that is checked against the signed set rather than trusted.
 */
async function resolveSignedPrerequisite(
  catalogId: string,
  prerequisiteId: string,
  deps: AlphaConnectionCoordinatorDeps,
  /** One table for the whole coordinator: the evaluator and the lookup must not disagree. */
  table: AlphaConnectionHandlerTableV1,
): Promise<
  | { ok: true; item: PackageConnectionPrerequisiteItemV1; envelopeDigest: string }
  | { ok: false; reasonCode: PackageConnectionReasonCodeV1; reason: string }
> {
  const loaded = await deps.loadVerifiedCatalog()
  if (loaded.source === "none")
    return { ok: false, reasonCode: "connection-profile-invalid", reason: `alpha connection: verified Catalog unavailable (${loaded.error})` }
  const validated = validateCatalogPackageShape(loaded.catalog)
  if (!validated.ok)
    return { ok: false, reasonCode: "connection-profile-invalid", reason: `alpha connection: ${validated.error}` }
  const selected = validated.packages.find((item) => item.prelude.packageId === catalogId)
  if (!selected)
    return { ok: false, reasonCode: "connection-profile-invalid", reason: "alpha connection: catalogId not found in verified Catalog" }

  let accepted: PackageAcceptedFactsV1 | undefined
  const view = await evaluatePackageForHost(selected.envelope, {
    ...deps.installability,
    connectionHandlers: table,
    accepted: (facts) => {
      accepted = facts
    },
  })
  if (!accepted)
    return { ok: false, reasonCode: "connection-profile-invalid", reason: `alpha connection: ${view.action.reasonCode}` }
  const item = accepted.components
    .flatMap((component) => component.connection.items)
    .find((candidate) => candidate.prerequisiteId === prerequisiteId)
  if (!item)
    return { ok: false, reasonCode: "connection-profile-invalid", reason: "alpha connection: prerequisiteId is not declared by this package" }
  return { ok: true, item, envelopeDigest: sha256Hex(canonicalJson(accepted.envelope)) }
}

function decodeIntent(
  input: unknown,
  allowed: Set<string>,
  required: string[],
): { ok: true; values: Record<string, string | undefined> } | { ok: false; reason: string } {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return { ok: false, reason: "alpha connection: intent must be an object" }
  const record = input as Record<string, unknown>
  const unknown = Object.keys(record).find((key) => !allowed.has(key))
  if (unknown) return { ok: false, reason: `alpha connection: renderer-supplied key "${unknown}" is refused` }
  const values: Record<string, string | undefined> = {}
  for (const key of required) {
    const value = record[key]
    if (typeof value !== "string" || value.length === 0 || value.length > 256)
      return { ok: false, reason: `alpha connection: invalid ${key}` }
    values[key] = value
  }
  return { ok: true, values }
}

function safeBrowserUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_BROWSER_URL) return
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return
    return url.toString()
  } catch {
    return
  }
}

function mintAttemptId(): string {
  return `a-${randomBytes(16).toString("hex")}`
}

function mintConnectionId(): string {
  return `c-${randomBytes(16).toString("hex")}`
}

function refuse(
  reasonCode: PackageConnectionReasonCodeV1,
  reason: string,
): { ok: false; reasonCode: PackageConnectionReasonCodeV1; reason: string } {
  return { ok: false, reasonCode, reason }
}
