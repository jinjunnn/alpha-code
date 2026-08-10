// #594/#577 回归锁(独立进程运行:隔离仓内其他测试预先缓存的 Solid server 条件导出)。
// 锁「不依赖事件必达」的恢复语义(R1 修复轮扩到 8 条),并覆盖 #692 非 Git 侧栏项目:
//   1. 闩死点一:recovering 后 ready 永不到达(#577 producer 事故)且引擎实际可达
//      → 有界自探必须重建 client。
//   2. recovering → ready 正常路径回归保持,自探不抢跑。
//   3. failed 终态不得被当成 ready 盲连(live 事件路):执行面关闭,自探真实通过后才重建。
//   4. 「立即重试」重读现值(replay 路):failed 现值不盲连;新代 ready 现值必须重建 client。
//   5. R1 Major1:自探建立的 provisional 连接,同代权威 ready 必须强制刷新一次。
//   6. R1 Major2:迟到的 getState 回放不得把新状态回退;完全相同的 ready 允许重复广播。
//   7. R1 Blocker2:自探重建后必须发本地恢复通知 —— composer 链(modelChainState/canSend)
//      真实恢复,而不是只有 SDK client 被构造。
//   8. R1 闩死点三收口:真实点击 picker 的「立即重试」按钮 → client 重建 + 列表恢复。
import { afterAll, afterEach, expect, mock, test } from "bun:test"
import { transformAsync } from "@babel/core"
import presetTypescript from "@babel/preset-typescript"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import presetSolid from "babel-preset-solid"
import type { ModelV2Info } from "@opencode-ai/sdk/v2/client"
import type { SidecarGenerationState, AccountSummary, AuthState } from "../src/preload/types"
import type { EffectiveCatalog, ProviderKeyStatus } from "../src/shared/alpha-model-types"
import type { AlphaProjectsApi, ServerInfo } from "../src/renderer/sidebar/use-projects"
import type { AlphaComposerRuntimeProps } from "../src/renderer/alpha-ui/alpha-composer"
import type { ModelContract } from "../src/renderer/alpha-ui/model-contract"
import { dict as zh } from "../src/renderer/i18n/zh"

GlobalRegistrator.register()
const solid = await import("solid-js/dist/solid.js")
mock.module("solid-js", () => solid)
const solidWeb = await import("solid-js/web/dist/web.js")
mock.module("solid-js/web", () => solidWeb)
const solidStore = await import("solid-js/store/dist/store.js")
mock.module("solid-js/store", () => solidStore)
const { createComponent, createRoot, createSignal } = solid
const { render } = solidWeb

Bun.plugin({
  name: "solid-component-tests",
  setup(builder) {
    builder.onLoad({ filter: /packages\/ui-mac\/src\/.*\.tsx$/ }, async (args) => {
      const transformed = await transformAsync(await Bun.file(args.path).text(), {
        filename: args.path,
        presets: [
          [presetSolid, { generate: "dom", hydratable: false }],
          [presetTypescript, { allExtensions: true, isTSX: true, onlyRemoveTypeImports: true }],
        ],
        sourceMaps: "inline",
      })
      return { contents: transformed?.code ?? "", loader: "js" }
    })
  },
})

const command = { options: [], trigger: () => {} } as unknown as AlphaComposerRuntimeProps["command"]
mock.module("../src/renderer/alpha-ui/providers", () => ({ useCommand: () => command }))

// —— preload 桥 stub:subscribe 捕获 runtime-recovery 的内部回调,getState 提供「现值」 ——
let bridgeCb: ((state: SidecarGenerationState) => void) | undefined
let currentState: SidecarGenerationState = { status: "recovering", generation: 0, reason: "boot" }

