import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  type AlphaPackageEnvelopeV1,
  type PackageProfilePayloadV1,
} from "../shared/host-extension-package-contract/decoder"
import type { PackageAdmissionBindingV1 } from "../shared/package-admission"
import {
  PACKAGE_MCP_OAUTH_REASON_CODES_V1,
  PACKAGE_MCP_OAUTH_RETRYABLE_REASONS_V1,
} from "../shared/package-mcp-oauth"
import {
  createPackageMcpOauthCoordinator,
  createPackageMcpOauthEngineV1,
  type PackageMcpOauthEngineV1,
} from "./package-mcp-oauth"
import { createPackageAdmissionCoordinator } from "./package-admission"
import { evaluatePackageForHost } from "./package-installability"
import { runExtensionTransaction } from "./ext-transaction"
import { uninstallPackageV1, type PackageArtifactInstallersV1 } from "./ext-package-uninstall"

const snapshotDigest = "7".repeat(64)
const COMPONENT_ID = "mcp:oauth-remote"
const SERVICE_ID = "oauth-remote"
const CATALOG_ID = "package:oauth-remote-mcp"
const PREREQUISITE_ID = `${COMPONENT_ID}#provider-oauth`
const SIGNED_URL = "https://mcp.example.com/"
const OTHER_URL = "https://evil.example.net/"
const GOOD_CODE = "authorization-code-4f1c9a"
const TOKEN_CANARY = "REQ128_MCP_OAUTH_TOKEN_4f1c9a"

let tmp = ""
let root = ""
let userData = ""
const previousRoot = process.env.ALPHA_GLOBAL_DIR

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "package-mcp-oauth-"))
  root = join(tmp, "root")
  userData = join(tmp, "user-data")
  mkdirSync(root, { recursive: true })
  process.env.ALPHA_GLOBAL_DIR = root
})

afterEach(() => {
  if (previousRoot === undefined) delete process.env.ALPHA_GLOBAL_DIR
  else process.env.ALPHA_GLOBAL_DIR = previousRoot
  rmSync(tmp, { recursive: true, force: true })
})

/** A host-owned v2 package whose remote MCP authorises through the engine's OAuth stack. */
function fixture(
  options: { required?: boolean; url?: string; catalogId?: string; componentId?: string } = {},
) {
  const componentId = options.componentId ?? COMPONENT_ID
  const payload = {
    schema: "alpha.host-extension-package.payload.mcp-remote.v1",
    behavior: {
      url: options.url ?? SIGNED_URL,
      headersTemplate: {},
      requiredSecrets: [],
      auth: {
        kind: "mcp-oauth",
        prerequisiteId: "provider-oauth",
        required: options.required ?? true,
        label: "Provider account",
      },
    },
  } as unknown as PackageProfilePayloadV1
  const bytes = new TextEncoder().encode(`${JSON.stringify(payload, null, 2)}\n`)
  const envelope = {
    schema: "alpha.host-extension-package.v1",
    prelude: { packageId: options.catalogId ?? CATALOG_ID, version: "1.0.0" },
    presentation: { displayName: "OAuth Remote MCP", description: "Engine-OAuth-authorised remote MCP." },
    root: componentId,
    components: [
      {
        id: componentId,
        required: true,
        dependencies: [],
        profileId: "mcp-remote",
        profileVersion: 1,
        capabilities: ["alpha.mcp-oauth.v1"],
        payloadRef: {
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.byteLength,
          mediaType: "application/vnd.alpha.host-extension-package.mcp-remote.v1+json",
          url: "https://alphacodeone.com/catalog/assets/mcp.oauth-remote/1.0.0/alpha-package/payload.json",
        },
      },
    ],
    capabilities: ["alpha.mcp-oauth.v1"],
  } as unknown as AlphaPackageEnvelopeV1
  return { envelope, bytes }
}

/**
 * The fake engine implements the load-bearing semantics of the real routes, not just their shapes:
 * `add` answers `connected` only when a stored token's `serverUrl` equals the config URL byte for
 * byte (the real `getForUrl` contract), `authStart` registers exactly one pending flow per service
 * name, and `authCallback` exchanges a code only against that pending flow. Token values exist
 * only in here — nothing the coordinator or admission returns may carry the canary.
 */
