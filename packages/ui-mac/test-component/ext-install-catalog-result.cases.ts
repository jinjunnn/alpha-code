import { afterAll, expect, mock, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// DBHub 来自 src/renderer/extensions/testvectors/d5-old-catalog.json(2026-08-31.2 的真实历史目录样本)。
import bundledCatalog from "../src/renderer/extensions/testvectors/d5-old-catalog.json"
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
const entry = structuredClone(bundledCatalog.entries.find((item) => item.id === "mcp:dbhub")!)
entry.source = "alpha"
delete entry.curation

// 未改 source:保持 catalog 里的真实形状(official)⇒ 落 installedDisabled 提前返回那条。
const disabledEntry = structuredClone(bundledCatalog.entries.find((item) => item.id === "mcp:dbhub")!)
disabledEntry.id = "mcp:dbhub-default-off"
disabledEntry.name = "dbhub-default-off"

// REQ-234 `#1529`:agent 请求的那一次安装(带 hubRequestId),走默认关那条真实分支。
const agentEntry = structuredClone(bundledCatalog.entries.find((item) => item.id === "mcp:dbhub")!)
agentEntry.id = "mcp:dbhub-agent"
agentEntry.name = "dbhub-agent"

// REQ-234 `#1531`:项目作用域安装(只重载该项目目录)与 agent 经确认框的金丝雀端到端,各一条目。
const projectEntry = structuredClone(bundledCatalog.entries.find((item) => item.id === "mcp:dbhub")!)
projectEntry.id = "mcp:dbhub-project"
projectEntry.name = "dbhub-project"
// 项目 MCP 不收密钥(main 拒绝 requiredEnvVars 非空的项目安装)
delete (projectEntry.installSpec as { requiredEnvVars?: string[] }).requiredEnvVars
const canaryEntry = structuredClone(bundledCatalog.entries.find((item) => item.id === "mcp:dbhub")!)
canaryEntry.id = "mcp:dbhub-canary"
canaryEntry.name = "dbhub-canary"
canaryEntry.source = "alpha"
delete canaryEntry.curation
// 随包 dbhub 带「待核实」声明 ⇒ 不在可安装视图里(agent 看不见、codepuppy_hub_install 答 unknown entry);金丝雀条目去掉它
delete (canaryEntry.installSpec as { _verify?: string })._verify

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
    catalog: { version: bundledCatalog.version, entries: [entry, disabledEntry, agentEntry, projectEntry, canaryEntry] },
    version: bundledCatalog.version,
    fetchedAt: "2026-07-30T00:00:00.000Z",
    via: "channel-dev",
    channel: "dev",
  }),
}))

// `#1529`:安装体不再在当前回答里 dispose + 读 status;MCP 是否连上由 hub-view 按目录核验(这里桩成已连接)。
mock.module("../src/main/ext-mcp-activation", () => ({
  verifyInstalledMcp: async (name: string) => ({
    reference: name,
    status: "connected",
  }),
  probeProjectMcpActivation: async () => "unverifiable" as const,
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
const { alphaSidecar } = registerExtIpcHandlers(
  join(root, "user-data"),
  "dev",
  async () => ({
    url: "http://127.0.0.1:39117",
    username: "opencode",
    password: "route-password",
  }),
  join(root, "home"),
)
// `#1529`:像 server.ts 在 sidecar ready 时那样接上发送口 —— 装完之后发往 ext 的东西都落在这里。
const toSidecar: Array<Record<string, unknown>> = []
alphaSidecar.attach((message) => void toSidecar.push(message as Record<string, unknown>))

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
      secrets: { DSN: canary },
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
  })
  const allowed = new Set(["ok", "kind", "name", "manifestDigest", "warning"])
  expect(
    Object.keys(result).every((key) => allowed.has(key)),
    JSON.stringify(result),
  ).toBe(true)
  expect(JSON.stringify(result)).not.toContain(canary)
  // `#1529`:提交成功之后是**请 ext 重载**(global,带这一项),而不是在这里 dispose。
  expect(toSidecar.at(-1)).toMatchObject({
    type: "alpha.reload.request",
    scope: "global",
    items: [{ id: entry.id, scope: "global" }],
  })
  expect(JSON.stringify(toSidecar)).not.toContain(canary)
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
      secrets: { DSN: canary },
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

// ── REQ-234 `#1529` ─────────────────────────────────────────────────────────────────────────
// 下面两条走的是**真** registerExtIpcHandlers 交出来的两个入口:定制中心的 `ext-hub-view` IPC 与 parentPort 的
// `alpha.*` 分发。把其中一个改成自己算一份(或把会话字段带进状态计算),I4 这条就红。

const directory = join(root, "workspace")

test("#1529 I4:同一目录,定制中心(IPC)与 agent(parentPort)读到逐行同档同原因", async () => {
  const hubView = handlers.get("ext-hub-view")
  if (!hubView) throw new Error("ext-hub-view handler was not registered")
  const fromHub = (await hubView({ sender: { id: 1 } }, directory)) as { rows: Array<Record<string, unknown>> }
  const replies: Array<Record<string, unknown>> = []
  expect(
    alphaSidecar.receive(
      { type: "alpha.hub.view.request", id: 41, directory, sessionID: "ses_x", agent: "build" },
      (message) => void replies.push(message as Record<string, unknown>),
    ),
  ).toBe(true)
  for (let i = 0; i < 100 && replies.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20))
  const reply = replies[0] as { id: number; view?: { rows: Array<Record<string, unknown>> } }
  expect(reply.id).toBe(41)
  const strip = (rows: Array<Record<string, unknown>>) => rows.map(({ agentNote: _note, ...rest }) => rest)
  expect(strip(reply.view!.rows)).toEqual(strip(fromHub.rows))
  const installed = fromHub.rows.find((row) => row.id === entry.id && row.scope === "global")
  expect(installed).toMatchObject({ installed: true, enabled: true, state: "available" })
  expect(fromHub.rows.find((row) => row.id === disabledEntry.id && row.scope === "global")).toMatchObject({
    installed: true,
    enabled: false,
    state: "installed",
  })
  expect(JSON.stringify(fromHub)).not.toContain(canary)
})

