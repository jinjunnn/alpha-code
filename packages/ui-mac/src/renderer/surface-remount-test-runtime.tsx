// #565(REQ-109 第四闪机制)「收敛不重挂 composer」闸门的**生产组合体**。
//
// 票面定案的机制:surface admission(`resolvedSurfaces`)迟到收敛 → 路由树重建 → composer
// 全量 remount(热启动 occurrence 2→7;token-only 换血首次触发后 30s 内 remount 6 次)。
// 那个异步 admission 资源已被 REQ-089(#638)连根删除 —— 本 harness 把「删除之后不重挂」
// 钉成回归闸:任何人把「服务器/surface 收敛」重新接回路由树重建(keyed 在不稳定值上、
// admission 变回异步、composer 被 keyed 在随收敛翻新的 store 上),这里先于真机红。
//
// 挂的是**真实 alpha 壳**(与 start-draft-test-runtime 同一形态):上游
// `PlatformProvider → AppBaseProviders → AppInterface`、真实 MemoryRouter 路由树、生产
// `composeRoutes`、生产 `AlphaHome`/`AlphaComposer`/`useAlphaProjects`/`runtime-recovery`。
// `App()` 的响应图(sidecar/defaultServer 资源、servers/sidebarServer/effectiveDefaultServer/
// projectsServerKey/surfaceComponents 五个 memo、keyed Show)**逐行照抄 renderer/index.tsx** ——
// index.tsx 是 render() 入口无法直接 import,这份复刻是 harness 唯一不执行原文件的部分,
// 判据文件里以源码锚点钉住原件形状(锚点变 = 本文件要跟着改)。
//
// 判据的可观察量**就是真机取证用的那一个**:生产 AlphaComposer `onMount` 里的
// `markStartupTimeline("renderer.composer.mount")`(经 window.api.startupTimeline 捕获),
// 加 DOM 节点同一性与草稿文本 —— 不断言任何内层 memo 的值。
//
// 替身只剩最外围三样,都不在被测命题上(与 start-draft harness 同口径):
//   · `window.api` —— Electron preload 桥(可控:init 时刻、generation 广播、timeline 捕获);
//   · `globalThis.fetch` —— 引擎 HTTP 面(形状正确的 fixture;/event 挂起);
//   · `platform.wslServers` —— WSL 桥(可控:用例驱动「多实例 init 迟到收敛」)。

import {
  AppBaseProviders,
  AppInterface,
  type AppSurfaces,
  type DraftSurfaceProps,
  PlatformProvider,
  ServerConnection,
  useServer,
  useWslServers,
  type Platform,
} from "@opencode-ai/app"
import type { WslServersState } from "@opencode-ai/app/wsl/types"
import { MemoryRouter } from "@solidjs/router"
import { createEffect, createMemo, createResource, createSignal, onCleanup, Show } from "solid-js"
import { render } from "solid-js/web"
import type { SidecarGenerationState } from "../preload/types"
import { AlphaHome } from "./alpha-ui/AlphaHome"
import { AlphaNewSession } from "./alpha-ui/alpha-new-session"
import { ContractHealthProvider } from "./alpha-ui/providers"
import { alphaSessionWorkspaceSurface } from "./alpha-ui/session-workspace/alpha-session-workspace"
import { SurfaceBoundary } from "./alpha-ui/surface-boundary"
import { UpstreamDialogHost } from "./alpha-ui/UpstreamDialogHost"
import { initializationData } from "./initialization"
import { composeRoutes } from "./route-composition"
import { type AlphaProjectsApi, useAlphaProjects } from "./sidebar/use-projects"
import { availableStartupServer, readyWslConnections } from "./wsl/connections"

export { render }

export const SIDECAR_URL = "http://127.0.0.1:4096"
export const PROJECT_DIRECTORY = "/repos/alpha-code"
export const DEFAULT_WORKSPACE = "/Users/tester/Alpha"

// —— 可释放的等待闸:sidecar init 的「迟到」由用例控制 ——————————————————————
function createBarrier() {
  let held = false
  let release = () => {}
  let gate = Promise.resolve()
  return {
    hold() {
      if (held) return
      held = true
      gate = new Promise<void>((resolve) => (release = resolve))
    },
    release() {
      if (!held) return
      held = false
      release()
    },
    wait() {
      return held ? gate : Promise.resolve()
    },
  }
}

const sidecarInitBarrier = createBarrier()
/** 按住 `window.api.awaitInitialization` → 复现「引擎 init 迟到」:壳先 splash,收敛后才挂路由树。 */
export const holdSidecarInit = () => sidecarInitBarrier.hold()
export const releaseSidecarInit = () => sidecarInitBarrier.release()