const catalog = {
  ...(await Bun.file(new URL("../src/main/alpha-models.json", import.meta.url)).json()),
  liveSync: { status: "static" },
  // #681:平台段没有有效 V2/LKG 时 basis 为 null(该 stub 不带远端目录)。
  pricingBasisModelId: null,
} as EffectiveCatalog
const info = (providerID: string, id: string, name = id): ModelV2Info => ({
  id,
  providerID,
  name,
  api: { id: providerID, type: "aisdk", package: "@ai-sdk/openai-compatible" },
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  request: { headers: {}, body: {} },
  variants: [],
  time: { released: 0 },
  cost: [],
  status: "active",
  enabled: true,
  limit: { context: 128_000, output: 8_192 },
})
const platformModels = catalog.platformModels.map((model) => info(catalog.platformProvider.id, model.id, model.name))
const keys = Object.fromEntries(
  catalog.byokProviders.map((provider) => [provider.id, { configured: false, source: "none" }]),
) as ProviderKeyStatus
const loggedIn: AuthState = { status: "logged-in", mode: "platform" }
const summary: AccountSummary = {
  balanceFen: 0,
  walletUsedFen: 0,
  plan: {
    id: "pro",
    name: "Pro",
    status: "active",
    window5h: { usedCredits: 0, limitCredits: 100, resetsInMin: 0 },
    window7d: { usedCredits: 0, limitCredits: 100, resetsInMin: 0 },
    renewsAt: "",
    daysLeft: 10,
  },
  usage: { todayTokens: 0, weekTokens: 0, tasksThisMonth: 0 },
  usageSeries: [],
}

// REQ-126 不变量 5(#656):`alpha-workspace-ensure` **不 throw**,失败以 `{ok:false}` 回来;而
// main 对**非默认路径**同样返回 `{ok:false}`(那是合法的 no-op,不是失败)。用例逐条设定默认目录
// 与这个回复(Error 实例 = 桥本身炸了),并记录 ensure 到底被调了几次。
const DEFAULT_WORKSPACE_DIR = "/Users/tester/Alpha"
let ensureReply: unknown = { ok: true }
let ensureCalls = 0
/** 默认目录**查询**这条 IPC 的回复;Error 实例 = 查询桥本身炸了(与供给桥炸了是两回事)。 */
let defaultDirReply: unknown = DEFAULT_WORKSPACE_DIR

Object.defineProperty(window, "api", {
  configurable: true,
  value: {
    endpoints: async () => null,
    workspaceDefaultDir: async () => {
      if (defaultDirReply instanceof Error) throw defaultDirReply
      return defaultDirReply
    },
    workspaceEnsureDefault: async () => {
      ensureCalls++
      if (ensureReply instanceof Error) throw ensureReply
      return ensureReply
    },
    openLink: () => {},
    models: { catalog: async () => catalog },
    auth: { getState: async () => loggedIn, subscribe: () => () => {}, start: async () => {} },
    account: { summary: async () => summary },
    providers: {
      keyStatus: async () => keys,
      add: async () => ({ ok: true as const }),
      test: async () => ({ ok: true as const, ms: 1 }),
      setKey: async () => ({ ok: true as const }),
      remove: async () => ({ ok: true as const }),
      removeKey: async () => ({ ok: true as const }),
    },
    sidecarGeneration: {
      getState: async () => currentState,
      subscribe: (cb: (state: SidecarGenerationState) => void) => {
        bridgeCb = cb
        return () => {}
      },
    },
  },
})

// —— 引擎 stub:/global/health 按开关回答;#692 用例按需启用完整 project/session/SSE 路由 ——
let healthReachable = false
let healthProbes = 0
let sidebarScenario = false
let experimentalPageRequests = 0
const projectSessionDirectories: string[] = []
let globalEventController: ReadableStreamDefaultController<Uint8Array> | undefined
const encoder = new TextEncoder()

const jsonResponse = (body: unknown, headers?: Record<string, string>) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  })

