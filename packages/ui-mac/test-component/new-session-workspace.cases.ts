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
// #891:两个「当会话身份用就是错的」的值,在本文件里被**故意钉成与 store 的 server 不同**:
// `useServer().key`(当前 active server)与 `tabs.draft().server`(建 draft 那一刻的 active
// server)。首页/新对话页的会话是 `projects.startChat` 在 **store 连着的那个 server** 上建的,
// 身份只能是后者。两个错值都取 ACTIVE_SERVER_KEY,任一叶回头去读它们,判据当场红。
const ACTIVE_SERVER_KEY = "wsl:ubuntu"
/** `projects` 这份 store 真正连着的 server(生产由 `index.tsx` 的 `projectsServerKey` 反查)。 */
const STORE_SERVER_KEY = "sidecar"

type DraftRecord = { server: string; directory: string }
const [draft, setDraft] = createSignal<DraftRecord>({ server: ACTIVE_SERVER_KEY, directory: "/ws/a" })
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
mock.module("@opencode-ai/app", () => ({ useTabs: () => tabs, useServer: () => server }))
mock.module("@solidjs/router", () => ({
  useSearchParams: () => [{}, () => {}],
  useNavigate: () => () => {},
}))
const command = { options: [], trigger: () => {} }
mock.module("../src/renderer/alpha-ui/providers", () => ({
  useCommand: () => command,
  useContractHealth: () => () => null,
}))

const { AlphaNewSession } = await import("../src/renderer/alpha-ui/alpha-new-session")
const { AlphaHome } = await import("../src/renderer/alpha-ui/AlphaHome")
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
function projectsApi(projects: AlphaProject[]): AlphaProjectsApi {
  return {
    store: { projects, ready: true, error: false },
    reload: async () => {},
    createSession: async () => undefined,
    startChat: async (directory: string, body: string, parts?: unknown[]) => {
      startChatCalls.push({ directory, body, parts: parts ?? [] })
      return "session-1"
    },
    sdk: () =>
      ({
        command: { list: async () => ({ data: [] }) },
        find: { files: async () => ({ data: [] }) },
        vcs: { status: async () => ({ data: [] }) },
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

function DraftLeaf(props: { projects: AlphaProjectsApi; draftId?: string }) {
  // 上游 createDraftRoute 的 keyed 包装(packages/app/src/app.tsx):directory 变 ⇒ 整叶重挂。
  return createComponent(solid.Show, {
    get when() {
      return `${draft().server}\0${draft().directory}`
    },
    keyed: true,
    get children() {
      return createComponent(AlphaNewSession, {
        projects: props.projects,
        // #891:生产由 index.tsx 的 `projectsServerKey` 供给(store 的 baseUrl 反查),这里同源:
        // 这份 `projects` 连的就是 STORE_SERVER_KEY,而 `draft().server` 是另一个值。
        serverKey: () => STORE_SERVER_KEY,
        draftId: props.draftId ?? "draft-1",
        promoteDraft: () => {},
      })
    },
  })
}

beforeEach(() => {
  installApi()
  newSessionDraftStash.resetForTests()
  updateDraftCalls.splice(0)
  startChatCalls.splice(0)
  pickerCalls.splice(0)
  pickedDirectory = undefined
  defaultWorkspaceGate = undefined
  setLiveDrafts(["draft-1"])
  setDraft({ server: ACTIVE_SERVER_KEY, directory: "/ws/a" })
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
    setDraft({ server: ACTIVE_SERVER_KEY, directory: "" })
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
   或 draft.server,下面两条当场红(已实跑,见 PR 说明)。 */
describe("#891 首页/新对话页:开局档位登记在 store 连着的那个 server 名下", () => {
  const planChipOf = (host: HTMLElement) => host.querySelector<HTMLButtonElement>(".a-chip-plan")
  const permChipOf = (host: HTMLElement) => host.querySelector<HTMLButtonElement>(".a-chip-perm")
  const readonlyItems = () =>
    [...document.body.querySelectorAll<HTMLButtonElement>('.a-pop-item[role="menuitemradio"]')].filter((item) =>
      item.textContent?.includes(zh["alpha.composer.permReadonly"]),
    )

  /** 本节要「先挂 A 断言、卸掉、再挂 B」——共享的 disposers 只在 afterEach 收,这里要能就地卸。 */
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
  async function submitFromHomeWithBothOn(projects: AlphaProjectsApi) {
    const home = mountDisposable(() => createComponent(AlphaHome, { projects, serverKey: () => STORE_SERVER_KEY }))
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
    setDraft({ server: ACTIVE_SERVER_KEY, directory: DEFAULT_WORKSPACE })
    const leaf = mountDisposable(() => createComponent(DraftLeaf, { projects }))
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
})
