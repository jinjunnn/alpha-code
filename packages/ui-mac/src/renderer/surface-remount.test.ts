// #565(REQ-109 第四闪机制)「收敛不重挂 composer」闸门。
//
// 保证(删掉本文件会失去什么):surface/服务器收敛与 token-only 换血重新变成「路由树重建 →
// composer 全量 remount → epoch/草稿全重置」这件事将不再有任何东西能在真机之前发现。那正是
// T1 定案的第四闪机制(#528 评论、docs/verification/2026-07-24-req109-110-pr3-longrun.md):
// 旧 `resolvedSurfaces` 异步 admission 已被 REQ-089(#638)删除,但「删了驱动」≠「命题被钉住」——
// 本文件把退出条件(收敛/换血后 composer mount 计数不再跳增、状态跨收敛保持)钉在生产接线上。
//
// 判据的可观察量 = 生产 AlphaComposer 自己的 `renderer.composer.mount` timeline 打点
// (真机取证同一口径)+ DOM 节点同一性 + 草稿文本。第一条用例是**控制组**:驱动一次真实的
// 服务器身份切换(keyed Show 的合法重挂),断言计数器确实数得到 2 —— 先证明手段能测出已知的
// 坏,再用它判未知的好。每条「事件确实到达生产代码」都有独立证据(generation.received 打点 /
// ServerProvider 清单收敛),空转的广播不算测过。
//
// 【harness 的边界,如实】`App()` 的响应图是对 renderer/index.tsx 的逐行复刻(render() 入口
// 无法 import),真正执行的生产件是:AppInterface + 上游路由树/Provider 链、composeRoutes、
// AlphaHome/AlphaComposer、useAlphaProjects、runtime-recovery。若 index.tsx 的接线形状变了,
// 下面的源码锚点先红,提示同步 harness —— 锚点红不代表行为坏,代表这道闸的复刻过期了。

import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import appPlugin from "@opencode-ai/app/vite"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import type { render } from "solid-js/web"
import type * as Runtime from "./surface-remount-test-runtime"

type TestRuntime = typeof Runtime & { render: typeof render }

const appSrc = join(import.meta.dir, "../../../app/src")

// 与 Electron renderer 同一个 Solid vite 插件编译生产组件(bun 原生 TSX 变换是 React 形状的,
// 会静默丢掉 Solid 的响应式 DOM 表达式);alias 是消歧不是替身(见 start-draft.test.ts)。
const runtimeDirectory = mkdtempSync(join(tmpdir(), "alpha-surface-remount-"))
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
      entry: join(import.meta.dir, "surface-remount-test-runtime.tsx"),
      formats: ["es"],
      fileName: () => "surface-remount-test-runtime.js",
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
})

const disposers: Array<() => void> = []
GlobalRegistrator.register()
const runtime = (await import(
  pathToFileURL(join(runtimeDirectory, "surface-remount-test-runtime.js")).href
)) as TestRuntime

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
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

/** 等某件事**出现**。「不该发生」那一侧仍是 settle 后直接断言,不能靠等待把它等没。 */
async function waitFor(check: () => boolean, label: string) {
  for (let round = 0; round < 20; round++) {
    if (check()) return
    await settle()
  }
  throw new Error(`等不到:${label}(composer.mount=${runtime.composerMountCount()})`)
}

function mountShell() {
  const host = document.createElement("div")
  document.body.append(host)
  disposers.push(runtime.render(() => runtime.AlphaSurfaceShell({}), host))
}

function composerRoot(): HTMLElement {
  const node = document.querySelector('[data-alpha-composer="home"]') as HTMLElement | null
  if (!node) throw new Error("首页 composer 不在 DOM 里")
  return node
}

function composerTextarea(): HTMLTextAreaElement {
  const node = composerRoot().querySelector("textarea") as HTMLTextAreaElement | null
  if (!node) throw new Error("composer textarea 不在 DOM 里")
  return node
}