function fakeEngine(script: { addFails?: boolean; startFails?: boolean; authorizationUrl?: string } = {}) {
  const calls: string[] = []
  const tokens = new Map<string, { serverUrl: string; secret: string }>()
  const pending = new Map<string, { url: string; state: string }>()
  const redirects = new Map<string, string>()
  let mintedStates = 0
  const engine: PackageMcpOauthEngineV1 = {
    add: async (name, config) => {
      calls.push(`add:${name}:${config.url}`)
      if (config.oauth) redirects.set(name, config.oauth.redirectUri)
      if (script.addFails) return { ok: false, reason: "engine unreachable" }
      const entry = tokens.get(name)
      return { ok: true, status: entry && entry.serverUrl === config.url ? "connected" : "needs_auth" }
    },
    authStart: async (name) => {
      calls.push(`authStart:${name}`)
      if (script.startFails) return { ok: false, reason: "service does not support OAuth" }
      const state = `st-${++mintedStates}-${name}`
      const url = [...calls].reverse().find((entry) => entry.startsWith(`add:${name}:`))!.slice(`add:${name}:`.length)
      pending.set(name, { url, state })
      return {
        ok: true,
        authorizationUrl: script.authorizationUrl ?? `https://auth.example.com/authorize?state=${state}`,
        oauthState: state,
      }
    },
    authCallback: async (name, code) => {
      calls.push(`authCallback:${name}:${code}`)
      const flow = pending.get(name)
      if (!flow) return { ok: false, reason: "no pending OAuth flow" }
      if (code !== GOOD_CODE) return { ok: true, status: "failed" }
      pending.delete(name)
      tokens.set(name, { serverUrl: flow.url, secret: TOKEN_CANARY })
      return { ok: true, status: "connected" }
    },
  }
  return {
    engine,
    calls,
    tokens,
    stateOf: (name: string) => pending.get(name)?.state,
    redirectOf: (name: string) => redirects.get(name),
  }
}

function coordinatorFor(engine: PackageMcpOauthEngineV1, fixtures: Array<{ envelope: AlphaPackageEnvelopeV1; bytes: Uint8Array }>) {
  const payloads = new Map(
    fixtures.map((entry) => [
      (entry.envelope as { components: Array<{ payloadRef: { sha256: string } }> }).components[0]!.payloadRef.sha256,
      entry.bytes,
    ]),
  )
  return createPackageMcpOauthCoordinator({
    loadVerifiedCatalog: async () => ({
      source: "remote",
      catalog: { version: "1", entries: [{}], packages: fixtures.map((entry) => entry.envelope) },
      snapshotDigest,
    }),
    engine,
    installability: {
      fetchPayload: async (ref) => {
        const bytes = payloads.get(ref.sha256)
        if (!bytes) throw new Error("unknown payload")
        return bytes
      },
    },
  })
}

async function completeOauth(
  coordinator: ReturnType<typeof createPackageMcpOauthCoordinator>,
  fake: ReturnType<typeof fakeEngine>,
  options: { catalogId?: string; prerequisiteId?: string; serviceId?: string; code?: string } = {},
) {
  const begun = await coordinator.begin({
    catalogId: options.catalogId ?? CATALOG_ID,
    prerequisiteId: options.prerequisiteId ?? PREREQUISITE_ID,
  })
  if (!begun.ok || begun.state !== "pending") throw new Error(`expected pending begin: ${JSON.stringify(begun)}`)
  const serviceId = options.serviceId ?? SERVICE_ID
  const redirect = fake.redirectOf(serviceId)!
  const state = fake.stateOf(serviceId)!
  const response = await fetch(`${redirect}?code=${options.code ?? GOOD_CODE}&state=${state}`)
  return { begun, response, attemptId: begun.attemptId }
}

function confirmation(preview: {
  authorization: Array<{ key: string; requested: string[] }>
  packageAuthorization: { binding: PackageAdmissionBindingV1 }
}) {
  return {
    confirmed: Object.fromEntries(preview.authorization.map((item) => [item.key, item.requested])),
    binding: preview.packageAuthorization.binding,
  }
}