// —— 默认服务器(index.tsx 里 platform.getDefaultServer 的等价供给,挂载前配置)——————
let defaultServerChoice = "sidecar"
export const setDefaultServerChoice = (key: string) => {
  defaultServerChoice = key
}

// —— WSL 桥(引擎多实例 init 的第二个迟到收敛源;用例驱动)————————————————————
const emptyWslState: WslServersState = {
  runtime: null,
  installed: [],
  online: [],
  distroProbes: {},
  opencodeChecks: {},
  pendingRestart: false,
  servers: [],
  job: null,
}
let wslState: WslServersState = emptyWslState
const wslSubscribers = new Set<(event: { type: "state"; state: WslServersState }) => void>()
export function setWslState(state: WslServersState) {
  wslState = state
  for (const cb of [...wslSubscribers]) cb({ type: "state", state })
}
export function readyWslServerState(distro: string, url: string): WslServersState {
  return {
    ...emptyWslState,
    servers: [
      {
        config: { id: `wsl:${distro}`, distro },
        runtime: { kind: "ready", url, username: null, password: null },
      },
    ],
  }
}

// —— sidecar generation 广播(token-only 换血的生产信道)———————————————————————
// runtime-recovery.ts 的 install() 是模块单例且 generation 单调:整个测试文件共用一个
// 递增计数器,跨用例不得回退。
const generationSubscribers = new Set<(state: SidecarGenerationState) => void>()
let generationState: SidecarGenerationState = { generation: 0, status: "ready", reason: "boot" }
export function emitSidecarGeneration(state: SidecarGenerationState) {
  generationState = state
  for (const cb of [...generationSubscribers]) cb(state)
}
let generationCounter = 0
export function nextGeneration() {
  return ++generationCounter
}

// —— 判据捕获:生产 markStartupTimeline 打进来的每一条 —————————————————————————
export type TimelineRecord = { name: string; extra?: Record<string, unknown> }
const timeline: TimelineRecord[] = []
export function timelineMarks(): TimelineRecord[] {
  return [...timeline]
}
/** 生产 AlphaComposer onMount 的 `renderer.composer.mount` 计数 —— 与真机取证同一个可观察量。 */
export function composerMountCount(): number {
  return timeline.filter((mark) => mark.name === "renderer.composer.mount").length
}
/** 生产 runtime-recovery 真实收到并放行的 generation 序列(证明换血事件没有打进死桥)。 */
export function generationsReceived(): number[] {
  return timeline
    .filter((mark) => mark.name === "renderer.sidecar.generation.received")
    .map((mark) => Number(mark.extra?.generation))
}
export function resetTimeline() {
  timeline.length = 0
}

// —— ServerProvider 真实收敛到的服务器清单(证明 WSL 收敛真的到达生产 server context)————
const [serverList, setServerList] = createSignal<string[]>([])
export { serverList }
function ServerListProbe() {
  const server = useServer()
  createEffect(() => setServerList(server.list.map((item) => ServerConnection.key(item) as string)))
  onCleanup(() => setServerList([]))
  return null
}

// —— 生产 useAlphaProjects 的探出口(证明换血作用在活的数据层上)——————————————————
let projectsApiRef: AlphaProjectsApi | undefined
export const projectsApi = () => projectsApiRef

// —— preload / fetch 替身(start-draft harness 同口径)——————————————————————————
const storageCells = new Map<string, string>()
const harnessStorage = (name = "default") => ({
  getItem: async (key: string) => storageCells.get(`${name}:${key}`) ?? null,
  setItem: async (key: string, value: string) => {
    storageCells.set(`${name}:${key}`, value)
  },
  removeItem: async (key: string) => {
    storageCells.delete(`${name}:${key}`)
  },
})

const platform: Platform = {
  platform: "desktop",
  os: "macos",
  storage: harnessStorage,
  openLink: () => {},
  restart: async () => {},
  back: () => {},
  forward: () => {},
  notify: async () => {},
  openDirectoryPickerDialog: async () => ({ paths: [] }) as never,
  wslServers: {
    getState: async () => wslState,
    subscribe: (cb) => {
      wslSubscribers.add(cb)
      return () => wslSubscribers.delete(cb)
    },
    probeRuntime: async () => {},
    refreshDistros: async () => {},
    installWsl: async () => {},
    installDistro: async () => {},
    probeAddable: async () => {},
    installOpencode: async () => {},
    openTerminal: async () => {},
    addServer: async (distro: string) => ({ id: `wsl:${distro}`, distro }),
    removeServer: async () => {},
    startServer: async () => {},
  },
}

