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
  ALPHA_CONNECTION_RECORD_SCHEMA_V1,
  PACKAGE_CONNECTION_REASON_CODES_V1,
  PACKAGE_CONNECTION_RETRYABLE_REASONS_V1,
  decodeAlphaConnectionResultV1,
  decodePackageConnectionPrerequisiteProfileV1,
  type AlphaConnectionHandlerTableV1,
  type AlphaConnectionHandlerV1,
  type AlphaConnectionStatusV1,
  type ConnectionRecordV1,
} from "../shared/package-alpha-connection"
import {
  ALPHA_CONNECTION_HANDLERS_V1,
  alphaConnectionHandlerIdsV1,
  lookupAlphaConnectionHandlerV1,
} from "./alpha-connection-handlers"
import {
  alphaConnectionStorePath,
  assertAlphaConnectionStoreIndependenceV1,
  bindAlphaConnectionPackageV1,
  readAlphaConnectionRecordsV1,
  releaseAlphaConnectionBindingsV1,
  upsertAlphaConnectionRecordV1,
  type AlphaConnectionStoreScope,
} from "./alpha-connection-store"
import { createAlphaConnectionCoordinator } from "./alpha-connection-coordinator"
import { upsertRecordV2 } from "./ext-receipt-v2"
import { createPackageAdmissionCoordinator } from "./package-admission"
import { evaluatePackageForHost } from "./package-installability"
import { runExtensionTransaction } from "./ext-transaction"

const snapshotDigest = "7".repeat(64)
const HANDLER_ID = "example-connector"
const COMPONENT_ID = "mcp:connected-remote"
const CATALOG_ID = "package:connected-remote-mcp"
const PREREQUISITE_ID = `${COMPONENT_ID}#account-link`
const TOKEN_CANARY = "REQ128_CONNECTION_TOKEN_4f1c9a"

let tmp = ""
let root = ""
let userData = ""
let scope: AlphaConnectionStoreScope
const previousRoot = process.env.ALPHA_GLOBAL_DIR

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "package-alpha-connection-"))
  root = join(tmp, "root")
  userData = join(tmp, "user-data")
  mkdirSync(root, { recursive: true })
  scope = { userDataPath: userData, extensionRoot: root }
  process.env.ALPHA_GLOBAL_DIR = root
})

afterEach(() => {
  if (previousRoot === undefined) delete process.env.ALPHA_GLOBAL_DIR
  else process.env.ALPHA_GLOBAL_DIR = previousRoot
  rmSync(tmp, { recursive: true, force: true })
})

/** A host-owned v2 package whose remote MCP authorises through a registered Alpha Connection. */
function fixture(options: { required?: boolean; handlerId?: string } = {}) {
  const payload = {
    schema: "alpha.host-extension-package.payload.mcp-remote.v1",
    behavior: {
      url: "https://mcp.example.com/",
      headersTemplate: {},
      requiredSecrets: [],
      auth: {
        kind: "alpha-connection",
        prerequisiteId: "account-link",
        required: options.required ?? true,
        connectionHandlerId: options.handlerId ?? HANDLER_ID,
        label: "Example account",
      },
    },
  } as unknown as PackageProfilePayloadV1
  const bytes = new TextEncoder().encode(`${JSON.stringify(payload, null, 2)}\n`)
  const envelope = {
    schema: "alpha.host-extension-package.v1",
    prelude: { packageId: CATALOG_ID, version: "1.0.0" },
    presentation: { displayName: "Connected Remote MCP", description: "Connection-authorised remote MCP." },
    root: COMPONENT_ID,
    components: [
      {
        id: COMPONENT_ID,
        required: true,
        dependencies: [],
        profileId: "mcp-remote",
        profileVersion: 1,
        capabilities: ["alpha.connection.v1"],
        payloadRef: {
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.byteLength,
          mediaType: "application/vnd.alpha.host-extension-package.mcp-remote.v1+json",
          url: "https://alphacodeone.com/catalog/assets/mcp.connected-remote/1.0.0/alpha-package/payload.json",
        },
      },
    ],
    capabilities: ["alpha.connection.v1"],
  } as unknown as AlphaPackageEnvelopeV1
  return { envelope, bytes }
}

type HandlerCalls = { begin: number; status: number; disconnect: string[] }

