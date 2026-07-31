import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, expect, mock, test } from "bun:test"
import type {
  AlphaPackageEnvelopeV1,
  PackageProfilePayloadV1,
} from "../src/shared/host-extension-package-contract/decoder"
import type { PackageAdmissionPreviewV1 } from "../src/shared/package-admission"

type IpcHandler = (event: { sender: { id: number } }, ...args: unknown[]) => unknown

const handlers = new Map<string, IpcHandler>()
const tmp = mkdtempSync(join(tmpdir(), "package-admission-ipc-"))
const userData = join(tmp, "user-data")
const corpus = (await Bun.file(
  resolve(
    import.meta.dir,
    "../../alpha-contracts-consumer/vendor/alpha-web-extension-package/expected.mcp-remote.compiled.json",
  ),
).json()) as {
  envelope: AlphaPackageEnvelopeV1
  payload: PackageProfilePayloadV1
}
const envelope = structuredClone(corpus.envelope)
const payload = structuredClone(corpus.payload)
if (payload.schema !== "alpha.host-extension-package.payload.mcp-remote.v1")
  throw new Error("producer corpus profile drifted")
payload.behavior.requiredSecrets = ["A_KEY"]
payload.behavior.headersTemplate = { Authorization: "Bearer {A_KEY}" }
const payloadBytes = new TextEncoder().encode(`${JSON.stringify(payload, null, 2)}\n`)
envelope.components[0].payloadRef.bytes = payloadBytes.byteLength
envelope.components[0].payloadRef.sha256 = createHash("sha256").update(payloadBytes).digest("hex")
const snapshotDigest = "6".repeat(64)
const secretCanary = "REQ128_IPC_SECRET_64c3b7"
let payloadFetches = 0

mock.module("electron", () => ({
  BrowserWindow: class {
    static fromWebContents() {
      return undefined
    }
  },
  dialog: {
    showMessageBox: async () => ({ response: 1, checkboxChecked: false }),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  },
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => handlers.set(channel, handler),
  },
}))

mock.module("../src/main/ipc", () => ({
  pickedFiles: {
    read: async () => {
      throw new Error("unexpected picked-file read")
    },
  },
}))

mock.module("../src/main/logging", () => ({
  getLogger: () => ({
    error: () => {},
    log: () => {},
    warn: () => {},
  }),
}))

mock.module("../src/main/ext-advisory-gate", () => ({
  listAdvisoryBlockedFacts: () => ({ ids: [], fresh: true }),
  makeAdvisoryGate: () => () => ({ allowed: true }),
}))

mock.module("../src/main/remote-catalog", () => ({
  downloadRemoteAsset: async () => ({ ok: false, reason: "unexpected remote asset download" }),
  readCachedCatalog: () => null,
  registerPackageCatalogReadIpcHandlers: (
    register: (channel: string, handler: IpcHandler) => void,
    refresh: () => Promise<unknown>,
  ) => {
    register("ext-remote-catalog", () => refresh())
    register("ext-package-detail", () => null)
  },
  refreshRemoteCatalog: async () => ({
    source: "remote",
    catalog: { version: "2026-07-31", entries: [{}], packages: [envelope] },
    version: "2026-07-31",
    fetchedAt: "2026-07-31T00:00:00.000Z",
    via: "channel-dev",
    channel: "dev",
    snapshotDigest,
  }),
}))

mock.module("../src/main/ext-mcp-activation", () => ({
  reloadInstalledMcp: async (name: string) => ({
    reference: name,
    status: "connected",
  }),
}))

const originalFetch = globalThis.fetch
globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
  payloadFetches++
  expect(init?.redirect).toBe("error")
  if (payloadFetches === 2) expect(existsSync(join(userData, "alpha-mcp-secrets"))).toBe(false)
  return new Response(payloadBytes, { status: 200 })
}) as typeof fetch

const { initAlphaEnvironment, getAlphaEnvironment } = await import("../src/main/alpha-environment")
const { registerExtIpcHandlers } = await import("../src/main/ext-ipc")

delete process.env.ALPHA_GLOBAL_DIR
initAlphaEnvironment({
  isPackaged: false,
  channel: "dev",
  appDataDir: tmp,
  baseRoot: join(tmp, "alpha-code-state"),
  homeDir: join(tmp, "home"),
})
registerExtIpcHandlers(
  userData,
  "dev",
  async () => ({
    url: "http://127.0.0.1:39117",
    username: "opencode",
    password: "route-password",
  }),
  join(tmp, "home"),
)

