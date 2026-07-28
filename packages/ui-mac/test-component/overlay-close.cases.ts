// REQ-126 AC2(#655)覆盖层随导航关闭 —— **运行时**参数化闸门。
//
// 判据形制(方案基线 §3 不变量 7 / §4 序 2 指定):挂**真实**覆盖层宿主(生产 ExtensionHub /
// AutomationPanel)与**真实**侧栏(生产 AlphaSidebar),路由是真的 @solidjs/router,断言
// 「覆盖层的 DOM 从 document 里消失」。刻意**不**断言 extHubOpen()/automationOpen() 的值:
// 信号可以被任何别处顺手置位,只有 DOM 才是用户看见的那个东西。更不断言源码文本。
//
// 矩阵 = 每个**已登记覆盖层** × 每类**导航路径**:
//   主轨(侧栏点击,与目标是否等于当前路由无关)
//     · 点当前正在看的那个会话 ← owner 报的动作;**URL 不变**,只靠 route effect 永远关不掉
//     · 点另一个会话 / 点「新对话」/ 点首页
//     · 点项目行的「+」——这一格的会话创建**保持未决**:关闭是导航**意图**的一部分,不能等
//       异步结果;用立即 resolve 的桩会把「关闭写在 await 之后」这个缺陷藏掉
//   兜底轨(不经侧栏点击)
//     · 程序化导航(深链、面板内回跳)
//     · 同 pathname 换 search(`/new-session?draftId=…` 的 draft 切换)—— 只看 pathname 会漏
//
// 每格自带前提自检(点之前必须**先**断言覆盖层真的在场),否则"覆盖层压根没打开"会让整格
// 空绿 —— 那是空闸门。
//
// 由 src/renderer/sidebar/overlay-close.test.ts 起子进程执行(本文件的 mock.module 会污染
// 同进程内其它测试:solid 实例、@opencode-ai/ui、SDK client 全被替身接管)。

import { transformAsync } from "@babel/core"
import presetTypescript from "@babel/preset-typescript"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import presetSolid from "babel-preset-solid"
import type { AlphaProject, AlphaProjectsApi } from "../src/renderer/sidebar/use-projects"
import { dict as zh } from "../src/renderer/i18n/zh"

GlobalRegistrator.register()
const solid = await import("solid-js/dist/solid.js")
mock.module("solid-js", () => solid)
const solidWeb = await import("solid-js/web/dist/web.js")
mock.module("solid-js/web", () => solidWeb)
const solidStore = await import("solid-js/store/dist/store.js")
mock.module("solid-js/store", () => solidStore)

