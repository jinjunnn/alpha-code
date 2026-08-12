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
import { homeHref, newSessionHref } from "./route"
import { parseRoute } from "../../shared/route-manifest"

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

/** 等某件事**出现**:轮流 settle 到条件成立为止(有界,等不到就红)。只用于正向断言 ——
 *  "不该出现"那一侧仍然是 settle 后直接断言,不能靠等待把它等没。 */
async function waitFor(check: () => boolean, label: string) {
  for (let round = 0; round < 20; round++) {
    if (check()) return
    await settle()
  }
  throw new Error(`等不到:${label}`)
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

/** #925:真实 router 收到的导航请求里,凡**解析成会话路由**的,抽出落点三元组。编码(生产
 *  `hrefFor`)与解码(生产 `parseRoute`)是两条相反的路,不构成自指等价链;判据锚在独立的
 *  server key 字面量上。 */
function sessionLandings(intents: string[]) {
  return intents
    .map((href) => parseRoute(href))
    .filter((route) => route.kind === "session")
    .map((route) => ({
      routeId: route.identity.routeId,
      serverKey: (route as { serverKey?: string }).serverKey,
      id: (route as { id?: string }).id,
    }))
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
    // 最终 location。#925 起落点是 canonical 的 `/server/:serverKey/session/:id`(单 server 壳,
    // projects key = "sidecar");legacy 形状(壳按 active 反推的那种)一条都不许有 ——
    // 多 server 下的判别在下方 #925 一节(那里各用例的 key 互不相同)。
    const landed = sessionLandings(runtime.navigationIntents()).find((route) => route.id === runtime.CREATED_SESSION_ID)
    expect(landed).toBeDefined()
    expect(landed!.routeId).toBe("session")
    expect(landed!.serverKey).toBe("sidecar")
    expect(sessionLandings(runtime.navigationIntents()).filter((route) => route.routeId === "legacy-session")).toEqual([])
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
    // 初版在这里断言 `newSessionHref(dir)`(legacy admission 路由)—— 那是 #656 之前的世界:
    // #656(不变量 1)把新对话唯一入口改成了直接建 draft,这个入口**不得再**产生那个 href。
    // 现行保证:触发 = 上游 tabs store 真的多一个同源 draft + 壳真的落到它的新对话页。
    await mountShell(() => runtime.AlphaShell())
    // 启动即落新草稿(#656 的启动导航)。先等它落地再触发:AC4 的 in-flight 去重会吞掉与启动
    // 并发的第二次 startDraft —— 不等就触发,测到的是去重,不是命令。
    await waitFor(() => runtime.draftTabs().length > 0 && runtime.routerPath() === runtime.draftHref(runtime.draftTabs().at(-1)!.draftID), "启动草稿落地")
    const draftsBefore = new Set(runtime.draftTabs().map((draft) => draft.draftID))
    const before = runtime.navigationIntents().length

    runtime.trigger("session.new")
    await waitFor(() => runtime.draftTabs().some((draft) => !draftsBefore.has(draft.draftID)), "触发后建出新 draft")

    // 可观察结果 1:真实 tabs store 多出**一个新的** draft,目录/服务器同源(不是复用启动那个)。
    const added = runtime.draftTabs().filter((draft) => !draftsBefore.has(draft.draftID))
    expect(added).toHaveLength(1)
    expect(added[0]!.directory).toBe(runtime.FIXTURE_DIRECTORY)
    expect(added[0]!.server).toBe("sidecar")

    // 可观察结果 2:真实 router 收到**去这个新 draft** 的导航,且壳真的落在了那页。
    await waitFor(() => runtime.routerPath() === runtime.draftHref(added[0]!.draftID), "壳落在新草稿页")
    expect(runtime.navigationIntents().slice(before)).toContain(runtime.draftHref(added[0]!.draftID))

    // 不变量 1(#656)反向闸:这个入口从此不得再借 legacy admission 路由 —— 初版断言以它为
    // **期望**,正是把回归当成了正确答案。
    expect(runtime.navigationIntents()).not.toContain(newSessionHref(runtime.FIXTURE_DIRECTORY))
  })

  // #925 注:上面 session.new 那条断言 `added[0].server === "sidecar"` 在单 server 壳里
  // active 与 projects key 同值,判别不了「draft 的 server 段来自谁」;多 server 的判别在
  // 下方 #925 一节的 draft 晋升用例(active=sidecar、projects=wsl:fedora,两值相异)。

  // common.goBack / common.goForward 已从桌面菜单**退休**(shared/desktop-menu-policy.ts),
  // 所以这里没有它们的用例:上游 Titlebar 在首页/新对话页抢先注册同名 id 并走只有 `["/"]` 的私有
  // history —— 那不是「语义相同、谁赢都行」,是同一菜单项在不同路由两种行为、其中一种还是空转。
  // 侧栏左上角那对**按钮**保留(直连 `navigate(±1)`,从不经命令总线),但本文件**没有**为它们写
  // 行为用例:只在退休那两条用例里断言过左上工具簇仍有 3 个按钮,从未点击并观察导航。这是刻意的
  // 诚实分层,已在 docs/architecture/upstream-integration.md 的「Known not covered」列明。
})