globalThis.fetch = ((input: unknown) => {
  const url = String(input instanceof URL ? input.href : ((input as { url?: string })?.url ?? input))
  if (url.includes("/global/health")) {
    healthProbes++
    return Promise.resolve(new Response("{}", { status: healthReachable ? 200 : 503 }))
  }
  if (sidebarScenario) {
    const parsed = new URL(url)
    if (parsed.pathname === "/project") {
      return Promise.resolve(
        jsonResponse([
          { id: "global", name: "global", worktree: "/", sandboxes: [] },
          { id: "git-alpha", name: "alpha-code", worktree: "/repos/alpha-code", sandboxes: [] },
        ]),
      )
    }
    if (parsed.pathname === "/session") {
      projectSessionDirectories.push(parsed.searchParams.get("directory") ?? "")
      return Promise.resolve(jsonResponse([]))
    }
    if (parsed.pathname === "/experimental/session") {
      experimentalPageRequests++
      const cursor = parsed.searchParams.get("cursor")
      if (!cursor) {
        return Promise.resolve(
          jsonResponse(
            [
              {
                id: "ses-documents",
                title: "Greeting",
                directory: "/Users/tester/Documents",
                projectID: "global",
                time: { created: 100, updated: 100 },
                project: { id: "global", name: "global", worktree: "/" },
              },
              {
                id: "ses-root",
                title: "Must stay hidden",
                directory: "/",
                projectID: "global",
                time: { created: 95, updated: 95 },
                project: { id: "global", name: "global", worktree: "/" },
              },
              {
                id: "ses-other-project",
                title: "Not global",
                directory: "/repos/elsewhere",
                projectID: "git-elsewhere",
                time: { created: 90, updated: 90 },
                project: { id: "git-elsewhere", name: "elsewhere", worktree: "/repos/elsewhere" },
              },
            ],
            { "x-next-cursor": "90" },
          ),
        )
      }
      return Promise.resolve(
        jsonResponse([
          {
            id: "ses-desktop",
            title: "Loose notes",
            directory: "/Users/tester/Desktop",
            projectID: "global",
            time: { created: 80, updated: 80 },
            project: { id: "global", name: "global", worktree: "/" },
          },
        ]),
      )
    }
    if (parsed.pathname === "/global/event") {
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              globalEventController = controller
              controller.enqueue(encoder.encode(": connected\n\n"))
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      )
    }
  }
  return new Promise(() => {})
}) as typeof fetch

const { useAlphaProjects } = await import("../src/renderer/sidebar/use-projects")
const { projectSidebarGroups } = await import("../src/renderer/sidebar/project-display")
const { replayRuntimeRecoveryState, subscribeCatalogUpdated, subscribeRuntimeRecovery } = await import(
  "../src/renderer/runtime-recovery"
)
const { AlphaComposerRuntime } = await import("../src/renderer/alpha-ui/alpha-composer")
const { ModelPickPop } = await import("../src/renderer/alpha-ui/alpha-composer-model")
const { composerModel, setComposerModel, setComposerAgent, resetComposerModelProjection } = await import(
  "../src/renderer/alpha-ui/composer-state"
)
// #882:接线用例要驱动**真的**就绪屏障 —— 只订阅 notifyCatalogUpdated 只能证明「最终被唤醒」,
// 证明不了「事件跑赢了兜底档位」。
const { createModelContract } = await import("../src/renderer/alpha-ui/model-contract")
const { ALPHA_V2_CATALOG_READY_PROVIDER_ID } = await import("../src/shared/alpha-config")

const serverInfo: ServerInfo = { baseUrl: "http://127.0.0.1:19099", username: "u", password: "p" }
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(assertion: () => void, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  let failure: unknown
  for (;;) {
    try {
      assertion()
      return
    } catch (error) {
      failure = error
      if (Date.now() > deadline) throw failure
      await tick(10)
    }
  }
}
const activeDisposals: Array<() => void> = []
/** #882 接线用例里那条**真**兜底定时器;用例结束必须清掉,不许把 tick 漏进下一条用例。 */
const fallbackTimers: Array<ReturnType<typeof setTimeout>> = []
function mountHook(probeDelayMs: number): { api: AlphaProjectsApi } {
  let api!: AlphaProjectsApi
  const dispose = createRoot((d: () => void) => {
    const [server] = createSignal<ServerInfo | undefined>(serverInfo)
    api = useAlphaProjects(server, { delayFor: () => probeDelayMs })
    return d
  })
  activeDisposals.push(dispose)
  return { api }
}
function mountView(view: () => HTMLElement) {
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(view, host)
  activeDisposals.push(dispose)
  return host
}
const buttonByText = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)

