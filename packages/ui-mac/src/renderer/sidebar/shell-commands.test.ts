// REQ-126 AC7(#658)壳命令处置闸门。
//
// 保证(删掉本文件会失去什么):alpha 界面上**又出现一个指向未注册命令的可点入口**这件事将不再有
// 任何东西能发现。上游 `run()` 对未注册 id **静默返回** —— 这类 bug 不抛错、不打日志、不留痕迹,
// 唯一的症状是「点了没反应」,所以只能由运行时逐入口触发来抓。
//
// 判据按**入口**枚举,不按命令枚举(基线 §1.6 那张表两轮审计各挖出新成员,不保证穷尽):
//   · 保留/改接的入口 —— 真点一次,断言**可观察结果**(真实 DOM 出现 / 真实路由变化 / 真实副作用);
//   · 退休的入口 —— 断言那块 DOM **不存在**,同时断言它所在的容器还在(否则「整个侧栏没渲染」
//     也能让断言变绿);
//   · 桌面菜单 —— 发布面(shared/desktop-menu-policy)上的每一条,都要在真实壳里确实注册,
//     且逐条触发有 alpha 自己的可观察结果。上游日后新增菜单命令默认落进发布面 → 直接在这里变红。
//
// 没有一条断言源码文本(基线 §3 不变量 7 明令源码锚定式断言不得作为本 REQ 的证据)。

import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import appPlugin from "@opencode-ai/app/vite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import type { render } from "solid-js/web"
import type * as Runtime from "./shell-commands-test-runtime"
import { RETIRED_MENU_COMMANDS, publishedMenuCommands } from "../../shared/desktop-menu-policy"
import { homeHref, newSessionHref, sessionHref } from "./route"

type TestRuntime = typeof Runtime & { render: typeof render }

const appSrc = join(import.meta.dir, "../../../../app/src")

