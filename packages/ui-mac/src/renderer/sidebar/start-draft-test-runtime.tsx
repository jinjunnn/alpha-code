// REQ-126 CODE-C(#656)「新对话不再经 legacy admission」闸门的**生产组合体**。
//
// 挂的是**真实 alpha 壳**:上游 `PlatformProvider → AppBaseProviders → AppInterface`(与
// renderer/index.tsx 同一条 provider 链、同一个 MemoryRouter),children 里挂真实生产
// `AlphaSidebar`。路由树、`LegacyServerLayout`、`createSessionRoute` 全是上游生产代码 ——
// 所以「点新对话会不会挂起上游左栏」这件事在这里是真的会发生,不是模拟。
//
// surfaces 里 `session` / `newSession` 都用**生产组件本体**(alpha 会话工作区 / alpha 新对话页),
// 因为闸门的两条判据正是「`[data-alpha-session-workspace]` 从未出现」与「`[data-alpha-new-session]`
// 最终出现」—— 用标记件代替会让前者变成一条永远成立的空断言。`home` 不在判据上,给最小标记件。
//
// 替身只剩最外围三样,都不在被测命题上:
//   · `window.api` —— Electron preload 桥(壳挂载期真的会调它);
//   · `globalThis.fetch` —— 壳会去连引擎;闸门不跑服务器,让它静默挂起而不是刷满 ECONNREFUSED;
//   · `projects`(AlphaProjectsApi)—— 侧栏的数据层。`ensureDefaultWorkspace` 由用例控制返回值/
//     未决状态,这是 AC「ensure 失败不建 draft」的可观察输入。