afterEach(() => {
  fallbackTimers.splice(0).forEach((timer) => clearTimeout(timer))
  activeDisposals.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
  sidebarScenario = false
  experimentalPageRequests = 0
  projectSessionDirectories.splice(0)
  globalEventController = undefined
  setComposerModel(null)
  setComposerAgent(null)
  resetComposerModelProjection()
})
afterAll(() => GlobalRegistrator.unregister())

test("#594 闩死点一:recovering 后 ready 永不到达、引擎实际可达 → 有界自探重建 client", async () => {
  healthReachable = true
  healthProbes = 0
  const { api } = mountHook(5)
  await tick()
  expect(api.sdk()).toBeUndefined()

  // 冷启动毒丸:recovering 到达(等价 preload 回放),ready 永不到达(#577)
  bridgeCb!({ status: "recovering", generation: 1, reason: "boot" })
  await waitFor(() => expect(api.sdk()).toBeDefined())
  expect(healthProbes).toBeGreaterThan(0)
})

test("#594 回归保持:recovering → ready 正常路径重建 client,自探不抢跑", async () => {
  healthReachable = false
  healthProbes = 0
  const { api } = mountHook(60_000)
  await tick()

  bridgeCb!({ status: "recovering", generation: 2, reason: "structural" })
  await tick()
  expect(api.sdk()).toBeUndefined()

  bridgeCb!({ status: "ready", generation: 2, reason: "structural" })
  await tick()
  expect(api.sdk()).toBeDefined()
  expect(healthProbes).toBe(0)
})

test("#577 T-c(live):failed 终态不得当成 ready 盲连 —— 执行面关闭,自探真实通过后才重建", async () => {
  healthReachable = false
  healthProbes = 0
  const { api } = mountHook(5)
  await tick()

  bridgeCb!({ status: "recovering", generation: 3, reason: "boot" })
  // recovering → failed 必须穿过转换过滤器到达 consumer(shouldApplySidecarState 放行)
  bridgeCb!({ status: "failed", generation: 3, reason: "boot" })
  await tick(60)

  // 引擎不可达期间:不盲连(failed ≠ ready),但自探已武装
  expect(api.sdk()).toBeUndefined()
  expect(healthProbes).toBeGreaterThan(0)

  // 引擎迟到恢复 → 自探自证后重建
  healthReachable = true
  await waitFor(() => expect(api.sdk()).toBeDefined())
})

test("#594 闩死点三(replay 机制):failed 现值不盲连;新代 ready 现值必须重建出 client", async () => {
  healthReachable = false
  healthProbes = 0
  const { api } = mountHook(60_000)
  await tick()

  bridgeCb!({ status: "recovering", generation: 4, reason: "boot" })
  await tick()
  expect(api.sdk()).toBeUndefined()

  // T-c(replay):现值为 failed → 「立即重试」不得据此重建
  currentState = { status: "failed", generation: 4, reason: "boot" }
  await replayRuntimeRecoveryState()
  await tick(20)
  expect(api.sdk()).toBeUndefined()

  // 现值为新代 ready(引擎已 respawn 到 gen5,UI 仍闩在旧态)→ 重试必须重建出 client。
  // 注:同代 failed→ready 按 producer exactly-once 契约不可能产生,replay 也拒绝回退/
  // 二次终态(见 Major2 用例),所以这里用新代 ready —— 真实可达序列。
  currentState = { status: "ready", generation: 5, reason: "boot" }
  await replayRuntimeRecoveryState()
  await tick(20)
  expect(api.sdk()).toBeDefined()
})

test("R1 Major1:自探建立的 provisional 连接,同代权威 ready 必须强制刷新一次", async () => {
  healthReachable = true
  healthProbes = 0
  const { api } = mountHook(5)
  await tick()

  bridgeCb!({ status: "recovering", generation: 6, reason: "structural" })
  await waitFor(() => expect(api.sdk()).toBeDefined())
  const provisional = api.sdk()

  // 同代权威 ready:不得因「同 generation 且已有 client」跳过 —— provisional 连接可能
  // 应答自将死的旧进程,必须重建 client + 重拉 + 重订阅(以 client 身份变化为证)。
  bridgeCb!({ status: "ready", generation: 6, reason: "structural" })
  await tick()
  expect(api.sdk()).toBeDefined()
  expect(api.sdk()).not.toBe(provisional)
})

