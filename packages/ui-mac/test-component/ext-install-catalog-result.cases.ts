import { afterAll, expect, mock, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import bundledCatalog from "../src/renderer/extensions/alpha-catalog.json"

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
