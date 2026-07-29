// REQ-126 AC7(#658)壳命令处置闸门的 harness。
//
// 挂的是**真实 alpha 壳**:上游 `PlatformProvider → AppBaseProviders → AppInterface`(与
// renderer/index.tsx 同一条 provider 链、同一个 MemoryRouter),children 里挂真实生产
// `AlphaSidebar`、真实生产 `AlphaSettings` 与真实生产 `AlphaSessionSearch` —— 壳组成与
// renderer/index.tsx 一致。少挂其中任何一件,「某条命令没人注册」就会被误判成产品缺陷。
// 于是命令总线是真的、注册是生产代码真跑的、触发是**点真实按钮**、判据落在真实 DOM 与真实路由上。
//
// 替身只剩最外围:`window.api`(Electron preload 桥)、`globalThis.fetch`(壳会去连引擎,闸门不
// 跑服务器)、三片叶(不在本票射程内,给最小标记件)、以及 AlphaSettings 的 `api` seam
// (设置**内容**不是本票命题,本票只问「点了设置,设置面出没出来」)。
//
// 形制沿用 alpha-session-search-test-runtime.tsx(含 `window.api` 必须用 defineProperty 而不是
// 裸赋值 —— 整包跑时先跑的测试可能已把它定义成只读属性)。

