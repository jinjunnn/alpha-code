// REQ-126 CODE-F(#659)会话搜索闸门。
//
// 保证(删掉本文件会失去什么):alpha 壳里**没有人注册 `command.palette`** 这件事将不再有任何
// 东西能发现。那正是本票要修的 bug 本体 —— 侧栏「搜索」按钮发的命令全应用无人接,上游 `run()`
// 对未注册 id 静默返回,点了什么都不发生;上游那三处注册全在已被 alpha 顶替的叶里,随叶蒸发。
//
// 闸门挂的是**真实 alpha 壳**:上游 `PlatformProvider → AppBaseProviders → AppInterface`
// (与 renderer/index.tsx 同一条 provider 链、同一个 MemoryRouter)+ 真实生产 `AlphaSidebar`
// + 真实生产 `AlphaSessionSearch`。触发用的是**真实侧栏按钮的点击**,跳转读的是**真实路由**
// 的 location。判据全是可观察结果,没有一条断言源码文本(基线 §3 不变量 7 明令源码锚定式断言
// 不得作为本 REQ 的证据)。

import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import appPlugin from "@opencode-ai/app/vite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import type { render } from "solid-js/web"
import type * as Runtime from "./alpha-session-search-test-runtime"
import { decodeDirectory, encodeDirectory, hrefFor } from "../../shared/route-manifest"
import { dict as zh } from "../i18n/zh"

type TestRuntime = typeof Runtime & { render: typeof render }

const appSrc = join(import.meta.dir, "../../../../app/src")

// 与 Electron renderer 同一个 Solid vite 插件编译生产组件:bun 原生 TSX 变换是 React 形状的,
// 会静默丢掉 Solid 的 ref 与响应式 DOM 表达式。
//
// 两个 alias 都不是替身,是**消歧**:worktree 的 node_modules 是主 checkout 的软链,
// `@opencode-ai/app` 会解析出两条不同的绝对路径 → 同一个 context 出现两份实例 →
// `usePlatform` 在自己的 provider 里也报 "must be used within a context provider"。
// 钉到 worktree 内的同一份源码即消歧(普通 checkout 下本就是同一份)。
const runtimeDirectory = mkdtempSync(join(tmpdir(), "alpha-session-search-"))
await build({
  configFile: false,
  logLevel: "silent",
  plugins: [appPlugin.at(-1)!],
  // 上游 app 的 vite 配置带 `worker.format: "es"`;这里只借它的 solid 插件,故手动补齐,
  // 否则 session-ui 的 diff worker 会以 iife 形式撞上 code-splitting。
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
      entry: join(import.meta.dir, "alpha-session-search-test-runtime.tsx"),
      formats: ["es"],
      fileName: () => "alpha-session-search-test-runtime.js",
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
})

const disposers: Array<() => void> = []
GlobalRegistrator.register()
const runtime = (await import(
  pathToFileURL(join(runtimeDirectory, "alpha-session-search-test-runtime.js")).href
)) as TestRuntime

beforeEach(() => {
  document.body.replaceChildren()
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

/** 生产侧栏上那个「搜索」按钮本体。 */
const searchButton = () => document.querySelector<HTMLButtonElement>("[data-alpha-sidebar-nav='search']")
const panel = () => document.querySelector<HTMLElement>("[data-alpha-session-search]")
const input = () => document.querySelector<HTMLInputElement>("[data-alpha-session-search-input]")!
const rows = () => Array.from(document.querySelectorAll<HTMLAnchorElement>("[data-alpha-session-search-result]"))
const rowFor = (sessionID: string) =>
  document.querySelector<HTMLAnchorElement>(`[data-alpha-session-search-result="${sessionID}"]`)

async function type(value: string) {
  const field = input()
  field.value = value
  field.dispatchEvent(new Event("input", { bubbles: true }))
  await flush()
}

async function key(name: string) {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })
  input().dispatchEvent(event)
  await settle()
  return event
}

