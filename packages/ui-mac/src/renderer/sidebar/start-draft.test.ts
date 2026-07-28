// REQ-126 CODE-C(#656)「新对话直接建 draft」闸门。
//
// 保证(删掉本文件会失去什么):alpha 的新对话入口**退回上游 legacy admission 路由**这件事将不再
// 有任何东西能发现。那正是本票要修的 bug 本体 —— `/<b64dir>/session` 在两种 layout 下都挂在上游
// `LegacyServerLayout` 之下,一次「新对话」会先挂起上游自己的左栏与会话叶,再被新对话页替换;
// owner 报的「点新对话闪烁、最左侧闪出不该出现的内容」就是这一帧。
//
// 闸门挂**真实 alpha 壳**(上游 provider 链 + 真实路由树 + 生产 AlphaSidebar + 生产 alpha 会话
// 工作区 / 新对话页),点**真实**侧栏按钮,判据是 MutationObserver 记下的**真实挂载序列**。
// 第一条用例是控制组:直接进 legacy admission 路由,断言两个"不该出现"的 DOM **确实会出现** ——
// 没有它,后面所有「从未出现」都可能只是选择器写错了的空绿(基线 §3 不变量 7)。
// 没有一条断言源码文本。

import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import appPlugin from "@opencode-ai/app/vite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import type { render } from "solid-js/web"
import type * as Runtime from "./start-draft-test-runtime"
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
const runtimeDirectory = mkdtempSync(join(tmpdir(), "alpha-start-draft-"))
await build({
  configFile: false,
  logLevel: "silent",
  plugins: [appPlugin.at(-1)!],
  worker: { format: "es" },
  resolve: {
    dedupe: ["solid-js", "solid-js/web", "solid-js/store", "@solidjs/router"],
    alias: [
      { find: /^@opencode-ai\/app$/, replacement: join(appSrc, "index.ts") },
      { find: /^@\//, replacement: `${appSrc}/` },
    ],
  },
  build: {
    emptyOutDir: true,
    outDir: runtimeDirectory,
    lib: {
      entry: join(import.meta.dir, "start-draft-test-runtime.tsx"),
      formats: ["es"],
      fileName: () => "start-draft-test-runtime.js",
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
})

const disposers: Array<() => void> = []
GlobalRegistrator.register()
const runtime = (await import(
  pathToFileURL(join(runtimeDirectory, "start-draft-test-runtime.js")).href
)) as TestRuntime

// 上游 legacy admission 的 href(`/<base64url(dir)>/session`)—— 本票之前侧栏「新对话」导向的
// 就是它。控制组用它复现修前行为;它同时是深链兼容仍在用的路由,故只保证 alpha 入口不再进。
const legacyAdmissionHref = `/${Buffer.from(runtime.PROJECT_DIRECTORY, "utf8").toString("base64url")}/session`

beforeEach(() => {
  localStorage.clear()
  document.body.replaceChildren()
  runtime.installRootHost()
  runtime.installPreloadStub()
  runtime.resetHarness()
})

afterEach(async () => {
  disposers.splice(0).reverse().forEach((dispose) => dispose())
  await settle()
  // 上游 tabs/layout 都是 persisted store,写盘是延迟的:只在 beforeEach 清会让上一棵树在清完
  // 之后补写的 draft 被下一个用例水合回来(实测跨用例累积到 7 条)。拆完再清一次。
  localStorage.clear()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
  rmSync(runtimeDirectory, { recursive: true, force: true })
})

/** 真实壳有若干层异步 provider(设置、连接门、路由、持久化水合);给它们几轮 microtask 落定。 */
async function settle() {
  for (let round = 0; round < 12; round++) {
    for (let i = 0; i < 40; i++) await Promise.resolve()
    runtime.sampleMounts()
    await new Promise((resolve) => setTimeout(resolve, 1))
    runtime.sampleMounts()
  }
}

/** 等某件事**出现**:轮流 settle 到条件成立为止。只用于"释放 barrier 后应该发生"的正向断言 ——
 *  "不该出现"那一侧仍然是 settle 一轮后直接断言,不能靠等待把它等没。 */
async function waitFor(check: () => boolean, label: string) {
  for (let round = 0; round < 20; round++) {
    if (check()) return
    await settle()
  }
  throw new Error(`等不到:${label}`)
}

async function mountShell(connection?: Parameters<typeof runtime.AlphaShell>[0]["connection"]) {
  const host = document.createElement("div")
  document.body.append(host)
  disposers.push(runtime.render(() => runtime.AlphaShell({ connection }), host))
  await settle()
  // 挂载期的水合噪音不该算进"这一次点击做了什么"(存储本身已按用例隔离,见 runtime 的
  // harnessStorage 抬头,tabs 每次都从空起步)。
  runtime.resetCallLog()
}

/** 生产侧栏上那个「新对话」按钮本体。 */
const newChatButton = () => document.querySelector<HTMLButtonElement>("[data-alpha-sidebar-nav='new-chat']")
const toastTitles = () => Array.from(document.querySelectorAll(".a-toast b")).map((el) => el.textContent)

describe("控制组:legacy admission 路由确实会挂起两套壳(记录仪与选择器都是活的)", () => {
  test("直接进 `/<dir>/session` → 上游左栏与 alpha 会话工作区都真的出现过", async () => {
    await mountShell()
    await settle()

    runtime.startRecording()
    runtime.navigateTo(legacyAdmissionHref)
    await settle()

    const seen = runtime.recorded()
    // 这两条是后面所有「从未出现」断言的前提:选择器写错、记录仪没接上,这里就会红。
    expect(seen, `legacy admission 路由没挂起上游左栏:${JSON.stringify(seen)}`).toContain("legacy-sidebar")
    expect(seen, `legacy admission 路由没挂起 alpha 会话工作区:${JSON.stringify(seen)}`).toContain(
      "session-workspace",
    )
  })
})

describe("REQ-126 AC1:alpha 的新对话入口不再经 legacy admission", () => {
  test("点生产侧栏「新对话」→ 新对话页出现之前,两套不该出现的壳一次都没挂过", async () => {
    // 刻意**不**翻 store.ready:冷启动落地是另一条入口,它会先建一个 draft,把「这一次点击
    // 产生了什么」搅浑。冷启动单独一条用例。
    await mountShell()
    await settle()

    runtime.startRecording()
    expect(newChatButton()).not.toBeNull()
    newChatButton()!.click()
    await settle()

    const seen = runtime.recorded()
    expect(seen, `没到新对话页:${JSON.stringify(seen)}`).toContain("new-session")
    expect(seen.slice(0, seen.indexOf("new-session"))).toEqual([])
    expect(runtime.routerHref()).toStartWith("/new-session?draftId=")
  })

  test("冷启动落地同样直接到新对话页,不经 admission", async () => {
    await mountShell()
    await settle()

    // 冷启动落地由「项目列表就绪」驱动(生产 didLaunchNav effect),这里翻的就是那个开关。
    runtime.startRecording()
    runtime.setProjectsReady(true)
    await settle()

    const seen = runtime.recorded()
    expect(seen, `冷启动没落到新对话页:${JSON.stringify(seen)}`).toContain("new-session")
    expect(seen.slice(0, seen.indexOf("new-session"))).toEqual([])
  })
})

describe("REQ-126 AC5:{server, directory} 同源 + 默认对话目录先供给", () => {
  test("本地 sidecar:draft 落默认对话目录,且 ensure 先于建 draft", async () => {
    await mountShell()
    await settle()

    newChatButton()!.click()
    await settle()

    expect(runtime.ensureCalls).toEqual([runtime.DEFAULT_WORKSPACE])
    expect(runtime.draftTabs()).toHaveLength(1)
    expect(runtime.draftTabs()[0]!.directory).toBe(runtime.DEFAULT_WORKSPACE)
    expect(runtime.draftTabs()[0]!.server).toBe("sidecar")
  })

  test("ensure 未决 → draft 一直不建(证明供给真的在前面,不是并排跑)", async () => {
    runtime.setEnsureOutcome("pending")
    await mountShell()
    await settle()

    runtime.startRecording()
    newChatButton()!.click()
    await settle()

    expect(runtime.ensureCalls).toEqual([runtime.DEFAULT_WORKSPACE])
    expect(runtime.recorded()).not.toContain("new-session")
    expect(runtime.draftTabs()).toHaveLength(0)
  })

  test("ensure 返回 {ok:false} → 不建 draft,并且说出来", async () => {
    runtime.setEnsureOutcome(false)
    await mountShell()
    await settle()

    runtime.startRecording()
    newChatButton()!.click()
    await settle()

    expect(runtime.draftTabs()).toHaveLength(0)
    expect(runtime.recorded()).not.toContain("new-session")
    expect(runtime.routerHref()).not.toStartWith("/new-session")
    expect(toastTitles()).toContain(zh["alpha.sidebar.newChatWorkspaceFailed"])
  })

  test("loopback 的 http 连接(SSH 隧道/远端反代)同样 fail-closed —— 它只是看起来像本机", async () => {
    // 上游 `ServerConnection.local` 把 127.0.0.1 的 http 连接判成 local(context/server.tsx),
    // 但隧道那头的机器上并没有宿主机的 `~/Alpha`。这一格钉住:同源判定不认"看起来是本机"。
    await mountShell(runtime.LOOPBACK_HTTP_CONNECTION)
    await settle()

    newChatButton()!.click()
    await settle()

    expect(runtime.ensureCalls).toEqual([])
    expect(runtime.draftTabs()).toHaveLength(0)
    expect(toastTitles()).toContain(zh["alpha.sidebar.newChatNoWorkspace"])
  })

  test("WSL server 上没有已知项目 → fail-closed:不建 draft,更不把宿主机 ~/Alpha 配上去", async () => {
    await mountShell(runtime.WSL_CONNECTION)
    await settle()

    newChatButton()!.click()
    await settle()

    expect(runtime.ensureCalls).toEqual([])
    expect(runtime.draftTabs()).toHaveLength(0)
    expect(toastTitles()).toContain(zh["alpha.sidebar.newChatNoWorkspace"])
  })

  test("WSL server 上有已知项目 → 用该 server 自己的目录,server 身份跟着它", async () => {
    await mountShell(runtime.WSL_CONNECTION)
    await settle()

    runtime.openProjectOnCurrentServer(runtime.REMOTE_PROJECT_DIRECTORY)
    await settle()

    newChatButton()!.click()
    await settle()

    expect(runtime.ensureCalls).toEqual([])
    expect(runtime.draftTabs()).toHaveLength(1)
    expect(runtime.draftTabs()[0]!.directory).toBe(runtime.REMOTE_PROJECT_DIRECTORY)
    expect(runtime.draftTabs()[0]!.server).toBe("wsl:Ubuntu")
  })
})

describe("REQ-126 AC4:连点两次只产生一个 draft", () => {
  test("同一帧内点两下 → 上游 tabs store 里只多出一条 draft", async () => {
    await mountShell()
    await settle()

    const button = newChatButton()!
    button.click()
    button.click()
    await settle()

    expect(runtime.draftTabs()).toHaveLength(1)
    expect(runtime.ensureCalls).toEqual([runtime.DEFAULT_WORKSPACE])
  })
})

describe("REQ-126:两处等待必须真的等(barrier 未释放时不得建 draft)", () => {
  test("tabs 还没水合完 → 一直不建 draft;水合完成后才进新对话页", async () => {
    // 上游 tabs 是 persisted store:水合前写进去的 tab 会被随后的读盘结果覆盖,draft 连同目录
    // 一起消失。按住存储读取,`tabs.ready()` 就一直是 false。
    runtime.holdTabsHydration()
    await mountShell()
    await settle()

    runtime.startRecording()
    newChatButton()!.click()
    await settle()

    expect(runtime.draftTabs()).toHaveLength(0)
    expect(runtime.recorded()).not.toContain("new-session")

    runtime.releaseTabsHydration()
    await waitFor(() => runtime.recorded().includes("new-session"), "水合完成后进入新对话页")

    expect(runtime.draftTabs()).toHaveLength(1)
  })

  test("默认对话目录还没解析出来 → 一直不建 draft、也不供给;解析后才落到它上面", async () => {
    // 未解析时拿别的目录顶上去,会话就开在用户从没选过的项目里(default-workspace.ts 抬头)。
    runtime.holdDefaultWorkspace()
    await mountShell()
    await settle()

    runtime.startRecording()
    newChatButton()!.click()
    await settle()

    expect(runtime.ensureCalls).toEqual([])
    expect(runtime.draftTabs()).toHaveLength(0)
    expect(runtime.recorded()).not.toContain("new-session")

    runtime.releaseDefaultWorkspace()
    await waitFor(() => runtime.draftTabs().length > 0, "默认对话目录解析后建出 draft")

    expect(runtime.ensureCalls).toEqual([runtime.DEFAULT_WORKSPACE])
    expect(runtime.draftTabs()).toHaveLength(1)
    expect(runtime.draftTabs()[0]!.directory).toBe(runtime.DEFAULT_WORKSPACE)
  })
})