import {
  AppBaseProviders,
  AppInterface,
  PlatformProvider,
  ServerConnection,
  useServer,
  useTabs,
  type Platform,
} from "@opencode-ai/app"
import { MemoryRouter, useLocation, useNavigate } from "@solidjs/router"
import { createEffect, createSignal, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { AlphaSidebar } from "./alpha-sidebar"
import { AlphaNewSession } from "../alpha-ui/alpha-new-session"
import { alphaSessionWorkspaceSurface } from "../alpha-ui/session-workspace/alpha-session-workspace"
import { ToastViewport } from "../alpha-ui/Toast"
import type { AlphaProject, AlphaProjectsApi, AlphaProjectsStore } from "./use-projects"

export { render }

export const DEFAULT_WORKSPACE = "/Users/tester/Alpha"
export const PROJECT_DIRECTORY = "/repos/alpha-code"
export const REMOTE_PROJECT_DIRECTORY = "/home/tester/on-the-wsl-box"

export const SIDECAR_CONNECTION: ServerConnection.Any = {
  displayName: "Local Server",
  type: "sidecar",
  variant: "base",
  http: { url: "http://127.0.0.1:4096" },
}

/** loopback 的 **http** 连接:上游 `ServerConnection.local` 判它是 local,但它完全可能是 SSH 隧道
 *  或远端反代 —— 那台机器上没有宿主机的 `~/Alpha`。同源判定必须把它当"别的 server"。 */
export const LOOPBACK_HTTP_CONNECTION: ServerConnection.Any = {
  displayName: "Tunnelled Server",
  type: "http",
  http: { url: "http://127.0.0.1:7788" },
}

/** WSL server:`ServerConnection.local()` 对它为 false —— 宿主机的 `~/Alpha` 不能配给它。 */
export const WSL_CONNECTION: ServerConnection.Any = {
  displayName: "Ubuntu",
  type: "sidecar",
  variant: "wsl",
  distro: "Ubuntu",
  http: { url: "http://127.0.0.1:4097" },
}

const fixtureProject: AlphaProject = {
  id: "prj_alpha-code",
  worktree: PROJECT_DIRECTORY,
  name: "alpha-code",
  directories: [PROJECT_DIRECTORY],
  loaded: true,
  sessions: [
    { id: "ses_a", title: "既有会话", directory: PROJECT_DIRECTORY, projectID: "prj_alpha-code", updated: 10 },
  ],
}

// —— 可释放的等待闸(barrier)————————————————————————————————————————————
// 生产入口有两处**等待**:等 tabs 水合、等默认对话目录解析落定。harness 若在动作前已经 settle 到
// 一切就绪,这两处删掉照样全绿 —— 那是空闸门。这两个 barrier 让用例把对应的异步来源按住,于是
// 「没等就建 draft」这件事真的可被观察到。
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

const tabsStorageBarrier = createBarrier()
const defaultWorkspaceBarrier = createBarrier()

/** 按住上游 tabs 持久化存储的读取 → `tabs.ready()` 一直为 false。 */
export const holdTabsHydration = () => tabsStorageBarrier.hold()
export const releaseTabsHydration = () => tabsStorageBarrier.release()
/** 按住默认对话目录的 IPC → `createDefaultWorkspaceDir()` 的 `.loading` 一直为 true。 */
export const holdDefaultWorkspace = () => defaultWorkspaceBarrier.hold()
export const releaseDefaultWorkspace = () => defaultWorkspaceBarrier.release()

// —— 用例可控的数据层 ——————————————————————————————————————————————————————
const [store, setStore] = createStore<AlphaProjectsStore>({ projects: [fixtureProject], ready: false, error: false })
export const setProjectsReady = (ready: boolean) => setStore("ready", ready)

export const ensureCalls: string[] = []
let ensureOutcome: boolean | "pending" = true
export const setEnsureOutcome = (outcome: boolean | "pending") => {
  ensureOutcome = outcome
}

const projects: AlphaProjectsApi = {
  store,
  reload: async () => {},
  createSession: async () => undefined,
  startChat: async () => undefined,
  sdk: () => undefined,
  renameSession: async () => true,
  shareSession: async () => undefined,
  deleteSession: async () => true,
  copySession: async () => undefined,
  ensureDefaultWorkspace: async (worktree: string) => {
    ensureCalls.push(worktree)
    if (ensureOutcome === "pending") return new Promise<boolean>(() => {})
    return ensureOutcome
  },
}

// —— 挂载记录仪 ————————————————————————————————————————————————————————————
// 判据是「从未出现」,所以不能只看终态 DOM:被替换掉的那一帧正是 owner 报的闪烁。
// MutationObserver 记下每一个被插入的节点,插进来又马上被移走照样留下记录。
export type MountKind = "legacy-sidebar" | "session-workspace" | "new-session"

const WATCHED: Array<{ kind: MountKind; selector: string }> = [
  // 上游 legacy 左栏(pages/layout/sidebar-shell.tsx 的 SidebarContent 根)。
  { kind: "legacy-sidebar", selector: "[data-component='sidebar-rail']" },
  // alpha 会话工作区(session-workspace-shell.tsx 的根)。
  { kind: "session-workspace", selector: "[data-alpha-session-workspace]" },
  // alpha 新对话页(alpha-new-session.tsx 的根)—— 目标终点。
  { kind: "new-session", selector: "[data-alpha-new-session]" },
]

let mountLog: MountKind[] = []
let observer: MutationObserver | undefined

function record(node: Node) {
  if (node.nodeType !== 1) return
  const element = node as Element
  for (const watch of WATCHED) {
    const hit = element.matches?.(watch.selector) || element.querySelector?.(watch.selector) !== null
    if (hit && mountLog[mountLog.length - 1] !== watch.kind) mountLog.push(watch.kind)
  }
}

/** 从这一刻起录制。起点也算一帧:已经在 DOM 里的同样记下来。 */
export function startRecording() {
  mountLog = []
  record(document.body)
  observer?.disconnect()
  observer = new MutationObserver((records) => {
    for (const entry of records) for (const node of Array.from(entry.addedNodes)) record(node)
  })
  observer.observe(document.body, { childList: true, subtree: true })
}

/** 观察者的**盲区兜底**:实测 happy-dom 的 MutationObserver 并不上报 Solid 某些整棵子树的换入
 *  (手工 append 能上报、同一次跑里叶子树的换入却一次都没上报),只靠它会让「从未出现」在那些场景
 *  下空绿。调用方在每一轮 settle 里采样一次:观察者负责抓**同一 tick 内挂了又被换掉**的那一帧,
 *  采样负责抓观察者漏掉的挂载。两者取并集,谁都不能单独让闸门变松。 */
export function sampleMounts() {
  record(document.body)
}

export function recorded(): MountKind[] {
  return [...mountLog]
}

// —— 真实路由的当前位置 / 真实 server 的项目登记 ————————————————————————————
const [routerHref, setRouterHref] = createSignal("")
export { routerHref }

/** 上游 tabs store 里当前活着的 draft —— 「连点两次只建一个 draft」的判据落在这上面,
 *  而不是某个替身记了几次调用。 */
export type DraftRecord = { draftID: string; server: string; directory: string }
const [draftTabs, setDraftTabs] = createSignal<DraftRecord[]>([])
export { draftTabs }

let navigateImpl: ((href: string) => void) | undefined
let openOnServerImpl: ((directory: string) => void) | undefined

/** 直接跳到某个 href(控制组用它复现 legacy admission 那条路由)。 */
export function navigateTo(href: string) {
  navigateImpl?.(href)
}

/** 用上游自己的 API 往**当前 server** 的项目列表里登记一个项目。 */
export function openProjectOnCurrentServer(directory: string) {
  openOnServerImpl?.(directory)
}

function ShellProbe() {
  const location = useLocation()
  const navigate = useNavigate()
  const server = useServer()
  const tabs = useTabs()
  createEffect(() => setRouterHref(`${location.pathname}${location.search}`))
  createEffect(() =>
    setDraftTabs(
      tabs.store.flatMap((tab) =>
        tab.type === "draft" ? [{ draftID: tab.draftID, server: tab.server as string, directory: tab.directory }] : [],
      ),
    ),
  )
  navigateImpl = (href) => navigate(href)
  openOnServerImpl = (directory) => server.projects.open(directory)
  onCleanup(() => {
    navigateImpl = undefined
    openOnServerImpl = undefined
  })
  return null
}

// 上游 persist 在 `platform.storage` 存在时走**异步**存储路径(utils/persist.ts),于是:
// ① tabs 的水合可以被 barrier 按住,「等 tabs.ready()」才有被考验的机会;
// ② 存储落在本模块的 Map 里而不是 localStorage —— 顺带绕开 persist 的**模块级**内存缓存,
//    每个用例都从空存储起步(此前跨用例累积 draft 的真因就是那层缓存)。
const storageCells = new Map<string, string>()

const harnessStorage = (name = "default") => ({
  getItem: async (key: string) => {
    if (key === "tabs") await tabsStorageBarrier.wait()
    return storageCells.get(`${name}:${key}`) ?? null
  },
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
}

/** 上游按端点解析响应;形状不对会触发重试退避,让叶"看起来没挂载"。 */
const FETCH_FIXTURES: Record<string, unknown> = {
  "/provider": { all: [], connected: [], default: {} },
  "/path": { state: "", config: "", worktree: DEFAULT_WORKSPACE, directory: DEFAULT_WORKSPACE, home: "/Users/tester" },
  "/project": [],
  "/project/current": { id: "prj_default", worktree: DEFAULT_WORKSPACE },
  "/session": [],
  "/agent": [],
  "/command": [],
  "/question": [],
  "/permission": [],
  "/experimental/resource": [],
  "/api/reference": [],
}

export function installPreloadStub() {
  // 形状明确的给真值(否则生产代码的 try/catch 会把"没数据"和"桥坏了"混为一谈);其余按名字
  // 分两类兜底:`on*`/`subscribe*` 返回退订函数,别的返回已 resolve 的 Promise。
  const explicit: Record<string, (...args: unknown[]) => unknown> = {
    "auth.getState": async () => ({ status: "logged-out", mode: "byok" }),
    "automations.list": async () => ({ tasks: [], state: { pausedAll: false }, loginItem: false }),
    "account.summary": async () => null,
    "contracts.health": async () => null,
    endpoints: async () => ({}),
    workspaceDefaultDir: async () => {
      await defaultWorkspaceBarrier.wait()
      return DEFAULT_WORKSPACE
    },
    "models.catalog": async () => ({
      version: "harness",
      defaultModel: null,
      tiers: {},
      platformProvider: { id: "alpha", name: "Alpha", npm: "", pico: { letter: "A", color: "#f60" } },
      platformModels: [],
      byokProviders: [],
      presetIds: [],
      liveSync: { status: "static" },
    }),
    "providers.keyStatus": async () => ({}),
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
  // 用 defineProperty 而不是直接赋值:整包跑时先跑的测试可能已经把 `window.api` 定义成
  // 只读属性,裸赋值会抛(单跑绿、整包红的那类假象)。
  Object.defineProperty(window, "api", { configurable: true, writable: true, value: node([]) })
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: ((input: RequestInfo | URL) => {
      const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url)
      const path = new URL(url).pathname
      // 事件流保持挂起(闸门不跑服务器);其余给**形状正确**的空响应 —— 形状错会让上游 query
      // 走 3 次退避重试,叶被 Suspense 压住 7 秒,那才是假的"没挂载"。
      if (path.endsWith("/event")) return new Promise(() => {})
      const body = path in FETCH_FIXTURES ? FETCH_FIXTURES[path] : {}
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
      )
    }) as unknown as typeof fetch,
  })
}