function admissionCoordinator(options: {
  envelope: AlphaPackageEnvelopeV1
  bytes: Uint8Array
  engine?: PackageMcpOauthEngineV1
  onTransaction: () => void
  failTransaction?: boolean
}) {
  return createPackageAdmissionCoordinator({
    loadVerifiedCatalog: async () => ({
      source: "remote",
      catalog: { version: "1", entries: [{}], packages: [options.envelope] },
      snapshotDigest,
    }),
    root: () => root,
    userDataPath: userData,
    casBaseRoot: () => userData,
    environment: () => "dev",
    installability: { fetchPayload: async () => options.bytes },
    ...(options.engine ? { mcpOauthEngine: options.engine } : {}),
    transaction: async (...args) => {
      options.onTransaction()
      if (options.failTransaction) return { ok: false as const, stage: "populate" as const, reason: "injected local install failure" }
      return runExtensionTransaction(...args)
    },
  })
}

async function install(options: {
  envelope: AlphaPackageEnvelopeV1
  bytes: Uint8Array
  engine?: PackageMcpOauthEngineV1
  attemptId: string
  failTransaction?: boolean
}) {
  let transactionCalls = 0
  const admit = admissionCoordinator({
    envelope: options.envelope,
    bytes: options.bytes,
    ...(options.engine ? { engine: options.engine } : {}),
    onTransaction: () => transactionCalls++,
    ...(options.failTransaction ? { failTransaction: true } : {}),
  })
  const preview = await admit({ catalogId: options.envelope.prelude.packageId, scope: { scope: "global" }, attemptId: options.attemptId })
  if (preview.ok || preview.stage !== "authorize") throw new Error(`expected preview: ${JSON.stringify(preview)}`)
  const outcome = await admit({
    catalogId: options.envelope.prelude.packageId,
    scope: { scope: "global" },
    attemptId: options.attemptId,
    authorization: confirmation(preview),
  })
  return { outcome, transactionCalls }
}

function uninstallInstallers(calls: string[]): PackageArtifactInstallersV1 {
  return {
    removeFsInstall: (type, name) => {
      calls.push(`removeFsInstall:${type}:${name}`)
      return { ok: true, files: [] }
    },
    removeMcpConfig: (name) => {
      calls.push(`removeMcpConfig:${name}`)
      return { ok: true }
    },
    removeCommandConfig: (name) => {
      calls.push(`removeCommandConfig:${name}`)
      return { ok: true }
    },
    removeMcpSecretsStrict: (name) => {
      calls.push(`removeMcpSecretsStrict:${name}`)
      return { ok: true }
    },
    releaseAlphaConnectionBindings: (componentId) => {
      calls.push(`releaseAlphaConnectionBindings:${componentId}`)
      return { ok: true }
    },
    removeInstallGrants: (_root, keys) => {
      calls.push(`removeInstallGrants:${keys.join(",")}`)
      return { ok: true, removed: [] }
    },
    removePluginPath: (name, absJsPath) => {
      calls.push(`removePluginPath:${name}:${absJsPath}`)
      return { ok: true }
    },
  }
}

describe("vocabulary", () => {
  test("every non-ready reason code except profile-invalid is retryable, and every code is named once", () => {
    const retryable = new Set<string>(PACKAGE_MCP_OAUTH_RETRYABLE_REASONS_V1)
    const terminalOnly = PACKAGE_MCP_OAUTH_REASON_CODES_V1.filter(
      (code) => !retryable.has(code) && code !== "mcp-oauth-ready",
    )
    // `mcp-oauth-profile-invalid` needs a new package; everything else must be retryable with a
    // fresh attempt, or "fail closed" turns into "stuck forever".
    expect(terminalOnly).toEqual(["mcp-oauth-profile-invalid"])
    expect(new Set(PACKAGE_MCP_OAUTH_REASON_CODES_V1).size).toBe(PACKAGE_MCP_OAUTH_REASON_CODES_V1.length)
  })
})

describe("the browse surface sees the signed OAuth prerequisite", () => {
  /**
   * Before this ticket the mcp-oauth declaration decoded but reached no view: a required OAuth
   * package presented itself as ready and the installer ran. This pins the honest verdict.
   */
  test("the production evaluator lists the prerequisite as required-action", async () => {
    const { envelope, bytes } = fixture()
    const view = await evaluatePackageForHost(envelope, { fetchPayload: async () => bytes })
    expect(view.verdict).toBe("compatible")
    expect(view.action.reasonCode).toBe("package-prerequisite-required")
    expect(view.prerequisites).toEqual({
      status: "required-action",
      items: [{ prerequisiteId: PREREQUISITE_ID, label: "Provider account", required: true }],
    })
  })
})