const emptyText = () => document.querySelector<HTMLElement>("[data-alpha-session-search-empty]")?.textContent
/** 被选中行的会话 id(比 id 不比 DOM 节点:节点 diff 会把失败输出撑到数万行)。 */
const selectedRows = () =>
  rows()
    .filter((row) => row.closest("[role='option']")?.getAttribute("aria-selected") === "true")
    .map((row) => row.dataset.alphaSessionSearchResult)

async function openViaSidebarButton() {
  await mountShell(() => runtime.AlphaShell())
  searchButton()!.click()
  await flush()
}

describe("真实壳:侧栏「搜索」按钮真的能打开面板", () => {
  test("点生产侧栏的搜索按钮 → alpha 搜索面板出现", async () => {
    await mountShell(() => runtime.AlphaShell())

    expect(searchButton()).not.toBeNull()
    expect(panel()).toBeNull()

    searchButton()!.click()
    await flush()

    expect(panel()).not.toBeNull()
    expect(document.querySelector("[role='dialog']")).not.toBeNull()
  })

  test("负对照:同一个真实壳、同一个真实按钮,不挂会话搜索件 → 点了什么都不发生", async () => {
    await mountShell(() => runtime.ShellWithoutSearch())

    expect(searchButton()).not.toBeNull()

    searchButton()!.click()
    await flush()

    expect(panel()).toBeNull()
    expect(document.querySelector("[role='dialog']")).toBeNull()
  })

  test("既有快捷键经上游 keydown 处理器打开同一个面板", async () => {
    await mountShell(() => runtime.AlphaShell())

    // 上游默认面板键位 mod+k:mac 是 meta,其余是 ctrl —— 两种修饰键各打一次,
    // 命中的那一次开面板,判据是"面板开了",不依赖 harness 认得当前平台。
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
      if (panel()) break
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true, cancelable: true, ...modifier }))
      await flush()
    }

    expect(panel()).not.toBeNull()
  })
})