function fakeHandler(
  calls: HandlerCalls,
  script: { statuses?: AlphaConnectionStatusV1[]; browserUrl?: string; beginFails?: boolean } = {},
): { table: AlphaConnectionHandlerTableV1; handler: AlphaConnectionHandlerV1 } {
  const statuses = [...(script.statuses ?? [])]
  const handler: AlphaConnectionHandlerV1 = {
    handlerId: HANDLER_ID,
    displayName: "Example connector",
    begin: async () => {
      calls.begin++
      if (script.beginFails) return { ok: false, reasonCode: "connection-handler-error" }
      return { ok: true, state: "pending", ...(script.browserUrl ? { browserUrl: script.browserUrl } : {}) }
    },
    status: async () => {
      calls.status++
      return statuses.shift() ?? { ok: true, state: "pending" }
    },
    disconnect: async (connectionId) => {
      calls.disconnect.push(connectionId)
      return { ok: true }
    },
  }
  return { table: Object.freeze({ [HANDLER_ID]: handler }), handler }
}

function readyResult(reuseKey = "acct-primary") {
  return { serviceIdentity: { serviceId: "example", accountLabel: "user@example.com" }, reuseKey }
}

function seedConnection(overrides: Partial<ConnectionRecordV1> = {}): ConnectionRecordV1 {
  const record: ConnectionRecordV1 = {
    schema: ALPHA_CONNECTION_RECORD_SCHEMA_V1,
    connectionId: `c-${"a".repeat(32)}`,
    handlerId: HANDLER_ID,
    serviceId: "example",
    accountLabel: "user@example.com",
    reuseKey: "acct-primary",
    state: "ready",
    packageBindings: [],
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
    ...overrides,
  }
  const written = upsertAlphaConnectionRecordV1(scope, record)
  if (!written.ok) throw new Error(written.reason)
  return record
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
  handlers?: AlphaConnectionHandlerTableV1
  onTransaction: () => void
}) {
  return createPackageAdmissionCoordinator({
    loadVerifiedCatalog: async () => ({
      source: "remote",
      catalog: { version: "1", entries: [{}], packages: [options.envelope] },
      snapshotDigest,
    }),
    root: () => root,
    userDataPath: userData,
    // `#828`:skill 载荷经验证共享 CAS 落 generation。测试里 CAS 与 userData 同根即可。
    casBaseRoot: () => userData,
    environment: () => "dev",
    installability: {
      fetchPayload: async () => options.bytes,
      ...(options.handlers ? { connectionHandlers: options.handlers } : {}),
    },
    transaction: async (...args) => {
      options.onTransaction()
      return runExtensionTransaction(...args)
    },
  })
}

describe("alpha connection allowlist", () => {
  /**
   * The shipped table. Pinned as an exact set rather than "is small" or "does not contain X": a
   * handler is App code that speaks to a third party on the user's behalf, so one appearing here
   * has to be a reviewed decision, not a diff nobody read.
   */
  test("the production handler table is empty in this build and every id is unknown", () => {
    expect(alphaConnectionHandlerIdsV1()).toEqual([])
    for (const id of [HANDLER_ID, "alpha-example", "github", "", "example-connector "])
      expect(lookupAlphaConnectionHandlerV1(id)).toEqual({ ok: false, reasonCode: "connection-handler-unknown" })
  })

  /**
   * Main looks the id up; it never reads meaning out of it. These ids all *look* like they belong
   * to a family the table serves, and none of them may borrow its authority.
   */
  test.each([
    ["a prefix sibling", "example-connector-staging"],
    ["a namespace parent", "example"],
    ["a segment suffix", "connector"],
    ["a prototype key", "constructor"],
    ["another prototype key", "__proto__"],
    ["an inherited method name", "toString"],
  ])("lookup refuses %s even though a real handler is registered", (_name, id) => {
    const { table } = fakeHandler({ begin: 0, status: 0, disconnect: [] })
    expect(lookupAlphaConnectionHandlerV1(id, table).ok).toBe(false)
    expect(lookupAlphaConnectionHandlerV1(HANDLER_ID, table).ok).toBe(true)
  })

  /** A table entry whose own id disagrees with its key is a mis-registration, not a handler. */
  test("lookup refuses a handler filed under the wrong key", () => {
    const { handler } = fakeHandler({ begin: 0, status: 0, disconnect: [] })
    const table: AlphaConnectionHandlerTableV1 = Object.freeze({ "other-connector": handler })
    expect(lookupAlphaConnectionHandlerV1("other-connector", table)).toEqual({
      ok: false,
      reasonCode: "connection-handler-unknown",
    })
  })

  test("the production table is frozen and prototype-free", () => {
    expect(Object.isFrozen(ALPHA_CONNECTION_HANDLERS_V1)).toBe(true)
    expect(Object.getPrototypeOf(ALPHA_CONNECTION_HANDLERS_V1)).toBe(null)
  })

  test("every non-ready reason code is retryable and every code is named", () => {
    const retryable = new Set<string>(PACKAGE_CONNECTION_RETRYABLE_REASONS_V1)
    const terminalOnly = PACKAGE_CONNECTION_REASON_CODES_V1.filter(
      (code) => !retryable.has(code) && code !== "connection-ready",
    )
    // `connection-handler-unknown` and `connection-profile-invalid` are the two that a retry cannot
    // fix — the first needs a new App build, the second a new package. Everything else must be
    // retryable, or "fail closed" turns into "stuck forever".
    expect(terminalOnly).toEqual(["connection-handler-unknown", "connection-profile-invalid"])
    expect(new Set(PACKAGE_CONNECTION_REASON_CODES_V1).size).toBe(PACKAGE_CONNECTION_REASON_CODES_V1.length)
  })
})

