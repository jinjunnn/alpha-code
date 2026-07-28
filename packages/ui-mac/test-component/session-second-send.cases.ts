// alpha-code#652 回归闸 —— 「同一个会话里的第二条消息」端到端真发一次,并断言**渲染出来的回复**。
//
// 为什么需要这一条(它补的是一个真实缺口,不是覆盖率):#652 在打包版活了四天,期间 2526 条
// 测试全绿、还过了对抗审计。事后普查发现,**没有任何测试发过第二条消息**:
//   · 唯一那条「发两次」的用例(app/components/prompt-input/submit.test.ts)每次把 params
//     重置成 {},两次都判成新会话 —— 后续消息分支覆盖率 0%;
//   · E2E 的 mock server 连 prompt endpoint 都没有;
//   · 多轮时间线测试靠直接注入 SSE 帧伪造轮次 —— 只证明能**显示**第 2 轮,没证明能**发起**它;
//   · takeover-adapter-coexistence 断的是 `composer` 源码里有没有 `delivery: "queue"` 这段
//     字面量 —— 源码文本断言,对本 bug 会照常通过。
//
// 所以这道闸的判据只认**可观测结果**:生产 AlphaComposer + 生产 AlphaSessionTimeline 挂在同一棵树
// 上,共用同一个假 sidecar;点发送 → 时间线上必须出现自己发的那句话和引擎的回复。连发三条,
// 第 2、3 条一样要出现。
//
// 假 sidecar 同时挂 v1 与 v2 两条发送端点,各自照**生产实测行为**实现,harness 自身不预设哪条
// 是对的:
//   · v1 `session.promptAsync` —— 用户消息与助手回复落进 v1 消息表(`message`/`part`)。alpha
//     时间线消费的就是这张表(serverSync 的 `message.updated` 投影)。
//   · v2 `v2.session.prompt`   —— HTTP 200 受理,回 `{admittedSeq, delivery}`,写进 v2 自己的
//     `session_message`,随后 step.failed(生产实测:全库受理 8 次、failed 8 次、零成功)。
//     alpha 的 store 里**没有任何 `session.next.*` 的 reducer**,两张表也互不投影 —— 于是 UI
//     一个字都不会变。这正是「输入框清空之后再无任何反应」的机制。
//
// 变异验证:把 alpha-composer 的会话发送改回 `c.v2.session.prompt`,本文件第一条用例必须转红。
import { transformAsync } from "@babel/core"
import presetTypescript from "@babel/preset-typescript"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import presetSolid from "babel-preset-solid"
import type { ModelV2Info } from "@opencode-ai/sdk/v2/client"
import type { AccountSummary, AuthState } from "../src/preload/types"
import type { EffectiveCatalog, ProviderKeyStatus } from "../src/shared/alpha-model-types"
import type { AlphaProjectsApi } from "../src/renderer/sidebar/use-projects"
import type { AlphaComposerRuntimeProps } from "../src/renderer/alpha-ui/alpha-composer"
import type { ModelContract } from "../src/renderer/alpha-ui/model-contract"

GlobalRegistrator.register()
const solid = await import("solid-js/dist/solid.js")
mock.module("solid-js", () => solid)
const solidWeb = await import("solid-js/web/dist/web.js")
mock.module("solid-js/web", () => solidWeb)
const { createComponent, createSignal } = solid
const { render } = solidWeb

class ObserverStub {
  callback: (entries: { target: Element; isIntersecting: boolean }[], observer: ObserverStub) => void
  constructor(callback: ObserverStub["callback"]) {
    this.callback = callback
  }
  observe(el: Element) {
    this.callback([{ target: el, isIntersecting: true }], this)
  }
  unobserve() {}
  disconnect() {}
}
;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = ObserverStub
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

mock.module("@opencode-ai/session-ui/markdown", () => ({
  Markdown: (props: { text?: string; class?: string }) => {
    const el = document.createElement("div")
    if (props.class) el.className = props.class
    solid.createRenderEffect(() => {
      el.textContent = props.text ?? ""
    })
    return el
  },
}))

const SESSION_ID = "ses_652"
const DIRECTORY = "/tmp/workspace"

/* ── 假 sidecar ────────────────────────────────────────────────────────────────
   一个进程内的引擎替身,两条发送端点都在,行为照生产实测。 */