/** 上游按端点解析响应;形状不对会触发重试退避,让叶"看起来没挂载"。 */
const FETCH_FIXTURES: Record<string, unknown> = {
  "/provider": { all: [], connected: [], default: {} },
  "/path": { state: "", config: "", worktree: DEFAULT_WORKSPACE, directory: DEFAULT_WORKSPACE, home: "/Users/tester" },
  // 非空:换血后 loadProjects 会整体重建这个数组(setStore("projects", prev => incoming.map(...)))
  // —— 「composer 被 keyed 在随收敛翻新的 store 上」这类错误实现要有真实翻新才能被打红。
  "/project": [{ id: "prj_alpha-code", worktree: PROJECT_DIRECTORY, name: "alpha-code", sandboxes: [] }],
  "/project/current": { id: "prj_alpha-code", worktree: PROJECT_DIRECTORY },
  "/session": [],
  "/agent": [],
  "/command": [],
  "/question": [],
  "/permission": [],
  "/experimental/resource": [],
  "/api/reference": [],
}

export function installPreloadStub() {
  const explicit: Record<string, (...args: unknown[]) => unknown> = {
    awaitInitialization: async () => {
      await sidecarInitBarrier.wait()
      return { url: SIDECAR_URL, username: "alpha", password: "generation-secret" }
    },
    getWindowCount: async () => 1,
    "startupTimeline.mark": (name, _rendererNow, extra) => {
      timeline.push({ name: String(name), extra: extra as Record<string, unknown> | undefined })
    },
    "sidecarGeneration.subscribe": (cb) => {
      const listener = cb as (state: SidecarGenerationState) => void
      generationSubscribers.add(listener)
      return () => generationSubscribers.delete(listener)
    },
    "sidecarGeneration.getState": async () => generationState,
    "auth.getState": async () => ({ status: "logged-out", mode: "byok" }),
    "automations.list": async () => ({ tasks: [], state: { pausedAll: false }, loginItem: false }),
    "account.summary": async () => null,
    "contracts.health": async () => null,
    endpoints: async () => ({}),
    workspaceDefaultDir: async () => DEFAULT_WORKSPACE,
    "models.catalog": async () => ({
      version: "harness",
      defaultModel: null,
      defaultPlatformModel: null,
      platformProvider: { id: "alpha", name: "Alpha", npm: "", pico: { letter: "A", color: "#f60" } },
      platformModels: [],
      byokProviders: [],
      presetIds: [],
      liveSync: { status: "static" },
      pricingBasisModelId: null,
    }),
    "providers.keyStatus": async () => ({}),
    // AlphaHome 的 useConfigHealth 走 extIpc.configHealth;缺省 Proxy 会回 undefined,
    // `configHealth().broken` 当场 throw → 整个 home surface 被边界吞掉(实测)。
    "ext.configHealth": async () => ({ broken: false }),
  }
  const node = (path: string[]): unknown => {
    const call = (...args: unknown[]) => {
      const key = path.join(".")
      if (key in explicit) return explicit[key]!(...args)
      const leaf = path[path.length - 1] ?? ""
      if (/^(on[A-Z]|subscribe)/.test(leaf)) return () => {}
      return Promise.resolve(undefined)
    }
    return new Proxy(call, {
      get: (_t, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : node([...path, String(prop)])),
    })
  }
  // defineProperty 而不是裸赋值:整包跑时先跑的测试可能已把 window.api 定义成只读属性。
  Object.defineProperty(window, "api", { configurable: true, writable: true, value: node([]) })
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: ((input: RequestInfo | URL) => {
      const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url)
      const path = new URL(url).pathname
      // 事件流保持挂起(闸门不跑服务器);其余给形状正确的响应,形状错会让上游走退避重试。
      if (path.endsWith("/event")) return new Promise(() => {})
      const body = path in FETCH_FIXTURES ? FETCH_FIXTURES[path] : {}
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
      )
    }) as unknown as typeof fetch,
  })
}

export function installRootHost() {
  if (document.getElementById("root")) return
  const root = document.createElement("div")
  root.id = "root"
  document.body.append(root)
}

export function resetHarness() {
  storageCells.clear()
  sidecarInitBarrier.release()
  defaultServerChoice = "sidecar"
  wslState = emptyWslState
  projectsApiRef = undefined
  resetTimeline()
  // 刻意不清 generationSubscribers / generationCounter:runtime-recovery 是模块单例、
  // generation 单调 —— 跨用例只能向前走(见抬头注释)。
}