describe("unknown handler is answered before any handler / auth / browser / store interaction", () => {
  /**
   * Deliberately *not* "before any external interaction". The connection declaration lives inside
   * the component payload, so the evaluator fetches that payload first and looks the handler id up
   * afterwards: by the time `update-required` comes back, the payload host has already been
   * contacted, and a payload fetch that fails surfaces as `package-payload-unavailable` instead of
   * this verdict. What is pinned here is the narrower — and true — fact: no handler runs, no auth
   * or browser window opens, nothing reaches the connection store, and that one payload request is
   * the only outbound call.
   */
  test("the production evaluator returns update-required after exactly one payload fetch and never touches a handler", async () => {
    const { envelope, bytes } = fixture()
    const calls: HandlerCalls = { begin: 0, status: 0, disconnect: [] }
    fakeHandler(calls)
    let fetchCalls = 0
    const view = await evaluatePackageForHost(envelope, {
      fetchPayload: async () => {
        fetchCalls++
        return bytes
      },
    })
    expect(view.verdict).toBe("update-required")
    expect(view.action).toEqual({ kind: "update-alpha", enabled: true, reasonCode: "package-host-update-required" })
    expect(view.prerequisites).toEqual({ status: "ready", items: [] })
    // An exact count, not "at least one": a second fetch inserted before the lookup, or the single
    // fetch moved after it, both have to turn this red — otherwise the ordering above is prose the
    // gate never measures.
    expect(fetchCalls).toBe(1)
    // Zero handler calls is structural in this build (the shipped table above is empty, so there is
    // nothing to call); the populated-table counter-case is the next test. Nothing is written to the
    // connection store either — refusing costs the user no persisted state.
    expect(calls).toEqual({ begin: 0, status: 0, disconnect: [] })
    expect(readAlphaConnectionRecordsV1(scope)).toEqual({ ok: true, records: [] })
  })

  /**
   * The counter-case. Without it "update-required" could be coming from anywhere in the evaluator
   * and the allowlist would be doing nothing.
   */
  test("a registered handler makes the same package compatible with a connection prerequisite", async () => {
    const { envelope, bytes } = fixture()
    const { table } = fakeHandler({ begin: 0, status: 0, disconnect: [] })
    const view = await evaluatePackageForHost(envelope, {
      fetchPayload: async () => bytes,
      connectionHandlers: table,
    })
    expect(view.verdict).toBe("compatible")
    expect(view.action.reasonCode).toBe("package-prerequisite-required")
    expect(view.prerequisites).toEqual({
      status: "required-action",
      items: [{ prerequisiteId: PREREQUISITE_ID, label: "Example account", required: true }],
    })
  })

  test("admission refuses an unknown handler package with zero transaction calls", async () => {
    const { envelope, bytes } = fixture()
    let transactionCalls = 0
    const admit = admissionCoordinator({ envelope, bytes, onTransaction: () => transactionCalls++ })
    expect(
      await admit({ catalogId: CATALOG_ID, scope: { scope: "global" }, attemptId: "attempt-unknown" }),
    ).toMatchObject({ ok: false, reason: "package-host-update-required" })
    expect(transactionCalls).toBe(0)
  })
})