/* ── #925:legacy sessionHref 的全部生产者清零 —— 会话导航钉在真正持有会话的 server 上 ────
   缺陷同形于 #894:legacy `/{目录}/session/{id}` 路径里没有 server 段,壳只能事后反推
   (`packages/app/src/utils/session-route.ts` 的 `legacySessionServer`:同 id 的 tab,否则回落
   「完成时的 active server」)。多 server(WSL/remote)下反推恒给错机器;那台机器上若恰好有
   同 id 会话,打开并污染的是那个无关会话。修法是删掉产生器(sidebar/route.ts 的
   `sessionHref`)并让四个消费者(侧栏点击 / 侧栏锚点 / 新会话导航 / 自动化回跳)+ draft 的
   server 段全部消费 projects store 的 server 身份。

   判据纪律:
   · 落点判据 = 真实 router 收到的 href 经生产 `parseRoute` 解回来的 {routeId, serverKey, id}
     (编码与解码两条相反的路);锚点是**本文件的独立字面量**,不 import 生产常量。
   · 各用例点击那一刻的 projects key 互不相同("sidecar" / "wsl:fedora" / "wsl:arch"),且都与
     该壳的 active server 相异 —— 写死任何单值、或按 active 反推的实现,至少两条当场红。
   · 每条都扫一遍「legacy 形状的会话导航 = 0」:那是反推入口本身。 */