import { AppBaseProviders, AppInterface, PlatformProvider, ServerConnection, useCommand, useTabs, type Platform } from "@opencode-ai/app"
import { MemoryRouter, useBeforeLeave, useLocation } from "@solidjs/router"
import { createEffect, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { AlphaSidebar } from "./alpha-sidebar"
import { AlphaSettings } from "../alpha-ui/settings"
import { AlphaSessionSearch } from "../alpha-ui/alpha-session-search"
import { setSettingsOpen, settingsOpen } from "../alpha-ui/settings-state"
import { PermChip } from "../alpha-ui/alpha-composer"
import { READONLY_AGENT, buildPromptRequest, composerPerm, setComposerPerm } from "../alpha-ui/composer-state"
import { setSidebarCollapsed } from "./sidebar-state"
import type { AlphaProject, AlphaProjectsApi } from "./use-projects"
import { ALPHA_SETTINGS_DEFAULTS } from "../../shared/settings-adapters"
import { hrefFor } from "../../shared/route-manifest"
import type { SettingsSurfaceApi } from "../alpha-ui/settings-authority-client"

export { render }
export { PermChip }

export const FIXTURE_DIRECTORY = "/repos/alpha-code"
export const PICKED_DIRECTORY = "/repos/picked-by-user"
export const CREATED_SESSION_ID = "ses_created"

const connection: ServerConnection.Any = {
  displayName: "Local Server",
  type: "sidecar",
  variant: "base",
  http: { url: "http://127.0.0.1:4096" },
}

const fixtureProject: AlphaProject = {
  id: "prj_alpha-code",
  worktree: FIXTURE_DIRECTORY,
  name: "alpha-code",
  directories: [FIXTURE_DIRECTORY],
  sessions: [
    { id: "ses_one", title: "已有会话", directory: FIXTURE_DIRECTORY, projectID: "prj_alpha-code", updated: 10 },
  ],
  loaded: true,
}

/* ── 可观察副作用的记录点(闸门读它们,不读源码)──────────────────────────────── */
const [pickerCalls, setPickerCalls] = createSignal(0)
const [createdIn, setCreatedIn] = createSignal<string[]>([])
const [exportedLogs, setExportedLogs] = createSignal(0)
const [routerPath, setRouterPath] = createSignal("")
/** 真实 router 收到的每一次导航请求(见 RouteProbe 的注释:为什么不能只看最终 location)。 */
const [navigationIntents, setNavigationIntents] = createSignal<string[]>([])
export { pickerCalls, createdIn, exportedLogs, routerPath, navigationIntents }

/** 该连接的 canonical serverKey(会话搜索结果的来源身份)。 */
const SERVER_KEY = ServerConnection.key(connection)

/** 目录选择器的下一次返回值:`null` = 用户取消。 */
const [pickerResult, setPickerResult] = createSignal<string | null>(PICKED_DIRECTORY)
export { setPickerResult }

/** 有项目 / 空项目两种壳:空项目态才渲染「打开项目」按钮。 */
const [hasProjects, setHasProjects] = createSignal(true)
export { setHasProjects }

const projects = {
  get store() {
    return { projects: hasProjects() ? [fixtureProject] : [], ready: true, error: false }
  },
  reload: async () => {},
  createSession: async (worktree: string) => {
    setCreatedIn((seen) => [...seen, worktree])
    return CREATED_SESSION_ID
  },
} as unknown as AlphaProjectsApi

function RouteProbe() {
  const location = useLocation()
  // 导航请求必须在这里取,不能只看 location:上游会对 legacy 会话/草稿路由立刻再 redirect 一次,
  // 中间那一站在同一个批次里就被覆盖掉,createEffect 根本看不见。
  useBeforeLeave((event) => setNavigationIntents((seen) => [...seen, String(event.to)]))
  createEffect(() => setRouterPath(`${location.pathname}${location.search}`))
  return null
}

/** 真实命令总线上此刻**确实注册**的 id —— 桌面菜单发布面按它逐条核对。 */
const [registeredCommands, setRegisteredCommands] = createSignal<string[]>([])
export { registeredCommands }

/** 上游 tabs store 里当前活着的 draft。`session.new` 的判据落在这上面(真实 store 多出一个新
 *  draft)+ 真实 router 收到去它的导航 —— 而不是某个替身记了一次调用。 */
export type DraftRecord = { draftID: string; server: string; directory: string }
const [draftTabs, setDraftTabs] = createSignal<DraftRecord[]>([])
export { draftTabs }
/** 新 draft 的落地 href,取自 alpha 路由契约的唯一事实源(route-manifest 的 `hrefFor.newSession`,
 *  与上游 `context/tabs.tsx` 的 `draftHref` 同形;route-authority ratchet 禁止在别处复刻该 URL)。 */
export const draftHref = (draftID: string) => hrefFor.newSession(draftID)

let triggerCommand: ((id: string) => void) | undefined
/** 用真实命令总线触发一个 id(桌面菜单点一下走的就是这条路)。 */
export function trigger(id: string) {
  if (!triggerCommand) throw new Error("shell is not mounted")
  triggerCommand(id)
}

function CommandProbe() {
  const command = useCommand()
  const tabs = useTabs()
  triggerCommand = (id) => command.trigger(id)
  createEffect(() => setRegisteredCommands(command.options.map((option) => option.id)))
  createEffect(() =>
    setDraftTabs(
      tabs.store.flatMap((tab) =>
        tab.type === "draft" ? [{ draftID: tab.draftID, server: tab.server as string, directory: tab.directory }] : [],
      ),
    ),
  )
  return null
}

// 上游 persist 在 `platform.storage` 存在时走**异步**存储路径(utils/persist.ts),存储落在本模块
// 的 Map 里而不是 localStorage —— 顺带绕开 persist 的**模块级**内存缓存,每个用例的 tabs 都从空
// 起步。没有这层隔离,前一条用例建过的 draft/session tab 会在下一条用例挂载时被水合回来,上游
// 随即恢复"上次的 tab" —— 壳一挂载就自行导航,后面的断言全在测残留而不是测命令。
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
  // 与 renderer/index.tsx 逐字同义:上游那几处 `settings.open` 注册都以
  // `if (platform.openSettings) return platform.openSettings()` 短路到 alpha 设置面
  // (settings-surface-ratchet 守着这条短路)。harness 少了它就会把「上游注册赢了竞争」
  // 误报成「设置打不开」—— 那是替身不忠实,不是产品缺陷。
  openSettings: () => setSettingsOpen(true),
  // `logs.export` 的可观察副作用(上游 app.tsx 全局注册的那条,alpha 不接管也不退休)。
  exportDebugLogs: async () => {
    setExportedLogs((count) => count + 1)
    return undefined as never
  },
}