describe("handler results are untrusted input", () => {
  test("a clean bounded result decodes", () => {
    expect(decodeAlphaConnectionResultV1(readyResult())).toEqual({
      ok: true,
      result: { serviceIdentity: { serviceId: "example", accountLabel: "user@example.com" }, reuseKey: "acct-primary" },
    })
  })

  /**
   * The negative fixtures are *plausible* handler outputs, not degenerate ones: every one of them
   * is a shape a real connector author would write by accident, which is the only kind of negative
   * that proves the allowlist is doing work.
   */
  test.each([
    ["a top-level access token", { ...readyResult(), accessToken: TOKEN_CANARY }],
    ["a refresh token", { ...readyResult(), refreshToken: TOKEN_CANARY }],
    ["a token digest", { ...readyResult(), tokenSha256: createHash("sha256").update(TOKEN_CANARY).digest("hex") }],
    [
      "a credential smuggled into the identity",
      { ...readyResult(), serviceIdentity: { serviceId: "example", accountLabel: "u@e.com", apiKey: TOKEN_CANARY } },
    ],
    ["a missing reuse key", { serviceIdentity: { serviceId: "example", accountLabel: "u@e.com" } }],
    ["an uppercase service id", { ...readyResult(), serviceIdentity: { serviceId: "Example", accountLabel: "u" } }],
    ["a control character in the label", { ...readyResult(), serviceIdentity: { serviceId: "example", accountLabel: "u\u0000e" } }],
    ["a reuse key with a path separator", { ...readyResult("../../escape") }],
    ["a non-ISO expiry", { ...readyResult(), expiresAt: "tomorrow" }],
  ])("%s is refused", (_name, value) => {
    const decoded = decodeAlphaConnectionResultV1(value)
    expect(decoded.ok).toBe(false)
    expect(JSON.stringify(decoded)).not.toContain(TOKEN_CANARY)
  })

  test("a handler that returns a token gets nothing written to the store", async () => {
    const { envelope, bytes } = fixture()
    const calls: HandlerCalls = { begin: 0, status: 0, disconnect: [] }
    const { table } = fakeHandler(calls, {
      statuses: [{ ok: true, state: "ready", result: { ...readyResult(), accessToken: TOKEN_CANARY } }],
    })
    const coordinator = createAlphaConnectionCoordinator({
      loadVerifiedCatalog: async () => ({
        source: "remote",
        catalog: { version: "1", entries: [{}], packages: [envelope] },
        snapshotDigest,
      }),
      scope: () => scope,
      handlers: table,
      installability: { fetchPayload: async () => bytes },
    })
    const begun = await coordinator.begin({ catalogId: CATALOG_ID, prerequisiteId: PREREQUISITE_ID })
    if (!begun.ok) throw new Error(begun.reason)
    const status = await coordinator.status({ attemptId: begun.attemptId })
    expect(status).toMatchObject({ ok: false, reasonCode: "connection-result-invalid" })
    expect(readAlphaConnectionRecordsV1(scope)).toEqual({ ok: true, records: [] })
  })
})

describe("attempt lifecycle", () => {
  function coordinatorFor(table: AlphaConnectionHandlerTableV1, envelope: AlphaPackageEnvelopeV1, bytes: Uint8Array) {
    return createAlphaConnectionCoordinator({
      loadVerifiedCatalog: async () => ({
        source: "remote",
        catalog: { version: "1", entries: [{}], packages: [envelope] },
        snapshotDigest,
      }),
      scope: () => scope,
      handlers: table,
      installability: { fetchPayload: async () => bytes },
    })
  }

  test("a completed attempt mints one record and cannot be replayed", async () => {
    const { envelope, bytes } = fixture()
    const calls: HandlerCalls = { begin: 0, status: 0, disconnect: [] }
    const { table } = fakeHandler(calls, {
      statuses: [{ ok: true, state: "pending" }, { ok: true, state: "ready", result: readyResult() }],
    })
    const coordinator = coordinatorFor(table, envelope, bytes)
    const begun = await coordinator.begin({ catalogId: CATALOG_ID, prerequisiteId: PREREQUISITE_ID })
    if (!begun.ok) throw new Error(begun.reason)
    expect(await coordinator.status({ attemptId: begun.attemptId })).toEqual({ ok: true, state: "pending" })
    const ready = await coordinator.status({ attemptId: begun.attemptId })
    expect(ready).toMatchObject({ ok: true, state: "ready", serviceId: "example", reused: false })
    expect(await coordinator.status({ attemptId: begun.attemptId })).toMatchObject({
      ok: false,
      reasonCode: "connection-attempt-stale",
    })
    const stored = readAlphaConnectionRecordsV1(scope)
    expect(stored.ok && stored.records).toHaveLength(1)
  })

  test.each([
    ["an attempt id that was never issued", "a-" + "0".repeat(32)],
    ["a well-formed but foreign attempt id", "a-" + "f".repeat(32)],
  ])("status on %s is stale and writes nothing", async (_name, attemptId) => {
    const { envelope, bytes } = fixture()
    const { table } = fakeHandler({ begin: 0, status: 0, disconnect: [] })
    const coordinator = coordinatorFor(table, envelope, bytes)
    expect(await coordinator.status({ attemptId })).toMatchObject({
      ok: false,
      reasonCode: "connection-attempt-stale",
    })
    expect(readAlphaConnectionRecordsV1(scope)).toEqual({ ok: true, records: [] })
  })

  test.each([
    ["cancel", { ok: false, reasonCode: "connection-cancelled" } as AlphaConnectionStatusV1, "connection-cancelled"],
    ["handler error", { ok: false, reasonCode: "connection-handler-error" } as AlphaConnectionStatusV1, "connection-handler-error"],
  ])("%s ends the attempt with zero writes and needs a fresh attempt", async (_name, reported, reasonCode) => {
    const { envelope, bytes } = fixture()
    const calls: HandlerCalls = { begin: 0, status: 0, disconnect: [] }
    const { table } = fakeHandler(calls, { statuses: [reported] })
    const coordinator = coordinatorFor(table, envelope, bytes)
    const begun = await coordinator.begin({ catalogId: CATALOG_ID, prerequisiteId: PREREQUISITE_ID })
    if (!begun.ok) throw new Error(begun.reason)
    expect(await coordinator.status({ attemptId: begun.attemptId })).toMatchObject({ ok: false, reasonCode })
    expect(await coordinator.status({ attemptId: begun.attemptId })).toMatchObject({
      ok: false,
      reasonCode: "connection-attempt-stale",
    })
    expect(readAlphaConnectionRecordsV1(scope)).toEqual({ ok: true, records: [] })
  })

  test("a handler that throws is a handler error, not an exception", async () => {
    const { envelope, bytes } = fixture()
    const handler: AlphaConnectionHandlerV1 = {
      handlerId: HANDLER_ID,
      displayName: "Throwing connector",
      begin: async () => {
        throw new Error("network down")
      },
      status: async () => ({ ok: true, state: "pending" }),
      disconnect: async () => ({ ok: true }),
    }
    const coordinator = coordinatorFor(Object.freeze({ [HANDLER_ID]: handler }), envelope, bytes)
    expect(await coordinator.begin({ catalogId: CATALOG_ID, prerequisiteId: PREREQUISITE_ID })).toMatchObject({
      ok: false,
      reasonCode: "connection-handler-error",
    })
  })

  test.each([
    ["a non-https browser URL", "http://mcp.example.com/connect"],
    ["a credential-bearing browser URL", "https://user:pass@mcp.example.com/connect"],
    ["a javascript URL", "javascript:alert(1)"],
  ])("begin refuses %s", async (_name, browserUrl) => {
    const { envelope, bytes } = fixture()
    const { table } = fakeHandler({ begin: 0, status: 0, disconnect: [] }, { browserUrl })
    const coordinator = coordinatorFor(table, envelope, bytes)
    expect(await coordinator.begin({ catalogId: CATALOG_ID, prerequisiteId: PREREQUISITE_ID })).toMatchObject({
      ok: false,
      reasonCode: "connection-handler-error",
    })
  })
})

