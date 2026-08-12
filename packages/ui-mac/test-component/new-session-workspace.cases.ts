// REQ-126 CODE-D（#657）——「新对话页工作区选择器 + 切目录不吞内容」的**真组件**闸门。
//
// 独立进程运行:mock.module 会污染同进程其它测试文件(与 alpha-composer-model.cases.ts 同因)。
//
// 本文件的判据全部是**可观察结果**:真实挂载 AlphaNewSession / AlphaHome(内含真实
// AlphaComposer),对真实 DOM 点击、真实输入,再断言 DOM 与真实回调收到的值。**不断言源码文本**。
//
// 关键形制:切目录的重挂在这里是**真的** —— harness 复刻上游 `createDraftRoute` 的
// `<Show when={`${server}\0${directory}`} keyed>`(packages/app/src/app.tsx),并在
// `startTransition` 里改 draft(与上游 `tabs.updateDraft` 同路)。每条内容保护用例都先断言
// 「textarea 是新的 DOM 节点」,以证明确实发生了重挂 —— 否则「内容还在」什么也不证明。

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { transformAsync } from "@babel/core"
import presetTypescript from "@babel/preset-typescript"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import presetSolid from "babel-preset-solid"
import type { AlphaProject, AlphaProjectsApi } from "../src/renderer/sidebar/use-projects"
import type { ComposerAttachment } from "../src/renderer/alpha-ui/composer-attachments-core"
import type { MentionPart } from "../src/renderer/alpha-ui/composer-autocomplete-core"
import { ALPHA_V2_CATALOG_READY_PROVIDER_ID } from "../src/shared/alpha-config"

GlobalRegistrator.register()
const solid = await import("solid-js/dist/solid.js")
mock.module("solid-js", () => solid)
const solidWeb = await import("solid-js/web/dist/web.js")
mock.module("solid-js/web", () => solidWeb)
const { createComponent, createSignal, startTransition } = solid
const { render } = solidWeb

