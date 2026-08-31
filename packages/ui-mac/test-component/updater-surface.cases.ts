// [ac#1207] REQ-147 —— 更新状态呈现的**组件端**闸门(renderer 半场)。
//
// AC1:点「检查更新」后,checking / downloading / ready / up-to-date / error 五个状态在
// footer 更新条上各有可见文案,且互不相同(文案来自 updater-state-surface.ts 的映射 + i18n;
// 这里不与任何一份词典逐字比 —— 判据是「互不相同 + 不是裸 key + 载荷哨兵出现」,对 locale 稳健)。
// AC2:订阅一开始就回放 ready(= main 从持久化恢复后的投影,恢复逻辑在
// src/main/updater-restore.test.ts),**不点任何东西**入口就可见,且点它调 install。
//
// 挂载走生产组合体(OverlayCloseHarness:真 AlphaSidebar + 真 @solidjs/router),交互走真实
// 点击。替身面与 account-version.cases.ts 同因同法:上游 ui 装饰件 / SDK 传输层 / preload 桥,
// 不含被测语义 —— updater 的桥替身只做「捕获订阅回调 + 计数 check/install」,状态推送本身
// 就是被测通路的输入端。子进程运行(src/renderer/sidebar/updater-surface.test.ts spawn):
// mock.module 会污染同进程其它测试文件。

import { transformAsync } from "@babel/core"
import presetTypescript from "@babel/preset-typescript"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test"
import presetSolid from "babel-preset-solid"
import type { UpdaterState } from "@opencode-ai/app/updater"
import type { AlphaProject, AlphaProjectsApi } from "../src/renderer/sidebar/use-projects"

GlobalRegistrator.register()
const solid = await import("solid-js/dist/solid.js")
mock.module("solid-js", () => solid)
const solidWeb = await import("solid-js/web/dist/web.js")
mock.module("solid-js/web", () => solidWeb)
const solidStore = await import("solid-js/store/dist/store.js")
mock.module("solid-js/store", () => solidStore)

Bun.plugin({
  name: "updater-surface-component-test",
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

// —— 替身面(装饰/传输,不是被测语义;同 account-version.cases.ts)——————————————————
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

/** 生产里不存在的哨兵载荷:呈现若把版本/错误写成字面量,哨兵不会出现,当场红。 */
const VERSION_SENTINEL = "9.9.7-ac1207-sentinel"
const MESSAGE_SENTINEL = "boom-ac1207-sentinel"

// —— preload 桥替身:updater 是被测通路的 renderer 端 ————————————————————————————
let updaterCb: ((state: UpdaterState) => void) | null = null
/** 订阅时立即回放的初始状态(AC2 = main 恢复投影后的 ready)。null = 不回放。 */
let initialUpdaterState: UpdaterState | null = null
let checkCalls = 0
let installCalls = 0

const EXPLICIT: Record<string, (...args: unknown[]) => unknown> = {
  appVersion: async () => "1.0.0",
  "auth.getState": async () => ({ status: "logged-out", mode: "byok" }),
  "account.summary": async () => null,
  endpoints: async () => ({}),
  "updater.subscribe": async (cb: unknown) => {
    updaterCb = cb as (state: UpdaterState) => void
    if (initialUpdaterState) updaterCb(initialUpdaterState)
    return () => {
      updaterCb = null
    }
  },
  "updater.check": async () => {
    checkCalls += 1
    return { status: "checking" }
  },
  "updater.install": async () => {
    installCalls += 1
  },
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

// —— 生产组合体(真实侧栏 + 真实路由;同 account-version)————————————————————————
const runtime = await import("../src/renderer/sidebar/overlay-close-test-runtime")
const { hrefFor } = await import("../src/shared/route-manifest")

const DIR = "/Users/tester/proj-a"

function makeProjects(): AlphaProjectsApi {
  const project: AlphaProject = {
    id: "prj-a",
    worktree: DIR,
    name: "proj-a",
    directories: [DIR],
    loaded: true,
    sessions: [{ id: "ses-current", title: "当前会话", directory: DIR, projectID: "prj-a", updated: 200 }],
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
  updaterCb = null
  initialUpdaterState = null
  checkCalls = 0
  installCalls = 0
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

async function push(state: UpdaterState) {
  expect(updaterCb, "生产侧栏应已通过 window.api.updater.subscribe 订阅").not.toBeNull()
  updaterCb!(state)
  await flush()
}

const note = () => document.querySelector(".alpha-updater-note")

test("AC1:主动检查后,五个状态各有可见文案且互不相同(载荷哨兵逐字出现)", async () => {
  await mount()
  expect(note(), "初始(disabled)不应画更新条").toBeNull()

  // 真实交互:打开账户浮层 → 点「检查更新」
  const trigger = document.querySelector(".alpha-sidebar-account")
  expect(trigger, "侧栏账户入口未挂载").not.toBeNull()
  click(trigger!)
  await flush()
  const row = document.querySelector('[data-alpha-acct-item="check-updates"]')
  expect(row, "浮层里没有「检查更新」项").not.toBeNull()
  click(row!)
  await flush()
  expect(checkCalls, "点「检查更新」应调 window.api.updater.check").toBe(1)
  expect(document.querySelector(".alpha-acct-pop"), "点完应关掉浮层").toBeNull()

  const states: UpdaterState[] = [
    { status: "checking" },
    { status: "downloading", version: VERSION_SENTINEL },
    { status: "ready", version: VERSION_SENTINEL },
    { status: "up-to-date" },
    { status: "error", message: MESSAGE_SENTINEL },
  ]
  const copies: string[] = []
  for (const state of states) {
    await push(state)
    const el = note()
    expect(el, `status=${state.status} 应有可见呈现`).not.toBeNull()
    expect(el!.getAttribute("data-status")).toBe(state.status)
    const text = el!.textContent ?? ""
    expect(text.trim().length, `status=${state.status} 文案不应为空`).toBeGreaterThan(0)
    // t() 对缺 key 返回 key 本身 —— 裸 key 也「互不相同」,所以单独拦住
    expect(text.includes("alpha.updater."), `status=${state.status} 渲染的是裸 i18n key:${text}`).toBe(false)
    copies.push(text)
  }
  expect(new Set(copies).size, `五个状态的文案必须互不相同:${copies.join(" | ")}`).toBe(states.length)
  expect(copies[1]).toContain(VERSION_SENTINEL) // downloading 显示版本
  expect(copies[2]).toContain(VERSION_SENTINEL) // ready 显示版本
  expect(copies[4]).toContain(MESSAGE_SENTINEL) // error 显示错误消息
})

test("AC2:订阅回放 ready(重启恢复投影)→ 零交互即可见安装入口,点它调 install", async () => {
  initialUpdaterState = { status: "ready", version: VERSION_SENTINEL }
  await mount()

  const el = note()
  expect(el, "重启后(ready 回放)更新条应直接可见,不依赖打开任何菜单").not.toBeNull()
  expect(el!.getAttribute("data-status")).toBe("ready")
  expect(el!.textContent ?? "").toContain(VERSION_SENTINEL)

  const install = el!.querySelector(".alpha-updater-install")
  expect(install, "ready 态应有安装按钮").not.toBeNull()
  click(install!)
  await flush()
  expect(installCalls, "点安装应调 window.api.updater.install").toBe(1)
})

test("反例:未主动检查时 up-to-date 不显示(可见性由映射门控,不是常亮)", async () => {
  initialUpdaterState = { status: "up-to-date" }
  await mount()
  expect(note()).toBeNull()
})