describe("按标题搜会话,跳转 href 钉在结果来源的 server 上", () => {
  test("输入标题片段只留下匹配的会话,并按最近更新在前", async () => {
    await openViaSidebarButton()
    expect(rows()).toHaveLength(0)

    await type("架构")

    expect(rows().map((row) => row.dataset.alphaSessionSearchResult)).toEqual(["ses_new", "ses_old"])
    expect(rowFor("ses_web")).toBeNull()
  })

  test("查无结果与空查询都不留下任何可点结果", async () => {
    await openViaSidebarButton()

    await type("这个标题不存在")
    expect(rows()).toHaveLength(0)

    await type("   ")
    expect(rows()).toHaveLength(0)
  })

  test("结果 href = server 限定的 canonical 路由,不是 legacy 的目录路由", async () => {
    await openViaSidebarButton()
    await type("整理架构图")

    const href = rowFor("ses_new")!.getAttribute("href")!
    expect(href).toBe(hrefFor.session(runtime.SIDECAR_SERVER_KEY, "ses_new"))
    // 形状:/server/<编码后的 serverKey>/session/<会话 id>,且中段能解回结果来源的 server。
    const segments = href.split("/")
    expect(segments[1]).toBe("server")
    expect(decodeDirectory(segments[2]!)).toBe(runtime.SIDECAR_SERVER_KEY)
    expect(segments[3]).toBe("session")
    expect(segments[4]).toBe("ses_new")
    // legacy 形状(`/{目录}/session/{id}`,壳事后反推 server)—— 明确不是它。#933 撤掉
    // `navFor.legacySession` 后,这个负锚点用独立字面量拼(encodeDirectory 是解码判据的逆)。
    expect(href).not.toBe(`/${encodeDirectory(runtime.FIXTURE_DIRECTORY)}/session/ses_new`)
  })

  test("换一个来源 server,href 跟着换 —— server 身份是取来的,不是常量", async () => {
    await openViaSidebarButton()
    await type("整理架构图")
    const sidecarHref = rowFor("ses_new")!.getAttribute("href")

    runtime.setServerKey(runtime.WSL_SERVER_KEY)
    await flush()

    const wslHref = rowFor("ses_new")!.getAttribute("href")!
    expect(wslHref).not.toBe(sidecarHref)
    expect(wslHref).toBe(hrefFor.session(runtime.WSL_SERVER_KEY, "ses_new"))
    expect(decodeDirectory(wslHref.split("/")[2]!)).toBe(runtime.WSL_SERVER_KEY)
  })

  test("来源 server 未就绪时 fail-closed:有匹配标题也不给出任何可点结果", async () => {
    await openViaSidebarButton()

    runtime.setServerKey(undefined)
    await type("整理架构图")

    expect(rows()).toHaveLength(0)
  })

  test("标题匹配的会话一条都不藏(不做结果截断)", async () => {
    await openViaSidebarButton()
    const expected = runtime.FIXTURE_PROJECTS.flatMap((project) =>
      project.sessions.filter((session) => session.title.includes("整理")).map((session) => session.id),
    )
    await type("整理")

    expect(rows()).toHaveLength(expected.length)
    expect(new Set(rows().map((row) => row.dataset.alphaSessionSearchResult))).toEqual(new Set(expected))
  })

  test("点结果 = 真实路由真的落到那条 server 限定路径,并关掉面板", async () => {
    await openViaSidebarButton()
    await type("整理架构图")

    const row = rowFor("ses_new")!
    const href = row.getAttribute("href")!
    const click = new MouseEvent("click", { bubbles: true, cancelable: true })
    row.dispatchEvent(click)
    await settle()

    expect(click.defaultPrevented).toBe(true)
    // 判据落在**真实 router 的 location** 上:壳真的导航过去了,不是某个替身记了一笔。
    expect(runtime.routerPath()).toBe(href)
    expect(runtime.routerPath()).toBe(hrefFor.session(runtime.SIDECAR_SERVER_KEY, "ses_new"))
    expect(panel()).toBeNull()
  })
})

describe("#1589 AC1/AC2:按侧栏所见的显示标题匹配与显示", () => {
  test("引擎默认标题 `New session - <ISO>` 显示为「新对话」,能被「新对话」搜到", async () => {
    await openViaSidebarButton()
    await type("新对话")

    const row = rowFor(runtime.DEFAULT_TITLE_SESSION)
    expect(row).not.toBeNull()
    expect(row!.querySelector(".a-search-result-title")!.textContent).toBe(zh["alpha.sidebar.newChat"])
  })

  test("负对照:原始英文时间戳标题不再参与匹配 —— 搜「new session」搜不到它", async () => {
    await openViaSidebarButton()
    await type("new session")

    // 比布尔不比节点:节点 diff 失败时会把输出撑到数万行。
    expect(rowFor(runtime.DEFAULT_TITLE_SESSION) === null).toBe(true)
  })
})

describe("#1589 AC3:方向键选择、回车打开,焦点留在输入框", () => {
  test("有结果时第一条默认选中", async () => {
    await openViaSidebarButton()
    await type("整理")

    expect(selectedRows()).toEqual([rows()[0]!.dataset.alphaSessionSearchResult])
  })

  test("↓ + 回车打开第二条结果,真实路由落到它的 href", async () => {
    await openViaSidebarButton()
    input().focus()
    await type("整理")
    const second = rows()[1]!
    const href = second.getAttribute("href")!

    const down = await key("ArrowDown")
    expect(down.defaultPrevented).toBe(true)
    expect(selectedRows()).toEqual([second.dataset.alphaSessionSearchResult])
    expect(document.activeElement === input()).toBe(true)

    await key("Enter")

    expect(runtime.routerPath()).toBe(href)
    expect(panel()).toBeNull()
  })

  test("↑ 从第一条回绕到最后一条", async () => {
    await openViaSidebarButton()
    await type("整理")
    const last = rows().at(-1)!

    await key("ArrowUp")

    expect(selectedRows()).toEqual([last.dataset.alphaSessionSearchResult])
  })

  test("无结果时回车不导航,面板留着", async () => {
    await openViaSidebarButton()
    await type("这个标题不存在")
    const before = runtime.routerPath()

    await key("Enter")

    expect(runtime.routerPath()).toBe(before)
    expect(panel()).not.toBeNull()
  })

  test("面板底部有按键提示", async () => {
    await openViaSidebarButton()
    const text = panel()!.querySelector(".a-search-keys")!.textContent!

    for (const label of [zh["alpha.search.keySelect"], zh["alpha.search.keyOpen"], zh["alpha.search.keyClose"]]) {
      expect(text).toContain(label)
    }
  })
})