Bun.plugin({
  name: "new-session-workspace-component-tests",
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

/* ── seams the leaf borrows from upstream / the router ─────────────────────────
   AlphaNewSession reads the draft through upstream `useTabs()` and clears `?prompt=`
   through the router; both are replaced with observable fakes so the assertions can be
   about *what the page asked for*, not about internal calls. */
// #891:「当会话身份用就是错的」的值在本文件里被**故意钉成与 store 的 server 不同**:
// `useServer().key`(当前 active server)恒为 ACTIVE_SERVER_KEY,任一叶回头去读它,判据当场红。
// 首页/新对话页的会话是 `projects.startChat` 在 **store 连着的那个 server** 上建的,身份只能是
// 后者。draft 的 server 段:#925 起 alpha-sidebar 建的 draft 已钉在 projects key 上,且
// AlphaNewSession 在唯一消费者处把不同值的 draft 收口钉回(#925 审计 Major,上游 Titlebar 的
// 「+ 新标签」/ mod+t 仍按 active server 建 draft)—— 所以本文件默认 draft 带 STORE_SERVER_KEY
// (生产两头收口后的稳态),「上游入口建的 wrong-server draft」由 #925 那组用例显式铺设。
const ACTIVE_SERVER_KEY = "wsl:ubuntu"
/** `projects` 这份 store 真正连着的 server(生产由 `index.tsx` 的 `projectsServerKey` 反查)。 */
const STORE_SERVER_KEY = "sidecar"
/** #894:第三个 server —— 请求在途期间 store 改连到它。三个互不相同,负向夹具才不是退化形状
 *  (两个值时「取另一个」也能蒙对)。 */
const LATER_SERVER_KEY = "wsl:debian"
/** #894 R1 审计:第四个 server —— **第二条用例提交那一刻** store 连的是它,而不是 `STORE_SERVER_KEY`。
 *  两条用例都从 `"sidecar"` 提交时,一个把 href 写死成 `"sidecar"` 的实现两条全绿(生产今天
 *  `projectsServerKey` 恒为 `sidecar`,行为等价 ⇒ 有人真会那么写);提交时的 key 两条不同,
 *  写死单值就同时满足不了 —— 这是本仓「期望值恰好等于一个可硬编码的常量」那一形态的闸。 */
const SUBMIT_TIME_SERVER_KEY = "wsl:fedora"

type DraftRecord = { server: string; directory: string }
const [draft, setDraft] = createSignal<DraftRecord>({ server: STORE_SERVER_KEY, directory: "/ws/a" })
// 上游 tabs.store 的最小形状:哪些 draft 还活着(关掉 = 从这里消失)。
const [liveDrafts, setLiveDrafts] = createSignal<string[]>(["draft-1"])
const updateDraftCalls: Array<{ draftID: string; patch: Partial<DraftRecord> }> = []
const tabs = {
  get store() {
    return liveDrafts().map((draftID) => ({ type: "draft", draftID }))
  },
  draft: () => draft(),
  updateDraft: (draftID: string, patch: Partial<DraftRecord>) => {
    updateDraftCalls.push({ draftID, patch })
    // 与上游 tabs.updateDraft 同路:store 写在 startTransition 内(叶重挂的真实触发方式)。
    void startTransition(() => setDraft((current) => ({ ...current, ...patch })))
  },
}
/** 上游 `useServer()` 的最小形状。故意只给 active server —— 任何叶把它当会话身份用都会被判据抓住。 */
const server = {
  get key() {
    return ACTIVE_SERVER_KEY
  },
}
mock.module("@opencode-ai/app", () => ({
  useTabs: () => tabs,
  useServer: () => server,
  // #925:生产的 `ServerConnection.Key.make` 就是 brand cast(packages/app/src/context/server.tsx:238),
  // 这里如实照抄 —— 收口 effect 写回 draft 的值不经任何变换。
  ServerConnection: { Key: { make: (v: string) => v } },
}))
/** #894:叶真正跳去了哪里。路由本体不参与 —— 记的是叶交给 `useNavigate()` 的那个 href,
 *  再由生产的 `parseRoute` 读回去,编码与解码是两条相反的路,不构成自指等价链。 */
const navigateCalls: string[] = []
mock.module("@solidjs/router", () => ({
  useSearchParams: () => [{}, () => {}],
  useNavigate: () => (href: string) => {
    navigateCalls.push(href)
  },
}))
const command = { options: [], trigger: () => {} }
mock.module("../src/renderer/alpha-ui/providers", () => ({
  useCommand: () => command,
  useContractHealth: () => () => null,
}))

const { AlphaNewSession } = await import("../src/renderer/alpha-ui/alpha-new-session")
const { AlphaHome } = await import("../src/renderer/alpha-ui/AlphaHome")
const { parseRoute } = await import("../src/shared/route-manifest")
const { newSessionDraftStash } = await import("../src/renderer/alpha-ui/new-session-draft-stash")
const { ToastViewport } = await import("../src/renderer/alpha-ui/Toast")
const { dict: zh } = await import("../src/renderer/i18n/zh")
const {
  resetComposerAgentScopesForTests,
  resetComposerModelProjection,
  resetComposerPermScopesForTests,
  setComposerAgent,
  setComposerModel,
} = await import("../src/renderer/alpha-ui/composer-state")
// #891 判据要跑**会话页那一侧的真实 adopt**(不是自己拼一条等价链):seed 写进去的钥匙,
// 只有 SessionComposerMount 按 canonical 身份算出同一把时才认领得到。
const { SessionComposerMount } = await import(
  "../src/renderer/alpha-ui/session-workspace/session-composer-mount"
)
const { createComposerDraftStash } = await import(
  "../src/renderer/alpha-ui/session-workspace/session-dock-core"
)

const DEFAULT_WORKSPACE = "/Users/tester/Alpha"

/* ── model chain fixture:composer 不 ready 就不肯提交,而本文件的判据里有两条要走真提交。
      形制照搬 alpha-composer-model.cases.ts:真出厂目录 + 已登录平台账户。 ────────────── */
const catalog = {
  ...(await Bun.file(new URL("../src/main/alpha-models.json", import.meta.url)).json()),
  liveSync: { status: "static" },
  // #681:平台段没有有效 V2/LKG 时 basis 为 null(该 stub 不带远端目录)。
  pricingBasisModelId: null,
}
const modelInfo = (providerID: string, id: string, name = id) => ({
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
const platformModels = (catalog.platformModels as Array<{ id: string; name: string }>).map((model) =>
  modelInfo((catalog.platformProvider as { id: string }).id, model.id, model.name),
)
const providerKeys = Object.fromEntries(
  (catalog.byokProviders as Array<{ id: string }>).map((provider) => [provider.id, { configured: false, source: "none" }]),
)
const accountSummary = {
  balanceFen: 100_000,
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

const project = (name: string, worktree: string): AlphaProject => ({
  id: name,
  worktree,
  name,
  directories: [worktree],
  sessions: [],
  loaded: true,
})

const startChatCalls: Array<{ directory: string; body: string; parts: unknown[] }> = []
/** #888:会话页那一侧**真发**出去的载荷。chip 只证明界面显示对了,这里证明它真的上了线。 */
const promptAsyncCalls: Array<Record<string, unknown>> = []
/** #894:让「会话创建在途」这段窗口真的存在 —— 生产上正是这段时间里用户可以切 server。 */
let startChatGate: { promise: Promise<void>; release: () => void } | undefined
function gateStartChat() {
  let release!: () => void
  const promise = new Promise<void>((next) => (release = () => next()))
  startChatGate = { promise, release }
  return startChatGate
}
function projectsApi(projects: AlphaProject[]): AlphaProjectsApi {
  return {
    store: { projects, ready: true, error: false },
    reload: async () => {},
    createSession: async () => undefined,
    startChat: async (directory: string, body: string, parts?: unknown[]) => {
      startChatCalls.push({ directory, body, parts: parts ?? [] })
      if (startChatGate) await startChatGate.promise
      return "session-1"
    },
    sdk: () =>
      ({
        command: { list: async () => ({ data: [] }) },
        find: { files: async () => ({ data: [] }) },
        vcs: { status: async () => ({ data: [] }) },
        // #652 起会话内发送与首页 startChat 同走 v1 session.promptAsync。
        session: {
          promptAsync: async (args: Record<string, unknown>) => {
            promptAsyncCalls.push(args)
            return {}
          },
        },
        v2: {
          agent: { list: async () => ({ data: { data: [] } }) },
          provider: {
            get: async () => ({ data: { data: { id: ALPHA_V2_CATALOG_READY_PROVIDER_ID } } }),
          },
          model: { list: async () => ({ data: { data: platformModels } }) },
          session: {
            get: async () => ({ data: { data: { id: "s", model: undefined, agent: undefined } } }),
            switchModel: async () => ({}),
          },
        },
      }) as never,
    renameSession: async () => false,
    shareSession: async () => undefined,
    deleteSession: async () => false,
    copySession: async () => undefined,
  } as unknown as AlphaProjectsApi
}

let pickedDirectory: string | undefined
const pickerCalls: number[] = []
/** 默认对话目录的解析可控:undefined = 立即返回;否则返回一个测试自己 resolve 的 promise。 */
let defaultWorkspaceGate: { promise: Promise<string>; resolve: (dir: string) => void } | undefined
function installApi() {
  Object.defineProperty(window, "api", {
    configurable: true,
    value: {
      endpoints: async () => null,
      openLink: () => {},
      openPath: () => {},
      workspaceDefaultDir: () => defaultWorkspaceGate?.promise ?? Promise.resolve(DEFAULT_WORKSPACE),
      openDirectoryPicker: async () => {
        pickerCalls.push(1)
        return pickedDirectory
      },
      models: { catalog: async () => catalog },
      auth: { getState: async () => ({ status: "logged-in", mode: "platform" }), subscribe: () => () => {}, start: async () => {} },
      account: { summary: async () => accountSummary },
      providers: { keyStatus: async () => providerKeys },
      config: { health: async () => ({ broken: false }), subscribe: () => () => {} },
      contracts: { health: async () => null, subscribe: () => () => {} },
    },
  })
}

const disposers: Array<() => void> = []
function mount(view: () => unknown) {
  const host = document.createElement("div")
  document.body.append(host)
  disposers.push(render(view as () => never, host))
  return host
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const textarea = (host: HTMLElement) => host.querySelector<HTMLTextAreaElement>("textarea.a-comp-input")
const chipButton = (host: HTMLElement) => host.querySelector<HTMLButtonElement>("button.a-ws-chip")!
const popItems = (host: HTMLElement) => Array.from(host.querySelectorAll<HTMLButtonElement>(".a-pop-item"))
const attachmentNames = (host: HTMLElement) =>
  Array.from(host.querySelectorAll(".a-comp-att .a-comp-att-name")).map((el) => el.textContent)

function type(el: HTMLTextAreaElement, value: string) {
  el.value = value
  el.dispatchEvent(new Event("input", { bubbles: true }))
}

async function openChipAndPick(host: HTMLElement, label: string) {
  chipButton(host).click()
  await flush()
  const item = popItems(host).find((button) => (button.textContent ?? "").includes(label))
  expect(item, `chip 条目「${label}」不存在:${popItems(host).map((b) => b.textContent)}`).toBeDefined()
  item!.click()
  await flush()
  await flush()
}

const attachment = (id: string, name: string): ComposerAttachment => ({
  id,
  name,
  mime: "image/png",
  kind: "image",
  size: 1024,
  url: `data:image/png;base64,${id}`,
})
const mention: MentionPart = { type: "file", path: "src/a.ts", content: "@src/a.ts" }

const toastTitles = () => Array.from(document.querySelectorAll(".a-toast-body b")).map((el) => el.textContent)
function mountToasts() {
  const host = document.createElement("div")
  document.body.append(host)
  disposers.push(render(() => createComponent(ToastViewport, {}) as never, host))
}

/** 可控 FileReader:readAsDataURL 挂起,直到测试显式 release —— 复刻「附件还在读盘」那段窗口。 */
class PendingFileReader {
  static pending: PendingFileReader[] = []
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  error: unknown = null
  result: string | null = null
  readAsDataURL() {
    PendingFileReader.pending.push(this)
  }
  release(url: string) {
    this.result = url
    this.onload?.()
  }
  abort() {
    this.onabort?.()
  }
}
function gateDefaultWorkspace() {
  let resolve!: (dir: string) => void
  const promise = new Promise<string>((next) => (resolve = next))
  defaultWorkspaceGate = { promise, resolve }
  return defaultWorkspaceGate
}
function pasteFile(el: HTMLTextAreaElement, file: File) {
  const event = new Event("paste", { bubbles: true, cancelable: true })
  Object.defineProperty(event, "clipboardData", { value: { files: [file] } })
  el.dispatchEvent(event)
}

/** #925:上游 `createDraftRoute` 的 `promoteDraft` 按 **`props.draft.server` 晋升那一刻的值**建
 *  session tab 并导航(packages/app/src/app.tsx:272-277)—— 这里如实照抄那次读取并记下来。
 *  它就是「打开的是哪台机器」的决定值:断言落在它身上,而不是某个内部 memo。 */
const promoteCalls: Array<{ server: string; sessionId: string }> = []
function DraftLeaf(props: { projects: AlphaProjectsApi; draftId?: string; serverKey?: () => string | undefined }) {
  // 上游 createDraftRoute 的 keyed 包装(packages/app/src/app.tsx):server/directory 变 ⇒ 整叶重挂。
  return createComponent(solid.Show, {
    get when() {
      return `${draft().server}\0${draft().directory}`
    },
    keyed: true,
    get children() {
      return createComponent(AlphaNewSession, {
        projects: props.projects,
        // #891:生产由 index.tsx 的 `projectsServerKey` 供给(store 的 baseUrl 反查),这里同源:
        // 这份 `projects` 连的就是 STORE_SERVER_KEY(#925 的用例用自己的 key 覆盖,两组字面量
        // 互不相同 —— 写死单值的实现过不了)。
        serverKey: props.serverKey ?? (() => STORE_SERVER_KEY),
        draftId: props.draftId ?? "draft-1",
        promoteDraft: (session: { sessionId: string }) => {
          promoteCalls.push({ server: draft().server, sessionId: session.sessionId })
        },
      })
    },
  })
}

beforeEach(() => {
  installApi()
  newSessionDraftStash.resetForTests()
  updateDraftCalls.splice(0)
  startChatCalls.splice(0)
  promptAsyncCalls.splice(0)
  navigateCalls.splice(0)
  startChatGate = undefined
  pickerCalls.splice(0)
  pickedDirectory = undefined
  defaultWorkspaceGate = undefined
  setLiveDrafts(["draft-1"])
  setDraft({ server: STORE_SERVER_KEY, directory: "/ws/a" })
  promoteCalls.splice(0)
  document.body.replaceChildren()
})

afterEach(() => {
  disposers.splice(0).reverse().forEach((dispose) => dispose())
  setComposerModel(null)
  setComposerAgent(null)
  resetComposerModelProjection()
  // #891:档位/只读档的作用域登记是**模块级**的,跨用例会串(与 signal 本身同理)。
  resetComposerAgentScopesForTests()
  resetComposerPermScopesForTests()
  document.body.replaceChildren()
})

afterAll(() => GlobalRegistrator.unregister())

describe("REQ-126 CODE-D 新对话页工作区选择器", () => {
  test("选中项目 ⇒ draft 目录真的换了(updateDraft 收到新目录,页面随之改显示)", async () => {
    const host = mount(() => createComponent(DraftLeaf, { projects: projectsApi([project("alpha-code", "/ws/a"), project("beta", "/ws/b")]) }))
    await flush()
    expect(chipButton(host).textContent).toContain("alpha-code")

    await openChipAndPick(host, "beta")

    expect(updateDraftCalls).toEqual([{ draftID: "draft-1", patch: { directory: "/ws/b" } }])
    expect(draft().directory).toBe("/ws/b")
    expect(chipButton(host).textContent).toContain("beta")
    expect(host.querySelector("h1")?.textContent).toContain("beta")
  })

  test("「打开项目…」选到的新目录同样即时生效(未注册项目走路径末段标签)", async () => {
    pickedDirectory = "/ws/fresh-dir"
    const host = mount(() => createComponent(DraftLeaf, { projects: projectsApi([project("alpha-code", "/ws/a")]) }))
    await flush()

    chipButton(host).click()
    await flush()
    popItems(host).at(-1)!.click() // 「打开项目…」永远是最后一项
    await flush()
    await flush()

    expect(pickerCalls).toHaveLength(1)
    expect(updateDraftCalls).toEqual([{ draftID: "draft-1", patch: { directory: "/ws/fresh-dir" } }])
    expect(chipButton(host).textContent).toContain("fresh-dir")
  })

  test("未显式选择(draft 无目录)⇒ chip 与标题都显示默认对话目录 ~/Alpha", async () => {
    setDraft({ server: STORE_SERVER_KEY, directory: "" })
    const host = mount(() => createComponent(DraftLeaf, { projects: projectsApi([project("alpha-code", "/ws/a")]) }))
    await flush()
    await flush()

    expect(chipButton(host).textContent).toContain("Alpha")
    expect(chipButton(host).textContent).not.toContain("alpha-code")
    expect(host.querySelector("h1")?.textContent).toContain("Alpha")
    // 默认对话目录未注册为项目 ⇒ 它作为常驻首项出现在列表里,选中态在它身上。
    chipButton(host).click()
    await flush()
    expect(popItems(host)[0]?.className).toContain("is-on")
  })
})

describe("REQ-126 CODE-D 切目录不吞内容(真重挂)", () => {
  test("文本 / mention / 附件在切目录后仍在,且是**切换前那一刻**的内容", async () => {
    // 先播种一份「已在输入」的草稿(经暂存注入 —— 这是 mention/附件唯一能被真实置入的入口),
    // 再在 UI 上**改动**它:改文本 + 删掉一个附件。若写穿捕获没生效,重挂后回来的会是播种的
    // 原样(两个附件 + 旧文本),断言就红 —— 这条不是自证。
    newSessionDraftStash.capture("draft-1", {
      text: "看下 @src/a.ts",
      mentions: [mention],
      attachments: [attachment("att-1", "one.png"), attachment("att-2", "two.png")],
      pendingReads: [],
    })
    const host = mount(() => createComponent(DraftLeaf, { projects: projectsApi([project("alpha-code", "/ws/a"), project("beta", "/ws/b")]) }))
    await flush()

    const before = textarea(host)!
    expect(before.value).toBe("看下 @src/a.ts")
    expect(attachmentNames(host)).toEqual(["one.png", "two.png"])

    type(before, "看下 @src/a.ts 的登录分支")
    host.querySelectorAll<HTMLButtonElement>(".a-comp-att .a-comp-att-x")[1]!.click()
    await flush()
    expect(attachmentNames(host)).toEqual(["one.png"])

    await openChipAndPick(host, "beta")

    const after = textarea(host)!
    expect(after).not.toBe(before) // 真发生了重挂(否则下面的断言什么也不证明)
    expect(draft().directory).toBe("/ws/b")
    expect(after.value).toBe("看下 @src/a.ts 的登录分支")
    expect(attachmentNames(host)).toEqual(["one.png"])
  })

  test("重挂后提交:mention 与附件真的随请求发出去(不是只留在框里)", async () => {
    newSessionDraftStash.capture("draft-1", {
      text: "看下 @src/a.ts",
      mentions: [mention],
      attachments: [attachment("att-1", "one.png")],
      pendingReads: [],
    })
    const host = mount(() => createComponent(DraftLeaf, { projects: projectsApi([project("alpha-code", "/ws/a"), project("beta", "/ws/b")]) }))
    await flush()
    type(textarea(host)!, "看下 @src/a.ts 现在")
    await flush()

    await openChipAndPick(host, "beta")

    const form = textarea(host)!
    expect(form.value).toBe("看下 @src/a.ts 现在")
    // 直接驱动真实提交路径(Enter),断言引擎侧真的收到 mention part 与附件 part。
    form.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
    for (let i = 0; i < 20 && startChatCalls.length === 0; i++) await flush()

    expect(startChatCalls).toHaveLength(1)
    expect(startChatCalls[0]!.directory).toBe("/ws/b")
    expect(startChatCalls[0]!.parts).toEqual([
      { type: "file", mime: "text/plain", url: "file:///ws/b/src/a.ts", filename: "a.ts" },
      { type: "file", mime: "image/png", url: "data:image/png;base64,att-1", filename: "one.png" },
    ])
  })

  test("20,001 字切目录后一字不少(暂存不得有任何长度帽)", async () => {
    const host = mount(() => createComponent(DraftLeaf, { projects: projectsApi([project("alpha-code", "/ws/a"), project("beta", "/ws/b")]) }))
    await flush()
    const long = "字".repeat(20_001)
    const before = textarea(host)!
    type(before, long)
    await flush()

    await openChipAndPick(host, "beta")

    const after = textarea(host)!
    expect(after).not.toBe(before) // 真重挂
    expect(after.value.length).toBe(20_001) // 先报长度:截断时的失败信息才读得懂
    expect(after.value).toBe(long)
  })

  test("附件还在读盘时切目录被拦下并明确提示;读完再切,附件跟着走", async () => {
    mountToasts()
    const realFileReader = globalThis.FileReader
    ;(globalThis as { FileReader: unknown }).FileReader = PendingFileReader
    try {
      const host = mount(() => createComponent(DraftLeaf, { projects: projectsApi([project("alpha-code", "/ws/a"), project("beta", "/ws/b")]) }))
      await flush()
      const before = textarea(host)!
      type(before, "看这张图")
      pasteFile(before, new File(["png-bytes"], "shot.png", { type: "image/png" }))
      await flush()
      expect(PendingFileReader.pending).toHaveLength(1) // 读取真的挂起了
      expect(attachmentNames(host)).toEqual([]) // 此刻附件还不在 composer 里

      // 挂起期间切目录:必须被拦下(draft 目录没变、没重挂),且用户看得到原因。
      chipButton(host).click()
      await flush()
      popItems(host).find((button) => (button.textContent ?? "").includes("beta"))!.click()
      await flush()
      await flush()
      expect(updateDraftCalls).toEqual([])
      expect(draft().directory).toBe("/ws/a")
      expect(textarea(host)).toBe(before) // 没重挂
      expect(toastTitles()).toContain(zh["alpha.newSession.attachmentReadPending"])

      // 读完 → 附件落位 → 再切,这次放行且附件随之走。
      PendingFileReader.pending.splice(0)[0]!.release("data:image/png;base64,shot")
      await flush()
      await flush()
      expect(attachmentNames(host)).toEqual(["shot.png"])

      await openChipAndPick(host, "beta")
      expect(draft().directory).toBe("/ws/b")
      expect(textarea(host)).not.toBe(before)
      expect(textarea(host)!.value).toBe("看这张图")
      expect(attachmentNames(host)).toEqual(["shot.png"])
    } finally {
      ;(globalThis as { FileReader: unknown }).FileReader = realFileReader
      PendingFileReader.pending.splice(0)
    }
  })

  test("附件读取被 abort 后,工作区切换必须恢复可用(不能永久锁死)", async () => {
    mountToasts()
    const realFileReader = globalThis.FileReader
    ;(globalThis as { FileReader: unknown }).FileReader = PendingFileReader
    try {
      const host = mount(() => createComponent(DraftLeaf, { projects: projectsApi([project("alpha-code", "/ws/a"), project("beta", "/ws/b")]) }))
      await flush()
      const before = textarea(host)!
      type(before, "读到一半被取消")
      pasteFile(before, new File(["png-bytes"], "shot.png", { type: "image/png" }))
      await flush()
      expect(PendingFileReader.pending).toHaveLength(1)

      PendingFileReader.pending.splice(0)[0]!.abort() // 只触发 onabort,不 load 不 error
      await flush()
      await flush()

      await openChipAndPick(host, "beta") // 计数必须已归零,否则这里被永久拦住
      expect(updateDraftCalls).toEqual([{ draftID: "draft-1", patch: { directory: "/ws/b" } }])
      expect(draft().directory).toBe("/ws/b")
      expect(textarea(host)!.value).toBe("读到一半被取消") // 文本照常保住
    } finally {
      ;(globalThis as { FileReader: unknown }).FileReader = realFileReader
      PendingFileReader.pending.splice(0)
    }
  })

  test("#663 读盘未完成时**离开 draft**:读完的附件仍随这条 draft 一起取回", async () => {
    // 与上一条的区别就是本票的全部内容:那条走工作区 chip(有拦截),这条**根本不碰 chip**,
    // 直接离开 draft 去另一条 draft —— 导航拦不住,只能让读完的结果自己找回 draft。
    const realFileReader = globalThis.FileReader
    ;(globalThis as { FileReader: unknown }).FileReader = PendingFileReader
    try {
      const api = projectsApi([project("alpha-code", "/ws/a")])
      setLiveDrafts(["draft-1", "draft-2"])
      const host = mount(() => createComponent(DraftLeaf, { projects: api, draftId: "draft-1" }))
      await flush()
      const before = textarea(host)!
      type(before, "读盘中的附件")
      pasteFile(before, new File(["png-bytes"], "lost.png", { type: "image/png" }))
      await flush()
      expect(PendingFileReader.pending).toHaveLength(1) // 读取真的挂起了
      expect(attachmentNames(host)).toEqual([]) // 此刻附件还不在 composer 里

      // 离开 draft-1(切到 draft-2):叶被卸载,cleanup 这一刻只看得见文本。
      disposers.pop()!()
      const other = mount(() => createComponent(DraftLeaf, { projects: api, draftId: "draft-2" }))
      await flush()
      expect(textarea(other)!.value).toBe("") // 另一条 draft 不该串味
      expect(attachmentNames(other)).toEqual([])

      // 读盘现在才完成 —— 只有已卸载的那个实例在等它。
      PendingFileReader.pending.splice(0)[0]!.release("data:image/png;base64,lost")
      await flush()
      await flush()
      expect(attachmentNames(other)).toEqual([]) // 迟到的结果不许漏进别的 draft

      // 回到 draft-1:文本和附件都必须在。
      disposers.pop()!()
      const revisit = mount(() => createComponent(DraftLeaf, { projects: api, draftId: "draft-1" }))
      await flush()
      expect(textarea(revisit)!.value).toBe("读盘中的附件")
      expect(attachmentNames(revisit)).toEqual(["lost.png"])

      // 判据不止「框里看得见」:真提交一次,断言这份附件真的随请求发出去了。
      textarea(revisit)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
      for (let i = 0; i < 20 && startChatCalls.length === 0; i++) await flush()
      expect(startChatCalls).toHaveLength(1)
      expect(startChatCalls[0]!.parts).toEqual([
        { type: "file", mime: "image/png", url: "data:image/png;base64,lost", filename: "lost.png" },
      ])
    } finally {
      ;(globalThis as { FileReader: unknown }).FileReader = realFileReader
      PendingFileReader.pending.splice(0)
    }
  })

  test("#663 读盘期间「离开 → 读完前就回来 → 再离开 → 再回来」:附件一次都不许丢", async () => {
    // 上一条覆盖的是「读完之后才回来」。这条是它的对偶:回来得**比读完早**。此时新实例已经把
    // 暂存取走了 —— 若读盘结果只会写回发起它的那个(已卸载的)实例,它就永远追不上活着的这个,
    // 下一次离开时活实例那份「没有附件」的快照会把它覆盖掉,于是永久静默丢失。
    const realFileReader = globalThis.FileReader
    ;(globalThis as { FileReader: unknown }).FileReader = PendingFileReader
    try {
      const api = projectsApi([project("alpha-code", "/ws/a")])
      const host = mount(() => createComponent(DraftLeaf, { projects: api, draftId: "draft-1" }))
      await flush()
      const before = textarea(host)!
      type(before, "读盘中的附件")
      pasteFile(before, new File(["png-bytes"], "lost.png", { type: "image/png" }))
      await flush()
      expect(PendingFileReader.pending).toHaveLength(1)
      expect(attachmentNames(host)).toEqual([])

      // ① 离开 draft-1(读盘仍挂起)
      disposers.pop()!()
      // ② 读完**之前**就回到 draft-1:新实例接手这条 draft,文本回来了、附件还在路上。
      const back = mount(() => createComponent(DraftLeaf, { projects: api, draftId: "draft-1" }))
      await flush()
      expect(textarea(back)!.value).toBe("读盘中的附件")
      expect(attachmentNames(back)).toEqual([])

      // ③ 现在才读完:结果必须落到**当前活着的这个实例**,而不是那个已卸载的发起者。
      PendingFileReader.pending.splice(0)[0]!.release("data:image/png;base64,lost")
      await flush()
      await flush()
      expect(attachmentNames(back)).toEqual(["lost.png"])

      // ④ 再离开、⑤ 再回来:附件仍在(活实例的快照本来就含它,没有谁来覆盖)。
      disposers.pop()!()
      const revisit = mount(() => createComponent(DraftLeaf, { projects: api, draftId: "draft-1" }))
      await flush()
      expect(textarea(revisit)!.value).toBe("读盘中的附件")
      expect(attachmentNames(revisit)).toEqual(["lost.png"])

      // 判据不止「框里看得见」:真提交一次,断言这份附件真的随请求发出去了。
      textarea(revisit)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
      for (let i = 0; i < 20 && startChatCalls.length === 0; i++) await flush()
      expect(startChatCalls).toHaveLength(1)
      expect(startChatCalls[0]!.parts).toEqual([
        { type: "file", mime: "image/png", url: "data:image/png;base64,lost", filename: "lost.png" },
      ])
    } finally {
      ;(globalThis as { FileReader: unknown }).FileReader = realFileReader
      PendingFileReader.pending.splice(0)
    }
  })

  test("关掉的 draft 不再永久占着暂存(按 tabs 里还活着的 draft 剪枝)", async () => {
    const api = projectsApi([project("alpha-code", "/ws/a")])
    setLiveDrafts(["draft-1", "draft-2"])
    for (const draftId of ["draft-1", "draft-2"]) {
      const host = mount(() => createComponent(DraftLeaf, { projects: api, draftId }))
      await flush()
      type(textarea(host)!, `${draftId} 的内容`)
      await flush()
      disposers.pop()!()
    }
    // 用户把 draft-1 关掉(上游只清 tabs,不通知暂存)
    setLiveDrafts(["draft-2"])

    // 回到还活着的 draft-2:它自己的内容必须在,而 draft-1 的条目已被剪掉。
    const host = mount(() => createComponent(DraftLeaf, { projects: api, draftId: "draft-2" }))
    await flush()
    expect(textarea(host)!.value).toBe("draft-2 的内容")
    expect(newSessionDraftStash.restore("draft-1")).toBeUndefined()
  })

  test("9 个 draft 依次输入后回到第 1 个,内容还在(暂存不得有容量帽)", async () => {
    const api = projectsApi([project("alpha-code", "/ws/a")])
    for (let i = 1; i <= 9; i++) {
      const host = mount(() => createComponent(DraftLeaf, { projects: api, draftId: `draft-${i}` }))
      await flush()
      type(textarea(host)!, `第 ${i} 个草稿`)
      await flush()
      disposers.pop()!() // 离开这个 draft(卸载 = 捕获)
    }
    const revisit = mount(() => createComponent(DraftLeaf, { projects: api, draftId: "draft-1" }))
    await flush()
    expect(textarea(revisit)!.value).toBe("第 1 个草稿")
  })

  test("发出去之后不复活:提交成功再回到同一个 draft,composer 是空的", async () => {
    const api = projectsApi([project("alpha-code", "/ws/a")])
    const host = mount(() => createComponent(DraftLeaf, { projects: api }))
    await flush()
    type(textarea(host)!, "这条已经发出去了")
    await flush()
    textarea(host)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
    for (let i = 0; i < 20 && startChatCalls.length === 0; i++) await flush()
    expect(startChatCalls).toHaveLength(1)

    disposers.pop()!() // 晋升 = 叶被换掉(卸载)
    const revisit = mount(() => createComponent(DraftLeaf, { projects: api }))
    await flush()
    expect(textarea(revisit)!.value).toBe("")
  })

  test("用户自己清空 ⇒ 切目录后仍然是空的(暂存不复活已删内容)", async () => {
    newSessionDraftStash.capture("draft-1", { text: "早先输入的", mentions: [], attachments: [], pendingReads: [] })
    const host = mount(() => createComponent(DraftLeaf, { projects: projectsApi([project("alpha-code", "/ws/a"), project("beta", "/ws/b")]) }))
    await flush()
    expect(textarea(host)!.value).toBe("早先输入的")

    type(textarea(host)!, "")
    await flush()
    await openChipAndPick(host, "beta")

    expect(textarea(host)!.value).toBe("")
  })
})

describe("REQ-126 CODE-D 首页:chip 抽取行为保持 + 默认落 ~/Alpha", () => {
  test("未显式选择 ⇒ chip 与真实提交目标都是默认对话目录(不是第一个项目)", async () => {
    const host = mount(() =>
      createComponent(AlphaHome, {
        projects: projectsApi([project("alpha-code", "/ws/a"), project("beta", "/ws/b")]),
        serverKey: () => STORE_SERVER_KEY,
      }),
    )
    await flush()
    await flush()

    // ADR-025 2026-07-28 改判:有项目的既有用户也一样,未显式选 ⇒ ~/Alpha。
    expect(chipButton(host).textContent).toContain("Alpha")
    expect(chipButton(host).textContent).not.toContain("alpha-code")

    type(textarea(host)!, "开工")
    await flush()
    textarea(host)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
    for (let i = 0; i < 20 && startChatCalls.length === 0; i++) await flush()

    // 判据是**真实提交目标**,不只是 chip 显示:显示对了而提交仍落旧项目才是最坏的假绿。
    expect(startChatCalls).toHaveLength(1)
    expect(startChatCalls[0]!.directory).toBe(DEFAULT_WORKSPACE)
  })

  test("默认目录还没解析出来时:不得拿第一个项目当提交目标(AC5 时序缺口)", async () => {
    mountToasts()
    const gate = gateDefaultWorkspace() // workspaceDefaultDir 保持未决
    const host = mount(() =>
      createComponent(AlphaHome, {
        projects: projectsApi([project("alpha-code", "/ws/a"), project("beta", "/ws/b")]),
        serverKey: () => STORE_SERVER_KEY,
      }),
    )
    await flush()
    await flush()
    expect(chipButton(host).textContent).not.toContain("alpha-code")

    type(textarea(host)!, "别开错项目")
    await flush()
    textarea(host)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
    for (let i = 0; i < 20; i++) await flush()

    // 判据是**真实提交目标**:未解析期间一条都不许发出去,且用户看得到「需要工作区」提示。
    expect(startChatCalls).toEqual([])
    expect(toastTitles()).toContain(zh["alpha.home.workspaceRequired"])

    // 解析回来后照常可发,落点是默认对话目录。
    gate.resolve(DEFAULT_WORKSPACE)
    for (let i = 0; i < 20; i++) await flush()
    textarea(host)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
    for (let i = 0; i < 20 && startChatCalls.length === 0; i++) await flush()
    expect(startChatCalls).toHaveLength(1)
    expect(startChatCalls[0]!.directory).toBe(DEFAULT_WORKSPACE)
  })

  test("chip 抽取行为保持:仍列默认工作区 + 项目 + 打开项目…,显式选中即改提交目标", async () => {
    const host = mount(() =>
      createComponent(AlphaHome, {
        projects: projectsApi([project("alpha-code", "/ws/a"), project("beta", "/ws/b")]),
        serverKey: () => STORE_SERVER_KEY,
      }),
    )
    await flush()
    await flush()

    chipButton(host).click()
    await flush()
    const labels = popItems(host).map((button) => button.textContent ?? "")
    expect(labels[0]).toContain("Alpha") // 默认工作区常驻首项(未注册为项目)
    expect(popItems(host)[0]?.className).toContain("is-on") // 未选时选中态在它身上
    expect(labels.some((label) => label.includes("alpha-code"))).toBe(true)
    expect(labels.some((label) => label.includes("beta"))).toBe(true)
    expect(labels.at(-1)).toContain(zh["alpha.home.openProjectEllipsis"]) // 「打开项目…」仍在末位

    popItems(host).find((button) => (button.textContent ?? "").includes("beta"))!.click()
    await flush()
    expect(chipButton(host).textContent).toContain("beta")

    type(textarea(host)!, "开工")
    await flush()
    textarea(host)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
    for (let i = 0; i < 20 && startChatCalls.length === 0; i++) await flush()

    expect(startChatCalls).toHaveLength(1)
    expect(startChatCalls[0]!.directory).toBe("/ws/b") // 显式所选压过默认目录
  })
})

/* ── #891 新会话开局档位登记的钥匙,取自**建这个会话的那个 server** ────────────────────
   首页与新对话页发第一条走的是 `props.projects.startChat` —— 会话就建在**那份 store 连着的
   server** 上。它的 canonical 身份第一段因此是那个 server 的 key,而不是壳里「当前 active
   server」(`useServer().key`),也不是「建 draft 那一刻的 active server」(`tabs.draft().server`)。
   WSL/remote 下这三者不是同一个值:登记落在后两者下面,会话页按真实身份 adopt 时就永远认领
   不到 —— 用户在首页开的只读档静默消失,而他从没关过它。

   判据形制:钥匙不直接断言(那是内部形状),断言的是**用户可观察的结果** —— 会话页把开局
   档位/只读档接过来没有。写入走首页的生产提交路径,读取走会话页的生产 `SessionComposerMount`
   (它自己按 canonical 身份算钥匙),两侧都不是测试拼的等价链。

   本文件里 ACTIVE_SERVER_KEY ≠ STORE_SERVER_KEY 是**故意**的:任一叶回头去读 active server
   或 draft.server,下面两条当场红(已实跑,见 PR 说明)。

   (#894 复用下面这几个助手 —— 它们从本节内提到模块作用域,内容未改。) */
const planChipOf = (host: HTMLElement) => host.querySelector<HTMLButtonElement>(".a-chip-plan")
const permChipOf = (host: HTMLElement) => host.querySelector<HTMLButtonElement>(".a-chip-perm")
const readonlyItems = () =>
  [...document.body.querySelectorAll<HTMLButtonElement>('.a-pop-item[role="menuitemradio"]')].filter((item) =>
    item.textContent?.includes(zh["alpha.composer.permReadonly"]),
  )

/** #891/#894 都要「先挂 A 断言、卸掉、再挂 B」——共享的 disposers 只在 afterEach 收,这里要能就地卸。 */
function mountDisposable(view: () => unknown) {
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(view as () => never, host)
  return {
    host,
    dispose: () => {
      dispose()
      host.remove()
    },
  }
}

/** 会话页那一侧的生产挂载:它自己从 identity 算 `identityKey`,再 adopt 档位/只读档。 */
function mountSessionAt(projects: AlphaProjectsApi, serverKey: string, sessionID: string) {
  return mountDisposable(() =>
    createComponent(SessionComposerMount, {
      identity: () => ({ serverKey, directory: DEFAULT_WORKSPACE, sessionID }),
      projects,
      dock: {
        running: () => false,
        contextUsage: () => null,
        approvalPending: () => false,
        onSlashCommand: () => {},
      },
      drafts: createComposerDraftStash(),
    } as never),
  )
}

/** 首页:开计划档 + 只读档,再真提交。顺序不能反 —— 只读档下 Shift+Tab 是 no-op。 */
async function submitFromHomeWithBothOn(
  projects: AlphaProjectsApi,
  serverKey: () => string | undefined = () => STORE_SERVER_KEY,
) {
  const home = mountDisposable(() => createComponent(AlphaHome, { projects, serverKey }))
  for (let i = 0; i < 20 && !textarea(home.host); i++) await flush()
  textarea(home.host)!.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }),
  )
  for (let i = 0; i < 20 && !planChipOf(home.host); i++) await flush()
  expect(planChipOf(home.host)).not.toBeNull()

  permChipOf(home.host)!.click()
  for (let i = 0; i < 20 && readonlyItems().length === 0; i++) await flush()
  readonlyItems()[0]!.click()
  for (let i = 0; i < 20 && permChipOf(home.host)!.getAttribute("data-mode") !== "readonly"; i++) await flush()
  expect(permChipOf(home.host)!.getAttribute("data-mode")).toBe("readonly")

  type(textarea(home.host)!, "开工")
  await flush()
  textarea(home.host)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
  for (let i = 0; i < 30 && startChatCalls.length === 0; i++) await flush()
  expect(startChatCalls).toHaveLength(1)
  for (let i = 0; i < 10; i++) await flush() // seed 落在 await startChat 之后
  home.dispose()
}

describe("#891 首页/新对话页:开局档位登记在 store 连着的那个 server 名下", () => {
  test("active server ≠ store 的 server 时:会话页按 store 的 server 认领得到开局档位与只读档", async () => {
    const projects = projectsApi([project("alpha-code", "/ws/a")])
    await submitFromHomeWithBothOn(projects)

    // ① 反方向先测:登记**没有**落在 active server 名下(落在那儿 = 会话页永远认领不到)。
    const wrong = mountSessionAt(projects, ACTIVE_SERVER_KEY, "session-1")
    for (let i = 0; i < 20 && !textarea(wrong.host); i++) await flush()
    expect(planChipOf(wrong.host)).toBeNull()
    expect(permChipOf(wrong.host)!.getAttribute("data-mode")).toBe("ask")
    wrong.dispose()

    // ② 正方向:同一个 sessionID,换成 store 真正连着的那个 server —— 两档都在。
    const right = mountSessionAt(projects, STORE_SERVER_KEY, "session-1")
    for (let i = 0; i < 20 && !textarea(right.host); i++) await flush()
    expect(planChipOf(right.host)).not.toBeNull()
    expect(permChipOf(right.host)!.getAttribute("data-mode")).toBe("readonly")
    right.dispose()
  })

  test("新对话页同一条线:draft.server 不是身份,登记仍在 store 的 server 名下", async () => {
    const projects = projectsApi([project("alpha-code", "/ws/a")])
    // draft 生来带 active server(上游入口的形态)。#925 收口会先钉回 projects key 并整叶重挂
    // 一次 —— 等它落定再开档位:开在旧实例上的档随重挂消失,那是收口的已知代价(内容经暂存
    // 保住,档位是 composer 实例状态),不是本用例的命题。
    setDraft({ server: ACTIVE_SERVER_KEY, directory: DEFAULT_WORKSPACE })
    const leaf = mountDisposable(() => createComponent(DraftLeaf, { projects }))
    for (let i = 0; i < 20 && draft().server !== STORE_SERVER_KEY; i++) await flush()
    for (let i = 0; i < 20 && !textarea(leaf.host); i++) await flush()

    textarea(leaf.host)!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }),
    )
    for (let i = 0; i < 20 && !planChipOf(leaf.host); i++) await flush()
    expect(planChipOf(leaf.host)).not.toBeNull()

    type(textarea(leaf.host)!, "从新对话页开工")
    await flush()
    textarea(leaf.host)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
    for (let i = 0; i < 30 && startChatCalls.length === 0; i++) await flush()
    expect(startChatCalls).toHaveLength(1)
    for (let i = 0; i < 10; i++) await flush()
    leaf.dispose()

    const wrong = mountSessionAt(projects, ACTIVE_SERVER_KEY, "session-1") // = draft.server
    for (let i = 0; i < 20 && !textarea(wrong.host); i++) await flush()
    expect(planChipOf(wrong.host)).toBeNull()
    wrong.dispose()

    const right = mountSessionAt(projects, STORE_SERVER_KEY, "session-1")
    for (let i = 0; i < 20 && !textarea(right.host); i++) await flush()
    expect(planChipOf(right.host)).not.toBeNull()
    right.dispose()
  })

  /* #888:上面两条盯的是**钥匙对不对**;这一条盯的是**整条序列还走不走得完**。
     真实序列是「首页提交 → 会话页挂载 → 卸载 → 再挂载 → 接着发」。#891 与 #882 各自单独测
     都绿,合起来才坏:#882 把 `model.list` 的取消源从一个 10s 固定预算换成**链的生命期**
     之后,卸载/supersede 会当场把在途 listing 拒掉,而 `runModelChain` 在它的真消费者
     (`loadEngineModelsWithRetry`)之前有三个早退点 —— 早退时那条 listing 无人接,于是每一次
     「链没跑完就卸载」都留下一个**未处理拒绝**。它不改档位的值(#891 那两条用例的断言值全对),
     却让这条序列上的用例整片变红:bun 把未处理拒绝记到当前用例头上,Electron 里走全局错误上报。

     判据落在两处用户可观察的地方,少一处都不够:
     ①会话页渲染出来的 chip —— 用户看得见的那两档;
     ②会话页**真发出去**的 `session.promptAsync` 载荷 —— 显示只读而线上不带 `alpha-readonly`,
       用户看到的就是「只读亮着,模型照样改文件」。丢了登记时这里连 `agent` 键都不会出现
       (`buildPromptRequest` 在 perm=ask + agent=null 时不写这个字段),所以键在不在本身就是判据。
     最后再把只读放回「请求审批」,让**开局档位**(plan)也走一次线 —— 只读会压过手选档位,
     不解除它,plan 永远只在 chip 上、不在载荷里。

     ⚠️ 步骤 ② 的位置是实测定下来的,不能挪:卸载必须发生在**模型链还在飞**的时候,而且后面
     还得有 await。链已 ready 之后再卸载抓不到(那一刻没有在途请求),把卸载写在用例最后一行
     也抓不到(拒绝落在用例窗口之外)—— 两种写法在还原修复后都**照样全绿**,是假绿。 */
  test("首页提交 → 会话页挂载 → 链未收敛就卸载 → 再挂载:开局档位与只读档整条序列不掉(chip + promptAsync 载荷)", async () => {
    const projects = projectsApi([project("alpha-code", "/ws/a")])
    await submitFromHomeWithBothOn(projects) // 内部结尾就是首页 composer 的真实卸载
    expect(startChatCalls[0]!.directory).toBe(DEFAULT_WORKSPACE)

    // ① 跳进会话页:两档立刻就在(chip 是用户唯一看得见的那一面)。
    const glance = mountSessionAt(projects, STORE_SERVER_KEY, "session-1")
    for (let i = 0; i < 20 && !textarea(glance.host); i++) await flush()
    expect(planChipOf(glance.host)).not.toBeNull()
    expect(permChipOf(glance.host)!.getAttribute("data-mode")).toBe("readonly")

    // ② 模型链还没收敛就把会话页卸掉(切标签页 / 切回列表 —— 生产上最常见的那一刻)。
    glance.dispose()
    for (let i = 0; i < 5; i++) await flush()

    // ③ 回到会话页:两档还在。
    const session = mountSessionAt(projects, STORE_SERVER_KEY, "session-1")
    for (let i = 0; i < 20 && !textarea(session.host); i++) await flush()
    expect(planChipOf(session.host)).not.toBeNull()
    expect(permChipOf(session.host)!.getAttribute("data-mode")).toBe("readonly")

    // ④ 线上:第一条后续消息带着 alpha-readonly 真发出去。
    const sendButton = () => session.host.querySelector<HTMLButtonElement>(".a-comp-send")!
    type(textarea(session.host)!, "第二条")
    for (let i = 0; i < 60 && sendButton().disabled; i++) await flush()
    expect(sendButton().disabled).toBe(false)
    sendButton().click()
    for (let i = 0; i < 30 && promptAsyncCalls.length === 0; i++) await flush()
    expect(promptAsyncCalls).toHaveLength(1)
    expect(promptAsyncCalls[0]).toMatchObject({
      sessionID: "session-1",
      directory: DEFAULT_WORKSPACE,
      agent: "alpha-readonly",
      parts: [{ type: "text", text: "第二条" }],
    })

    // 等这次发送**落定**再往下走:清空输入框与解锁发送都在 `await promptAsync` 之后,而
    // `promptAsync` 是同步被调用的 —— 不等,下一步敲进去的字会被这次的 setText("") 抹掉,
    // 表现成一个与本判据无关的假红(实测踩过)。
    for (let i = 0; i < 30 && textarea(session.host)!.value !== ""; i++) await flush()
    expect(textarea(session.host)!.value).toBe("")

    // ⑤ 解除只读之后,开局的 plan 档仍在,并且这一次它自己上了线。
    permChipOf(session.host)!.click()
    const askItems = () =>
      [...document.body.querySelectorAll<HTMLButtonElement>('.a-pop-item[role="menuitemradio"]')].filter((item) =>
        item.textContent?.includes(zh["alpha.composer.permAsk"]),
      )
    for (let i = 0; i < 20 && askItems().length === 0; i++) await flush()
    askItems()[0]!.click()
    for (let i = 0; i < 20 && permChipOf(session.host)!.getAttribute("data-mode") !== "ask"; i++) await flush()
    expect(permChipOf(session.host)!.getAttribute("data-mode")).toBe("ask")
    expect(planChipOf(session.host)).not.toBeNull()

    type(textarea(session.host)!, "第三条")
    for (let i = 0; i < 60 && sendButton().disabled; i++) await flush()
    expect(sendButton().disabled).toBe(false)
    sendButton().click()
    for (let i = 0; i < 30 && promptAsyncCalls.length < 2; i++) await flush()
    expect(promptAsyncCalls).toHaveLength(2)
    expect(promptAsyncCalls[1]).toMatchObject({ sessionID: "session-1", agent: "plan" })

    session.dispose()
  })
})