test("#1529 I9:确认框记的阶段 + 带 hubRequestId 的安装 ⇒ main 记 committed(带作用域),ext 查得到", async () => {
  const stage = handlers.get("ext-hub-request-stage")!
  const install = handlers.get("ext-install-catalog")!
  const requestId = "req_agent_0001"
  expect(await stage({ sender: { id: 1 } }, { requestId, stage: "confirming", catalogId: agentEntry.id })).toEqual({ ok: true })
  expect(await stage({ sender: { id: 1 } }, { requestId, stage: "submitted" })).toEqual({ ok: true })
  const intent = { catalogId: agentEntry.id, scope: { scope: "global" }, hubRequestId: requestId }
  const first = (await install({ sender: { id: 1 } }, intent)) as {
    stage?: string
    authorization: Array<{ key: string; requested: unknown; requiresConfirmation: boolean }>
  }
  // 授权暂停不是落定
  expect(first.stage).toBe("authorize")
  const query = (id: number) => {
    const replies: Array<Record<string, unknown>> = []
    alphaSidecar.receive({ type: "alpha.hub.request.request", id, requestId }, (m) => void replies.push(m as Record<string, unknown>))
    return replies[0]
  }
  expect(query(51)).toEqual({ type: "alpha.hub.request.reply", id: 51, record: { requestId, catalogId: agentEntry.id, stage: "submitted" } })
  const confirmed = Object.fromEntries(
    first.authorization.filter((d) => d.requiresConfirmation).map((d) => [d.key, d.requested]),
  )
  const result = (await install({ sender: { id: 1 } }, { ...intent, authorization: { confirmed } })) as { ok?: boolean }
  expect(result.ok, JSON.stringify(result)).toBe(true)
  expect(query(52)).toEqual({
    type: "alpha.hub.request.reply",
    id: 52,
    record: { requestId, catalogId: agentEntry.id, stage: "committed", scope: "global" },
  })
  // 之后到达的 reject 回执(期限到 / 用户点了取消)记不成「用户拒绝」
  expect((await stage({ sender: { id: 1 } }, { requestId, stage: "declined" })) as { ok: boolean }).toMatchObject({ ok: false })
  expect(query(53)).toMatchObject({ record: { stage: "committed" } })
})

// ── REQ-234 `#1531` ─────────────────────────────────────────────────────────────────────────

/** 两段式安装(授权暂停 → 带全部需确认项重驱),与 Hub / 确认框守望者同一出站形状。 */
async function installTwice(intent: Record<string, unknown>) {
  const install = handlers.get("ext-install-catalog")!
  const first = (await install({ sender: { id: 1 } }, intent)) as {
    stage?: string
    authorization: Array<{ key: string; requested: unknown; requiresConfirmation: boolean }>
  }
  if (first?.stage !== "authorize") throw new Error(`expected authorization pause, got ${JSON.stringify(first)}`)
  const confirmed = Object.fromEntries(first.authorization.filter((d) => d.requiresConfirmation).map((d) => [d.key, d.requested]))
  return (await install({ sender: { id: 1 } }, { ...intent, authorization: { confirmed } })) as Record<string, unknown>
}

