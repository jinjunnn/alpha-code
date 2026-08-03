import { afterAll, expect, mock, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import bundledCatalog from "../src/renderer/extensions/alpha-catalog.json"
// `#777`:本文件跑的是生产 `ext-install-catalog` 全链,里面有 ADR-026 的平台闸
// (`platforms: ["darwin","win32"]`)。在 ubuntu runner 上不声明这一条,两条用例量到的是
// 「runner 不是发布平台」而不是「返回值不回显 canary」。必须在任何生产模块 import 之前调。
import { pinShippedPlatform } from "./pin-shipped-platform"

pinShippedPlatform()

type IpcHandler = (event: { sender: { id: number } }, ...args: unknown[]) => unknown

const handlers = new Map<string, IpcHandler>()
const root = mkdtempSync(join(tmpdir(), "ext-install-result-"))
const canary = "REQ128_IPC_CANARY_02c9f86a"
// 两条条目覆盖 `ext-ipc.ts` 的**两条**返回分支。R2 审计实测:只测 source="alpha" 那条
// 是不够的 —— shipped catalog 的 8 条 MCP 全是 official/community,`source:"alpha"` 一条都没有,
// 所以每一次真实首装走的都是 installedDisabled 那条提前返回。往那条分支塞明文,
// 只测另一条时整包 3269 全绿。
const entry = structuredClone(bundledCatalog.entries.find((item) => item.id === "mcp:github")!)
entry.source = "alpha"

// 未改 source:保持 catalog 里的真实形状(official)⇒ 落 installedDisabled 提前返回那条。
const disabledEntry = structuredClone(bundledCatalog.entries.find((item) => item.id === "mcp:github")!)
disabledEntry.id = "mcp:github-default-off"
disabledEntry.name = "github-default-off"

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
  downloadRemoteAsset: async () => ({
    ok: false,
    reason: "unexpected remote asset download",
  }),
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
    catalog: { version: bundledCatalog.version, entries: [entry, disabledEntry] },
    version: bundledCatalog.version,
    fetchedAt: "2026-07-30T00:00:00.000Z",
    via: "channel-dev",
    channel: "dev",
  }),
}))

mock.module("../src/main/ext-mcp-activation", () => ({
  reloadInstalledMcp: async (name: string) => ({
    reference: name,
    status: "connected",
  }),
}))

const { initAlphaEnvironment } = await import("../src/main/alpha-environment")
const { registerExtIpcHandlers } = await import("../src/main/ext-ipc")

delete process.env.ALPHA_GLOBAL_DIR
initAlphaEnvironment({
  isPackaged: false,
  channel: "dev",
  appDataDir: root,
  baseRoot: join(root, "alpha-code-state"),
  homeDir: join(root, "home"),
})
registerExtIpcHandlers(
  join(root, "user-data"),
  "dev",
  async () => ({
    url: "http://127.0.0.1:39117",
    username: "opencode",
    password: "route-password",
  }),
  join(root, "home"),
)

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

test("真实 ext-install-catalog 返回值只含公开状态且不回显 canary", async () => {
  const install = handlers.get("ext-install-catalog")
  if (!install) throw new Error("ext-install-catalog handler was not registered")
  const intent = {
    catalogId: entry.id,
    scope: { scope: "global" },
    grants: {
      secrets: { GITHUB_PERSONAL_ACCESS_TOKEN: canary },
    },
  }
  const first = await install({ sender: { id: 1 } }, intent)
  if (
    !first ||
    typeof first !== "object" ||
    (first as { ok?: unknown }).ok !== false ||
    (first as { stage?: unknown }).stage !== "authorize"
  )
    throw new Error(`expected authorization pause, got ${JSON.stringify(first)}`)
  const confirmed = Object.fromEntries(
    (
      first as {
        authorization: Array<{
          key: string
          requested: unknown
          requiresConfirmation: boolean
        }>
      }
    ).authorization
      .filter((decision) => decision.requiresConfirmation)
      .map((decision) => [decision.key, decision.requested]),
  )
  const result = await install({ sender: { id: 1 } }, { ...intent, authorization: { confirmed } })
  if (!result || typeof result !== "object") throw new Error(`expected install result, got ${JSON.stringify(result)}`)
  expect(result).toMatchObject({
    ok: true,
    kind: "mcp",
    name: entry.name,
    mcpActivation: { reference: entry.name, status: "connected" },
  })
  const allowed = new Set(["ok", "kind", "name", "manifestDigest", "mcpActivation", "warning"])
  expect(
    Object.keys(result).every((key) => allowed.has(key)),
    JSON.stringify(result),
  ).toBe(true)
  expect(JSON.stringify(result)).not.toContain(canary)
})