Bun.plugin({
  name: "overlay-close-component-test",
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

// —— 替身面(全部是**装饰/传输**,不是被测语义)——————————————————————————————
// 上游 ui 组件(图标/头像/主题)与 SDK 传输层与「导航时覆盖层是否关闭」无关;侧栏与两个
// 覆盖层本体一律真实。useCommand 是上游命令面板句柄(ADR-016 借用面),本票不触发命令。
mock.module("@opencode-ai/ui/v2/icon", () => ({ Icon: () => null }))
mock.module("@opencode-ai/ui/v2/project-avatar-v2", () => ({ ProjectAvatar: () => null }))
mock.module("@opencode-ai/ui/theme/context", () => ({
  useTheme: () => ({ colorScheme: () => "dark", setColorScheme: () => {} }),
}))
mock.module("../src/renderer/alpha-ui/providers", () => ({
  useCommand: () => ({ options: [], trigger: () => {}, show: () => {}, hide: () => {} }),
  useContractHealth: () => () => null,
  ContractHealthProvider: (props: { children?: unknown }) => props.children,
}))
mock.module("@opencode-ai/sdk/v2/client", () => ({ createOpencodeClient: () => sdkStub() }))

function sdkStub(): unknown {
  const fail = async () => ({ data: undefined, error: { message: "offline in test" } })
  return new Proxy(
    {},
    {
      get: (_t, prop) => (prop === "then" ? undefined : new Proxy(fail, { get: () => fail })),
    },
  )
}

// —— preload 桥替身:renderer 侧一切 IPC 都经 window.api ——————————————————————
// 形状明确的给真值(否则生产代码的 try/catch 会把"没数据"和"桥坏了"混为一谈);其余按名字
// 分两类兜底:`on*`/`subscribe*` 返回退订函数,别的返回已 resolve 的 Promise。
const EXPLICIT: Record<string, (...args: unknown[]) => unknown> = {
  "auth.getState": async () => ({ status: "logged-out", mode: "byok" }),
  "automations.list": async () => ({ tasks: [], state: { pausedAll: false }, loginItem: false }),
  "automations.cloudSync": async () => ({}),
  "account.summary": async () => null,
  endpoints: async () => ({}),
  "ext.listInstalls": async () => ({ global: [], project: [] }),
  "ext.inventoryView": async () => ({ rows: [] }),
  "ext.sessionGrants": async () => ({ grants: [] }),
  "ext.factorySkillIds": async () => [],
  "ext.remoteCatalog": async () => ({ source: "none", catalog: undefined }),
}

function apiNode(path: string[]): unknown {
  const call = (...args: unknown[]) => {
    const key = path.join(".")
    if (key in EXPLICIT) return EXPLICIT[key]!(...args)
    const leaf = path[path.length - 1] ?? ""
    if (/^(on[A-Z]|subscribe)/.test(leaf)) return () => {}
    return Promise.resolve(undefined)
  }
  return new Proxy(call, {
    get: (_t, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : apiNode([...path, prop])),
  })
}
;(globalThis as unknown as { window: { api: unknown } }).window.api = apiNode([])

// —— 生产组合体(真实侧栏 + 真实两个覆盖层 + 真实路由)—————————————————————————
const runtime = await import("../src/renderer/sidebar/overlay-close-test-runtime")
const { sessionHref } = await import("../src/renderer/sidebar/route")
const { hrefFor } = await import("../src/shared/route-manifest")
const extHubState = await import("../src/renderer/extensions/ext-hub-state")
const automationState = await import("../src/renderer/automations/automation-state")

const DIR = "/Users/tester/proj-a"
const CURRENT_SESSION = "ses-current"
const OTHER_SESSION = "ses-other"

function makeProjects(overrides?: { createSession?: () => Promise<string | undefined> }): AlphaProjectsApi {
  const project: AlphaProject = {
    id: "prj-a",
    worktree: DIR,
    name: "proj-a",
    directories: [DIR],
    loaded: true,
    sessions: [
      { id: CURRENT_SESSION, title: "当前会话", directory: DIR, projectID: "prj-a", updated: 200 },
      { id: OTHER_SESSION, title: "另一个会话", directory: DIR, projectID: "prj-a", updated: 100 },
    ],
  }
  return {
    store: { projects: [project], ready: true, error: false },
    reload: async () => {},
    createSession: overrides?.createSession ?? (async () => "ses-created"),
    startChat: async () => "ses-created",
    sdk: () => undefined,
    renameSession: async () => true,
    shareSession: async () => undefined,
    deleteSession: async () => true,
    copySession: async () => undefined,
  } as unknown as AlphaProjectsApi
}

// —— 已登记的全页覆盖层。新增一个却不加进这里 = 本闸门漏掉它(方案基线 S2 明说:防漏靠
//    测试而非架构)。navLabel 是侧栏里打开它的那个 nav 项。 ——————————————————————
const OVERLAYS = [
  { name: "定制中心 ExtensionHub", navLabel: zh["alpha.sidebar.plugins"], host: "[data-alpha-ext-hub]", page: ".alpha-ext-page" },
  { name: "自动化 AutomationPanel", navLabel: zh["alpha.sidebar.automation"], host: "[data-alpha-automations]", page: ".alpha-auto-page" },
] as const

const disposers: Array<() => void> = []

async function flush() {
  for (let i = 0; i < 4; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  localStorage.clear()
  document.body.replaceChildren()
  const root = document.createElement("div")
  root.id = "root"
  document.body.append(root)
  extHubState.setExtHubOpen(false)
  automationState.setAutomationOpen(false)
})

afterEach(() =>
  disposers
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose()),
)

afterAll(() => GlobalRegistrator.unregister())

/** 挂真实组合体,并把位置摆到 `startPath`(冷启动落地 effect 自己会 navigate 一次,故挂完再摆)。 */
async function mount(startPath: string, projectOverrides?: Parameters<typeof makeProjects>[0]) {
  const history = runtime.createMemoryHistory()
  history.set({ value: startPath })
  const host = document.getElementById("root")!
  disposers.push(
    solidWeb.render(() => runtime.OverlayCloseHarness({ history, projects: makeProjects(projectOverrides) }), host),
  )
  await flush()
  history.set({ value: startPath })
  await flush()
  return history
}

function overlayPresent(overlay: (typeof OVERLAYS)[number]): boolean {
  return document.querySelector(`${overlay.host} ${overlay.page}`) !== null
}

/** 覆盖层的 portal 宿主必须被清空 —— 「关闭」= DOM 不在了,不是被藏起来。 */
function overlayHostChildren(overlay: (typeof OVERLAYS)[number]): number {
  return document.querySelector(overlay.host)?.childElementCount ?? -1
}

function query<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector)
  if (!el) throw new Error(`未找到元素:${selector}`)
  return el
}

function navItem(label: string): HTMLElement {
  for (const el of document.querySelectorAll<HTMLElement>(".alpha-sidebar-nav .alpha-sidebar-nav-item")) {
    if ((el.textContent ?? "").includes(label)) return el
  }
  throw new Error(`侧栏 nav 项未找到:${label}`)
}