function typeDraft(text: string) {
  const textarea = composerTextarea()
  textarea.value = text
  textarea.dispatchEvent(new Event("input", { bubbles: true }))
}

/** #927 丢稿提示的可观察面:toast DOM 里按**独立字面量**筛(不 import i18n 目录 ——
 *  期望值与被测对象同源就是自指等价链,文案改了这里要跟着人工改)。字面量取 zh:本包
 *  bunfig 的 test-preload 把所有 bun 测试钉在 ALPHA_UI_LOCALE=zh(与既有 zh 断言套件同口径)。 */
function discardNoticeToasts(): HTMLElement[] {
  return [...document.querySelectorAll(".a-toast")].filter((el) =>
    el.textContent?.includes("已切换服务器"),
  ) as HTMLElement[]
}

/** 冷启动到首页 composer 就位:init 迟到(先 splash)→ 收敛 → 恰好一次 mount。 */
async function bootToHome() {
  runtime.holdSidecarInit()
  mountShell()
  await settle()
  // init 未收敛前:splash 在、composer 从未挂载 —— 「迟到」这一侧是真实的,不是预先 settle 好的。
  expect(document.querySelector("[data-harness-splash]")).not.toBeNull()
  expect(runtime.composerMountCount()).toBe(0)

  runtime.releaseSidecarInit()
  const bootGeneration = runtime.nextGeneration()
  runtime.emitSidecarGeneration({ generation: bootGeneration, status: "ready", reason: "boot" })
  await waitFor(() => runtime.composerMountCount() === 1, "首页 composer 首次挂载")
  await waitFor(() => runtime.projectsApi()?.store.ready === true, "生产 useAlphaProjects 完成首拉")
  return bootGeneration
}

describe("#565 surface 收敛不重挂 composer(REQ-109 第四闪机制回归闸)", () => {
  test("控制组:真实的默认服务器身份切换,mount 计数器数得到重挂", async () => {
    // 默认服务器指向尚未就绪的 WSL → 生效键先落 sidecar;WSL 迟到就绪后生效键翻成 wsl:Ubuntu,
    // keyed Show 合法重挂整棵路由树。这不是 #565 要禁的行为(那是身份切换),它是手段自证:
    // 计数器若对真实重挂数不到 2,后面所有「仍为 1」都是空绿。
    runtime.setDefaultServerChoice("wsl:Ubuntu")
    await bootToHome()
    expect(runtime.composerMountCount()).toBe(1)

    runtime.setWslState(runtime.readyWslServerState("Ubuntu", "http://127.0.0.1:4097"))
    await waitFor(() => runtime.composerMountCount() === 2, "服务器身份切换后的第二次挂载")

    // #927 反向之二:身份真的切换了但 composer 里没字 —— 不弹丢稿提示(那句话只对
    // 「这一拍确实丢了未发送内容」说,空 composer 的切换弹了就是恒显噪声)。
    await settle()
    expect(discardNoticeToasts().length).toBe(0)
  })

  test("引擎多实例 init 迟到收敛(WSL 服务器迟到就绪/离场):composer 不重挂,草稿与节点保持", async () => {
    await bootToHome()
    const composerBefore = composerRoot()
    typeDraft("这句草稿不应随收敛蒸发")

    // WSL 服务器迟到就绪:servers()/projectsServerKey 全部重算,AppInterface 的 servers prop
    // 换了一份新数组 —— 收敛必须**增量更新**已挂载子树。
    runtime.setWslState(runtime.readyWslServerState("Ubuntu", "http://127.0.0.1:4097"))
    // 收敛真的到达了生产 ServerProvider(不是广播进了死桥):
    await waitFor(() => runtime.serverList().includes("wsl:Ubuntu"), "ServerProvider 收敛出 WSL 服务器")
    await settle()

    // 再离场一次(第二种形状的收敛;负向夹具不用单一形状)。
    runtime.setWslState(runtime.readyWslServerState("Debian", "http://127.0.0.1:4098"))
    await waitFor(() => runtime.serverList().includes("wsl:Debian"), "ServerProvider 收敛出第二台 WSL")
    await settle()

    expect(runtime.composerMountCount()).toBe(1)
    expect(composerRoot()).toBe(composerBefore)
    expect(composerTextarea().value).toBe("这句草稿不应随收敛蒸发")
  })

  test("token-only 换血 ×2:composer 不重挂,草稿与节点保持,数据层真的换过血", async () => {
    await bootToHome()
    const composerBefore = composerRoot()
    typeDraft("换血期间的草稿")

    for (const round of [1, 2]) {
      const generation = runtime.nextGeneration()
      runtime.emitSidecarGeneration({ generation, status: "recovering", reason: "token-only" })
      await settle()
      runtime.emitSidecarGeneration({ generation, status: "ready", reason: "token-only" })
      // 事件真的被生产 runtime-recovery 收下并放行(recovering + ready 各一条),不是空转:
      await waitFor(
        () => runtime.generationsReceived().filter((g) => g === generation).length === 2,
        `第 ${round} 次换血的 recovering/ready 均被生产代码接收`,
      )
      await settle()
    }

    // 换血作用在活的数据层上:生产 use-projects 仍连着、无错、项目还在。
    const store = runtime.projectsApi()!.store
    expect(store.error).toBe(false)
    expect(store.ready).toBe(true)
    expect(store.projects.some((p) => p.worktree === runtime.PROJECT_DIRECTORY)).toBe(true)

    expect(runtime.composerMountCount()).toBe(1)
    expect(composerRoot()).toBe(composerBefore)
    expect(composerTextarea().value).toBe("换血期间的草稿")
  })
})