type StoreMessage = Record<string, unknown>
const engine = {
  /** v1 消息表(alpha 时间线消费的那张)。 */
  message: {} as Record<string, StoreMessage[]>,
  part: {} as Record<string, StoreMessage[]>,
  session_status: {} as Record<string, { type: string }>,
  session_diff: {} as Record<string, unknown[]>,
  todo: {} as Record<string, unknown[]>,
  info: {} as Record<string, unknown>,
  /** v2 durable 表(`session_message`)—— 引擎写得下,alpha 的 store 读不出来。 */
  v2SessionMessages: [] as Array<Record<string, unknown>>,
  /** v2 的事件日志(session.next.*)—— alpha reducer 零 case,没有任何渲染路径。 */
  v2Events: [] as Array<{ type: string; detail?: unknown }>,
  v1Prompts: [] as Array<Record<string, unknown>>,
  v2Prompts: [] as Array<Record<string, unknown>>,
  createdSessions: [] as string[],
  seq: 0,
}

function resetEngine() {
  engine.message = { [SESSION_ID]: [] }
  engine.part = {}
  engine.session_status = {}
  engine.session_diff = {}
  engine.todo = {}
  engine.info = { [SESSION_ID]: { id: SESSION_ID, title: "整理架构说明", directory: DIRECTORY } }
  engine.v2SessionMessages = []
  engine.v2Events = []
  engine.v1Prompts = []
  engine.v2Prompts = []
  engine.createdSessions = []
  engine.seq = 0
}
resetEngine()

/** store 变更要让 Solid 重算:用一个版本 signal 当依赖(等价于 serverSync 的响应式 store)。 */
const [storeVersion, bumpStoreVersion] = createSignal(0, { equals: false })