/* ── #894 首页提交后的导航,落在**建这个会话的那个 server** 上 ──────────────────────────
   首页发第一条走 `props.projects.startChat` ⇒ 会话建在**那份 store 连着的 server** 上,而
   过去这里跳的是 legacy `/{目录}/session/{id}` —— 路径里没有任何 server 段,壳只能事后反推
   (`packages/app/src/utils/session-route.ts` 的 `legacySessionServer`:同 id 的 tab,否则回落
   到「完成时的 active server」)。实测(sidecar + 一个 ready 的 WSL,默认 server = 那个 WSL):
   active = `wsl:Ubuntu`,而 store 连的是 `sidecar`,反推恒给 `wsl:Ubuntu`;那台机器上若恰好
   有同 id 会话,打开并污染的就是那个无关会话。

   判据落在**用户可观察的结果**上,而不是某个 memo 的值:
   ① 叶真正交给路由的那个 href,经生产 `parseRoute` 读回来必须是 canonical 的 `session` 路由,
      且 server 段等于建会话的那个 server(锚点是本文件自己的字面量,不 import 生产常量);
   ② 落地页确实是「刚建的那个会话」—— 首页开的开局档位/只读档在它身上接得住(读取走生产的
      `SessionComposerMount`,它自己按 canonical 身份算钥匙)。
   第二条用例把「快照」与「完成时重读」分开:请求在途时 store 改连别的 server,导航仍须落在
   提交那一刻的那个。四个 server key 互不相同,负向夹具不取退化形状;两条用例**提交那一刻**的
   key 也刻意不同(`STORE_SERVER_KEY` / `SUBMIT_TIME_SERVER_KEY`)—— 否则一个把 href 写死成
   `"sidecar"` 的实现两条全绿(R1 审计 Minor)。 */