describe("#927 身份切换吃掉首页草稿 ⇒ 丢弃但先提示(owner 裁决)", () => {
  // 判据全部落在用户可观察结果上(toast DOM / textarea value),不断言内层信号;
  // 驱动复用上面控制组同一条真实身份切换链(setWslState → keyed 重挂),不新拼等价链。

  test("反向:没有身份切换的收敛不弹丢稿提示,草稿也仍在", async () => {
    await bootToHome() // 默认 sidecar:生效键不会翻
    typeDraft("旁观收敛的这句不该触发提示#927")

    // WSL 迟到就绪但**不是**默认服务器:servers 收敛、生效键不变、无重挂。
    // 提示在这里出现 = 恒显噪声(票面反向判据)。「不该发生」侧 settle 后直接断言,不等待。
    runtime.setWslState(runtime.readyWslServerState("Fedora", "http://127.0.0.1:4112"))
    await waitFor(() => runtime.serverList().includes("wsl:Fedora"), "ServerProvider 收敛出旁观 WSL")
    await settle()

    expect(runtime.composerMountCount()).toBe(1)
    expect(composerTextarea().value).toBe("旁观收敛的这句不该触发提示#927")
    expect(discardNoticeToasts().length).toBe(0)
  })

  test("正向:首页打了半截字,默认服务器迟到就绪引发身份切换 ⇒ 提示出现且说清缘由,草稿按裁决丢弃", async () => {
    runtime.setDefaultServerChoice("wsl:Suse")
    await bootToHome() // WSL 未就绪,先落 sidecar
    typeDraft("打到一半的这句会被切换丢掉#927")
    expect(discardNoticeToasts().length).toBe(0) // 切换发生前无提示

    runtime.setWslState(runtime.readyWslServerState("Suse", "http://127.0.0.1:4111"))
    await waitFor(() => runtime.composerMountCount() === 2, "身份切换后的第二次挂载")

    // 用户可观察结果:提示出现,文本能看出是切换服务器导致的(独立字面量)。
    // 它是在旧树 dispose 期间 push 的,此刻还在 = 熬过了重挂本身。
    const notices = discardNoticeToasts()
    expect(notices.length).toBe(1)
    expect(notices[0]!.textContent).toContain("已切换服务器")
    expect(notices[0]!.textContent).toContain("刚才未发送的草稿未保留")

    // 裁决是「丢弃」不是「恢复」:新 composer 是空的,草稿确实没跟过去。
    expect(composerTextarea().value).toBe("")

    // 收尾:按用户的方式点掉提示,免得全局 toast store 把这条漏进后续用例的 DOM。
    ;(notices[0]!.querySelector(".a-toast-x") as HTMLElement).click()
    await settle()
  })
})