test("R1 Major2:迟到的 getState 回放不得回退新状态;完全相同的 ready 允许重复广播", async () => {
  healthReachable = false
  const { api } = mountHook(60_000)
  await tick()

  bridgeCb!({ status: "recovering", generation: 7, reason: "structural" })
  await tick()
  bridgeCb!({ status: "ready", generation: 7, reason: "structural" })
  await tick()
  const authoritative = api.sdk()
  expect(authoritative).toBeDefined()

  const replayed: SidecarGenerationState[] = []
  const unsubscribe = subscribeRuntimeRecovery((state) => replayed.push(state))
  await tick() // 消化订阅时的当前值回放
  replayed.splice(0)

  // 迟到的 getState 读到旧 recovering(用户点重试时响应尚未回来,期间 live ready 已到)
  // → 必须被丢弃:不得拆掉已恢复的 client,不得污染之后订阅者看到的当前值。
  currentState = { status: "recovering", generation: 7, reason: "structural" }
  await replayRuntimeRecoveryState()
  await tick(20)
  expect(replayed).toEqual([])
  expect(api.sdk()).toBe(authoritative)

  // 完全相同的 ready:允许重复广播(把已恢复的事实再递给停跑的消费链),client 不重建。
  currentState = { status: "ready", generation: 7, reason: "structural" }
  await replayRuntimeRecoveryState()
  await tick(20)
  expect(replayed).toEqual([{ status: "ready", generation: 7, reason: "structural" }])
  expect(api.sdk()).toBe(authoritative)
  unsubscribe()
})

test("R1 Blocker2:自探重建后发本地恢复通知 —— composer 模型链与 canSend 真实恢复", async () => {
  healthReachable = true
  healthProbes = 0
  const { api } = mountHook(30)
  const contract: ModelContract = {
    // 镜像 model-contract.ts 的 fail-closed:client 缺失 = 同步失败,不上网络
    list: async () => {
      if (!api.sdk()) throw new Error("model contract list failed: client missing")
      return platformModels
    },
    current: async () => undefined,
    switch: async () => {},
  }
  const host = mountView(() =>
    createComponent(AlphaComposerRuntime, {
      mode: "home",
      projects: api,
      directory: () => "/W",
      command,
      modelContract: contract,
    }),
  )
  // 上一用例把现值留在 ready gen7 —— 订阅回放让 hook 立刻权威建连,composer 首链完成
  //(= Codex 失败序列的 t0:运行中、链已 ready、无循环在跑)。
  await waitFor(() => expect(composerModel()).not.toBeNull())
  const textarea = host.querySelector("textarea.a-comp-input") as HTMLTextAreaElement
  const send = () => host.querySelector("button.a-comp-send") as HTMLButtonElement
  textarea.value = "hello"
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: "hello" }))
  await waitFor(() => expect(send().disabled).toBe(false))

  // t1:respawn 发出 recovering;t2:ready 事件丢失(永不到达)
  bridgeCb!({ status: "recovering", generation: 8, reason: "structural" })
  await tick()
  expect(api.sdk()).toBeUndefined()
  expect(send().disabled).toBe(true) // modelChainState 已闩在 recovering,发送关闭

  // t3:自探成功重建 client;t4:本地恢复通知必须唤醒已停跑的模型链 → canSend 恢复。
  // (修复前:client 重建但无通知,modelChainState 永久 recovering,发送永久禁用。)
  await waitFor(() => expect(api.sdk()).toBeDefined())
  await waitFor(() => expect(send().disabled).toBe(false))
  expect(healthProbes).toBeGreaterThan(0)
})