describe("reuse key decides identity, the renderer never does", () => {
  function coordinatorFor(table: AlphaConnectionHandlerTableV1, envelope: AlphaPackageEnvelopeV1, bytes: Uint8Array) {
    return createAlphaConnectionCoordinator({
      loadVerifiedCatalog: async () => ({
        source: "remote",
        catalog: { version: "1", entries: [{}], packages: [envelope] },
        snapshotDigest,
      }),
      scope: () => scope,
      handlers: table,
      installability: { fetchPayload: async () => bytes },
    })
  }

  test("the same reuse key reuses the connection id instead of minting a second record", async () => {
    const { envelope, bytes } = fixture()
    const { table } = fakeHandler(
      { begin: 0, status: 0, disconnect: [] },
      {
        statuses: [
          { ok: true, state: "ready", result: readyResult() },
          { ok: true, state: "ready", result: { ...readyResult(), expiresAt: "2027-01-01T00:00:00.000Z" } },
        ],
      },
    )
    const coordinator = coordinatorFor(table, envelope, bytes)
    const first = await coordinator.begin({ catalogId: CATALOG_ID, prerequisiteId: PREREQUISITE_ID })
    if (!first.ok) throw new Error(first.reason)
    const firstReady = await coordinator.status({ attemptId: first.attemptId })
    const second = await coordinator.begin({ catalogId: CATALOG_ID, prerequisiteId: PREREQUISITE_ID })
    if (!second.ok) throw new Error(second.reason)
    const secondReady = await coordinator.status({ attemptId: second.attemptId })

    if (!firstReady.ok || firstReady.state !== "ready") throw new Error("first attempt did not complete")
    if (!secondReady.ok || secondReady.state !== "ready") throw new Error("second attempt did not complete")
    expect(secondReady.connectionId).toBe(firstReady.connectionId)
    expect(secondReady.reused).toBe(true)
    const stored = readAlphaConnectionRecordsV1(scope)
    expect(stored.ok && stored.records).toHaveLength(1)
  })

  test("a second live identity for the same handler is a conflict, not a silent second record", async () => {
    const { envelope, bytes } = fixture()
    const { table } = fakeHandler(
      { begin: 0, status: 0, disconnect: [] },
      { statuses: [{ ok: true, state: "ready", result: readyResult("acct-secondary") }] },
    )
    seedConnection()
    const coordinator = coordinatorFor(table, envelope, bytes)
    const begun = await coordinator.begin({ catalogId: CATALOG_ID, prerequisiteId: PREREQUISITE_ID })
    if (!begun.ok) throw new Error(begun.reason)
    expect(await coordinator.status({ attemptId: begun.attemptId })).toMatchObject({
      ok: false,
      reasonCode: "connection-reuse-conflict",
    })
    const stored = readAlphaConnectionRecordsV1(scope)
    expect(stored.ok && stored.records.map((record) => record.reuseKey)).toEqual(["acct-primary"])
  })

  /**
   * The renderer's vocabulary is two keys wide. Naming a service, a reuse key or a connection id is
   * not "rejected input" — there is no field to put it in.
   */
  test.each([
    ["connectionId", { catalogId: CATALOG_ID, prerequisiteId: PREREQUISITE_ID, connectionId: `c-${"b".repeat(32)}` }],
    ["reuseKey", { catalogId: CATALOG_ID, prerequisiteId: PREREQUISITE_ID, reuseKey: "attacker" }],
    ["serviceIdentity", { catalogId: CATALOG_ID, prerequisiteId: PREREQUISITE_ID, serviceIdentity: { serviceId: "x" } }],
    ["handlerId", { catalogId: CATALOG_ID, prerequisiteId: PREREQUISITE_ID, handlerId: HANDLER_ID }],
  ])("begin refuses a renderer-supplied %s", async (_name, intent) => {
    const { envelope, bytes } = fixture()
    const calls: HandlerCalls = { begin: 0, status: 0, disconnect: [] }
    const { table } = fakeHandler(calls)
    const coordinator = coordinatorFor(table, envelope, bytes)
    const result = await coordinator.begin(intent)
    expect(result).toMatchObject({ ok: false, reasonCode: "connection-profile-invalid" })
    expect(calls.begin).toBe(0)
  })

  test("begin refuses a prerequisiteId the signed package does not declare", async () => {
    const { envelope, bytes } = fixture()
    const calls: HandlerCalls = { begin: 0, status: 0, disconnect: [] }
    const { table } = fakeHandler(calls)
    const coordinator = coordinatorFor(table, envelope, bytes)
    expect(
      await coordinator.begin({ catalogId: CATALOG_ID, prerequisiteId: `${COMPONENT_ID}#invented` }),
    ).toMatchObject({ ok: false, reasonCode: "connection-profile-invalid" })
    expect(calls.begin).toBe(0)
  })
})