describe("#1056 冷启动只挂一次 home composer(启动 draft 交接闸)", () => {
  // 实测事实(#1053 的 13/13 样本,docs/verification/2026-08-21-req109-1053-catalog-p95/):
  // 一次 `renderer.root.mount` 下有**两条** home 模式模型链 —— `chain:2` 先起、以
  // `outcome:"error:request"` 收场,`chain:1` 随后 30–50ms 内起并 `ok`,`catalog_ready` 只在
  // 后者身上发过。两条链分属两个组件实例(`chainSeq` 是实例本地的 `let`),即 composer 挂了两次。
  // 机制:路由起点恒为 `/` ⇒ AlphaHome 先挂;侧栏的启动效应(REQ-126 §4 序 3)在 `store.ready`
  // 之后必然把路由换到 `/new-session`,首页那一个实例连同它的模型链一起被丢弃。
  //
  // 本组用**生产侧栏 + 生产首页 + 生产新对话页**跑完整条启动路径,判据仍是真机取证的那一个
  // (`renderer.composer.mount` 计数),不断言任何内层信号。

  async function bootWithSidebar() {
    runtime.setSidebarMounted(true)
    // 项目列表按住 = 侧栏启动 draft 的发车闸按住(它 gate 在 store.ready 上)。真机冷启动
    // 这段窗口是 6–10s;这里由用例决定长短,好让「过渡态那一拍」可断言。
    runtime.holdProjectList()
    mountShell()
    await settle()
  }

  // 判据取**存在与否的布尔**而不是节点本身:失败时 happy-dom 节点会被整棵序列化进 diff
  // (实测把一次失败拖成 140s 的日志),这里只需要"在/不在"。
  const newSessionMounted = () => document.querySelector("[data-alpha-new-session]") !== null
  const homeMounted = () => document.querySelector("[data-alpha-home]") !== null
  const homeComposerMounted = () => document.querySelector('[data-alpha-composer="home"]') !== null

  test("控制组:交接位缺席时,同一条启动路径确实挂两次 composer", async () => {
    // 抢先 arm 一个**当场到期**的交接位:侧栏自己的 arm 因一次性闩而成为 no-op,
    // 于是首页照修复前的样子挂 composer —— 先证明这个计数器数得到已知的坏。
    runtime.resetLaunchDraftHandoff()
    runtime.beginLaunchDraftHandoff(0)
    await bootWithSidebar()
    await waitFor(() => runtime.composerMountCount() === 1, "首页(过渡态)composer 挂载")

    runtime.releaseProjectList()
    await waitFor(newSessionMounted, "启动 draft 落到新对话页")
    await waitFor(() => runtime.composerMountCount() === 2, "新对话页 composer 的第二次挂载")
  })

  test("首页过渡态不挂 composer;落到新对话页后全程只挂过一次", async () => {
    await bootWithSidebar()

    // 首页**是**挂着的(不是整页被藏起来):骨架在,只是不掏 composer。
    expect(homeMounted()).toBe(true)
    expect(homeComposerMounted()).toBe(false)
    expect(runtime.composerMountCount()).toBe(0)

    runtime.releaseProjectList()
    await waitFor(newSessionMounted, "启动 draft 落到新对话页")
    await waitFor(() => runtime.composerMountCount() === 1, "新对话页 composer 挂载")

    // 「不该再有第二次」这一侧 settle 后直接断言,不靠等待把它等没。
    await settle()
    expect(runtime.composerMountCount()).toBe(1)
  })

  test("启动 draft 如实失败(默认目录供给被拒)⇒ 首页当场拿回 composer,不留一个没有输入框的死首页", async () => {
    runtime.setEnsureDefaultWorkspaceOk(false)
    await bootWithSidebar()
    expect(runtime.composerMountCount()).toBe(0)

    runtime.releaseProjectList()
    // 没有导航发生(仍在首页),但交接结束 ⇒ composer 补挂上来。
    await waitFor(() => runtime.composerMountCount() === 1, "失败后首页补挂 composer")
    expect(newSessionMounted()).toBe(false)
    expect(homeComposerMounted()).toBe(true)
  })
})