describe("#925 多 server 下的会话导航:落在真正持有该会话的 server 上", () => {
  test("点侧栏里没开过 tab 的会话(active=wsl:ubuntu,store 连 sidecar)→ 锚点与真实落点都钉在 sidecar", async () => {
    await mountShell(() => runtime.AlphaShellRemoteActive())
    runtime.expandProject(runtime.FIXTURE_DIRECTORY)
    await settle()

    // ① 锚点本身(右键复制/中键打开拿到的就是它):canonical 会话路由,server 段 = sidecar。
    const anchor = document.querySelector<HTMLAnchorElement>("a.alpha-session")
    expect(anchor).not.toBeNull()
    const anchorLanding = parseRoute(anchor!.getAttribute("href")!)
    expect({ kind: anchorLanding.kind, routeId: anchorLanding.identity.routeId }).toEqual({
      kind: "session",
      routeId: "session",
    })
    expect((anchorLanding as { serverKey?: string }).serverKey).toBe("sidecar")

    // ② 真点击:真实 router 收到的落点同样钉在 sidecar,而不是 active 的 wsl:ubuntu。
    const before = runtime.navigationIntents().length
    anchor!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    await settle()
    const landed = sessionLandings(runtime.navigationIntents().slice(before)).find((route) => route.id === "ses_one")
    expect(landed).toBeDefined()
    expect(landed!.routeId).toBe("session")
    expect(landed!.serverKey).toBe("sidecar")
    expect(landed!.serverKey).not.toBe("wsl:ubuntu")

    // ③ 反推入口清零:全程一条 legacy 形状的会话导航都没有。
    expect(sessionLandings(runtime.navigationIntents()).filter((route) => route.routeId === "legacy-session")).toEqual([])
  })

  test("「打开项目」开出的新会话(active=sidecar,store 连 wsl:fedora)→ 落点钉在 wsl:fedora", async () => {
    runtime.setHasProjects(false)
    await mountShell(() => runtime.AlphaShellRemoteProjects())

    openProjectButton()!.click()
    await settle()

    expect(runtime.createdIn()).toEqual([runtime.PICKED_DIRECTORY])
    const landed = sessionLandings(runtime.navigationIntents()).find((route) => route.id === runtime.CREATED_SESSION_ID)
    expect(landed).toBeDefined()
    expect(landed!.routeId).toBe("session")
    // 与上一条用例点击那一刻的 key("sidecar")相异 —— 写死单值的实现两条不可能同时绿。
    expect(landed!.serverKey).toBe("wsl:fedora")
    expect(landed!.serverKey).not.toBe("sidecar")
    expect(sessionLandings(runtime.navigationIntents()).filter((route) => route.routeId === "legacy-session")).toEqual([])
  })

  test("draft 晋升(active=sidecar,store 连 wsl:fedora):draft 带 store 的 server,上游 promoteDraft 的真实导航落在 wsl:fedora", async () => {
    await mountShell(() => runtime.AlphaShellRemoteProjects())

    // 启动导航自己建 draft(#656)。#925:draft 的 server 段 = store 的 server,不再是 active ——
    // 会话是 `projects.startChat` 在 store 的 server 上建的,draft 带 active 时,上游
    // `promoteDraft`(packages/app createDraftRoute)会把 session tab 与导航都落到一台没有
    // 这个会话的机器上。
    await waitFor(() => runtime.draftTabs().length > 0, "启动草稿落地")
    const draft = runtime.draftTabs().at(-1)!
    expect(draft.server).toBe("wsl:fedora")
    expect(draft.server).not.toBe("sidecar")
    await waitFor(() => runtime.routerPath() === runtime.draftHref(draft.draftID), "壳落在新草稿页")

    // 探针把「已建成的会话」交回**上游生产 promoteDraft**:真实 tabs 交换 + 真实导航。
    const probe = document.querySelector<HTMLButtonElement>("[data-harness-promote]")
    expect(probe).not.toBeNull()
    probe!.click()
    await waitFor(
      () => sessionLandings(runtime.navigationIntents()).some((route) => route.id === runtime.PROMOTED_SESSION_ID),
      "晋升导航落地",
    )
    const landed = sessionLandings(runtime.navigationIntents()).find((route) => route.id === runtime.PROMOTED_SESSION_ID)
    expect(landed!.routeId).toBe("session")
    expect(landed!.serverKey).toBe("wsl:fedora")
    expect(landed!.serverKey).not.toBe("sidecar")
    expect(sessionLandings(runtime.navigationIntents()).filter((route) => route.routeId === "legacy-session")).toEqual([])
  })

  test("自动化「回跳会话」(active=wsl:ubuntu,store 连 wsl:arch)→ 落点钉在 wsl:arch", async () => {
    await mountShell(() => runtime.AlphaShellAutomationRemote())
    runtime.openAutomationPanel()
    await waitFor(() => document.querySelector(".alpha-auto-row") !== null, "自动化任务列表渲染")

    // 进任务详情 → 运行历史 → 点「打开会话」(带 sessionID 的那条 run 才渲染这个按钮)。
    document
      .querySelector<HTMLElement>(".alpha-auto-row")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    await waitFor(() => document.querySelector(".alpha-auto-hist .alpha-ext-link") !== null, "运行历史的回跳按钮渲染")
    document.querySelector<HTMLButtonElement>(".alpha-auto-hist .alpha-ext-link")!.click()
    await settle()

    const landed = sessionLandings(runtime.navigationIntents()).find(
      (route) => route.id === runtime.AUTOMATION_SESSION_ID,
    )
    expect(landed).toBeDefined()
    expect(landed!.routeId).toBe("session")
    // run 的会话由主进程建在 projects store 连着的那台上;三个 #925 用例的 key 各不相同。
    expect(landed!.serverKey).toBe("wsl:arch")
    expect(landed!.serverKey).not.toBe("wsl:ubuntu")
    expect(landed!.serverKey).not.toBe("sidecar")
    expect(sessionLandings(runtime.navigationIntents()).filter((route) => route.routeId === "legacy-session")).toEqual([])
  })
})