// 与 Electron renderer 同一个 Solid vite 插件编译生产组件:bun 原生 TSX 变换是 React 形状的,
// 会静默丢掉 Solid 的 ref 与响应式 DOM 表达式。两个 alias 不是替身,是**消歧**:worktree 的
// node_modules 是主 checkout 的软链,`@opencode-ai/app` 会解析出两条不同的绝对路径 → 同一个
// context 出现两份实例 → `usePlatform` 在自己的 provider 里也报 "must be used within a
// context provider"。钉到 worktree 内的同一份源码即消歧。
const runtimeDirectory = mkdtempSync(join(tmpdir(), "alpha-shell-commands-"))
await build({
  configFile: false,
  logLevel: "silent",
  plugins: [appPlugin.at(-1)!],
  worker: { format: "es" },
  resolve: {
    dedupe: ["solid-js", "solid-js/web", "@solidjs/router"],
    alias: [
      { find: /^@opencode-ai\/app$/, replacement: join(appSrc, "index.ts") },
      { find: /^@\//, replacement: `${appSrc}/` },
    ],
  },
  build: {
    emptyOutDir: true,
    outDir: runtimeDirectory,
    lib: {
      entry: join(import.meta.dir, "shell-commands-test-runtime.tsx"),
      formats: ["es"],
      fileName: () => "shell-commands-test-runtime.js",
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
})

const disposers: Array<() => void> = []
GlobalRegistrator.register()
const runtime = (await import(
  pathToFileURL(join(runtimeDirectory, "shell-commands-test-runtime.js")).href
)) as TestRuntime

beforeEach(() => {
  document.body.replaceChildren()
  delete document.body.dataset.alphaSidebar
  runtime.installRootHost()
  runtime.installPreloadStub()
  runtime.resetHarness()
})

afterEach(async () => {
  disposers.splice(0).reverse().forEach((dispose) => dispose())
  await settle()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
  rmSync(runtimeDirectory, { recursive: true, force: true })
})

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
}

/** 真实壳有若干层异步 provider(设置、连接门、路由);给它们几个 microtask 轮次落定。 */
async function settle() {
  for (let i = 0; i < 40; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (let i = 0; i < 40; i++) await Promise.resolve()
}

async function mountShell(component: () => unknown) {
  const host = document.createElement("div")
  document.body.append(host)
  disposers.push(runtime.render(component, host))
  await settle()
  return host
}

/* ── 生产 DOM 上的选择器(全部是生产代码里真实存在的钩子)────────────────────── */
const settingsSurface = () => document.querySelector("[data-alpha-settings]")
const accountButton = () => document.querySelector<HTMLButtonElement>(".alpha-sidebar-account")!
const settingsItem = () => document.querySelector<HTMLButtonElement>("[data-alpha-acct-item='settings']")
const leftToolbar = () => document.querySelector(".alpha-topbar")
const openProjectButton = () => document.querySelector<HTMLButtonElement>("[data-alpha-sidebar-open-project]")
const brandButton = () => document.querySelector<HTMLButtonElement>(".alpha-sidebar-brand-mark")!

async function openAccountMenu() {
  accountButton().click()
  await flush()
}

describe("侧栏账户菜单「设置」:改接 alpha 自有设置面,与路由无关", () => {
  test("在首页点设置 → 真实的 alpha 设置面出现在 DOM 里", async () => {
    // 首页是「原来死得最彻底」的那条路由:上游三叶已被顶替、legacy layout 不挂载。
    runtime.setHasProjects(false)
    await mountShell(() => runtime.AlphaShell())
    expect(runtime.routerPath()).toBe(homeHref())
    expect(settingsSurface()).toBeNull()

    await openAccountMenu()
    expect(settingsItem()).not.toBeNull()
    settingsItem()!.click()
    await settle()

    expect(settingsSurface()).not.toBeNull()
    expect(settingsSurface()!.getAttribute("role")).toBe("dialog")
  })

  test("设置页的快捷键表里,一条已退休的命令 id 都不许出现", async () => {
    // 这也是一批**指向命令的入口**:每行都能改键位、能保存,而上游只对已注册的命令应用自定义
    // 键位 —— 留一条退休 id 在表里,就是又一个「改完保存、按下去什么都不发生」。
    // 判据落在真渲染出来的 DOM 上(必须先真把设置内容加载出来,否则这一格是空的)。
    runtime.setHasProjects(false)
    await mountShell(() => runtime.AlphaShell())
    await openAccountMenu()
    settingsItem()!.click()
    await settle()

    document.querySelector<HTMLButtonElement>("[data-settings-section='shortcuts']")!.click()
    await settle()

    const rows = Array.from(document.querySelectorAll<HTMLElement>(".alpha-settings-shortcut-row code"))
    const ids = rows.map((row) => row.textContent)
    // 前提自检:表真的渲染出来了(否则下面的 not.toContain 是空绿)。
    expect(ids.length).toBeGreaterThan(0)
    expect(ids).toContain("settings.open")
    for (const retired of RETIRED_MENU_COMMANDS) expect(ids).not.toContain(retired)
    // 反过来也要真:表里每一条都得在真实壳里确实注册,否则它同样是个改了不生效的输入框。
    const registered = new Set(runtime.registeredCommands())
    expect(ids.filter((id) => !registered.has(id!))).toEqual([])
  })

  test("负对照:回到本票之前那个世界(无 alpha 壳级注册),同一条命令点了什么都不发生", async () => {
    await mountShell(() => runtime.ShellWithLegacySettingsEntryOnly())
    expect(runtime.routerPath()).toBe(homeHref())

    const legacy = document.querySelector<HTMLButtonElement>("[data-legacy-settings-entry]")
    expect(legacy).not.toBeNull()
    legacy!.click()
    await settle()

    // 无人注册 → 上游 `run()` 静默返回。这正是 owner 报的「点了没反应」的形状。
    expect(settingsSurface()).toBeNull()
  })
})

describe("新对话页右上角「终端 / 审查」:连按钮一起退休", () => {
  test("落地路由上不存在这对浮动按钮,而左上角工具簇还在(证明壳确实渲染了)", async () => {
    await mountShell(() => runtime.AlphaShell())

    expect(leftToolbar()).not.toBeNull()
    expect(leftToolbar()!.querySelectorAll("button")).toHaveLength(3) // 折叠 + 后退 + 前进
    expect(document.querySelector(".alpha-topbar-right")).toBeNull()
    // 按可观察语义再查一次:整篇 DOM 里不该再有终端/审查这对浮动开关。
    expect(document.querySelectorAll(".alpha-topbar-btn")).toHaveLength(3)
  })

  test("换到首页也不会冒出来(以前它由 `inWorkspace()` 控制,首页藏、新对话页可见且无效)", async () => {
    await mountShell(() => runtime.AlphaShell())
    brandButton().click()
    await settle()

    expect(runtime.routerPath()).toBe(homeHref())
    expect(leftToolbar()).not.toBeNull()
    expect(document.querySelector(".alpha-topbar-right")).toBeNull()
    expect(document.querySelectorAll(".alpha-topbar-btn")).toHaveLength(3)
  })
})

describe("空项目态「打开项目」:改走 alpha 自己的目录选择", () => {
  test("点它 → 真的弹目录选择,选中后在该目录开一段对话并跳进去", async () => {
    runtime.setHasProjects(false)
    await mountShell(() => runtime.AlphaShell())

    const button = openProjectButton()
    expect(button).not.toBeNull()
    button!.click()
    await settle()

    expect(runtime.pickerCalls()).toBe(1)
    expect(runtime.createdIn()).toEqual([runtime.PICKED_DIRECTORY])
    // 真实 router 真的收到了去那条会话路由的导航。判据取 router 自己的 beforeLeave,而不是
    // 最终 location:上游对 legacy 会话路由会立刻再 redirect 一次,中间那一站在同一批次里就被
    // 覆盖掉了(这条 admission 跳转正是 REQ-126 CODE-C 在处置的东西,不是本票的命题)。
    expect(runtime.navigationIntents()).toContain(sessionHref(runtime.PICKED_DIRECTORY, runtime.CREATED_SESSION_ID))
  })

  test("用户取消选择 → 不建会话、不跳转", async () => {
    runtime.setHasProjects(false)
    runtime.setPickerResult(null)
    await mountShell(() => runtime.AlphaShell())
    const before = runtime.navigationIntents()

    openProjectButton()!.click()
    await settle()

    expect(runtime.pickerCalls()).toBe(1)
    expect(runtime.createdIn()).toEqual([])
    expect(runtime.navigationIntents()).toEqual(before)
  })
})

describe("composer 权限档位:退休无效的「全自动」档", () => {
  test("弹层里只剩两档,且都是真的 —— 只读会改变提交参数,「全自动」曾经改不了任何东西", async () => {
    await mountShell(() => runtime.PermChipHost())

    const chip = document.querySelector<HTMLButtonElement>(".a-chip-perm")!
    expect(chip).not.toBeNull()
    chip.click()
    await flush()

    const tiers = () => Array.from(document.querySelectorAll<HTMLButtonElement>("[role='menuitemradio']"))
    expect(tiers()).toHaveLength(2)
    const labels = tiers().map((tier) => tier.textContent)

    // 逐档真点,判据是**提交层真的不同** —— 只断言 chip 选中态是修前即绿的假闸门:退休掉的
    // 「全自动」当年选得中、亮得起来,却与「询问」产出逐字节相同的请求。
    const seen = new Map<string, string | undefined>()
    for (const label of labels) {
      if (tiers().length === 0) {
        chip.click()
        await flush()
      }
      tiers().find((candidate) => candidate.textContent === label)!.click()
      await flush()
      seen.set(chip.dataset.mode!, runtime.submittedAgent())
    }
    expect([...seen.keys()].sort()).toEqual(["ask", "readonly"])
    expect(seen.get("readonly")).toBe(runtime.READONLY_AGENT)
    expect(seen.get("ask")).toBeUndefined()
  })
})

describe("桌面菜单:发布面上的每一条在真实壳里都接得住", () => {
  test("发布的命令 id 全部真的注册了(上游新增菜单项会在这里变红)", async () => {
    runtime.setHasProjects(false)
    await mountShell(() => runtime.AlphaShell())
    expect(runtime.routerPath()).toBe(homeHref())
    const registered = new Set(runtime.registeredCommands())
    const published = publishedMenuCommands("macos")

    expect(published.length).toBeGreaterThan(0)
    expect(published.filter((id) => !registered.has(id))).toEqual([])
  })

  test("逐条触发,每一条都有 alpha 自己的可观察结果", async () => {
    runtime.setHasProjects(false)
    await mountShell(() => runtime.AlphaShell())
    expect(runtime.routerPath()).toBe(homeHref())

    // settings.open —— alpha 设置面出现(修复前首页上这条命令无人注册,见上面的负对照)。
    expect(settingsSurface()).toBeNull()
    runtime.trigger("settings.open")
    await settle()
    expect(settingsSurface()).not.toBeNull()

    // sidebar.toggle —— alpha 侧栏的可见性写在 body 上(上游那条只动上游自己的侧栏)。
    const before = document.body.dataset.alphaSidebar
    runtime.trigger("sidebar.toggle")
    await settle()
    expect(document.body.dataset.alphaSidebar).not.toBe(before)

    // project.open —— 弹 alpha 自己的目录选择(上游那条只往上游 layout 的项目列表里加)。
    expect(runtime.pickerCalls()).toBe(0)
    runtime.trigger("project.open")
    await settle()
    expect(runtime.pickerCalls()).toBe(1)

    // logs.export —— 上游 app.tsx 全局注册,alpha 不接管也不退休;真跑到 platform 那一层。
    expect(runtime.exportedLogs()).toBe(0)
    runtime.trigger("logs.export")
    await settle()
    expect(runtime.exportedLogs()).toBeGreaterThan(0)
  })

  test("session.new 真的把壳送去新对话(侧栏「新对话」按钮同一条路径)", async () => {
    await mountShell(() => runtime.AlphaShell())
    const before = runtime.navigationIntents().length

    runtime.trigger("session.new")
    await settle()

    // 侧栏「新对话」按钮点出来的是同一个 href;这里断言命令真的走到了那条路径。
    expect(runtime.navigationIntents().slice(before)).toContain(newSessionHref(runtime.FIXTURE_DIRECTORY))
  })

  // common.goBack / common.goForward 没有单独的运行时用例,理由写在这里而不是省略:
  // 侧栏左上角那对后退/前进**按钮**从来不经命令总线(它们直接 `navigate(±1)`),所以它们不属于
  // 「指向未注册命令的入口」这一类,本票没有改动它们;桌面菜单那两条的义务是「有人注册」,由上面
  // 「发布面全注册」逐条判。刻意不按 `trigger` 断言位置变化:上游 titlebar 在首页/新对话页也注册
  // 同名 id(语义相同,都是历史前后移动),谁先挂载谁赢 —— 那样的断言判的是挂载顺序,不是产品。
})