describe("#1099 启动窗口不再是一段空白(REQ-109 观测闸)", () => {
  // 实测事实(docs/verification/2026-08-24-req109-p95-post1083/ §4):`renderer.root.mount` 与
  // `renderer.composer.mount` 之间**一条事件都没有**(seq 从 10 跳到 14),而同一轮里这段窗口
  // 取到过 2,612 / 4,257 / 12,089 ms —— 两个样本的事件序列结构完全相同、前面每步耗时逐项接近,
  // **整个方差都落在这段看不见的窗口里**。#1099 只做一件事:把这段窗口按真实交接点拆开。
  //
  // 本组要钉住的,是这个能力**不会静默消失**:打点写在生产代码里而没人驱动它、或者驱动到了
  // 但记不出「慢在哪一步」,都属于修复被抽空。所以判据分两层:
  //   ① 交接点真的会发,且顺序就是启动路径的顺序(驱动真实生产壳,不断言源码里有那行字符串);
  //   ② 往**两个不同的**步骤里各注一段已知长度的延迟,记录必须把它归到发生它的那一步上 ——
  //      只在窗口两端记时的粗实现能满足 ①,满足不了 ②。

  const INJECTED_DELAY_MS = 200
  /** 归因下限取得比注入值低一截:判的是「这段延迟落在这一步」,不是计时器精度。 */
  const ATTRIBUTED_FLOOR_MS = 150

  const marks = () => runtime.timelineMarks()
  const markNames = () => marks().map((mark) => mark.name)
  const firstIndexOf = (name: string) => markNames().indexOf(name)
  const firstMark = (name: string) => marks().find((mark) => mark.name === name)
  const stepMark = (step: string) =>
    marks().find((mark) => mark.name === "renderer.launch_draft.step" && mark.extra?.step === step)
  /** 相邻两个交接点之间的实际耗时(renderer 时钟)—— 归因就是这个差值。 */
  const gapBetween = (from: string, to: string) => {
    const a = firstMark(from)
    const b = firstMark(to)
    if (!a || !b) throw new Error(`时间线里缺 ${!a ? from : to}`)
    return b.rendererNow - a.rendererNow
  }

  /** 冷启动全路径:侧栏在场(启动 draft 的唯一发起处),generation 到达即连引擎。 */
  async function bootFullStartup() {
    runtime.setSidebarMounted(true)
    mountShell()
    await settle()
    // 显式给一次 ready generation:数据层据此当场建 client(与 bootToHome 同一条生产路径),
    // 免得落到「从未收到 generation 状态」的 1s 兜底上,让注入的延迟被那 1 秒盖过去。
    runtime.emitSidecarGeneration({ generation: runtime.nextGeneration(), status: "ready", reason: "boot" })
  }

  test("从壳门到 composer,每一个交接点都真的会发,顺序即启动路径的顺序", async () => {
    await bootFullStartup()
    await waitFor(() => runtime.composerMountCount() === 1, "启动 draft 落到新对话页并挂上 composer")

    // ① 顺序:按首次出现的位置严格递增,且**只钉结构上必然的两条链** —— 渲染链与数据链在启动
    //    路径上是并行的(数据层的 client 何时建起来,取决于 generation 状态是随壳一起到、还是
    //    随后广播过来),把它们串成一条会把一个真实的非确定性写成判据(实测两种顺序都出现过)。
    const renderChain = [
      "renderer.shell.resource.settled",
      "renderer.shell.ready",
      "renderer.sidebar.setup",
      "renderer.home.surface.setup",
      "renderer.new_session.surface.setup",
      "renderer.composer.mount",
    ]
    const dataChain = [
      "renderer.shell.resource.settled",
      "renderer.projects.connect",
      "renderer.projects.store_ready",
      "renderer.launch_draft.start",
      "renderer.launch_draft.step",
      "renderer.launch_draft.end",
    ]
    for (const chain of [renderChain, dataChain]) {
      const positions = chain.map(firstIndexOf)
      // 缺席 ⇒ indexOf 为 -1,严格递增当场断掉(-1 不小于其后的任何下标)。
      expect(positions.every((position) => position >= 0)).toBe(true)
      for (let i = 1; i < positions.length; i++) expect(positions[i]!).toBeGreaterThan(positions[i - 1]!)
    }
    // 两条链的交汇:新对话页是启动 draft 导航来的,不是自己冒出来的。
    expect(firstIndexOf("renderer.new_session.surface.setup")).toBeGreaterThan(
      firstIndexOf("renderer.launch_draft.start"),
    )

    // ② 壳门的四个收敛源逐个可归因 —— 集合相等,不是「至少有一条」。`ready()` 里新并一个资源
    //    而没并进 installShellBootTimeline,splash 就又多一段没人记的等待:那正是本票在修的病。
    const settledResources = marks()
      .filter((mark) => mark.name === "renderer.shell.resource.settled")
      .map((mark) => String(mark.extra?.resource))
    expect(new Set(settledResources)).toEqual(new Set(["windowCount", "sidecar", "defaultServer", "locale"]))
    expect(settledResources.length).toBe(4)

    // ③ 首页那一拍确实是「挂上了但没有输入框」的过渡态(#1056 的交接位),这件事此前只能靠
    //    推理,现在写在记录里。
    expect(firstMark("renderer.home.surface.setup")?.extra?.composerPending).toBe(true)

    // ④ 启动 draft 的四步逐个留痕,且这一轮是走到底的那条路(而不是半途失败)。
    const stepNames = marks()
      .filter((mark) => mark.name === "renderer.launch_draft.step")
      .map((mark) => String(mark.extra?.step))
    expect(stepNames).toEqual(["tabs_ready", "resolve_target", "ensure_workspace", "new_draft"])
    expect(firstMark("renderer.launch_draft.start")?.extra?.trigger).toBe("launch")
    expect(firstMark("renderer.launch_draft.end")?.extra?.outcome).toBe("navigated")
    // 数据层是**经哪条路**连上的,同样是这段窗口的一部分(1s 兜底与封顶退避自探的时间特征
    // 完全不同,混成一条就分不出慢在哪)。走哪条路依赖 generation 状态的到达时刻,不写死;
    // 但它必须是**已命名的那几条之一** —— 打成空/undefined 就等于这条信息没记。
    expect([
      "bridge-absent",
      "runtime-ready",
      "generation-event",
      "bridge-fallback-timer",
      "self-probe",
    ]).toContain(String(firstMark("renderer.projects.connect")?.extra?.reason))
  })

  test("归因之一:项目列表首拉被按住 ⇒ 这段延迟落在 connect→store_ready 上,不摊到别处", async () => {
    runtime.holdProjectList()
    await bootFullStartup()
    await waitFor(() => markNames().includes("renderer.projects.connect"), "数据层连上引擎")
    // 引擎已连、首拉在途:此刻按住的正是 connect 与 store_ready 之间那一段。
    await new Promise((resolve) => setTimeout(resolve, INJECTED_DELAY_MS))
    runtime.releaseProjectList()
    await waitFor(() => runtime.composerMountCount() === 1, "释放后启动 draft 走完")

    const held = gapBetween("renderer.projects.connect", "renderer.projects.store_ready")
    expect(held).toBeGreaterThanOrEqual(ATTRIBUTED_FLOOR_MS)
    // 而启动 draft 的每一步都没有被这段延迟污染 —— 「慢在哪一步」答得出来,不是「总共慢了」。
    for (const mark of marks().filter((m) => m.name === "renderer.launch_draft.step"))
      expect(Number(mark.extra?.durationMs)).toBeLessThan(ATTRIBUTED_FLOOR_MS)
    expect(gapBetween("renderer.shell.ready", "renderer.sidebar.setup")).toBeLessThan(ATTRIBUTED_FLOOR_MS)
  })

  test("归因之二:默认目录供给 IPC 被拖慢 ⇒ 这段延迟落在 launch_draft 的 ensure_workspace 那一步", async () => {
    runtime.setEnsureDefaultWorkspaceDelayMs(INJECTED_DELAY_MS)
    await bootFullStartup()
    await new Promise((resolve) => setTimeout(resolve, INJECTED_DELAY_MS + 60))
    await waitFor(() => runtime.composerMountCount() === 1, "启动 draft 走完(供给 IPC 慢了一拍)")

    // 注入点换了一个,记录跟着换了一步 —— 这是「粒度不比缺陷粗一格」的判据。
    expect(Number(stepMark("ensure_workspace")?.extra?.durationMs)).toBeGreaterThanOrEqual(ATTRIBUTED_FLOOR_MS)
    expect(Number(stepMark("tabs_ready")?.extra?.durationMs)).toBeLessThan(ATTRIBUTED_FLOOR_MS)
    expect(Number(stepMark("resolve_target")?.extra?.durationMs)).toBeLessThan(ATTRIBUTED_FLOOR_MS)
    expect(gapBetween("renderer.projects.connect", "renderer.projects.store_ready")).toBeLessThan(
      ATTRIBUTED_FLOOR_MS,
    )
    // 整段窗口的总耗时仍然包含这 200ms —— 分项加起来对得上总数,不是两套互不相干的数字。
    expect(Number(firstMark("renderer.launch_draft.end")?.extra?.durationMs)).toBeGreaterThanOrEqual(
      ATTRIBUTED_FLOOR_MS,
    )
  })

  test("启动 draft 如实失败时,记录指名是哪一步失败的(不是只剩一个「没成」)", async () => {
    runtime.setEnsureDefaultWorkspaceOk(false)
    await bootFullStartup()
    await waitFor(() => runtime.composerMountCount() === 1, "失败后首页补挂 composer")

    expect(stepMark("ensure_workspace")?.extra?.outcome).toBe("rejected")
    expect(firstMark("renderer.launch_draft.end")?.extra?.outcome).toBe("workspace-failed")
    // 没有导航发生 ⇒ 新对话页那条交接点不该出现(错误实现若把它写成无条件打点,这里红)。
    expect(markNames()).not.toContain("renderer.new_session.surface.setup")
  })
})

