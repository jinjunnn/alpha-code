// REQ-126 CODE-F(#659)会话搜索闸门 harness。
//
// 挂的是**真实 alpha 壳**:上游 `PlatformProvider → AppBaseProviders → AppInterface`(与
// renderer/index.tsx 同一条 provider 链、同一个 MemoryRouter),children 里挂真实生产
// `AlphaSidebar` 与真实生产 `AlphaSessionSearch` —— 与入口在 `<AppInterface>` 下的接法一致。
//
// 于是命令总线是真的(上游 `CommandProvider` 由 `AppInterface` 内部的 SharedProviders 挂起)、
// 注册是生产代码真跑的、触发是**点真实侧栏按钮**、跳转是真实 `@solidjs/router` 真的走了一次。
// 替身只剩最外围三样,都不在被测命题上:
//   · `window.api` —— Electron preload 桥(侧栏挂载期真的会调它);
//   · `globalThis.fetch` —— 壳会去连引擎;闸门不跑服务器,让它静默失败而不是刷满 ECONNREFUSED;
//   · `surfaces` 三个叶 —— 叶不在本闸门射程内(本票只管壳),给最小标记件即可;
//     跳转判据因此落在**真实路由的 location** 上,而不是叶渲染了什么。

import { AppBaseProviders, AppInterface, PlatformProvider, ServerConnection, type Platform } from "@opencode-ai/app"
import { MemoryRouter, useLocation } from "@solidjs/router"
import { createEffect, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { AlphaSessionSearch } from "./alpha-session-search"
import { AlphaSidebar } from "../sidebar/alpha-sidebar"
import type { AlphaProject, AlphaProjectsApi } from "../sidebar/use-projects"

export { render }

export const SIDECAR_SERVER_KEY = "sidecar"
export const WSL_SERVER_KEY = "wsl:Ubuntu"
export const FIXTURE_DIRECTORY = "/repos/alpha-code"

const project = (name: string, worktree: string, sessions: AlphaProject["sessions"]): AlphaProject => ({
  id: `prj_${name}`,
  worktree,
  name,
  directories: [worktree],
  sessions,
  loaded: true,
})

export const FIXTURE_PROJECTS: AlphaProject[] = [
  project("alpha-code", FIXTURE_DIRECTORY, [
    { id: "ses_old", title: "架构说明整理", directory: FIXTURE_DIRECTORY, projectID: "prj_alpha-code", updated: 10 },
    { id: "ses_new", title: "整理架构图", directory: FIXTURE_DIRECTORY, projectID: "prj_alpha-code", updated: 30 },
  ]),
  project("alpha-web", "/repos/alpha-web", [
    { id: "ses_web", title: "Landing page copy", directory: "/repos/alpha-web", projectID: "prj_alpha-web", updated: 20 },
  ]),
]

/** 只喂壳真正读的那一面(store);本闸门路径不触达其余 API。 */
const projects = {
  store: { projects: FIXTURE_PROJECTS, ready: true, error: false },
  reload: async () => {},
} as unknown as AlphaProjectsApi

const connection: ServerConnection.Any = {
  displayName: "Local Server",
  type: "sidecar",
  variant: "base",
  http: { url: "http://127.0.0.1:4096" },
}

const [serverKey, setServerKey] = createSignal<string | undefined>(SIDECAR_SERVER_KEY)
export { setServerKey }

/** 真实路由的当前位置 —— 跳转判据读它,而不是读某个替身记录下来的字符串。 */
const [routerPath, setRouterPath] = createSignal("")
export { routerPath }

function RouteProbe() {
  const location = useLocation()
  createEffect(() => setRouterPath(location.pathname))
  return null
}

const platform: Platform = {
  platform: "desktop",
  os: "macos",
  openLink: () => {},
  restart: async () => {},
  back: () => {},
  forward: () => {},
  notify: async () => {},
  openDirectoryPickerDialog: async () => ({ paths: [] }) as never,
}

/** 叶不在本闸门射程内:给最小标记件,免得把三棵叶子树一起拖进来。 */
const leaf = (name: string) => () => <div data-harness-leaf={name} />

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
  }
  // 用 defineProperty 而不是直接赋值:整包跑时先跑的测试可能已经把 `window.api` 定义成
  // 只读属性,裸赋值会抛(单跑绿、整包红的那类假象)。
  Object.defineProperty(window, "api", { configurable: true, writable: true, value: api })
  // 壳会去连引擎;闸门不跑服务器 —— 静默失败即可,别刷满 ECONNREFUSED 噪音。
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: (() => new Promise(() => {})) as typeof fetch,
  })
}

/** 侧栏把自己的 chrome Portal 挂到 `#root`;没有它,侧栏 DOM 不会进 document。 */
export function installRootHost() {
  if (document.getElementById("root")) return
  const root = document.createElement("div")
  root.id = "root"
  document.body.append(root)
}

export function resetHarness() {
  setServerKey(SIDECAR_SERVER_KEY)
  setRouterPath("")
}

function Shell(props: { search?: boolean }) {
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
          {/* #925:侧栏与搜索同源 —— 都消费 projects store 连着的那个 server 的 key。 */}
          <AlphaSidebar projects={projects} serverKey={serverKey} />
          {props.search === false ? null : <AlphaSessionSearch projects={projects} serverKey={serverKey} />}
        </AppInterface>
      </AppBaseProviders>
    </PlatformProvider>
  )
}

/** 真实壳(侧栏 + 会话搜索),与生产入口的接法一致。 */
export function AlphaShell() {
  return <Shell />
}

/**
 * 负对照:同一个真实壳、同一个真实侧栏按钮,只是**不挂**会话搜索件 —— 这就是本票修复前的
 * 全应用状态(`command.palette` 无人注册,`run()` 静默返回)。
 */
export function ShellWithoutSearch() {
  return <Shell search={false} />
}