// REQ-128 #702 R1 审计 B1:package 的两条 IPC 生产接线必须真的在 registerExtIpcHandlers 里。
// 原 wiring 用例自己调 registerPackageCatalogReadIpcHandlers / runCatalogInstallWithPackagePreflight,
// 于是 `ext-ipc.ts` 退回裸 ipcMain.handle / 裸 installCatalog 之后全量仍全绿。
// 本文件起的是**真的** registerExtIpcHandlers,所以这两条断言删接线即红。
test("REQ-128:真 registerExtIpcHandlers 注册了 package detail 通道", () => {
  expect(handlers.has("ext-package-detail")).toBe(true)
})

test("REQ-128:带 attempt identity 的意图走 package admission,不落 legacy planner", async () => {
  const install = handlers.get("ext-install-catalog")
  if (!install) throw new Error("ext-install-catalog handler was not registered")
  const result = await install(
    { sender: { id: 1 } },
    {
      catalogId: "skill:not-in-this-catalog",
      scope: { scope: "global" },
      attemptId: "missing-package-attempt",
    },
  )
  // admission 在场:package 权威接手,在本组件桩缺少 verified snapshot digest 时 fail-closed。
  // package 路由被摘掉:意图掉进不懂 package 的 legacy planner,返回另一条错误。
  //
  // `reason` 不能省:它区分 admission 的已签快照重取边界与 legacy catalog lookup。
  expect(result).toMatchObject({
    ok: false,
    reason: "package admission: verified Catalog snapshot digest unavailable",
  })
})

test("REQ-128:browse 通道的数据源是真的 refreshRemoteCatalog", async () => {
  const browse = (await handlers.get("ext-remote-catalog")!({ sender: { id: 1 } })) as {
    version?: string
  } | null
  // 把 registerPackageCatalogReadIpcHandlers 的 refresh 实参换成不刷新的桩时,本行变红。
  expect(browse?.version).toBe(bundledCatalog.version)
})

// 这一条守的是 `ext-ipc.ts` 里 `installedDisabled` 的**提前返回**分支 —— 真实 catalog 里
// 每一次首装走的都是它(8 条 MCP 全非 alpha 源)。上一条用例改了 source 才够得着另一条分支,
// 所以两条缺一不可。
test("默认关的真实 catalog MCP:提前返回分支同样只含公开状态且不回显 canary", async () => {
  const install = handlers.get("ext-install-catalog")
  if (!install) throw new Error("ext-install-catalog handler was not registered")
  const intent = {
    catalogId: disabledEntry.id,
    scope: { scope: "global" },
    grants: {
      secrets: { GITHUB_PERSONAL_ACCESS_TOKEN: canary },
    },
  }
  const first = await install({ sender: { id: 1 } }, intent)
  if (
    !first ||
    typeof first !== "object" ||
    (first as { ok?: unknown }).ok !== false ||
    (first as { stage?: unknown }).stage !== "authorize"
  )
    throw new Error(`expected authorization pause, got ${JSON.stringify(first)}`)
  const confirmed = Object.fromEntries(
    (
      first as {
        authorization: Array<{ key: string; requested: unknown; requiresConfirmation: boolean }>
      }
    ).authorization
      .filter((decision) => decision.requiresConfirmation)
      .map((decision) => [decision.key, decision.requested]),
  )
  const result = await install({ sender: { id: 1 } }, { ...intent, authorization: { confirmed } })
  if (!result || typeof result !== "object") throw new Error(`expected install result, got ${JSON.stringify(result)}`)
  // 走到的必须真是提前返回那条:第三方 MCP 默认关。若这里变成 false,说明分支覆盖又漂掉了。
  expect((result as { installedDisabled?: unknown }).installedDisabled, JSON.stringify(result)).toBe(true)
  const allowedDisabled = new Set(["ok", "kind", "name", "manifestDigest", "installedDisabled", "warning"])
  expect(
    Object.keys(result).every((key) => allowedDisabled.has(key)),
    JSON.stringify(result),
  ).toBe(true)
  expect(JSON.stringify(result)).not.toContain(canary)
})