/** 侧栏把自己的 chrome Portal 挂到 `#root`;没有它,侧栏 DOM 不会进 document。 */
export function installRootHost() {
  if (document.getElementById("root")) return
  const root = document.createElement("div")
  root.id = "root"
  document.body.append(root)
}

/** 只清调用记录(挂载期的冷启动/水合噪音不该算进"这一次点击做了什么")。 */
export function resetCallLog() {
  ensureCalls.length = 0
}

export function resetHarness() {
  storageCells.clear()
  tabsStorageBarrier.release()
  defaultWorkspaceBarrier.release()
  setStore("ready", false)
  ensureCalls.length = 0
  ensureOutcome = true
  mountLog = []
  observer?.disconnect()
  observer = undefined
  setRouterHref("")
  setDraftTabs([])
}

/** `home` 不在判据上:给最小标记件,免得把首页那棵树一起拖进来。 */
const homeLeaf = () => <div data-harness-leaf="home" />

export function AlphaShell(props: { connection?: ServerConnection.Any }) {
  const connection = props.connection ?? SIDECAR_CONNECTION
  return (
    <PlatformProvider value={platform}>
      <AppBaseProviders>
        <AppInterface
          defaultServer={ServerConnection.key(connection)}
          servers={[connection]}
          router={MemoryRouter}
          disableHealthCheck
          surfaces={{
            home: homeLeaf,
            session: alphaSessionWorkspaceSurface(projects),
            newSession: (surfaceProps) => (
              <AlphaNewSession
                projects={projects}
                draftId={surfaceProps.draftId}
                promoteDraft={surfaceProps.promoteDraft}
              />
            ),
          }}
        >
          <ShellProbe />
          <AlphaSidebar projects={projects} />
          <ToastViewport />
        </AppInterface>
      </AppBaseProviders>
    </PlatformProvider>
  )
}