describe("#565 harness 复刻的原件形状锚点(renderer/index.tsx)", () => {
  // App() 的响应图无法 import(render() 入口)。这些锚点不判行为,只判「复刻还对不对得上原件」。
  // 判据是**整段精确文本**而不是 presence 探针:第四闪的历史触发点(REQ-088 的 resolvedSurfaces
  // admission)是「往被复刻区域里新增一个收敛源」—— presence 探针对新增全盲(旧四条锚点在
  // `ready()` 并入新资源时一条不红,而 harness 跑的是自己的复刻,index.tsx 一个字节没被执行)。
  // 三处咽喉逐字钉死:ready() 的收敛源集合、keyed 的 key 计算、外层门→keyed→AppInterface 的
  // 连续文本(中间插任何新门都会打断连续性)。锚点红不代表行为坏,代表复刻过期了:
  // 先把 surface-remount-test-runtime.tsx 的复刻同步到原件,再把这里的字面量一起更新。
  const entry = readFileSync(join(import.meta.dir, "index.tsx"), "utf8")
  const replica = readFileSync(join(import.meta.dir, "surface-remount-test-runtime.tsx"), "utf8")

  // ready() 整段:哪些资源的 loading 能拆掉整棵树,一字不差。独立字面量,不从被测文件里抽取。
  const readyAnchor = [
    "    const ready = createMemo(",
    "      () => !defaultServer.loading && !sidecar.loading && !windowCount.loading && !locale.loading,",
    "    )",
  ].join("\n")

  test("ready() 的收敛源集合被逐字钉死,且复刻与原件是同一段文本", () => {
    // 在 ready() 里并入任何新的 `.loading`(资源重取 ⇒ ready 翻 false ⇒ 外层 Show 整棵拆毁重建,
    // 即第四闪)都会当场打断这段字面量:
    expect(entry).toContain(readyAnchor)
    // 复刻用同一段文本 —— 复刻单方面漂移(今天真实发生过:少 `!locale.loading`)同样当场红:
    expect(replica).toContain(readyAnchor)
  })

  test("surfaces 仍是一次性同步组合,路由树仍 keyed 在 effectiveDefaultServer 上", () => {
    expect(entry).toContain("const surfaceComponents = createMemo<AppSurfaces>(() => ({")
    // keyed 的 key 计算整段:往这个 memo 里并收敛源同样会翻树。
    expect(entry).toContain(
      [
        "    const effectiveDefaultServer = createMemo(() =>",
        "      ServerConnection.Key.make(availableStartupServer(defaultServer.latest, wslServers.data)),",
        "    )",
      ].join("\n"),
    )
    // 外层门 → keyed → AppInterface 的连续文本:在 ready() 之外新加一道收敛门(包一层 Show)、
    // 或在 keyed 与 AppInterface 之间再插一层,都会打断连续性:
    expect(entry).toContain(
      [
        "    return (",
        "      <Show when={ready()} fallback={splash}>",
        "        <Show when={effectiveDefaultServer()} keyed>",
        "          {(key) => (",
        "            <AppInterface defaultServer={key} servers={servers()} router={MemoryRouter} surfaces={surfaceComponents()}>",
      ].join("\n"),
    )
    // 整个 index.tsx 只允许这一个 keyed Show:
    expect(entry.match(/keyed/g)?.length).toBe(1)
    // REQ-089 删掉的异步 admission 不得回魂:
    expect(entry).not.toContain("resolvedSurfaces")
    expect(entry).not.toContain("surfaces.resolve")
  })

  test("#1099 壳门打点的安装线钉在原件与复刻上(同一行;逻辑全在生产模块里)", () => {
    // 行为用例跑的是复刻 —— 只有这条锚点保证 index.tsx 原件也接着同一根线。删掉原件那行
    // (splash 这一段静默退回没有记录)在这里红;删掉模块里的打点在行为用例红。
    const anchor = "  installShellBootTimeline({ windowCount, sidecar, defaultServer, locale })"
    expect(entry).toContain(anchor)
    expect(replica).toContain(anchor)
  })

  test("#927 丢稿提示的安装线钉在原件与复刻上(同一行;逻辑全在生产模块里)", () => {
    // 行为用例跑的是复刻 —— 只有这条锚点保证 index.tsx 原件也接着同一根线。
    // 删掉原件那行(静默退回「丢了不说」)在这里红;删掉模块里的 pushToast 在行为用例红。
    const anchor = "    installHomeDraftDiscardNotice(effectiveDefaultServer)"
    expect(entry).toContain(anchor)
    expect(replica).toContain(anchor)
  })
})
