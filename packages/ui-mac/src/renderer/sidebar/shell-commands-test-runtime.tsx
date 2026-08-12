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
import { MemoryRouter, useBeforeLeave, useLocation, useNavigate } from "@solidjs/router"
import { createEffect, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { AlphaSidebar } from "./alpha-sidebar"
import { AlphaSettings } from "../alpha-ui/settings"
import { AlphaSessionSearch } from "../alpha-ui/alpha-session-search"
import { setSettingsOpen, settingsOpen } from "../alpha-ui/settings-state"
import { PermChip } from "../alpha-ui/alpha-composer"
import { READONLY_AGENT, buildPromptRequest, composerPerm, setComposerPerm } from "../alpha-ui/composer-state"
import { setSidebarCollapsed, setProjectExpanded, markSessionViewed } from "./sidebar-state"
import { AutomationPanel } from "../automations/automation-panel"
import { setAutomationOpen } from "../automations/automation-state"
import type { AlphaProject, AlphaProjectsApi } from "./use-projects"
import { ALPHA_SETTINGS_DEFAULTS } from "../../shared/settings-adapters"
import { hrefFor } from "../../shared/route-manifest"
import type { SettingsSurfaceApi } from "../alpha-ui/settings-authority-client"

export { render }
export { PermChip }

export const FIXTURE_DIRECTORY = "/repos/alpha-code"
export const PICKED_DIRECTORY = "/repos/picked-by-user"
export const CREATED_SESSION_ID = "ses_created"
/** #925:draft 晋升探针交给上游 `promoteDraft` 的会话 id(与 CREATED_SESSION_ID 相异,免得
 *  两条判据互相蒙混)。 */
export const PROMOTED_SESSION_ID = "ses_promoted"
/** #925:自动化 run 记录里的会话 id。 */
export const AUTOMATION_SESSION_ID = "ses_auto_run"

const connection: ServerConnection.Any = {
  displayName: "Local Server",
  type: "sidecar",
  variant: "base",
  http: { url: "http://127.0.0.1:4096" },
}

/* ── #925:多 server 配置 ────────────────────────────────────────────────────────
   legacy sessionHref 那一类缺陷只在「active server ≠ 会话真正所在的 server」时可见,单 server
   壳结构上测不出它。这里给三台互不相同的 WSL 连接(key 分别是 wsl:ubuntu / wsl:fedora /
   wsl:arch),按用例组合成不同的 {active, projects} 对 —— 各用例**点击那一刻**的 projects key
   互不相同,把 href 写死成任何单个字面量的实现无法同时满足(#894 R1 审计那条形态⑨)。 */
const wslUbuntu: ServerConnection.Any = {
  displayName: "WSL Ubuntu",
  type: "sidecar",
  variant: "wsl",
  distro: "ubuntu",
  http: { url: "http://127.0.0.1:5096" },
}
const wslFedora: ServerConnection.Any = {
  displayName: "WSL Fedora",
  type: "sidecar",
  variant: "wsl",
  distro: "fedora",
  http: { url: "http://127.0.0.1:6096" },
}
const wslArch: ServerConnection.Any = {
  displayName: "WSL Arch",
  type: "sidecar",
  variant: "wsl",
  distro: "arch",
  http: { url: "http://127.0.0.1:7096" },
}

/** #933:emitSessionIdle 的驱动端参数(从哪台 server 的事件流发)。判据侧的 server key 锚点
 *  仍是测试文件里的独立字面量,不从这里读。 */
export const SIDECAR_URL = connection.http.url
export const WSL_UBUNTU_URL = wslUbuntu.http.url
export const WSL_ARCH_URL = wslArch.http.url

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

/** #925:展开侧栏里某个项目(生产状态函数;会话行只在展开后渲染)。 */
export function expandProject(worktree: string) {
  setProjectExpanded(worktree, true)
}

/** #925:打开自动化面板(生产模块信号;面板本体与「回跳会话」按钮都是生产组件)。 */
export function openAutomationPanel() {
  setAutomationOpen(true)
}

/** #925:自动化任务夹具 —— 一条已完成的 run,带会话 id(「回跳会话」按钮的渲染条件)。 */
const automationTaskFixture = {
  id: "auto-1",
  name: "夜间总结",
  nlText: "每天 21 点总结当天工作",
  schedule: { kind: "cron", expr: "0 21 * * *" },
  target: { projectDir: FIXTURE_DIRECTORY, agent: "alpha-automation" },
  prompt: "总结当天工作",
  execution: "local",
  permissionProfile: "readonly",
  budget: { maxDurationMin: 30 },
  overlapPolicy: "skip",
  catchUpPolicy: "skip",
  notify: { system: true },
  enabled: true,
  createdAt: "2026-08-10T21:00:00.000Z",
  lastRun: { at: "2026-08-10T21:00:00.000Z", status: "ok", sessionID: AUTOMATION_SESSION_ID, summary: "已完成" },
  history: [{ at: "2026-08-10T21:00:00.000Z", status: "ok", sessionID: AUTOMATION_SESSION_ID, summary: "已完成" }],
  nextFireAt: null,
  running: false,
}

function RouteProbe() {
  const location = useLocation()
  const navigate = useNavigate()
  // 导航请求必须在这里取,不能只看 location:上游会对 legacy 会话/草稿路由立刻再 redirect 一次,
  // 中间那一站在同一个批次里就被覆盖掉,createEffect 根本看不见。
  useBeforeLeave((event) => setNavigationIntents((seen) => [...seen, String(event.to)]))
  createEffect(() => setRouterPath(`${location.pathname}${location.search}`))
  // #933:让用例能把真实 router 开到任意 href(存量 legacy URL / 别台 server 的 canonical 路由),
  // 复现「点了升级前的 OS 通知 / 经上游标签页打开别台机器的会话」。必须经**真实 DOM 点击**进
  // Solid 的事件派发(与生产的点击同一条执行上下文):从测试代码裸调 `navigate()` 没有 owner,
  // 会让 AppInterface 的 children 整棵重挂(实测每导航一次 sidebar 重挂一次、多出一个 draft)。
  return (
    <button
      type="button"
      data-harness-navigate
      style={{ display: "none" }}
      onClick={() => {
        if (pendingNavigateHref) navigate(pendingNavigateHref)
      }}
    />
  )
}

let pendingNavigateHref: string | undefined
/** 把真实 router 开到 href(见 RouteProbe)。 */
export function navigateTo(href: string) {
  const probe = document.querySelector<HTMLButtonElement>("[data-harness-navigate]")
  if (!probe) throw new Error("shell is not mounted")
  pendingNavigateHref = href
  try {
    probe.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
  } finally {
    pendingNavigateHref = undefined
  }
}

/** #933:被交给 OS 通知层(platform.notify)的每一条 —— 用户点通知后会去的就是这个 href。 */
export type OsNotification = { title: string; description?: string; href?: string }
const [osNotifications, setOsNotifications] = createSignal<OsNotification[]>([])
export { osNotifications }

/** #933:通知用例的会话 id(`/session/{id}` fixture 配套)。 */
export const NOTIFIED_SESSION_ID = "ses_noti"

/* ── #933:可控的 `/global/event` SSE 流,按 server 端口区分 ───────────────────────
   每台 server 的 ServerSDK 都对自己的 baseUrl 开一条事件流;fixture 按**端口**把流的写端存起来,
   用例便可从指定的那台 server 发一条真事件 —— 之后跑的全是生产代码(server-sdk 的 SSE 解析、
   合流、notification context 的 lookup 与 platform.notify)。 */
const sseWriters = new Map<string, (frame: string) => void>()

/** 那台 server 的事件流是否已被生产代码连上(emit 前用它等,不猜时长)。 */
export function hasEventStream(serverUrl: string) {
  return sseWriters.has(new URL(serverUrl).port)
}

/** 从 `serverUrl`(如 "http://127.0.0.1:4096")那台 server 的事件流发一条 session.idle。 */
export function emitSessionIdle(serverUrl: string, directory: string, sessionID: string) {
  const port = new URL(serverUrl).port
  const write = sseWriters.get(port)
  if (!write) throw new Error(`no event stream connected for port ${port}`)
  write(`data: ${JSON.stringify({ directory, payload: { type: "session.idle", properties: { sessionID } } })}\n\n`)
}

/** #933:预置某会话的已读水位(生产 sidebar-state),让未读点有一个可观察的「在/不在」。 */
export function seedSessionViewed(id: string, updated: number) {
  markSessionViewed(id, updated)
}

/** 真实命令总线上此刻**确实注册**的 id —— 桌面菜单发布面按它逐条核对。 */
const [registeredCommands, setRegisteredCommands] = createSignal<string[]>([])
export { registeredCommands }

/** 上游 tabs store 里当前活着的 draft。`session.new` 的判据落在这上面(真实 store 多出一个新
 *  draft)+ 真实 router 收到去它的导航 —— 而不是某个替身记了一次调用。 */
export type DraftRecord = { draftID: string; server: string; directory: string }
const [draftTabs, setDraftTabs] = createSignal<DraftRecord[]>([])
export { draftTabs }

/** #933:上游 tabs store 里当前的 session tab(legacySessionServer 反推消费的就是这份)。 */
export type SessionTabRecord = { server: string; sessionId: string }
const [sessionTabs, setSessionTabs] = createSignal<SessionTabRecord[]>([])
export { sessionTabs }

let addSessionTabFn: ((server: string, sessionId: string) => void) | undefined
/** #933:经上游生产 `tabs.addSessionTab` 在指定 server 上落一个 session tab(不导航)——
 *  复现「用户曾在那台机器上开过这条会话」的持久化痕迹。 */
export function openSessionTab(serverKey: string, sessionId: string) {
  if (!addSessionTabFn) throw new Error("shell is not mounted")
  addSessionTabFn(serverKey, sessionId)
}
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
  addSessionTabFn = (server, sessionId) => tabs.addSessionTab({ server: ServerConnection.Key.make(server), sessionId })
  createEffect(() => setRegisteredCommands(command.options.map((option) => option.id)))
  createEffect(() =>
    setDraftTabs(
      tabs.store.flatMap((tab) =>
        tab.type === "draft" ? [{ draftID: tab.draftID, server: tab.server as string, directory: tab.directory }] : [],
      ),
    ),
  )
  createEffect(() =>
    setSessionTabs(
      tabs.store.flatMap((tab) =>
        tab.type === "session" ? [{ server: tab.server as string, sessionId: tab.sessionId }] : [],
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
  // #933:生产里这个 href 原样交给 OS 通知的 onclick → handleNotificationClick(href) → router。
  // 记录它 = 记录「用户点通知会落到哪」。
  notify: async (title: string, description?: string, href?: string) => {
    setOsNotifications((seen) => [...seen, { title, description, href }])
  },
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

/** #925:新对话叶的最小探针。`promoteDraft` 这个 prop 是**上游生产 wrapper**
 *  (packages/app/src/app.tsx createDraftRoute)交下来的 —— 点这个按钮走的是真实
 *  tabs.promoteDraft:真实 tab 交换 + 真实导航(tabHref 按 tab.server 拼 canonical 路由)。
 *  叶只发起,判据落在真实 router 收到的落点上。 */
const NewSessionPromoteProbe = (props: {
  draftId: string
  promoteDraft: (session: { directory: string; sessionId: string }) => void
}) => (
  <div data-harness-leaf="new-session">
    <button
      type="button"
      data-harness-promote
      onClick={() => props.promoteDraft({ directory: FIXTURE_DIRECTORY, sessionId: PROMOTED_SESSION_ID })}
    >
      promote
    </button>
  </div>
)

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
    automations: {
      // #925:完整形状(list 消费 r.state.pausedAll / r.loginItem);一条带 run 历史的任务,
      // 「回跳会话」用例点的就是它。
      list: async () => ({ tasks: [automationTaskFixture], state: { pausedAll: false }, loginItem: false }),
      onEvent: noop,
    },
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
      // #933:`/global/event` 变成可控 SSE 流(按端口存写端,emitSessionIdle 用);其余事件端点
      // 维持挂起。流保持打开(生产的重连逻辑不被触发),Response 走标准 ReadableStream。
      if (path === "/global/event") {
        const port = new URL(url).port
        const encoder = new TextEncoder()
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            sseWriters.set(port, (frame) => controller.enqueue(encoder.encode(frame)))
          },
        })
        return Promise.resolve(
          new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
        )
      }
      if (path.endsWith("/event")) return new Promise(() => {})
      // #933:session.sync 会顺带拉消息/子会话/todo/diff,这些端点按契约回**数组**;回 {} 会让
      // 上游 `.filter` 直接 TypeError,lookup 静默失败。
      const listShaped = /^\/session\/[^/]+\/(message|children|todo|diff)$/.test(path)
      const body = path in FETCH_FIXTURES ? FETCH_FIXTURES[path] : listShaped ? [] : {}
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
  // #933:测试里会被真实路由/事件解析到的会话逐个给形状正确的响应 —— 上游对形状不对的响应
  // 走重试退避,叶被 Suspense 压住之后,**后续所有导航都并进悬置事务、静默丢失**(见上面
  // fetch stub 的注释;这里少一条 fixture 的症状就是"navigateTo 点了没反应")。
  "/session/ses_noti": {
    id: "ses_noti",
    projectID: "prj_alpha-code",
    directory: FIXTURE_DIRECTORY,
    title: "通知会话",
    version: "0",
    time: { created: 1, updated: 1 },
  },
  // #933:ghost 用例的关键夹具 —— **active server 的引擎里恰好有一条同 id 的无关会话**
  // (跨机器撞 id 的形状)。它不在任何 tab 里;反推兜底若按 active 猜,打开的就是这一条。
  // 没有这个夹具,错误落点的路由会被 Suspense 压住永不提交,判据两个方向都绿(实测)。
  "/session/ses_ghost": {
    id: "ses_ghost",
    projectID: "prj_alpha-code",
    directory: FIXTURE_DIRECTORY,
    title: "别台机器上的无关会话",
    version: "0",
    time: { created: 1, updated: 1 },
  },
  "/session/ses_tab_only": {
    id: "ses_tab_only",
    projectID: "prj_alpha-code",
    directory: FIXTURE_DIRECTORY,
    title: "只在 tab 里的会话",
    version: "0",
    time: { created: 1, updated: 1 },
  },
  // #933 R1 Minor 1(单机放行用例):升级前通知指的会话 —— 引擎里有,tabs 里从来没有。
  "/session/ses_solo": {
    id: "ses_solo",
    projectID: "prj_alpha-code",
    directory: FIXTURE_DIRECTORY,
    title: "单机上从未开过标签页的会话",
    version: "0",
    time: { created: 1, updated: 1 },
  },
  "/session/ses_one": {
    id: "ses_one",
    projectID: "prj_alpha-code",
    directory: FIXTURE_DIRECTORY,
    title: "已有会话",
    version: "0",
    time: { created: 1, updated: 10 },
  },
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
  // #925:自动化面板的开合是模块级信号,跨用例残留。
  setAutomationOpen(false)
  triggerCommand = undefined
  // #933:OS 通知记录与 SSE 写端都跨用例残留。
  addSessionTabFn = undefined
  setOsNotifications([])
  setSessionTabs([])
  sseWriters.clear()
}