function click(el: Element) {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
}

/** 真的点侧栏那个 nav 项来打开覆盖层 —— 不用信号直接置位,开与关走同一条生产路径。 */
async function open(overlay: (typeof OVERLAYS)[number]) {
  click(navItem(overlay.navLabel))
  await flush()
}

const CURRENT_HREF = sessionHref(DIR, CURRENT_SESSION)
const OTHER_HREF = sessionHref(DIR, OTHER_SESSION)
const DRAFT_A = hrefFor.newSession("draft-a")
const DRAFT_B = hrefFor.newSession("draft-b")

/**
 * 导航路径矩阵的另一维。`act` 拿到 history 以便执行**不经侧栏**的程序化导航;
 * `projects` 覆盖数据层桩,用来钉住"关闭必须发生在导航**意图**处、不等异步结果"。
 */
const NAVIGATIONS: Array<{
  name: string
  track: "click" | "route"
  projects?: Parameters<typeof makeProjects>[0]
  act: (history: ReturnType<typeof runtime.createMemoryHistory>) => void
}> = [
  // 主轨:侧栏点击。第一格是本票的核心缺口 —— 目标 == 当前路由,URL 一个字符都不变。
  { name: "点当前正在看的那个会话(URL 不变)", track: "click", act: () => click(query(`a.alpha-session[href="${CURRENT_HREF}"]`)) },
  { name: "点另一个会话", track: "click", act: () => click(query(`a.alpha-session[href="${OTHER_HREF}"]`)) },
  { name: "点「新对话」", track: "click", act: () => click(navItem(zh["alpha.sidebar.newChat"])) },
  { name: "点首页(品牌区)", track: "click", act: () => click(query(".alpha-sidebar-brand-mark")) },
  // 会话创建**保持未决**:生产 startChat 的导航在 `await createSession(...)` 之后,而真实创建是
  // 多个 await(use-projects.ts:294-307)。用立即 resolve 的桩会把「关闭发生在 await 之后」这个
  // 缺陷藏掉(#655 审计 Major 就是这么漏的)——所以这一格断言的是**点下去当场就关**,不等 resolve。
  {
    name: "点项目行的新对话「+」(会话创建未决 → 必须当场关,不等结果)",
    track: "click",
    projects: { createSession: () => new Promise<string | undefined>(() => {}) },
    act: () => click(query(".alpha-project-add")),
  },
  // 兜底轨:不经侧栏点击(深链、程序化导航、自动化面板内「回跳会话」)。
  { name: "程序化导航到首页(深链/面板内回跳)", track: "route", act: (history) => history.set({ value: hrefFor.home() }) },
  { name: "同 pathname 换 search(draft 之间切换)", track: "route", act: (history) => history.set({ value: DRAFT_B }) },
]

describe("REQ-126 AC2:覆盖层随导航关闭(真实宿主 × 真实点击)", () => {
  test("前提自检:两个覆盖层都能挂起来,且默认不在场", async () => {
    await mount(CURRENT_HREF)
    for (const overlay of OVERLAYS) {
      expect(document.querySelector(overlay.host), `${overlay.name} 的 portal 宿主未挂载`).not.toBeNull()
      expect(overlayPresent(overlay), `${overlay.name} 未打开却已在 DOM 里`).toBe(false)
    }
    for (const overlay of OVERLAYS) {
      await open(overlay)
      expect(overlayPresent(overlay), `点侧栏「${overlay.navLabel}」没能打开 ${overlay.name}`).toBe(true)
    }
  })

  test("前提自检:draft 切换那格确实只变 search —— 否则它退化成普通 pathname 变化", () => {
    const a = new URL(DRAFT_A, "http://x")
    const b = new URL(DRAFT_B, "http://x")
    expect(a.pathname).toBe(b.pathname)
    expect(a.search).not.toBe(b.search)
  })

  for (const overlay of OVERLAYS) {
    for (const nav of NAVIGATIONS) {
      test(`${overlay.name} × ${nav.name} → 覆盖层 DOM 消失`, async () => {
        const history = await mount(nav.name.includes("draft") ? DRAFT_A : CURRENT_HREF, nav.projects)

        await open(overlay)
        // 前提自检:没先打开就断言"消失"是空闸门。
        expect(overlayPresent(overlay), `前提不成立:${overlay.name} 没打开`).toBe(true)

        nav.act(history)
        await flush()

        expect(overlayPresent(overlay), `${nav.name} 之后 ${overlay.name} 仍压在页面上`).toBe(false)
        expect(overlayHostChildren(overlay), `${overlay.name} 的宿主还留着节点(只是藏起来不算关)`).toBe(0)
      })
    }
  }
})