describe("the engine owns the protocol; main owns the attempt", () => {
  /**
   * Discovery, DCR and PKCE all live behind `authStart`: the coordinator's entire outbound
   * vocabulary for starting a flow is [add, authStart], and the browser URL it hands out is the
   * engine's, byte for byte. A coordinator that composed its own authorization URL would have to
   * diverge from this exact call log to do it.
   */
  test("begin drives exactly add + authStart against the signed URL and relays the engine's authorization URL", async () => {
    const fake = fakeEngine()
    const coordinator = coordinatorFor(fake.engine, [fixture()])
    const begun = await coordinator.begin({ catalogId: CATALOG_ID, prerequisiteId: PREREQUISITE_ID })
    if (!begun.ok || begun.state !== "pending") throw new Error(JSON.stringify(begun))
    expect(fake.calls).toEqual([`add:${SERVICE_ID}:${SIGNED_URL}`, `authStart:${SERVICE_ID}`])
    expect(begun.browserUrl).toBe(`https://auth.example.com/authorize?state=${fake.stateOf(SERVICE_ID)}`)
    // The redirect the engine was configured with is a loopback URL owned by this attempt.
    expect(fake.redirectOf(SERVICE_ID)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    await coordinator.cancel({ attemptId: begun.attemptId })
  })

  test("begin refuses a non-https authorization URL from the engine", async () => {
    const fake = fakeEngine({ authorizationUrl: "http://auth.example.com/authorize" })
    const coordinator = coordinatorFor(fake.engine, [fixture()])
    expect(await coordinator.begin({ catalogId: CATALOG_ID, prerequisiteId: PREREQUISITE_ID })).toMatchObject({
      ok: false,
      reasonCode: "mcp-oauth-engine-error",
    })
  })

  test("valid tokens for the signed URL complete the attempt with no browser round", async () => {
    const fake = fakeEngine()
    fake.tokens.set(SERVICE_ID, { serverUrl: SIGNED_URL, secret: TOKEN_CANARY })
    const coordinator = coordinatorFor(fake.engine, [fixture()])
    const begun = await coordinator.begin({ catalogId: CATALOG_ID, prerequisiteId: PREREQUISITE_ID })
    expect(begun).toMatchObject({ ok: true, state: "ready" })
    expect(fake.calls).toEqual([`add:${SERVICE_ID}:${SIGNED_URL}`])
  })

  /**
   * The full loopback round trip. The code travels to the engine's callback route verbatim and the
   * exchange happens over the engine's pending PKCE transport — the coordinator's only contribution
   * after the redirect is the state check and the typed route call.
   */
  test("a real loopback callback with the attempt's state completes the exchange through the engine", async () => {
    const fake = fakeEngine()
    const coordinator = coordinatorFor(fake.engine, [fixture()])
    const { response, attemptId } = await completeOauth(coordinator, fake)
    expect(response.status).toBe(200)
    expect(fake.calls).toEqual([
      `add:${SERVICE_ID}:${SIGNED_URL}`,
      `authStart:${SERVICE_ID}`,
      `authCallback:${SERVICE_ID}:${GOOD_CODE}`,
    ])
    const ready = await coordinator.status({ attemptId })
    expect(ready).toEqual({
      ok: true,
      state: "ready",
      serviceId: SERVICE_ID,
      serverUrl: SIGNED_URL,
      prerequisiteId: PREREQUISITE_ID,
    })
    // The token landed in the engine's store, bound to the signed URL; main never saw it.
    expect(fake.tokens.get(SERVICE_ID)).toEqual({ serverUrl: SIGNED_URL, secret: TOKEN_CANARY })
    expect(JSON.stringify(ready)).not.toContain(TOKEN_CANARY)
    // A completed attempt is consumed: replaying its id is stale, not a second success.
    expect(await coordinator.status({ attemptId })).toMatchObject({ ok: false, reasonCode: "mcp-oauth-attempt-stale" })
  })
})

describe("state, mixup and cancel fail closed", () => {
  test("a callback with the wrong state is answered 400 and reaches no engine exchange", async () => {
    const fake = fakeEngine()
    const coordinator = coordinatorFor(fake.engine, [fixture()])
    const begun = await coordinator.begin({ catalogId: CATALOG_ID, prerequisiteId: PREREQUISITE_ID })
    if (!begun.ok || begun.state !== "pending") throw new Error(JSON.stringify(begun))
    const redirect = fake.redirectOf(SERVICE_ID)!
    for (const query of [`?code=${GOOD_CODE}&state=forged-state`, `?code=${GOOD_CODE}`]) {
      const response = await fetch(`${redirect}${query}`)
      expect(response.status).toBe(400)
    }
    expect(fake.calls.filter((entry) => entry.startsWith("authCallback"))).toEqual([])
    // The attempt is still waiting for its real callback — a stray local request cannot end it.
    expect(await coordinator.status({ attemptId: begun.attemptId })).toEqual({ ok: true, state: "pending" })
    const real = await fetch(`${redirect}?code=${GOOD_CODE}&state=${fake.stateOf(SERVICE_ID)}`)
    expect(real.status).toBe(200)
    expect(await coordinator.status({ attemptId: begun.attemptId })).toMatchObject({ ok: true, state: "ready" })
  })

  /**
   * Two live attempts for two services: attempt B's state delivered to attempt A's listener is a
   * mixed-up callback. It must complete neither — the ports differ *and* the state differs, and
   * this pins that the state check alone already refuses it.
   */
  test("a callback mixup between two live attempts completes neither", async () => {
    const other = fixture({ catalogId: "package:other-remote-mcp", componentId: "mcp:other-remote", url: "https://other.example.com/" })
    const fake = fakeEngine()
    const coordinator = coordinatorFor(fake.engine, [fixture(), other])
    const begunA = await coordinator.begin({ catalogId: CATALOG_ID, prerequisiteId: PREREQUISITE_ID })
    const begunB = await coordinator.begin({ catalogId: "package:other-remote-mcp", prerequisiteId: "mcp:other-remote#provider-oauth" })
    if (!begunA.ok || begunA.state !== "pending" || !begunB.ok || begunB.state !== "pending")
      throw new Error("expected two pending attempts")
    const crossed = await fetch(`${fake.redirectOf(SERVICE_ID)}?code=${GOOD_CODE}&state=${fake.stateOf("other-remote")}`)
    expect(crossed.status).toBe(400)
    expect(fake.calls.filter((entry) => entry.startsWith("authCallback"))).toEqual([])
    expect(await coordinator.status({ attemptId: begunA.attemptId })).toEqual({ ok: true, state: "pending" })
    expect(await coordinator.status({ attemptId: begunB.attemptId })).toEqual({ ok: true, state: "pending" })
    await coordinator.cancel({ attemptId: begunA.attemptId })
    await coordinator.cancel({ attemptId: begunB.attemptId })
  })

  test("a provider refusal ends the attempt as cancelled, with zero exchanges", async () => {
    const fake = fakeEngine()
    const coordinator = coordinatorFor(fake.engine, [fixture()])
    const begun = await coordinator.begin({ catalogId: CATALOG_ID, prerequisiteId: PREREQUISITE_ID })
    if (!begun.ok || begun.state !== "pending") throw new Error(JSON.stringify(begun))
    const response = await fetch(
      `${fake.redirectOf(SERVICE_ID)}?error=access_denied&state=${fake.stateOf(SERVICE_ID)}`,
    )
    expect(response.status).toBe(200)
    expect(fake.calls.filter((entry) => entry.startsWith("authCallback"))).toEqual([])
    expect(await coordinator.status({ attemptId: begun.attemptId })).toMatchObject({
      ok: false,
      reasonCode: "mcp-oauth-cancelled",
    })
  })

  /**
   * Cancel is main-side only: the listener dies (a late redirect has nowhere to land) and no
   * engine route is called — in particular not the credential-removal one, which would destroy a
   * still-valid token behind a re-authorization the user merely abandoned.
   */
  test("cancel closes the listener, consumes the attempt and touches neither engine nor tokens", async () => {
    const fake = fakeEngine()
    fake.tokens.set(SERVICE_ID, { serverUrl: OTHER_URL, secret: TOKEN_CANARY })
    const coordinator = coordinatorFor(fake.engine, [fixture()])
    const begun = await coordinator.begin({ catalogId: CATALOG_ID, prerequisiteId: PREREQUISITE_ID })
    if (!begun.ok || begun.state !== "pending") throw new Error(JSON.stringify(begun))
    const redirect = fake.redirectOf(SERVICE_ID)!
    const state = fake.stateOf(SERVICE_ID)!
    const callsBefore = [...fake.calls]
    expect(await coordinator.cancel({ attemptId: begun.attemptId })).toEqual({ ok: true, cancelled: true })
    expect(fake.calls).toEqual(callsBefore)
    expect(fake.tokens.get(SERVICE_ID)).toEqual({ serverUrl: OTHER_URL, secret: TOKEN_CANARY })
    await expect(fetch(`${redirect}?code=${GOOD_CODE}&state=${state}`)).rejects.toThrow()
    expect(await coordinator.status({ attemptId: begun.attemptId })).toMatchObject({
      ok: false,
      reasonCode: "mcp-oauth-attempt-stale",
    })
  })

  test("a second concurrent attempt for the same service is a conflict until the first ends", async () => {
    const fake = fakeEngine()
    const coordinator = coordinatorFor(fake.engine, [fixture()])
    const first = await coordinator.begin({ catalogId: CATALOG_ID, prerequisiteId: PREREQUISITE_ID })
    if (!first.ok) throw new Error(JSON.stringify(first))
    expect(await coordinator.begin({ catalogId: CATALOG_ID, prerequisiteId: PREREQUISITE_ID })).toMatchObject({
      ok: false,
      reasonCode: "mcp-oauth-attempt-conflict",
    })
    await coordinator.cancel({ attemptId: first.attemptId })
    const retry = await coordinator.begin({ catalogId: CATALOG_ID, prerequisiteId: PREREQUISITE_ID })
    expect(retry.ok).toBe(true)
    if (retry.ok && retry.state === "pending") await coordinator.cancel({ attemptId: retry.attemptId })
  })

  test.each([
    ["an attempt id that was never issued", "a-" + "0".repeat(32)],
    ["a well-formed but foreign attempt id", "a-" + "f".repeat(32)],
  ])("status and cancel on %s are stale", async (_name, attemptId) => {
    const fake = fakeEngine()
    const coordinator = coordinatorFor(fake.engine, [fixture()])
    expect(await coordinator.status({ attemptId })).toMatchObject({ ok: false, reasonCode: "mcp-oauth-attempt-stale" })
    expect(await coordinator.cancel({ attemptId })).toMatchObject({ ok: false, reasonCode: "mcp-oauth-attempt-stale" })
  })
})

describe("the renderer cannot construct a free OAuth request", () => {
  /**
   * The renderer's entire vocabulary is two keys at begin and one at status/cancel. Naming a
   * service, a URL, a state or a code is not "rejected input" — there is no field to put it in.
   */
  test.each([
    ["serviceId", { catalogId: CATALOG_ID, prerequisiteId: PREREQUISITE_ID, serviceId: "attacker" }],
    ["serverUrl", { catalogId: CATALOG_ID, prerequisiteId: PREREQUISITE_ID, serverUrl: OTHER_URL }],
    ["url", { catalogId: CATALOG_ID, prerequisiteId: PREREQUISITE_ID, url: OTHER_URL }],
    ["oauthState", { catalogId: CATALOG_ID, prerequisiteId: PREREQUISITE_ID, oauthState: "forged" }],
    ["code", { catalogId: CATALOG_ID, prerequisiteId: PREREQUISITE_ID, code: GOOD_CODE }],
    ["redirectUri", { catalogId: CATALOG_ID, prerequisiteId: PREREQUISITE_ID, redirectUri: "http://127.0.0.1:1/x" }],
  ])("begin refuses a renderer-supplied %s before any engine call", async (_name, intent) => {
    const fake = fakeEngine()
    const coordinator = coordinatorFor(fake.engine, [fixture()])
    expect(await coordinator.begin(intent)).toMatchObject({ ok: false, reasonCode: "mcp-oauth-profile-invalid" })
    expect(fake.calls).toEqual([])
  })

  test("begin refuses a prerequisiteId the signed package does not declare", async () => {
    const fake = fakeEngine()
    const coordinator = coordinatorFor(fake.engine, [fixture()])
    expect(
      await coordinator.begin({ catalogId: CATALOG_ID, prerequisiteId: `${COMPONENT_ID}#invented` }),
    ).toMatchObject({ ok: false, reasonCode: "mcp-oauth-profile-invalid" })
    expect(fake.calls).toEqual([])
  })

  /**
   * The production engine seam really is the authenticated typed sidecar route surface: every call
   * carries the engine's Basic credential and lands on the `/mcp` route family. The expected header
   * is computed here from independent literals, not read back from the code under test.
   */
  test("the production engine client sends authenticated requests to the typed /mcp routes", async () => {
    const seen: Array<{ url: string; method: string; authorization: string | null }> = []
    const respond = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
    const fakeFetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      seen.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.get("authorization"),
      })
      const path = new URL(request.url).pathname
      if (path === "/mcp" && request.method === "POST")
        return respond({ [SERVICE_ID]: { status: "needs_auth" } })
      if (path === `/mcp/${SERVICE_ID}/auth`)
        return respond({ authorizationUrl: "https://auth.example.com/a", oauthState: "st-1" })
      if (path === `/mcp/${SERVICE_ID}/auth/callback`) return respond({ status: "connected" })
      return new Response("not found", { status: 404 })
    }) as typeof fetch
    const engine = createPackageMcpOauthEngineV1(
      async () => ({ url: "http://127.0.0.1:19999", username: "alpha", password: "engine-secret" }),
      fakeFetch,
    )
    expect(await engine.add(SERVICE_ID, { type: "remote", url: SIGNED_URL, enabled: true })).toEqual({
      ok: true,
      status: "needs_auth",
    })
    expect(await engine.authStart(SERVICE_ID)).toEqual({
      ok: true,
      authorizationUrl: "https://auth.example.com/a",
      oauthState: "st-1",
    })
    expect(await engine.authCallback(SERVICE_ID, GOOD_CODE)).toEqual({ ok: true, status: "connected" })
    expect(seen.map((entry) => new URL(entry.url).pathname)).toEqual([
      "/mcp",
      `/mcp/${SERVICE_ID}/auth`,
      `/mcp/${SERVICE_ID}/auth/callback`,
    ])
    const expected = `Basic ${Buffer.from("alpha:engine-secret").toString("base64")}`
    for (const entry of seen) {
      expect(entry.method).toBe("POST")
      expect(entry.authorization).toBe(expected)
    }
  })
})