// #1529 审计 Minor ③:项目作用域提交成功 ⇒ 只请 ext 重载**该项目目录**(items 带 project 作用域),不是 global。
test("#1531:项目作用域安装 ⇒ 发往 ext 的是 { scope:{ directory }, items:[{ scope:'project' }] }", async () => {
  const projectDir = join(root, "project-a")
  mkdirSync(join(projectDir, ".code-puppy"), { recursive: true })
  const result = await installTwice({ catalogId: projectEntry.id, scope: { scope: "project", projectDir } })
  expect(result.ok, JSON.stringify(result)).toBe(true)
  expect(toSidecar.at(-1)).toMatchObject({
    type: "alpha.reload.request",
    scope: { directory: projectDir },
    items: [{ id: projectEntry.id, scope: "project" }],
  })
})

// 基线 §2.4 的金丝雀端到端(I2):agent 的 codepuppy_hub_install(**生产** ext 工具)经 parentPort 形状的消息接到**真** main 分发;
// 确认框那一环由守望者的出站动作代演(记 confirming / submitted → 带 hubRequestId 与金丝雀密钥两段式安装 → 回 once)。
// 金丝雀值在工具参数、工具输出与 metadata、审批请求载荷、parentPort 双向全部消息、发往 ext 的重载请求里 **零命中**;
// 对照组:同一个值在 main 落盘的密钥文件里**必须命中**(证明这把 grep 看得见它)。
test("#1531 金丝雀:agent 安装的密钥只落在 main 的密钥文件里,工具 / 审批 / parentPort 一个字节都没有", async () => {
  const { createHubBridge } = await import("../../ext/src/hub-bridge")
  const { createHubTools } = await import("../../ext/src/hub-tools")
  const stage = handlers.get("ext-hub-request-stage")!
  const value = "REQ234_AGENT_CANARY_7b31e0d4"
  const wire: unknown[] = []
  const listeners: Array<(event: { data: unknown }) => void> = []
  const bridge = createHubBridge(
    {
      postMessage: (message) => {
        wire.push(message)
        alphaSidecar.receive(message, (reply) => {
          wire.push(reply)
          for (const listener of listeners) listener({ data: reply })
        })
      },
      on: (_event, listener) => void listeners.push(listener),
    },
    { log: () => {} },
  )
  const asks: unknown[] = []
  const ctx = {
    sessionID: "ses_canary",
    messageID: "msg_canary",
    agent: "build",
    directory: join(root, "workspace"),
    worktree: join(root, "workspace"),
    abort: new AbortController().signal,
    metadata: () => {},
    // 守望者:先记阶段再出站,框里填的密钥只进 install 意图的 grants。
    ask: async (input: { metadata: { alphaHub: { catalogId: string; requestId: string } } }) => {
      asks.push(input)
      const { catalogId, requestId } = input.metadata.alphaHub
      expect(await stage({ sender: { id: 1 } }, { requestId, stage: "confirming", catalogId })).toEqual({ ok: true })
      expect(await stage({ sender: { id: 1 } }, { requestId, stage: "submitted" })).toEqual({ ok: true })
      const result = await installTwice({ catalogId, scope: { scope: "global" }, grants: { secrets: { DSN: value } }, hubRequestId: requestId })
      expect(result.ok, JSON.stringify(result)).toBe(true)
    },
  }
  const args = { catalogId: canaryEntry.id }
  const result = (await createHubTools(bridge).codepuppy_hub_install.execute(args, ctx as never)) as { output: string; metadata: unknown }
  expect(result.output.split("\n")[0]).toBe("installed; available")
  for (const surface of [args, result, asks, wire, toSidecar]) expect(JSON.stringify(surface)).not.toContain(value)
  expect(wire.some((m) => (m as { type?: string }).type === "alpha.hub.request.reply")).toBe(true)

  // 对照组:main 落盘的密钥文件里看得见它
  const hits: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name)
      if (e.isDirectory()) walk(abs)
      else if (readFileSync(abs).includes(value)) hits.push(abs)
    }
  }
  walk(root)
  expect(hits.length).toBeGreaterThan(0)
  expect(hits.every((path) => /secret/i.test(path)), JSON.stringify(hits)).toBe(true)
})