/** 叶不在本闸门射程内:给最小标记件,免得把三棵叶子树一起拖进来。 */
const leaf = (name: string) => () => <div data-harness-leaf={name} />

/**
 * 设置面的**权威读**必须真的落定:设置页里那张快捷键表也是一批「指向命令」的入口(用户能改、
 * 能存),而上游只对**已注册**的命令应用自定义键位 —— 表里留一条已退休的 id,就是又一个
 * 「改完保存、按下去没反应」。让内容真渲染出来,这一格才不是空的(第一版让 read 永不落定,
 * 设置内容从未渲染,那格实际上什么也没判)。
 * 写路径不是本票命题,保持不落定。
 */
const settingsApi = {
  settings: {
    read: async () => ({ ok: true, value: structuredClone(ALPHA_SETTINGS_DEFAULTS), revision: "harness-rev" }),
    validate: () => new Promise(() => {}),
    write: () => new Promise(() => {}),
  },
  extensionStorage: {
    snapshot: () => new Promise(() => {}),
    inspect: () => new Promise(() => {}),
    collect: () => new Promise(() => {}),
  },
} as unknown as SettingsSurfaceApi

export function installPreloadStub() {
  const noop = () => () => {}
  const api = {
    auth: {
      subscribe: noop,
      onError: noop,
      getState: async () => ({ status: "logged-out", mode: "byok" }),
      start: async () => {},
      logout: async () => {},
    },
    automations: { list: async () => ({ tasks: [] }), onEvent: noop },
    account: { summary: async () => null },
    contracts: { health: async () => null, subscribe: noop },
    endpoints: async () => undefined,
    openLink: () => {},
    updater: { check: async () => {}, subscribe: noop },
    setTitlebar: async () => {},
    setBackgroundColor: async () => {},
    openDirectoryPicker: async () => {
      setPickerCalls((count) => count + 1)
      return pickerResult()
    },
  }
  Object.defineProperty(window, "api", { configurable: true, writable: true, value: api })
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: ((input: RequestInfo | URL) => {
      const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url)
      const path = new URL(url).pathname
      // 事件流保持挂起(闸门不跑服务器);其余给**形状正确**的空响应。第一版让所有请求
      // 永远挂起,结果是:一旦某条用例把真实路由带进一个会 Suspense 的上游分支(project.open
      // 那条最终 navigate 进会话路由),Solid **全局**的 transition 就永远悬着 —— 此后每一次
      // startTransition(含 `tabs.newDraft` 内部的导航)都并进这个悬置事务,永不提交。症状是
      // 下一条用例整个壳"点了没反应"且随用例顺序漂移:单跑绿、全文件红。
      if (path.endsWith("/event")) return new Promise(() => {})
      const body = path in FETCH_FIXTURES ? FETCH_FIXTURES[path] : {}
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
      )
    }) as unknown as typeof fetch,
  })
}

/** 上游按端点解析响应;形状不对会触发重试退避,叶被 Suspense 压住,"看起来没挂载"。 */
const FETCH_FIXTURES: Record<string, unknown> = {
  "/provider": { all: [], connected: [], default: {} },
  "/path": { state: "", config: "", worktree: FIXTURE_DIRECTORY, directory: FIXTURE_DIRECTORY, home: "/Users/tester" },
  "/project": [],
  "/project/current": { id: "prj_default", worktree: FIXTURE_DIRECTORY },
  "/session": [],
  "/agent": [],
  "/command": [],
  "/question": [],
  "/permission": [],
  "/experimental/resource": [],
  "/api/reference": [],
}