test("R1 闩死点三收口:真实点击「立即重试」→ client 重建 + 模型列表恢复", async () => {
  healthReachable = false
  healthProbes = 0
  const { api } = mountHook(60_000)
  await tick()
  bridgeCb!({ status: "recovering", generation: 9, reason: "boot" })
  await tick()
  expect(api.sdk()).toBeUndefined()
  // generation 现值已是 ready(producer 已发终态,UI 的事件路丢失)
  currentState = { status: "ready", generation: 9, reason: "boot" }

  const contract: ModelContract = {
    list: async () => {
      if (!api.sdk()) throw new Error("model contract list failed: client missing")
      return platformModels
    },
    current: async () => undefined,
    switch: async () => {},
  }
  let retryCurrentCalls = 0
  const host = mountView(() =>
    createComponent(ModelPickPop, {
      contract,
      directory: () => "/W",
      selected: () => null,
      onSelect: async () => {},
      onPicked: () => {},
      onRetryCurrent: () => {
        retryCurrentCalls++
      },
      modelChainReady: () => true,
    }),
  )
  // client 缺失 → 列表进入 recovering 横幅,出现「立即重试」;本地目录行全部锁死不可选
  await waitFor(() => expect(buttonByText(host, zh["alpha.model.retryNow"])).toBeDefined())
  const rows = () => [...host.querySelectorAll(".a-mpp-row")] as HTMLButtonElement[]
  expect(rows().length).toBeGreaterThan(0)
  expect(rows().every((row) => row.disabled)).toBe(true)

  // 修复前:按钮只重跑 fetch 层(loadAll),sdk() 依旧 undefined → 原地同步失败,
  // 横幅与锁死常驻。
  buttonByText(host, zh["alpha.model.retryNow"])!.click()
  await waitFor(() => expect(api.sdk()).toBeDefined())
  await waitFor(() => expect(rows().some((row) => !row.disabled)).toBe(true))
  expect(retryCurrentCalls).toBeGreaterThan(0)
  expect(buttonByText(host, zh["alpha.model.retryNow"])).toBeUndefined()
})

test("REQ-126 不变量5:默认对话目录的供给结果必须如实回报,非默认路径不当成失败", async () => {
  const { api } = mountHook(0)

  // 非默认路径:main 侧本就不代建任意路径(合法 no-op),不能当失败 —— 否则所有普通项目的会话
  // 创建会被一起挡掉。而且**根本不该发起供给**。
  ensureCalls = 0
  expect(await api.ensureDefaultWorkspace("/repos/alpha-code")).toBe(true)
  expect(ensureCalls).toBe(0)

  ensureReply = { ok: true, dir: DEFAULT_WORKSPACE_DIR }
  expect(await api.ensureDefaultWorkspace(DEFAULT_WORKSPACE_DIR)).toBe(true)
  expect(ensureCalls).toBe(1)

  // 默认目录建不出来(同名被文件占用 / mkdir 失败)—— IPC **不抛**,只回 {ok:false}。
  ensureReply = { ok: false }
  expect(await api.ensureDefaultWorkspace(DEFAULT_WORKSPACE_DIR)).toBe(false)

  // 桥本身炸了(preload 缺失/通道断)同样算没供给成功。
  ensureReply = new Error("bridge down")
  expect(await api.ensureDefaultWorkspace(DEFAULT_WORKSPACE_DIR)).toBe(false)

  ensureReply = { ok: true }
})

test("REQ-126 不变量5:默认目录**查询**桥炸了不得连坐 —— 普通项目照常能创建会话", async () => {
  // 收敛轮抓到的真 bug:查询与供给曾共用一个 try,查询 reject 会落到同一个 catch 返回 false,
  // 于是 createSession/startChat 在"分类不了"时把**所有普通项目**的会话创建一起挡掉。
  // 判据不停在 helper 的布尔上:直接跑真实 createSession,看它到底有没有被这道闸挡下。
  healthReachable = true
  const { api } = mountHook(0)
  bridgeCb!({ status: "recovering", generation: 1, reason: "boot" })
  await waitFor(() => expect(api.sdk()).toBeDefined())

  defaultDirReply = new Error("default-dir bridge down")
  ensureCalls = 0

  // ① helper 层:分类不了 → 放行,且**不发起供给**。
  expect(await api.ensureDefaultWorkspace("/repos/alpha-code")).toBe(true)
  expect(ensureCalls).toBe(0)

  // ② 真实调用层:createSession 必须越过这道闸,进到 session.create(harness 里引擎请求悬挂,
  //    所以"仍未 settle"= 它真的在等引擎;被闸挡下则会立刻 resolve 成 undefined)。
  const pending = Symbol("pending")
  const outcome = await Promise.race([api.createSession("/repos/alpha-code"), tick(50).then(() => pending)])
  expect(outcome).toBe(pending)

  defaultDirReply = DEFAULT_WORKSPACE_DIR
})