function Shell(props: {
  sidebar?: boolean
  legacySettingsEntry?: boolean
  /** #925:壳里挂的全部连接;缺省 = 单 sidecar(既有用例的世界)。 */
  servers?: ServerConnection.Any[]
  /** #925:active(default)server;缺省 sidecar。 */
  activeServer?: ServerConnection.Any
  /** #925:`projects` 这份 store「连着」的 server —— 生产里 `projectsServerKey` 反查出来的那台。 */
  projectsServer?: ServerConnection.Any
}) {
  const servers = props.servers ?? [connection]
  const active = props.activeServer ?? connection
  const projectsServer = props.projectsServer ?? connection
  // 与生产同构:serverKey 是「由连接算 key」的 accessor(renderer/index.tsx 的 projectsServerKey);
  // 判据侧的锚点用独立字面量,不读这里(否则是自指等价链)。
  const projectsServerKey = () => ServerConnection.key(projectsServer)
  return (
    <PlatformProvider value={platform}>
      <AppBaseProviders>
        <AppInterface
          defaultServer={ServerConnection.key(active)}
          servers={servers}
          router={MemoryRouter}
          disableHealthCheck
          surfaces={{ home: leaf("home"), session: leaf("session"), newSession: NewSessionPromoteProbe }}
        >
          <RouteProbe />
          <CommandProbe />
          {props.sidebar === false ? null : <AlphaSidebar projects={projects} serverKey={projectsServerKey} />}
          {/* 与 renderer/index.tsx 的 settings surface 同一接法。 */}
          <AlphaSettings open={settingsOpen()} onClose={() => setSettingsOpen(false)} api={settingsApi} />
          {/* `command.palette` 的唯一注册点(#659)。壳组成必须与 renderer/index.tsx 一致 ——
              设置页快捷键表里就有这一条,少挂它会把「产品少注册了一条」误判成真。
              负对照那个壳同样不挂它(它复现的正是「alpha 壳级注册还不存在」的世界)。 */}
          {props.sidebar === false ? null : <AlphaSessionSearch projects={projects} serverKey={projectsServerKey} />}
          {/* #925:自动化面板与生产同构地挂在壳上(renderer/index.tsx),「回跳会话」用例点它。 */}
          {props.sidebar === false ? null : <AutomationPanel serverKey={projectsServerKey} />}
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

/* ── #925:多 server 壳 ─────────────────────────────────────────────────────────
   三个变体的 {active, projects} 对各不相同,且 projects key 三者互异("sidecar" /
   "wsl:fedora" / "wsl:arch")—— 判据锚在各自的独立字面量上,写死任何单值的实现无法全绿。 */

/** active = wsl:ubuntu,projects store 连的是本地 sidecar("sidecar")。 */
export function AlphaShellRemoteActive() {
  return <Shell servers={[connection, wslUbuntu]} activeServer={wslUbuntu} projectsServer={connection} />
}

/** active = sidecar,projects store 连的是 wsl:fedora。 */
export function AlphaShellRemoteProjects() {
  return <Shell servers={[connection, wslFedora]} activeServer={connection} projectsServer={wslFedora} />
}

/** active = wsl:ubuntu,projects store 连的是 wsl:arch(自动化「回跳会话」用例)。 */
export function AlphaShellAutomationRemote() {
  return <Shell servers={[wslUbuntu, wslArch]} activeServer={wslUbuntu} projectsServer={wslArch} />
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