describe("#1589 AC4:每条结果带项目名与最近更新时间", () => {
  // 固定「现在」= 2026-10-30 15:00(本地时区),三种分档各一条。
  const now = new Date(2026, 9, 30, 15, 0)

  test("今天 HH:MM", () => {
    expect(runtime.sessionSearchTime(new Date(2026, 9, 30, 9, 12).getTime(), now)).toBe("今天 09:12")
  })

  test("昨天 HH:MM", () => {
    expect(runtime.sessionSearchTime(new Date(2026, 9, 29, 22, 40).getTime(), now)).toBe("昨天 22:40")
  })

  test("更早:月日", () => {
    expect(runtime.sessionSearchTime(new Date(2026, 8, 21, 6, 29).getTime(), now)).toBe("9月21日")
  })

  test("结果行渲染项目名与时间", async () => {
    await openViaSidebarButton()
    await type("整理架构图")

    const row = rowFor("ses_new")!
    expect(row.querySelector(".a-search-result-project")!.textContent).toBe("alpha-code")
    expect(row.querySelector(".a-search-result-time")!.textContent).toBe(runtime.sessionSearchTime(30, new Date()))
  })
})

describe("#1589 AC5:列表还没读到时如实说「读取中」,读到后结果自动出现", () => {
  test("服务未就绪 → 读取中;服务就绪后不重新输入,结果出现", async () => {
    await openViaSidebarButton()
    runtime.setServerKey(undefined)
    await type("整理架构图")

    expect(rows()).toHaveLength(0)
    expect(emptyText()).toBe(zh["alpha.search.loading"])

    runtime.setServerKey(runtime.SIDECAR_SERVER_KEY)
    await flush()

    expect(rowFor("ses_new")).not.toBeNull()
  })

  test("项目的对话还没读到 → 读取中;读到后不重新输入,结果出现", async () => {
    await openViaSidebarButton()
    runtime.unloadSessions()
    await type("整理架构图")

    expect(rows()).toHaveLength(0)
    expect(emptyText()).toBe(zh["alpha.search.loading"])

    runtime.loadSessions()
    await flush()

    expect(rowFor("ses_new")).not.toBeNull()
  })

  test("负对照:列表已读到、确实无匹配 → 「没有匹配的对话」", async () => {
    await openViaSidebarButton()
    await type("这个标题不存在")

    expect(emptyText()).toBe(zh["alpha.search.empty"])
  })
})

describe("#1589 AC6:面板文案与批准稿 #search 表一致", () => {
  test("zh 文案", () => {
    expect(zh["alpha.search.title"]).toBe("搜索对话")
    expect(zh["alpha.search.placeholder"]).toBe("按标题搜索…")
    expect(zh["alpha.search.hint"]).toBe("输入标题关键词")
    expect(zh["alpha.search.empty"]).toBe("没有匹配的对话")
    expect(zh["alpha.search.loading"]).toBe("对话列表读取中…")
  })

  test("还没输入时显示提示文案", async () => {
    await openViaSidebarButton()
    expect(emptyText()).toBe(zh["alpha.search.hint"])
  })
})