/** 侧栏把自己的 chrome Portal 挂到 `#root`;没有它,侧栏 DOM 不会进 document。 */
export function installRootHost() {
  if (document.getElementById("root")) return
  const root = document.createElement("div")
  root.id = "root"
  document.body.append(root)
}

export function resetHarness() {
  storageCells.clear()
  setPickerCalls(0)
  setCreatedIn([])
  setExportedLogs(0)
  setRouterPath("")
  setNavigationIntents([])
  // 侧栏折叠是模块级信号,会跨用例残留(`sidebar.toggle` 那条用例翻过它)。
  setSidebarCollapsed(false)
  setPickerResult(PICKED_DIRECTORY)
  setHasProjects(true)
  setSettingsOpen(false)
  setComposerPerm("ask")
  setRegisteredCommands([])
  setDraftTabs([])
  triggerCommand = undefined
}

function Shell(props: { sidebar?: boolean; legacySettingsEntry?: boolean }) {
  return (
    <PlatformProvider value={platform}>
      <AppBaseProviders>
        <AppInterface
          defaultServer={ServerConnection.key(connection)}
          servers={[connection]}
          router={MemoryRouter}
          disableHealthCheck
          surfaces={{ home: leaf("home"), session: leaf("session"), newSession: leaf("new-session") }}
        >
          <RouteProbe />
          <CommandProbe />
          {props.sidebar === false ? null : <AlphaSidebar projects={projects} />}
          {/* 与 renderer/index.tsx 的 settings surface 同一接法。 */}
          <AlphaSettings open={settingsOpen()} onClose={() => setSettingsOpen(false)} api={settingsApi} />
          {/* `command.palette` 的唯一注册点(#659)。壳组成必须与 renderer/index.tsx 一致 ——
              设置页快捷键表里就有这一条,少挂它会把「产品少注册了一条」误判成真。
              负对照那个壳同样不挂它(它复现的正是「alpha 壳级注册还不存在」的世界)。 */}
          {props.sidebar === false ? null : <AlphaSessionSearch projects={projects} serverKey={() => SERVER_KEY} />}
          {props.legacySettingsEntry ? <LegacySettingsEntry /> : null}
        </AppInterface>
      </AppBaseProviders>
    </PlatformProvider>
  )
}

/** 一个**按修复前那样接线**的设置入口:发上游 `settings.open`。 */
function LegacySettingsEntry() {
  const command = useCommand()
  return (
    <button type="button" data-legacy-settings-entry onClick={() => command.trigger("settings.open")}>
      legacy settings
    </button>
  )
}

/** 真实壳(侧栏 + 生产设置面),与生产入口的接法一致。 */
export function AlphaShell() {
  return <Shell />
}

/**
 * 负对照 = **本票之前的那个世界**:真实壳、首页路由,但不挂 alpha 侧栏(于是没有 alpha 的壳级
 * 注册),只放一个按旧接线发 `settings.open` 的入口。上游那三处注册全在已被 alpha 顶替的叶里,
 * legacy layout 在首页也不挂载 —— 所以这条命令全应用无人接,`run()` 静默返回,点了什么都不发生。
 * 这正是 owner 报的症状形状,也是「新接线不是空断言」的证据。
 */
export function ShellWithLegacySettingsEntryOnly() {
  return <Shell sidebar={false} legacySettingsEntry />
}

/** 权限档位 chip 的最小宿主(生产组件,零替身 —— 它已经不再依赖命令总线)。 */
export function PermChipHost() {
  return <PermChip />
}

export { READONLY_AGENT }

/**
 * 当前档位下**提交层真正会发出的** agent 参数(undefined = 不带)。权限档位的判据必须落在这里:
 * 只断言 chip 选中态是修前即绿的假闸门 —— 已退休的「全自动」档当年选得中、亮得起来,却与「询问」
 * 产出逐字节相同的请求。
 */
export function submittedAgent(): string | undefined {
  return buildPromptRequest({ text: "hi", model: null, effort: null, perm: composerPerm(), agent: null }).agent
}