test("#692 非 Git 会话冷加载与 SSE 新建都进入真实目录项目,且从不实例化或显示根目录", async () => {
  sidebarScenario = true
  const { api } = mountHook(60_000)

  // runtime-recovery 会向新订阅者回放上一条 ready;等待真实 project.list + 两页全局索引完成。
  await waitFor(() => {
    const global = api.store.projects.find((project) => project.id === "global")
    expect(global?.loaded).toBe(true)
    expect(global?.sessions.map((session) => session.id).sort()).toEqual(["ses-desktop", "ses-documents"])
  })
  expect(experimentalPageRequests).toBe(2)
  expect(projectSessionDirectories).toEqual(["/repos/alpha-code"])
  expect(projectSessionDirectories).not.toContain("/")

  // 生产 display transform 按真实目录拆成侧栏项目,内部 "/" 会话不留下「全局」残桶。
  let groups = projectSidebarGroups(api.store.projects)
  expect(groups.map((project) => project.worktree)).toContain("/Users/tester/Documents")
  expect(groups.map((project) => project.worktree)).toContain("/Users/tester/Desktop")
  expect(groups.map((project) => project.worktree)).not.toContain("/")
  expect(groups.find((project) => project.worktree === "/Users/tester/Documents")?.sessions[0]?.title).toBe("Greeting")

  // 新会话不等 reload:global SSE 事件按 projectID 命中内部哨兵,立刻生成真实目录分组。
  await waitFor(() => expect(globalEventController).toBeDefined())
  globalEventController!.enqueue(
    encoder.encode(
      `data: ${JSON.stringify({
        directory: "/Users/tester/Downloads",
        project: "global",
        payload: {
          type: "session.created",
          properties: {
            info: {
              id: "ses-live",
              title: "Live loose chat",
              directory: "/Users/tester/Downloads",
              projectID: "global",
              time: { created: 110, updated: 110 },
            },
          },
        },
      })}\n\n`,
    ),
  )
  await waitFor(() => {
    groups = projectSidebarGroups(api.store.projects)
    expect(groups.find((project) => project.worktree === "/Users/tester/Downloads")?.sessions[0]?.id).toBe("ses-live")
  })
})