describe("#894 首页提交后的导航:落地的是真正创建会话的那个 server 上的那个会话", () => {
  test("active server ≠ store 的 server:导航目标带着 store 的 server,落地页就是刚建的那个会话", async () => {
    const projects = projectsApi([project("alpha-code", "/ws/a")])
    await submitFromHomeWithBothOn(projects)

    expect(navigateCalls).toHaveLength(1)
    const landing = parseRoute(navigateCalls[0]!)
    // canonical 的 server 路由,不是 legacy 那条(legacy 的 routeId 是 `legacy-session`,
    // 且它解出来根本没有 server 段 —— 那正是壳只能去猜的原因)。
    expect({ kind: landing.kind, routeId: landing.identity.routeId }).toEqual({
      kind: "session",
      routeId: "session",
    })
    const landed = landing as { serverKey?: string; id?: string }
    expect(landed.id).toBe("session-1")
    expect(landed.serverKey).toBe(STORE_SERVER_KEY)
    expect(landed.serverKey).not.toBe(ACTIVE_SERVER_KEY)

    // 用户可观察:跳过去之后,首页开的开局档位与只读档都在 —— 落地的就是刚建的那个会话。
    const page = mountSessionAt(projects, landed.serverKey!, landed.id!)
    for (let i = 0; i < 20 && !textarea(page.host); i++) await flush()
    expect(planChipOf(page.host)).not.toBeNull()
    expect(permChipOf(page.host)!.getAttribute("data-mode")).toBe("readonly")
    page.dispose()
  })

  test("请求在途时 store 改连了别的 server:仍落在**提交那一刻**的那个,不是完成时的", async () => {
    const projects = projectsApi([project("alpha-code", "/ws/a")])
    const [storeServerKey, setStoreServerKey] = createSignal<string | undefined>(SUBMIT_TIME_SERVER_KEY)
    const gate = gateStartChat()

    const home = mountDisposable(() => createComponent(AlphaHome, { projects, serverKey: storeServerKey }))
    for (let i = 0; i < 20 && !textarea(home.host); i++) await flush()
    type(textarea(home.host)!, "开工")
    await flush()
    textarea(home.host)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
    for (let i = 0; i < 30 && startChatCalls.length === 0; i++) await flush()
    expect(startChatCalls).toHaveLength(1)
    expect(navigateCalls).toEqual([]) // 还在途:会话还没建成,当然还没跳

    // 会话此刻正建在 SUBMIT_TIME_SERVER_KEY 上;这时 store 改连到另一个 server(sidecar 重启换端口 /
    // 用户切了服务器),`props.serverKey()` 从此返回新值。
    await startTransition(() => setStoreServerKey(LATER_SERVER_KEY))
    for (let i = 0; i < 5; i++) await flush()
    gate.release()
    for (let i = 0; i < 30 && navigateCalls.length === 0; i++) await flush()

    expect(navigateCalls).toHaveLength(1)
    const landed = parseRoute(navigateCalls[0]!) as { serverKey?: string; id?: string }
    expect(landed.id).toBe("session-1")
    expect(landed.serverKey).toBe(SUBMIT_TIME_SERVER_KEY)
    expect(landed.serverKey).not.toBe(LATER_SERVER_KEY)
    // 与第一条用例提交时的 key 也不同 ⇒ 把 href 写死成任何单个字面量都过不了这两条。
    expect(landed.serverKey).not.toBe(STORE_SERVER_KEY)
    home.dispose()
  })
})

