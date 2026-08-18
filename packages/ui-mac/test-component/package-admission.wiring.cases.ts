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
import { computeInstalledGraphDigest, type PackageGraphV1 } from "../src/main/ext-package-ledger-v3"

type IpcHandler = (event: { sender: { id: number } }, ...args: unknown[]) => unknown

const handlers = new Map<string, IpcHandler>()
const tmp = mkdtempSync(join(tmpdir(), "package-admission-ipc-"))
const userData = join(tmp, "user-data")
const payload = {
  schema: "alpha.host-extension-package.payload.mcp-remote.v1",
  behavior: {
    url: "https://mcp.example.com/",
    headersTemplate: { Authorization: "Bearer {A_KEY}" },
    requiredSecrets: ["A_KEY"],
    auth: "none",
  },
} as unknown as PackageProfilePayloadV1
const payloadBytes = new TextEncoder().encode(`${JSON.stringify(payload, null, 2)}\n`)
// 宿主自持的 v2 信封,沿用 producer 语料的身份。vendored producer 产物本身没有 `root`,
// 在 v2 合同下应当被拒 —— 那道过渡闸在 package-installability{,.wiring}.test.ts,不在这里重述。
const envelope = {
  schema: "alpha.host-extension-package.v1",
  prelude: { packageId: "package:generic-remote-mcp", version: "1.0.0" },
  presentation: {
    displayName: "Generic Remote MCP",
    description: "Generic Phase 1 compiler corpus input.",
  },
  root: "mcp:generic-remote",
  components: [
    {
      id: "mcp:generic-remote",
      required: true,
      dependencies: [],
      profileId: "mcp-remote",
      profileVersion: 1,
      capabilities: ["alpha.secret-prerequisite.v1"],
      payloadRef: {
        sha256: createHash("sha256").update(payloadBytes).digest("hex"),
        bytes: payloadBytes.byteLength,
        mediaType: "application/vnd.alpha.host-extension-package.mcp-remote.v1+json",
        url: "https://alphacodeone.com/catalog/assets/mcp.generic-remote/1.0.0/alpha-package/payload.json",
      },
    },
  ],
  capabilities: ["alpha.secret-prerequisite.v1"],
} as unknown as AlphaPackageEnvelopeV1
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
  probeProjectMcpActivation: async () => "unverifiable" as const,
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
    "graphDigest",
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
        included: true,
        componentId: "mcp:generic-remote",
        role: "root",
        required: true,
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

  // REQ-128 `#706`:**生产接线** —— 真 IPC + 真事务提交后,账本必须是 V3 信封,且带着这个
  // package 的图与 claim。没有这一段,把 `package-admission` 里挂 `packageMutation` 的那行删掉
  // 之后一切照绿(`commitTransactionLedger` 会静默走回 V2 的 upsert 分支)—— 那正是「闸门没测
  // 生产接线」的形状。判据:删掉那行生产调用,下面五条一起红。
  const ledger = JSON.parse(readFileSync(join(root, "installs.json"), "utf8")) as {
    v: number
    records: Array<{ kind: string; name: string; manifestDigest: string }>
    packageGraphs: PackageGraphV1[]
    claims: Array<{ kind: string; name: string; owners: string[] }>
  }
  const childRecord = ledger.records.find((r) => r.kind === "mcp" && r.name === "generic-remote")
  if (!childRecord) throw new Error("expected an InstallRecordV2 for mcp:generic-remote")
  const itemDigest = `sha256:${preview.packageAuthorization.binding.itemDigests["mcp:generic-remote"]}`
  expect(ledger.v).toBe(3)
  expect(ledger.packageGraphs).toEqual([
    {
      packageId: envelope.prelude.packageId,
      envelopeDigest: `sha256:${preview.packageAuthorization.binding.envelopeDigest}`,
      installedGraphDigest: ledger.packageGraphs[0]!.installedGraphDigest,
      root: {
        componentId: envelope.components[0].id,
        kind: "mcp",
        name: "generic-remote",
        required: true,
        manifestDigest: itemDigest,
      },
      children: [],
    },
  ])
  // installedGraphDigest 不是自由字符串:重算必须逐字相同(账本被改一个字节就解不开)。
  expect(computeInstalledGraphDigest(ledger.packageGraphs[0]!)).toBe(ledger.packageGraphs[0]!.installedGraphDigest)
  expect(childRecord.manifestDigest).toBe(itemDigest)

  // `#758`:同一次安装里有**两个**图摘要,名字不同、值也不同 —— 这条断言存在的唯一目的,
  // 是让「它们应该相等吗」这个问题以后不必再被提出一次。答案是不,而且结构上做不到相等:
  //   · `binding.graphDigest`(授权侧,`shared/package-admission.ts`)—— 安装**前**对信封声明的
  //     计划安装图,输入是 componentId/required/profileId/profileVersion/payloadSha256,裸 hex;
  //   · `installedGraphDigest`(账本侧,`main/ext-package-ledger-v3.ts`)—— 安装**后**对已装图,
  //     输入是 packageId/envelopeDigest 与逐节点 componentId/kind/name/required/manifestDigest,
  //     带 `sha256:` 前缀。
  // 落盘键名单独断言:改名一旦被回退,下面第一条就红(值断言本身不足以杀掉回退 —— 回退后
  // 读到的是 undefined,而 undefined 与任何 hex 也「不相等」)。
  const installedGraph = ledger.packageGraphs[0]!
  expect(Object.keys(installedGraph).sort()).toEqual([
    "children",
    "envelopeDigest",
    "installedGraphDigest",
    "packageId",
    "root",
  ])
  expect(installedGraph.installedGraphDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
  expect(preview.packageAuthorization.binding.graphDigest).toMatch(/^[0-9a-f]{64}$/)
  expect(installedGraph.installedGraphDigest).not.toBe(preview.packageAuthorization.binding.graphDigest)
  // 去掉前缀也仍然不同 —— 差别不是字面格式,是两者覆盖的事实不同。
  expect(installedGraph.installedGraphDigest.slice("sha256:".length)).not.toBe(
    preview.packageAuthorization.binding.graphDigest,
  )
  expect(ledger.claims).toEqual([
    { kind: "mcp", name: "generic-remote", owners: [`bundle:${envelope.prelude.packageId}@${itemDigest}`] },
  ])
  const journals = readdirSync(join(root, "ext-tx", "journal"))
  expect(journals).toHaveLength(1)
  expect(JSON.parse(readFileSync(join(root, "ext-tx", "journal", journals[0]!), "utf8")).state).toBe("committed")
})