/** v1 引擎受理一条 prompt:落用户消息 + 助手回复(与 message.updated 投影同形)。 */
function v1Admit(sessionID: string, parts: Array<Record<string, unknown>>, agent: string | undefined) {
  const n = ++engine.seq
  const userID = `msg_u${n}`
  const assistantID = `msg_a${n}`
  const text = parts.find((part) => part["type"] === "text")?.["text"]
  const messages = (engine.message[sessionID] ??= [])
  messages.push({
    id: userID,
    sessionID,
    role: "user",
    time: { created: 1000 + n },
    agent: agent ?? "build",
    model: { providerID: "deepseek", modelID: "deepseek-reasoner" },
  })
  engine.part[userID] = [{ id: `prt_u${n}`, sessionID, messageID: userID, type: "text", text }]
  messages.push({
    id: assistantID,
    sessionID,
    role: "assistant",
    time: { created: 1000 + n, completed: 1001 + n },
    parentID: userID,
    modelID: "deepseek-reasoner",
    providerID: "deepseek",
    mode: agent ?? "build",
    agent: agent ?? "build",
    path: { cwd: DIRECTORY, root: DIRECTORY },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  engine.part[assistantID] = [
    { id: `prt_a${n}`, sessionID, messageID: assistantID, type: "text", text: `回复第 ${n} 条` },
  ]
  bumpStoreVersion((value) => value + 1)
}

/** v2 引擎受理一条 prompt:200 OK + admittedSeq,随后 401 死在 step —— UI 侧零投影。 */
function v2Admit(sessionID: string, delivery: string) {
  const seq = engine.v2SessionMessages.length + 20
  engine.v2SessionMessages.push({ seq, sessionID, type: "user" })
  engine.v2Events.push({ type: "session.next.prompt.admitted.1", detail: { seq } })
  engine.v2Events.push({ type: "session.next.prompted.1" })
  engine.v2Events.push({ type: "session.next.step.started.1" })
  engine.v2Events.push({
    type: "session.next.step.failed.2",
    detail: { error: "Provider request failed with HTTP 401: Authentication Fails (governor)" },
  })
  return { data: { admittedSeq: seq, delivery } }
}

const sdkClient = {
  command: { list: async () => ({ data: [] }) },
  session: {
    create: async () => {
      engine.createdSessions.push(SESSION_ID)
      return { data: { id: SESSION_ID } }
    },
    promptAsync: async (args: Record<string, unknown>) => {
      engine.v1Prompts.push(args)
      const sessionID = String(args["sessionID"])
      if (engine.info[sessionID] === undefined) return { error: { status: 404 } }
      v1Admit(sessionID, (args["parts"] as Array<Record<string, unknown>>) ?? [], args["agent"] as string | undefined)
      return {}
    },
    command: async () => ({ data: {} }),
    abort: async () => ({}),
  },
  v2: {
    session: {
      get: async (args: { sessionID: string }) => ({ data: { data: { id: args.sessionID, agent: undefined } } }),
      prompt: async (args: Record<string, unknown>) => {
        engine.v2Prompts.push(args)
        return v2Admit(String(args["sessionID"]), String(args["delivery"] ?? "steer"))
      },
      switchAgent: async () => ({}),
      switchModel: async () => ({}),
      permission: { list: async () => ({ data: { data: [] } }) },
    },
  },
}

mock.module("@solidjs/router", () => ({ useNavigate: () => () => {} }))
mock.module("../src/renderer/alpha-ui/session-workspace/alpha-session-workspace", () => ({
  useAlphaSessionLiveContext: () => ({
    current: () => ({
      identity: { serverKey: "sidecar", directory: DIRECTORY, sessionID: SESSION_ID },
      title: "整理架构说明",
    }),
    accepts: () => true,
  }),
}))
mock.module("@opencode-ai/app", () => ({
  useServerSDK: () => () => ({ client: sdkClient }),
  useServerSync: () => () => ({
    session: {
      sync: () => Promise.resolve(),
      get data() {
        storeVersion()
        return engine
      },
      history: { more: () => false, loading: () => false, loadMore: () => Promise.resolve() },
    },
  }),
}))

const command = { options: [], trigger: () => {} } as unknown as AlphaComposerRuntimeProps["command"]
mock.module("../src/renderer/alpha-ui/providers", () => ({ useCommand: () => command }))

Bun.plugin({
  name: "session-second-send-component-test",
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

const { AlphaComposerRuntime } = await import("../src/renderer/alpha-ui/alpha-composer")
const { AlphaSessionTimeline } = await import("../src/renderer/alpha-ui/session-timeline/session-timeline")
const { composerModel, resetComposerModelProjection, setComposerAgent, setComposerModel } = await import(
  "../src/renderer/alpha-ui/composer-state"
)

/* ── composer 的模型链前置(与既有 composer 组件用例同一套 fixture)────────────── */
const catalog = {
  ...(await Bun.file(new URL("../src/main/alpha-models.json", import.meta.url)).json()),
  liveSync: { status: "static" },
} as EffectiveCatalog
const modelInfo = (providerID: string, id: string, name = id): ModelV2Info => ({
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
const platformModels = catalog.platformModels.map((model) =>
  modelInfo(catalog.platformProvider.id, model.id, model.name),
)
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
Object.defineProperty(window, "api", {
  configurable: true,
  value: {
    endpoints: async () => null,
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
  },
})

const readyContract = (): ModelContract => ({
  list: async () => platformModels,
  current: async () => ({ providerID: catalog.platformProvider.id, id: catalog.platformModels[0]!.id }),
  switch: async () => {},
})

const projects = {
  store: { projects: [], ready: true, error: false },
  reload: async () => {},
  createSession: async () => undefined,
  /** 首页入口:与生产 use-projects.startChat 同样的两步(v1 session.create + v1 promptAsync)。
   *  第一条消息走的就是这条 —— #652 里它一直是好的,坏的只有会话页那条。 */
  startChat: async (_directory: string, text: string, extraParts?: unknown[]) => {
    const created = await sdkClient.session.create()
    const id = created.data.id
    const prompted = await sdkClient.session.promptAsync({
      sessionID: id,
      parts: [{ type: "text", text }, ...((extraParts as Array<Record<string, unknown>>) ?? [])],
    })
    if ((prompted as { error?: unknown }).error !== undefined) return undefined
    return id
  },
  sdk: () => sdkClient as never,
  renameSession: async () => false,
  shareSession: async () => undefined,
  deleteSession: async () => false,
  copySession: async () => undefined,
} satisfies AlphaProjectsApi

const disposers: Array<() => void> = []
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
async function waitFor(assertion: () => void) {
  let failure: unknown
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      assertion()
      return
    } catch (error) {
      failure = error
      await flush()
    }
  }
  throw failure
}

/** 生产会话页的三块,同一棵树、同一个假 sidecar:
 *  timeline(呈现面)+ session composer(会话内发送)+ home composer(首页入口)。
 *  两个 composer 都是生产 AlphaComposerRuntime,只是 mode 不同 —— 这正是 #652 里
 *  「第一条好、第二条起坏」的那条分界线所在。 */
function mountSessionSurface(running: () => boolean) {
  const host = document.createElement("div")
  document.body.append(host)
  disposers.push(
    render(
      () => [
        createComponent(AlphaSessionTimeline, {}),
        createComponent(AlphaComposerRuntime, {
          mode: "session",
          projects,
          directory: () => DIRECTORY,
          sessionID: () => SESSION_ID,
          command,
          modelContract: readyContract(),
          sessionDock: { running, contextUsage: () => null, approvalPending: () => false },
        }),
        createComponent(AlphaComposerRuntime, {
          mode: "home",
          projects,
          directory: () => DIRECTORY,
          command,
          modelContract: readyContract(),
        }),
      ],
      host,
    ),
  )
  return host
}

const surfaceOf = (host: HTMLElement, mode: "home" | "session") =>
  host.querySelector<HTMLElement>(`[data-alpha-composer="${mode}"]`)!

async function send(host: HTMLElement, mode: "home" | "session", text: string) {
  const surface = surfaceOf(host, mode)
  const textarea = surface.querySelector("textarea")!
  textarea.value = text
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }))
  await waitFor(() => expect(surface.querySelector<HTMLButtonElement>(".a-comp-send")?.disabled).toBe(false))
  surface.querySelector<HTMLButtonElement>(".a-comp-send")!.click()
}

beforeEach(() => {
  resetEngine()
  bumpStoreVersion((value) => value + 1)
  document.body.replaceChildren()
})
afterEach(() => {
  disposers.splice(0).reverse().forEach((dispose) => dispose())
  document.body.replaceChildren()
  setComposerModel(null)
  setComposerAgent(null)
  resetComposerModelProjection()
})
afterAll(() => GlobalRegistrator.unregister())

describe("#652 会话内连发三条:每一条都必须渲染出来", () => {
  test("第 1 条走首页、第 2/3 条走会话页 —— 三条都渲染出回复(生产那条分界线本身)", async () => {
    const host = mountSessionSurface(() => false)
    await waitFor(() => expect(composerModel()?.id).toBe(catalog.platformModels[0]!.id))

    // —— 第 1 条:首页入口(#652 里这条一直是好的)——
    await send(host, "home", "第一条消息")
    await waitFor(() => expect(host.textContent).toContain("第一条消息"))
    await waitFor(() => expect(host.textContent).toContain("回复第 1 条"))
    expect(engine.createdSessions).toEqual([SESSION_ID])

    // 第 2 条发出去之前,先把「这真是后续消息」钉死:会话已有一轮完整对话在场,
    // 而且接下来这一次**不会**再新建会话 —— 排掉「两次都被判成新会话」这个已知陷阱
    // (#652 的旧用例正是栽在这:params 被重置成 {},两次都判新会话,后续分支覆盖率 0%)。
    expect(engine.message[SESSION_ID]).toHaveLength(2)

    // —— 第 2 条:会话页 composer(#652 里这条起静默失效)——
    await send(host, "session", "第二条消息")
    await waitFor(() => expect(host.textContent).toContain("第二条消息"))
    await waitFor(() => expect(host.textContent).toContain("回复第 2 条"))

    // —— 第 3 条:同一条路径再来一次 ——
    await send(host, "session", "第三条消息")
    await waitFor(() => expect(host.textContent).toContain("第三条消息"))
    await waitFor(() => expect(host.textContent).toContain("回复第 3 条"))

    // 三条都落在**同一个既有会话**上(只在第 1 条建了一次会话),
    // 而且没有一条走进 v2 那条零成功的链路。
    expect(engine.v1Prompts.map((prompt) => prompt["sessionID"])).toEqual([SESSION_ID, SESSION_ID, SESSION_ID])
    expect(engine.createdSessions).toEqual([SESSION_ID])
    expect(engine.v2Prompts).toEqual([])
    expect(engine.v2SessionMessages).toEqual([])
    // 前一条的回复不会因为后一条而消失(「只显示最后一轮」也是一种静默丢失)。
    expect(host.textContent).toContain("回复第 1 条")
  })

  test("运行中发送:输入照样送达并渲染 —— 占位文案说的「发送后排队」是真的", async () => {
    const host = mountSessionSurface(() => true)
    await waitFor(() => expect(composerModel()?.id).toBe(catalog.platformModels[0]!.id))
    // 运行中发送键呈停止形态,Enter 仍是发送路径。
    await waitFor(() => expect(host.querySelector(".a-comp-stop")).not.toBeNull())

    const textarea = host.querySelector("textarea")!
    textarea.value = "运行中补一句"
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: "运行中补一句" }))
    await flush()
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))

    await waitFor(() => expect(host.textContent).toContain("运行中补一句"))
    await waitFor(() => expect(host.textContent).toContain("回复第 1 条"))
    expect(engine.v2Prompts).toEqual([])
  })

  test("引擎拒绝这条发送时不静默:正文留在输入框,时间线上不凭空多出一轮", async () => {
    const host = mountSessionSurface(() => false)
    await waitFor(() => expect(composerModel()?.id).toBe(catalog.platformModels[0]!.id))
    await send(host, "home", "第一条消息")
    await waitFor(() => expect(host.textContent).toContain("回复第 1 条"))

    // 会话在引擎侧消失(重启/清理):v1 promptAsync 回 { error } 信封。
    delete engine.info[SESSION_ID]
    await send(host, "session", "会被拒绝的一条")
    await waitFor(() => expect(engine.v1Prompts).toHaveLength(2))
    await flush()

    expect(host.querySelector("textarea")!.value).toBe("会被拒绝的一条")
    expect(engine.message[SESSION_ID]).toHaveLength(2)
  })
})