afterAll(() => {
  globalThis.fetch = originalFetch
  rmSync(tmp, { recursive: true, force: true })
})

test("real ext-install-catalog IPC binds preview, revalidates, then commits through the real transaction", async () => {
  const install = handlers.get("ext-install-catalog")
  if (!install) throw new Error("ext-install-catalog handler was not registered")
  const intent = {
    catalogId: envelope.prelude.packageId,
    scope: { scope: "global" },
    attemptId: "ipc-attempt-1",
  }
  const first = await install({ sender: { id: 1 } }, intent)
  if (
    !first ||
    typeof first !== "object" ||
    (first as { ok?: unknown }).ok !== false ||
    (first as { stage?: unknown }).stage !== "authorize"
  )
    throw new Error(`expected package authorization preview, got ${JSON.stringify(first)}`)
  const preview = first as {
    authorization: Array<{ key: string; requested: string[] }>
    packageAuthorization: PackageAdmissionPreviewV1
  }
  expect(Object.keys(preview.packageAuthorization.binding).sort()).toEqual([
    "capabilityDigest",
    "envelopeDigest",
    "itemDigests",
    "snapshotDigest",
  ])
  expect(preview.packageAuthorization.binding.snapshotDigest).toBe(snapshotDigest)
  expect(preview.packageAuthorization.plan).toEqual({
    packageId: envelope.prelude.packageId,
    version: envelope.prelude.version,
    scope: { scope: "global" },
    items: [
      {
        componentId: "mcp:generic-remote",
        key: "mcp--generic-remote",
        kind: "mcp",
        name: "generic-remote",
        manifestDigest: `sha256:${preview.packageAuthorization.binding.itemDigests["mcp:generic-remote"]}`,
        payloadDigest: `sha256:${envelope.components[0].payloadRef.sha256}`,
        capabilities: ["alpha.secret-prerequisite.v1"],
        prerequisites: [
          {
            prerequisiteId: "mcp:generic-remote#A_KEY",
            label: "A_KEY",
            required: true,
          },
        ],
        operations: ["write-secret-version", "update-config", "write-install-record", "write-capability-grant"],
      },
    ],
  })
  expect(JSON.stringify(preview.packageAuthorization.plan)).not.toContain(secretCanary)
  expect(payloadFetches).toBe(1)
  expect(existsSync(join(userData, "alpha-mcp-secrets"))).toBe(false)

  const result = await install(
    { sender: { id: 1 } },
    {
      ...intent,
      grants: { secrets: { "mcp:generic-remote#A_KEY": secretCanary } },
      authorization: {
        confirmed: Object.fromEntries(preview.authorization.map((item) => [item.key, item.requested])),
        binding: preview.packageAuthorization.binding,
      },
    },
  )
  expect(result).toMatchObject({
    ok: true,
    kind: "mcp",
    name: "generic-remote",
    installedDisabled: true,
  })
  expect(JSON.stringify(result)).not.toContain(secretCanary)
  expect(payloadFetches).toBe(2)

  const serverDir = join(userData, "alpha-mcp-secrets", "generic-remote")
  const versions = readdirSync(serverDir)
  expect(versions).toHaveLength(1)
  const secretFile = join(serverDir, versions[0]!, "A_KEY")
  expect(readFileSync(secretFile, "utf8")).toBe(secretCanary)
  expect(statSync(secretFile).mode & 0o777).toBe(0o600)
  const root = getAlphaEnvironment().mutableRoot
  const config = readFileSync(join(root, "alpha.jsonc"), "utf8")
  expect(config).toContain(`{file:${secretFile}}`)
  expect(config).not.toContain(secretCanary)
  expect(existsSync(join(root, "installs.json"))).toBe(true)
  expect(existsSync(join(root, "ext-store", "mcp--generic-remote", "grants.json"))).toBe(true)
  const journals = readdirSync(join(root, "ext-tx", "journal"))
  expect(journals).toHaveLength(1)
  expect(JSON.parse(readFileSync(join(root, "ext-tx", "journal", journals[0]!), "utf8")).state).toBe("committed")
})