describe("admission binds a connection id and nothing else", () => {
  async function install(options: {
    required?: boolean
    seeded?: boolean
    attemptId: string
  }) {
    const { envelope, bytes } = fixture({ required: options.required })
    const { table } = fakeHandler({ begin: 0, status: 0, disconnect: [] })
    if (options.seeded) seedConnection()
    let transactionCalls = 0
    const admit = admissionCoordinator({
      envelope,
      bytes,
      handlers: table,
      onTransaction: () => transactionCalls++,
    })
    const preview = await admit({ catalogId: CATALOG_ID, scope: { scope: "global" }, attemptId: options.attemptId })
    if (preview.ok || preview.stage !== "authorize") throw new Error(`expected preview: ${JSON.stringify(preview)}`)
    const outcome = await admit({
      catalogId: CATALOG_ID,
      scope: { scope: "global" },
      attemptId: options.attemptId,
      authorization: confirmation(preview),
    })
    return { outcome, transactionCalls }
  }

  test("a required connection that is not ready stops the install with zero transaction calls", async () => {
    const { outcome, transactionCalls } = await install({ attemptId: "attempt-required-missing" })
    expect(outcome).toMatchObject({ ok: false, reason: "package admission: connection-required" })
    expect(transactionCalls).toBe(0)
  })

  test("a ready connection lets the install through and records the binding", async () => {
    const { outcome, transactionCalls } = await install({ seeded: true, attemptId: "attempt-required-ready" })
    expect(outcome).toMatchObject({ ok: true, kind: "mcp", name: "connected-remote" })
    expect(outcome).not.toHaveProperty("connectionUnavailable")
    expect(transactionCalls).toBe(1)
    const stored = readAlphaConnectionRecordsV1(scope)
    expect(stored.ok && stored.records[0]?.packageBindings).toEqual([COMPONENT_ID])
  })

  /**
   * `installedDisabled` is true for *every* catalog install under the current activation policy, so
   * it cannot be the signal here — reading it would be a gate that passes whether or not this code
   * runs at all. `connectionUnavailable` is the distinguishing fact, and it exists precisely so the
   * user can be told "connect an account" instead of "turn it on".
   */
  test("an optional connection that is not ready installs unavailable rather than refusing", async () => {
    const { outcome, transactionCalls } = await install({ required: false, attemptId: "attempt-optional-missing" })
    expect(outcome).toMatchObject({ ok: true, kind: "mcp", connectionUnavailable: true })
    expect(transactionCalls).toBe(1)
    expect(readAlphaConnectionRecordsV1(scope)).toEqual({ ok: true, records: [] })
  })

  /**
   * And the desired state really is forced, not merely coincident with the default. Seeding a prior
   * `enabled` record makes `nextDesiredState` return `enabled`, so the only thing that can turn the
   * install off is the optional-connection branch: delete it and this goes green as `enabled`.
   */
  test("an unavailable optional connection lands disabled even when policy would enable it", async () => {
    const seeded = upsertRecordV2(root, {
      id: COMPONENT_ID,
      name: "connected-remote",
      kind: "mcp",
      environment: "dev",
      scope: { kind: "global" },
      version: "0.9.0",
      manifestDigest: `sha256:${"1".repeat(64)}`,
      payloadDigest: `sha256:${"2".repeat(64)}`,
      grantDigest: `sha256:${"3".repeat(64)}`,
      desiredState: "enabled",
      origin: "catalog",
      installedAt: "2026-07-30T00:00:00.000Z",
    })
    if (!seeded.ok) throw new Error(seeded.reason)

    const { outcome } = await install({ required: false, attemptId: "attempt-optional-prior-enabled" })
    expect(outcome).toMatchObject({ ok: true, kind: "mcp", installedDisabled: true, connectionUnavailable: true })

    const config = readFileSync(join(root, "alpha.jsonc"), "utf8")
    expect(JSON.parse(config).mcp["connected-remote"].enabled).toBe(false)
  })

  test.each([
    ["disconnected", { state: "disconnected" as const }, "connection-record-disconnected"],
    ["expired", { expiresAt: "2020-01-01T00:00:00.000Z" }, "connection-record-expired"],
  ])("a %s record blocks a required connection with a named reason", async (_name, overrides, reasonCode) => {
    const { envelope, bytes } = fixture()
    const { table } = fakeHandler({ begin: 0, status: 0, disconnect: [] })
    seedConnection(overrides)
    let transactionCalls = 0
    const admit = admissionCoordinator({ envelope, bytes, handlers: table, onTransaction: () => transactionCalls++ })
    const preview = await admit({ catalogId: CATALOG_ID, scope: { scope: "global" }, attemptId: "attempt-degraded" })
    if (preview.ok || preview.stage !== "authorize") throw new Error("expected preview")
    expect(
      await admit({
        catalogId: CATALOG_ID,
        scope: { scope: "global" },
        attemptId: "attempt-degraded",
        authorization: confirmation(preview),
      }),
    ).toMatchObject({ ok: false, reason: `package admission: ${reasonCode}` })
    expect(transactionCalls).toBe(0)
  })

  test("the renderer cannot name a connection in the admission intent", async () => {
    const { envelope, bytes } = fixture()
    const { table } = fakeHandler({ begin: 0, status: 0, disconnect: [] })
    seedConnection()
    let transactionCalls = 0
    const admit = admissionCoordinator({ envelope, bytes, handlers: table, onTransaction: () => transactionCalls++ })
    for (const key of ["connectionId", "reuseKey", "serviceIdentity"])
      expect(
        await admit({
          catalogId: CATALOG_ID,
          scope: { scope: "global" },
          attemptId: `attempt-${key}`,
          [key]: "attacker-supplied",
        }),
      ).toMatchObject({ ok: false, reason: expect.stringContaining("renderer-supplied key") })
    expect(transactionCalls).toBe(0)
  })

  /**
   * The receipt is the durable package-side record. It may say which connection was used; it may
   * not carry anything the connection knows about the user's account.
   */
  test("the install ledger record carries no connection identity or credential", async () => {
    await install({ seeded: true, attemptId: "attempt-receipt" })
    const ledger = readFileSync(join(root, "installs.json"), "utf8")
    for (const forbidden of ["acct-primary", "user@example.com", TOKEN_CANARY, "accessToken"])
      expect(ledger).not.toContain(forbidden)
  })
})