describe("admission asks the engine, and required OAuth gates the installer", () => {
  test("a required OAuth prerequisite that is not ready stops the install with zero transaction calls", async () => {
    const fake = fakeEngine()
    const { envelope, bytes } = fixture()
    const { outcome, transactionCalls } = await install({ envelope, bytes, engine: fake.engine, attemptId: "attempt-required-missing" })
    expect(outcome).toMatchObject({ ok: false, reason: "package admission: mcp-oauth-required" })
    expect(transactionCalls).toBe(0)
  })

  test("an absent engine seam is refused for a required prerequisite, never treated as ready", async () => {
    const { envelope, bytes } = fixture()
    const { outcome, transactionCalls } = await install({ envelope, bytes, attemptId: "attempt-no-seam" })
    expect(outcome).toMatchObject({ ok: false, reason: "package admission: mcp-oauth-engine-unavailable" })
    expect(transactionCalls).toBe(0)
  })

  test("an unreachable engine is refused for a required prerequisite", async () => {
    const fake = fakeEngine({ addFails: true })
    const { envelope, bytes } = fixture()
    const { outcome, transactionCalls } = await install({ envelope, bytes, engine: fake.engine, attemptId: "attempt-engine-down" })
    expect(outcome).toMatchObject({ ok: false, reason: "package admission: mcp-oauth-engine-unavailable" })
    expect(transactionCalls).toBe(0)
  })

  test("a ready engine lets the install through, probed against the signed URL", async () => {
    const fake = fakeEngine()
    fake.tokens.set(SERVICE_ID, { serverUrl: SIGNED_URL, secret: TOKEN_CANARY })
    const { envelope, bytes } = fixture()
    const { outcome, transactionCalls } = await install({ envelope, bytes, engine: fake.engine, attemptId: "attempt-ready" })
    expect(outcome).toMatchObject({ ok: true, kind: "mcp", name: SERVICE_ID })
    expect(outcome).not.toHaveProperty("mcpOauthUnavailable")
    expect(transactionCalls).toBe(1)
    expect(fake.calls).toEqual([`add:${SERVICE_ID}:${SIGNED_URL}`])
    // The durable config binds the signed URL — the same binding the engine's token store enforces.
    const config = JSON.parse(readFileSync(join(root, "alpha.jsonc"), "utf8"))
    expect(config.mcp[SERVICE_ID].url).toBe(SIGNED_URL)
    // No token byte reaches the ledger or the config.
    for (const file of ["alpha.jsonc", "installs.json"])
      expect(readFileSync(join(root, file), "utf8")).not.toContain(TOKEN_CANARY)
  })

  /**
   * Token↔server binding, end to end: the token was minted for the signed URL of version A. An
   * envelope now pointing somewhere else re-probes against *its* URL, the engine's `getForUrl`
   * semantics answer needs_auth, and the required gate refuses. A token can never follow a package
   * to a server it was not granted for.
   */
  test("a token bound to another URL does not satisfy a tampered envelope", async () => {
    const fake = fakeEngine()
    fake.tokens.set(SERVICE_ID, { serverUrl: SIGNED_URL, secret: TOKEN_CANARY })
    const moved = fixture({ url: OTHER_URL })
    const { outcome, transactionCalls } = await install({
      envelope: moved.envelope,
      bytes: moved.bytes,
      engine: fake.engine,
      attemptId: "attempt-moved-url",
    })
    expect(outcome).toMatchObject({ ok: false, reason: "package admission: mcp-oauth-required" })
    expect(transactionCalls).toBe(0)
    expect(fake.calls).toEqual([`add:${SERVICE_ID}:${OTHER_URL}`])
  })

  test("an optional OAuth prerequisite that is not ready installs unavailable and disabled", async () => {
    const fake = fakeEngine()
    const { envelope, bytes } = fixture({ required: false })
    const { outcome, transactionCalls } = await install({ envelope, bytes, engine: fake.engine, attemptId: "attempt-optional" })
    expect(outcome).toMatchObject({ ok: true, kind: "mcp", mcpOauthUnavailable: true, activateMcp: [] })
    expect(transactionCalls).toBe(1)
    const config = JSON.parse(readFileSync(join(root, "alpha.jsonc"), "utf8"))
    expect(config.mcp[SERVICE_ID].enabled).toBe(false)
  })
})

