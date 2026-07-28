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
type DraftRecord = { server: string; directory: string }
const [draft, setDraft] = createSignal<DraftRecord>({ server: "sidecar", directory: "/ws/a" })
const updateDraftCalls: Array<{ draftID: string; patch: Partial<DraftRecord> }> = []
const tabs = {
  draft: () => draft(),
  updateDraft: (draftID: string, patch: Partial<DraftRecord>) => {
    updateDraftCalls.push({ draftID, patch })
    // 与上游 tabs.updateDraft 同路:store 写在 startTransition 内(叶重挂的真实触发方式)。
    void startTransition(() => setDraft((current) => ({ ...current, ...patch })))
  },
}
mock.module("@opencode-ai/app", () => ({ useTabs: () => tabs }))
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
const { resetComposerModelProjection, setComposerAgent, setComposerModel } = await import(
  "../src/renderer/alpha-ui/composer-state"
)

const DEFAULT_WORKSPACE = "/Users/tester/Alpha"

/* ── model chain fixture:composer 不 ready 就不肯提交,而本文件的判据里有两条要走真提交。
      形制照搬 alpha-composer-model.cases.ts:真出厂目录 + 已登录平台账户。 ────────────── */
const catalog = {
  ...(await Bun.file(new URL("../src/main/alpha-models.json", import.meta.url)).json()),
  liveSync: { status: "static" },
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
function installApi() {
  Object.defineProperty(window, "api", {
    configurable: true,
    value: {
      endpoints: async () => null,
      openLink: () => {},
      openPath: () => {},
      workspaceDefaultDir: async () => DEFAULT_WORKSPACE,
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

function DraftLeaf(props: { projects: AlphaProjectsApi }) {
  // 上游 createDraftRoute 的 keyed 包装(packages/app/src/app.tsx):directory 变 ⇒ 整叶重挂。
  return createComponent(solid.Show, {
    get when() {
      return `${draft().server}\0${draft().directory}`
    },
    keyed: true,
    get children() {
      return createComponent(AlphaNewSession, {
        projects: props.projects,
        draftId: "draft-1",
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
  setDraft({ server: "sidecar", directory: "/ws/a" })
  document.body.replaceChildren()
})

afterEach(() => {
  disposers.splice(0).reverse().forEach((dispose) => dispose())
  setComposerModel(null)
  setComposerAgent(null)
  resetComposerModelProjection()
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
    setDraft({ server: "sidecar", directory: "" })
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

  test("用户自己清空 ⇒ 切目录后仍然是空的(暂存不复活已删内容)", async () => {
    newSessionDraftStash.capture("draft-1", { text: "早先输入的", mentions: [], attachments: [] })
    const host = mount(() => createComponent(DraftLeaf, { projects: projectsApi([project("alpha-code", "/ws/a"), project("beta", "/ws/b")]) }))
    await flush()
    expect(textarea(host)!.value).toBe("早先输入的")

    type(textarea(host)!, "")
    await flush()
    await openChipAndPick(host, "beta")

    expect(textarea(host)!.value).toBe("")
  })
})

describe("REQ-126 CODE-D chip 抽取后首页行为不变", () => {
  test("首页 chip 仍列出默认工作区 + 项目 + 打开项目…,选中即改 composer 的提交目标", async () => {
    const host = mount(() =>
      createComponent(AlphaHome, { projects: projectsApi([project("alpha-code", "/ws/a"), project("beta", "/ws/b")]) }),
    )
    await flush()
    await flush()

    expect(chipButton(host).textContent).toContain("alpha-code") // 既有优先级:第一个项目

    chipButton(host).click()
    await flush()
    const labels = popItems(host).map((button) => button.textContent ?? "")
    expect(labels[0]).toContain("Alpha") // 默认工作区常驻首项(未注册为项目)
    expect(labels.some((label) => label.includes("alpha-code"))).toBe(true)
    expect(labels.some((label) => label.includes("beta"))).toBe(true)

    popItems(host).find((button) => (button.textContent ?? "").includes("beta"))!.click()
    await flush()
    expect(chipButton(host).textContent).toContain("beta")

    type(textarea(host)!, "开工")
    await flush()
    textarea(host)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
    for (let i = 0; i < 20 && startChatCalls.length === 0; i++) await flush()

    expect(startChatCalls).toHaveLength(1)
    expect(startChatCalls[0]!.directory).toBe("/ws/b") // 选中的工作区,不是第一个项目
  })
})
