// ac#1187 —— 账户浮层显示当前版本号的**组件端**闸门。
//
// 判据钉在取值来源上,不是「浮层里有个像版本号的字符串」:window.api.appVersion(preload 桥,
// 另一端由 src/main/app-version-ipc.wiring.cases.ts 钉在 app.getVersion() 上)在这里给一个
// 生产里不存在的哨兵版本号,断言打开账户浮层后它出现在浮层 DOM 里 —— 组件若把版本写成
// 字面量(不管抄的是真版本还是别的),哨兵值不会出现,当场红。
// 登录/登出两种分支都断言:版本行挂在 auth <Show> 之外,谁也不该丢。
//
// 挂载走生产组合体(OverlayCloseHarness:真 AlphaSidebar + 真 @solidjs/router),
// 打开浮层走真实点击(.alpha-sidebar-account)。替身面与 overlay-close.cases.ts 同因同法:
// 上游 ui 装饰件 / SDK 传输层 / preload 桥,不含被测语义。
// 子进程运行(src/renderer/sidebar/account-version.test.ts spawn):mock.module 会污染同进程。

import { transformAsync } from "@babel/core"
import presetTypescript from "@babel/preset-typescript"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test"
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
  name: "account-version-component-test",
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

// —— 替身面(装饰/传输,不是被测语义;同 overlay-close.cases.ts)——————————————————
mock.module("@opencode-ai/ui/v2/icon", () => ({ Icon: () => null }))
mock.module("@opencode-ai/ui/v2/project-avatar-v2", () => ({ ProjectAvatar: () => null }))
mock.module("@opencode-ai/ui/theme/context", () => ({
  useTheme: () => ({ colorScheme: () => "dark", setColorScheme: () => {} }),
}))
mock.module("../src/renderer/alpha-ui/providers", () => ({
  useCommand: () => ({ options: [], register: () => {}, trigger: () => {}, show: () => {}, hide: () => {} }),
  ServerConnection: { key: () => "sidecar", Key: { make: (value: string) => value } },
  useTabs: () => ({
    ready: Object.assign(() => true, { promise: undefined }),
    newDraft: () => new Promise<void>(() => {}),
  }),
  useServer: () => ({ key: "sidecar", isLocal: () => true, projects: { list: () => [] } }),
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

/** 生产里不存在的哨兵版本号:字面量实现抄不到它,抄了真版本也匹配不上。 */
const SENTINEL_VERSION = "9.9.9-ac1187-sentinel"
/** 登录态按用例切换(登录/登出两分支都得有版本行)。 */
let authStatus: "logged-in" | "logged-out" = "logged-out"

// —— preload 桥替身:appVersion 是被测通路的 renderer 端,给哨兵值 ——————————————————
const EXPLICIT: Record<string, (...args: unknown[]) => unknown> = {
  appVersion: async () => SENTINEL_VERSION,
  "auth.getState": async () =>
    authStatus === "logged-in"
      ? { status: "logged-in", mode: "cloud", email: "tester@example.com" }
      : { status: "logged-out", mode: "byok" },
  "account.summary": async () => null,
  endpoints: async () => ({}),
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

// —— 生产组合体(真实侧栏 + 真实路由;同 overlay-close)—————————————————————————
const runtime = await import("../src/renderer/sidebar/overlay-close-test-runtime")
const { hrefFor } = await import("../src/shared/route-manifest")

const DIR = "/Users/tester/proj-a"
const SESSION = "ses-current"

function makeProjects(): AlphaProjectsApi {
  const project: AlphaProject = {
    id: "prj-a",
    worktree: DIR,
    name: "proj-a",
    directories: [DIR],
    loaded: true,
    sessions: [{ id: SESSION, title: "当前会话", directory: DIR, projectID: "prj-a", updated: 200 }],
  }
  return {
    store: { projects: [project], ready: true, error: false },
    reload: async () => {},
    createSession: async () => "ses-created",
    startChat: async () => "ses-created",
    sdk: () => undefined,
    renameSession: async () => true,
    shareSession: async () => undefined,
    deleteSession: async () => true,
    copySession: async () => undefined,
  } as unknown as AlphaProjectsApi
}

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
})

afterEach(() =>
  disposers
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose()),
)

afterAll(() => GlobalRegistrator.unregister())

async function mount() {
  const history = runtime.createMemoryHistory()
  history.set({ value: hrefFor.home() })
  const host = document.getElementById("root")!
  disposers.push(solidWeb.render(() => runtime.OverlayCloseHarness({ history, projects: makeProjects() }), host))
  await flush()
}

function click(el: Element) {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
}

for (const status of ["logged-out", "logged-in"] as const) {
  test(`账户浮层(${status})显示当前版本号,值来自 window.api.appVersion`, async () => {
    authStatus = status
    await mount()
    const trigger = document.querySelector(".alpha-sidebar-account")
    expect(trigger, "侧栏账户入口未挂载").not.toBeNull()
    click(trigger!)
    await flush()
    const pop = document.querySelector(".alpha-acct-pop")
    expect(pop, "点账户入口没打开浮层").not.toBeNull()
    // 前提自检:分支真的是我们要的那个(登录分支有退出登录项,登出分支没有)。
    expect((pop!.textContent ?? "").includes(zh["alpha.sidebar.signOut"])).toBe(status === "logged-in")
    const line = pop!.querySelector(".alpha-acct-version")
    expect(line, "浮层里没有版本行").not.toBeNull()
    expect(line!.textContent ?? "").toContain(SENTINEL_VERSION)
    expect(line!.textContent ?? "").toContain(zh["alpha.sidebar.version"])
  })
}