/* ── #925 审计 Major:draft 的生产者不止 alpha-sidebar 一个 ────────────────────────────
   上游 Titlebar 的「+ 新标签」/ mod+t(packages/app/src/components/titlebar.tsx `openNewTab`,
   五个分支)建的 draft 带的是 active(或兜底)server;而新对话页发第一条恒经
   `props.projects.startChat` 把会话建在 projects store 连着的 server 上。收口在唯一消费者:
   AlphaNewSession 挂载/取到 key 后把不同值的 draft.server 钉回 projects key,上游 `promoteDraft`
   按 `draft.server` 建的 session tab 与导航才落在真正持有会话的那台。
   判据纪律:两组用例的 projects key 用**不同**字面量(STORE / LATER),写死单值的实现两条同时
   过不了;负向夹具的 draft.server 也取两个互不相同的非退化值(ACTIVE / SUBMIT_TIME)。 */
describe("#925 上游入口建的 draft(带 active server)在唯一消费者处被钉回 projects key", () => {
  test("draft 带 active server ⇒ server 段被钉回,晋升读到的就是 projects key;收口重挂不吞已有内容", async () => {
    // 用户此前在这条 draft 里输入过(经暂存注入 —— 与切目录内容保护同一条路)。
    newSessionDraftStash.capture("draft-1", { text: "上游入口建的草稿", mentions: [], attachments: [], pendingReads: [] })
    setDraft({ server: ACTIVE_SERVER_KEY, directory: "/ws/a" })
    const host = mount(() => createComponent(DraftLeaf, { projects: projectsApi([project("alpha-code", "/ws/a")]) }))
    for (let i = 0; i < 20 && draft().server !== STORE_SERVER_KEY; i++) await flush()

    expect(updateDraftCalls).toEqual([{ draftID: "draft-1", patch: { server: STORE_SERVER_KEY } }])
    expect(draft().server).toBe(STORE_SERVER_KEY)
    // 收口引发的重挂不吞内容(卸载捕获 → 重挂取回,与切目录同一条暂存路)。
    for (let i = 0; i < 20 && !textarea(host)?.value; i++) await flush()
    expect(textarea(host)!.value).toBe("上游入口建的草稿")

    // 用户可观察的终点:晋升(上游按 draft.server 建 tab + 导航)读到的 server 是 projects key,
    // 不是建 draft 那一刻的 active server —— 打开的才是真正持有这个会话的机器。
    textarea(host)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
    for (let i = 0; i < 30 && promoteCalls.length === 0; i++) await flush()
    expect(startChatCalls).toHaveLength(1)
    expect(promoteCalls).toEqual([{ server: STORE_SERVER_KEY, sessionId: "session-1" }])
  })

  test("钉回的是**这份 projects 连着的那个** key,不是任何单一字面量(第二组 key 全不同)", async () => {
    setDraft({ server: SUBMIT_TIME_SERVER_KEY, directory: "/ws/a" })
    mount(() =>
      createComponent(DraftLeaf, {
        projects: projectsApi([project("alpha-code", "/ws/a")]),
        serverKey: () => LATER_SERVER_KEY,
      }),
    )
    for (let i = 0; i < 20 && draft().server !== LATER_SERVER_KEY; i++) await flush()
    expect(updateDraftCalls).toEqual([{ draftID: "draft-1", patch: { server: LATER_SERVER_KEY } }])
    expect(draft().server).toBe(LATER_SERVER_KEY)
  })

  test("draft.server 已等于 projects key ⇒ 零写入、零重挂(收口是条件的,不是每次挂载都拍一下)", async () => {
    const host = mount(() => createComponent(DraftLeaf, { projects: projectsApi([project("alpha-code", "/ws/a")]) }))
    const before = textarea(host)!
    for (let i = 0; i < 5; i++) await flush()
    expect(updateDraftCalls).toEqual([])
    expect(draft().server).toBe(STORE_SERVER_KEY)
    expect(textarea(host)).toBe(before) // 没重挂
  })

  test("挂载时 key 还没就绪(sidecar 迟启动)⇒ 不猜不写;就绪那一刻补钉", async () => {
    setDraft({ server: ACTIVE_SERVER_KEY, directory: "/ws/a" })
    const [lateKey, setLateKey] = createSignal<string | undefined>(undefined)
    mount(() =>
      createComponent(DraftLeaf, {
        projects: projectsApi([project("alpha-code", "/ws/a")]),
        serverKey: lateKey,
      }),
    )
    for (let i = 0; i < 5; i++) await flush()
    expect(updateDraftCalls).toEqual([]) // key 缺席:不写 undefined,也不拿 active 兜底
    expect(draft().server).toBe(ACTIVE_SERVER_KEY)

    setLateKey(STORE_SERVER_KEY)
    for (let i = 0; i < 20 && draft().server !== STORE_SERVER_KEY; i++) await flush()
    expect(updateDraftCalls).toEqual([{ draftID: "draft-1", patch: { server: STORE_SERVER_KEY } }])
    expect(draft().server).toBe(STORE_SERVER_KEY)
  })
})