// —— 生产 surface 组合(逐行对应 renderer/index.tsx 的 productionRoutes)—————————————
// settings / recovery 的 mount 不进 AppInterface 的 surfaces(index.tsx 里它们作为 children
// 挂载),不在本命题上 → 给最小替身;dialog 用生产 UpstreamDialogHost(经 AppBaseProviders)。
const productionRoutes = composeRoutes({
  home: (projects: AlphaProjectsApi, serverKey: () => string | undefined) => () => (
    <SurfaceBoundary surface="home">
      <AlphaHome projects={projects} serverKey={serverKey} />
    </SurfaceBoundary>
  ),
  newSession:
    (projects: AlphaProjectsApi, serverKey: () => string | undefined) => (props: DraftSurfaceProps) => (
      <SurfaceBoundary surface="newSession">
        <AlphaNewSession
          projects={projects}
          serverKey={serverKey}
          draftId={props.draftId}
          promoteDraft={props.promoteDraft}
        />
      </SurfaceBoundary>
    ),
  session: (projects: AlphaProjectsApi) => alphaSessionWorkspaceSurface(projects),
  settings: () => null,
  dialog: UpstreamDialogHost,
  recovery: () => null,
})

export function AlphaSurfaceShell() {
  // —— 以下响应图逐行对应 renderer/index.tsx 的 render 闭包 + App()(资源在 App 外建、
  // App 闭包引用;locale/windowCount 之外的 alpha children 不在命题上,已裁)。————————
  const [windowCount] = createResource(() => window.api.getWindowCount())
  const [sidecar] = createResource(() => window.api.awaitInitialization())
  const [defaultServer] = createResource(async () => defaultServerChoice)
  // 原件 ready() 的第四个收敛源(index.tsx 的 loadLocale)。值的消费(AppBaseProviders 的
  // locale prop)不在命题上,已裁;但 loading 边必须在 —— 它进 ready(),锚点钉的原件文本里有它,
  // 复刻少了它就是审计点名过的那种静默漂移。
  const [locale] = createResource(async () => "harness-locale")

  function App() {
    const wslServers = useWslServers()

    const ready = createMemo(
      () => !defaultServer.loading && !sidecar.loading && !windowCount.loading && !locale.loading,
    )
    const servers = createMemo(() => {
      const data = initializationData(sidecar)
      const list: ServerConnection.Any[] = []
      if (data) {
        list.push({
          displayName: "Local Server",
          type: "sidecar",
          variant: "base",
          http: {
            url: data.url,
            username: data.username ?? undefined,
            password: data.password ?? undefined,
          },
        })
      }
      list.push(...readyWslConnections(wslServers.data))
      return list
    })
    const sidebarServer = createMemo(() => {
      const data = initializationData(sidecar)
      if (!data) return undefined
      return { baseUrl: data.url, username: data.username ?? undefined, password: data.password ?? undefined }
    })
    const effectiveDefaultServer = createMemo(() =>
      ServerConnection.Key.make(availableStartupServer(defaultServer.latest, wslServers.data)),
    )

    const alphaProjects = useAlphaProjects(sidebarServer)
    projectsApiRef = alphaProjects
    onCleanup(() => {
      if (projectsApiRef === alphaProjects) projectsApiRef = undefined
    })

    const projectsServerKey = createMemo(() => {
      const baseUrl = sidebarServer()?.baseUrl
      if (!baseUrl) return undefined
      const connection = servers().find((candidate) => candidate.http.url === baseUrl)
      return connection ? ServerConnection.key(connection) : undefined
    })

    const surfaceComponents = createMemo<AppSurfaces>(() => ({
      [productionRoutes.home.surface]: productionRoutes.home.mount(alphaProjects, projectsServerKey),
      [productionRoutes["new-session"].surface]: productionRoutes["new-session"].mount(
        alphaProjects,
        projectsServerKey,
      ),
      [productionRoutes.session.surface]: productionRoutes.session.mount(alphaProjects),
    }))

    return (
      <Show when={ready()} fallback={<div data-harness-splash />}>
        <Show when={effectiveDefaultServer()} keyed>
          {(key) => (
            <AppInterface
              defaultServer={key}
              servers={servers()}
              router={MemoryRouter}
              // ConnectionGate 在 keyed Show 之下、路由树之上,但它的 refetch 只由用户按钮触发,
              // 不在收敛命题上(与 start-draft harness 同口径:不跑真健康探测)。
              disableHealthCheck
              surfaces={surfaceComponents()}
            >
              <ServerListProbe />
            </AppInterface>
          )}
        </Show>
      </Show>
    )
  }

  return (
    <PlatformProvider value={platform}>
      <ContractHealthProvider>
        <AppBaseProviders dialogHost={productionRoutes.dialog.mount}>
          <Show when={true}>{(_) => <App />}</Show>
        </AppBaseProviders>
      </ContractHealthProvider>
    </PlatformProvider>
  )
}