test("#882 global 事件流把 catalog.updated 按 directory 派发给就绪屏障(接线层,不是等价链)", async () => {
  // 没有这一条,use-projects 里那个 case 可以被整段删掉而全仓仍然全绿 —— model-contract 的
  // 单测只驱动 notifyCatalogUpdated,证明不了「引擎真发的那条事件走到了这个函数」。
  sidebarScenario = true
  const { api } = mountHook(60_000)
  await waitFor(() => expect(api.sdk()).toBeDefined())
  await waitFor(() => expect(globalEventController).toBeDefined())

  const woken: string[] = []
  const unsubscribe = subscribeCatalogUpdated("/repos/alpha-code", () => woken.push("/repos/alpha-code"))
  const unsubscribeOther = subscribeCatalogUpdated("/repos/elsewhere", () => woken.push("/repos/elsewhere"))

  const emit = (frame: Record<string, unknown>) =>
    globalEventController!.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))

  // 控制组:同一条流上的**别的**事件类型不得唤醒任何人(否则这个 case 只是「流是通的」)。
  emit({ directory: "/repos/alpha-code", project: "git-alpha", payload: { type: "server.heartbeat", properties: {} } })
  await tick(20)
  expect(woken).toEqual([])

  // 真事实:引擎每次 CatalogV2.finalize 都发这条,envelope 带 directory(实跑记录见
  // docs/architecture/2026-08-10-catalog-readiness-signals.md)。
  emit({ directory: "/repos/alpha-code", project: "git-alpha", payload: { type: "catalog.updated", properties: {} } })
  await waitFor(() => expect(woken).toEqual(["/repos/alpha-code"]))

  // 按 directory 分派:另一个目录的提交只唤醒那个目录的等待者。
  emit({ directory: "/repos/elsewhere", project: "git-elsewhere", payload: { type: "catalog.updated", properties: {} } })
  await waitFor(() => expect(woken).toEqual(["/repos/alpha-code", "/repos/elsewhere"]))

  unsubscribe()
  unsubscribeOther()

  // ── 事件到请求的**间隔**,不是「最终收到」 ────────────────────────────────────────
  // R1 Major:上面几条只断言「3 秒内最终被唤醒」。把生产通知延迟 300ms,它们照样全绿 ——
  // 而真实环境里 250ms 的兜底档位已经先发出请求了,事件通路实际上是死的。票面判据是间隔。
  //
  // 所以这里挂**真的**就绪屏障(生产 createModelContract),兜底走**真定时器**(默认 250ms
  // 档位),并在每次探针发生的**那一刻**同步记下已经烧掉了几个兜底 tick。事件路径活着 ⇒
  // 第二次探针看到的 tick 数是 0;事件比兜底慢(或整条链被删)⇒ 兜底先赢,读到 ≥1,当场红。
  let fallbackTicks = 0
  const ticksAtProbe: number[] = []
  let markerReady = false
  const contract = createModelContract(
    () =>
      ({
        v2: {
          provider: {
            get: async () => {
              ticksAtProbe.push(fallbackTicks)
              return markerReady
                ? { data: { data: { id: ALPHA_V2_CATALOG_READY_PROVIDER_ID } } }
                : { error: { message: "Provider not found" }, response: { status: 404 } }
            },
          },
          model: { list: async () => ({ data: { data: [info("alpha", "m")] } }) },
        },
      }) as never,
    {
      wait: (delayMs: number) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            fallbackTicks++
            resolve()
          }, delayMs)
          fallbackTimers.push(timer)
        }),
    },
  )

  const listing = contract.list("/repos/alpha-code")
  await waitFor(() => expect(ticksAtProbe.length).toBe(1))
  expect(ticksAtProbe).toEqual([0])

  markerReady = true
  emit({ directory: "/repos/alpha-code", project: "git-alpha", payload: { type: "catalog.updated", properties: {} } })
  await waitFor(() => expect(ticksAtProbe.length).toBe(2))
  // 判据:第二次探针是**事件**推动的 —— 它发生时一个兜底 tick 都还没烧掉。
  expect(ticksAtProbe[1]).toBe(0)
  expect(await listing).toHaveLength(1)
})

test("#858 idle token-only rotation keeps the SDK identity stable, but a failed generation falls back to probing", async () => {
  healthReachable = false
  healthProbes = 0
  currentState = { status: "ready", generation: 20, reason: "boot" }
  await replayRuntimeRecoveryState()
  const { api } = mountHook(5)
  await waitFor(() => expect(api.sdk()).toBeDefined())
  const stable = api.sdk()

  bridgeCb!({ status: "recovering", generation: 21, reason: "token-only" })
  await tick(20)
  expect(api.sdk()).toBe(stable)
  expect(healthProbes).toBe(0)

  bridgeCb!({ status: "ready", generation: 21, reason: "token-only" })
  await tick(20)
  expect(api.sdk()).toBe(stable)
  expect(healthProbes).toBe(0)

  bridgeCb!({ status: "recovering", generation: 22, reason: "token-only" })
  bridgeCb!({ status: "failed", generation: 22, reason: "token-only" })
  await waitFor(() => expect(healthProbes).toBeGreaterThan(0))
  expect(api.sdk()).toBeUndefined()
})