describe("a connection outlives the packages bound to it", () => {
  /**
   * The independence guard. The tempting home for this store is beside the ledger, and everything
   * under the extension root is owned by install/uninstall transactions — a record there is not
   * stored badly, it is scheduled for deletion. Deleting the guard makes both halves of this go
   * green with the store sitting exactly where an uninstall would wipe it.
   */
  test("the store refuses to live inside the extension root", () => {
    const captured: AlphaConnectionStoreScope = { userDataPath: join(root, "state"), extensionRoot: root }
    expect(assertAlphaConnectionStoreIndependenceV1(captured).ok).toBe(false)
    expect(upsertAlphaConnectionRecordV1(captured, seedConnection()).ok).toBe(false)
    expect(readAlphaConnectionRecordsV1(captured).ok).toBe(false)
    expect(assertAlphaConnectionStoreIndependenceV1(scope)).toEqual({ ok: true })
  })

  test("the production store path is outside the extension root", () => {
    expect(alphaConnectionStorePath(userData).startsWith(root)).toBe(false)
    expect(alphaConnectionStorePath(userData)).toBe(join(userData, "alpha-connections", "records.json"))
  })

  /**
   * The shared boundary. Two packages hold the same connection; one is uninstalled. Releasing the
   * binding is all that may happen — the record stays `ready`, the other binding survives, and the
   * handler's `disconnect` is never reached. Turning "no bindings left" into a delete makes the
   * second half of this red.
   */
  test("releasing one package's binding leaves the connection ready for the other", async () => {
    const record = seedConnection()
    const calls: HandlerCalls = { begin: 0, status: 0, disconnect: [] }
    fakeHandler(calls)
    expect(bindAlphaConnectionPackageV1(scope, record.connectionId, COMPONENT_ID, "2026-07-31T01:00:00.000Z").ok).toBe(true)
    expect(bindAlphaConnectionPackageV1(scope, record.connectionId, "mcp:other-remote", "2026-07-31T01:00:00.000Z").ok).toBe(true)

    expect(releaseAlphaConnectionBindingsV1(scope, COMPONENT_ID, "2026-07-31T02:00:00.000Z")).toEqual({ ok: true })
    const afterOne = readAlphaConnectionRecordsV1(scope)
    expect(afterOne.ok && afterOne.records).toHaveLength(1)
    expect(afterOne.ok && afterOne.records[0]).toMatchObject({
      connectionId: record.connectionId,
      state: "ready",
      packageBindings: ["mcp:other-remote"],
    })

    expect(releaseAlphaConnectionBindingsV1(scope, "mcp:other-remote", "2026-07-31T03:00:00.000Z")).toEqual({ ok: true })
    const afterAll = readAlphaConnectionRecordsV1(scope)
    expect(afterAll.ok && afterAll.records).toHaveLength(1)
    expect(afterAll.ok && afterAll.records[0]).toMatchObject({ state: "ready", packageBindings: [] })
    expect(calls.disconnect).toEqual([])
  })

  test("an unrelated component id releases nothing", () => {
    const record = seedConnection()
    bindAlphaConnectionPackageV1(scope, record.connectionId, COMPONENT_ID, "2026-07-31T01:00:00.000Z")
    expect(releaseAlphaConnectionBindingsV1(scope, "mcp:not-installed", "2026-07-31T02:00:00.000Z")).toEqual({ ok: true })
    const stored = readAlphaConnectionRecordsV1(scope)
    expect(stored.ok && stored.records[0]?.packageBindings).toEqual([COMPONENT_ID])
  })

  /** Disconnect is the only deletion path, and it is allowed while packages are still bound. */
  test("explicit disconnect calls the handler and removes the record even with live bindings", async () => {
    const { envelope, bytes } = fixture()
    const record = seedConnection()
    bindAlphaConnectionPackageV1(scope, record.connectionId, COMPONENT_ID, "2026-07-31T01:00:00.000Z")
    const calls: HandlerCalls = { begin: 0, status: 0, disconnect: [] }
    const { table } = fakeHandler(calls)
    const coordinator = createAlphaConnectionCoordinator({
      loadVerifiedCatalog: async () => ({
        source: "remote",
        catalog: { version: "1", entries: [{}], packages: [envelope] },
        snapshotDigest,
      }),
      scope: () => scope,
      handlers: table,
      installability: { fetchPayload: async () => bytes },
    })
    expect(await coordinator.disconnect({ connectionId: record.connectionId })).toEqual({
      ok: true,
      disconnected: true,
    })
    expect(calls.disconnect).toEqual([record.connectionId])
    expect(readAlphaConnectionRecordsV1(scope)).toEqual({ ok: true, records: [] })
  })

  test("a corrupt store is an error, never an empty connection list", () => {
    seedConnection()
    const raw = JSON.parse(readFileSync(alphaConnectionStorePath(userData), "utf8")) as {
      records: Array<Record<string, unknown>>
    }
    raw.records[0]!.accessToken = TOKEN_CANARY
    Bun.write(alphaConnectionStorePath(userData), JSON.stringify(raw))
    const read = readAlphaConnectionRecordsV1(scope)
    expect(read.ok).toBe(false)
    expect(read.ok === false && read.reason).toContain("unknown key")
  })
})