describe("credentials outlive local installs", () => {
  test("a failed local install retains the engine-side credential for reuse", async () => {
    const fake = fakeEngine()
    const coordinator = coordinatorFor(fake.engine, [fixture()])
    await completeOauth(coordinator, fake)
    expect(fake.tokens.get(SERVICE_ID)).toEqual({ serverUrl: SIGNED_URL, secret: TOKEN_CANARY })

    const { envelope, bytes } = fixture()
    const { outcome, transactionCalls } = await install({
      envelope,
      bytes,
      engine: fake.engine,
      attemptId: "attempt-install-fails",
      failTransaction: true,
    })
    expect(outcome).toMatchObject({ ok: false, reason: "injected local install failure" })
    expect(transactionCalls).toBe(1)
    // The consent already granted at the provider is not a rollbackable local side effect: the
    // token entry survives, and a retry needs no second browser round.
    expect(fake.tokens.get(SERVICE_ID)).toEqual({ serverUrl: SIGNED_URL, secret: TOKEN_CANARY })
    const retry = await coordinatorFor(fake.engine, [fixture()]).begin({
      catalogId: CATALOG_ID,
      prerequisiteId: PREREQUISITE_ID,
    })
    expect(retry).toMatchObject({ ok: true, state: "ready" })
  })

  /**
   * Uninstall is structurally incapable of revoking: its installer surface has no OAuth verb and
   * it holds no engine handle. This pins the observable half — a full install/uninstall round trip
   * leaves the engine's call log and token store byte-identical.
   */
  test("package uninstall does not revoke the shared engine credential", async () => {
    const fake = fakeEngine()
    fake.tokens.set(SERVICE_ID, { serverUrl: SIGNED_URL, secret: TOKEN_CANARY })
    const { envelope, bytes } = fixture()
    const installed = await install({ envelope, bytes, engine: fake.engine, attemptId: "attempt-then-uninstall" })
    expect(installed.outcome).toMatchObject({ ok: true, kind: "mcp" })
    const callsAfterInstall = [...fake.calls]

    const uninstallCalls: string[] = []
    const outcome = uninstallPackageV1(CATALOG_ID, {
      globalRoot: () => root,
      installers: uninstallInstallers(uninstallCalls),
    })
    expect(outcome.ok).toBe(true)
    expect(fake.calls).toEqual(callsAfterInstall)
    expect(fake.tokens.get(SERVICE_ID)).toEqual({ serverUrl: SIGNED_URL, secret: TOKEN_CANARY })
  })
})
