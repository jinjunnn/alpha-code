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
})
