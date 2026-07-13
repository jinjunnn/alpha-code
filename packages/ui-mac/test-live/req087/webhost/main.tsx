// REQ-088 T3/T4 live-comparison web host(Issue alpha-code#181)。
//
// 目的:在与 C2 legacy 基线**同一运行态**(vite dev web + 真 serve 引擎 + 真 Chromium)下,
// 让 adapter(AlphaSessionWorkspace)与 legacy(上游默认叶)可以在同一 host 内由双闸翻转对比。
//
// 通道合法性(spike §4 结论的 web 侧对应):
//   - 冻结的 packages/app/src/entry.tsx 挂 AppInterface 时**不传 surfaces**,因此「web 运行态注入
//     alpha surface」在冻结入口上不存在 —— 不改冻结文件的唯一合法通道是:本 host(alpha 自有文件)
//     用 @opencode-ai/app 包根**公开导出**(AppInterface/AppBaseProviders/PlatformProvider/
//     ServerConnection,与 ui-mac renderer/index.tsx 同一消费面)自行挂载,并经公开 `surfaces`
//     prop 注入真 AlphaSessionWorkspace(REQ-088 T2 正式组件,含 chrome/CrossServerGuard/
//     SurfaceBoundary/C1 窄导出叶)。窄导出消费点不变(仍是 alpha-session-workspace.tsx)。
//   - 除 surfaces 注入与末尾注明的两处偏差外,本文件逐段复刻冻结 entry.tsx 的 web Platform 与
//     挂载参数(defaultServer/canonicalLocalServer/servers/disableHealthCheck),保证 legacy 半边
//     行为与 C2 基线运行态一致。
//
// 双闸语义(与生产一致,「加载时解析一次、不热切换」):
//   - localStorage["ALPHA_SESSION_SPIKE"]="1"(harness 在 adapter 模式经 addInitScript 预置)
//     ⇒ alphaSessionWorkspaceSurface() 返回组件 ⇒ surfaces.session 注入;
//   - 闸关 ⇒ 工厂返回 undefined ⇒ surfaces.session 未注入 ⇒ seam 走上游默认叶(严格零变化)。
//   生产的另一道闸(主进程 ALPHA_SURFACE_SESSION env-override → resolved.session.mode)在本 host
//   由「哪个测试运行注入 localStorage」代位 —— 每次运行只测一种模式,harness 负责翻转。
//
// 与冻结 entry.tsx 的两处显式偏差(均不在 adapter-vs-legacy 差异面上,两半边同受影响):
//   1. 不含 Sentry 分支(冻结入口仅在 VITE_SENTRY_DSN 设置时初始化;harness 不设置 ⇒ 行为等价);
//   2. 不含 auth_token 解析(harness 从不带 auth;authToken 恒 false 与冻结入口无 token 路径等价)。
// 另:window.api 兜底为空对象 —— SurfaceBoundary 的 fatal fallback 会触碰
// `window.api.surfaces?.reportFailure`(Electron preload 面),web 下无 preload;空对象让
// 可选链短路,fatal 链路仍可渲染(仅上报 no-op,与「记录」缺失一并在证据档披露)。

import { render } from "solid-js/web"
import {
  AppBaseProviders,
  AppInterface,
  type AppSurfaces,
  type Platform,
  PlatformProvider,
  ServerConnection,
} from "@opencode-ai/app"
import { handleNotificationClick } from "@opencode-ai/app"
import { alphaSessionWorkspaceSurface } from "../../../src/renderer/alpha-ui/session-workspace/alpha-session-workspace"

// SurfaceBoundary fatal fallback 的 preload 触点兜底(见头注释)。
;(window as unknown as { api?: object }).api ??= {}

const DEFAULT_SERVER_URL_KEY = "opencode.settings.dat:defaultServerUrl"

const getStorage = (key: string) => {
  if (typeof localStorage === "undefined") return null
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const setStorage = (key: string, value: string | null) => {
  if (typeof localStorage === "undefined") return
  try {
    if (value !== null) {
      localStorage.setItem(key, value)
      return
    }
    localStorage.removeItem(key)
  } catch {
    return
  }
}

const readDefaultServerUrl = () => getStorage(DEFAULT_SERVER_URL_KEY)
const writeDefaultServerUrl = (url: string | null) => setStorage(DEFAULT_SERVER_URL_KEY, url)

const notify: Platform["notify"] = async (title, description, href) => {
  if (!("Notification" in window)) return

  const permission =
    Notification.permission === "default"
      ? await Notification.requestPermission().catch(() => "denied")
      : Notification.permission

  if (permission !== "granted") return

  const inView = document.visibilityState === "visible" && document.hasFocus()
  if (inView) return

  const notification = new Notification(title, {
    body: description ?? "",
    icon: "https://opencode.ai/favicon-96x96-v3.png",
  })

  notification.onclick = () => {
    handleNotificationClick(href)
    notification.close()
  }
}

const openLink: Platform["openLink"] = (url) => {
  window.open(url, "_blank")
}

const back: Platform["back"] = () => {
  window.history.back()
}

const forward: Platform["forward"] = () => {
  window.history.forward()
}

const restart: Platform["restart"] = async () => {
  window.location.reload()
}

const root = document.getElementById("root")
if (!(root instanceof HTMLElement) && import.meta.env.DEV) {
  throw new Error("root element not found")
}

const getCurrentUrl = () => {
  if (location.hostname.includes("opencode.ai")) return "http://localhost:4096"
  if (import.meta.env.DEV)
    return `http://${import.meta.env.VITE_OPENCODE_SERVER_HOST ?? "localhost"}:${import.meta.env.VITE_OPENCODE_SERVER_PORT ?? "4096"}`
  return location.origin
}

const getDefaultUrl = () => {
  const lsDefault = readDefaultServerUrl()
  if (lsDefault) return lsDefault
  return getCurrentUrl()
}

const platform: Platform = {
  platform: "web",
  version: "req088-live-comparison",
  openLink,
  back,
  forward,
  restart,
  notify,
  getDefaultServer: async () => {
    const stored = readDefaultServerUrl()
    return stored ? ServerConnection.Key.make(stored) : null
  },
  setDefaultServer: writeDefaultServerUrl,
}

if (root instanceof HTMLElement) {
  const server: ServerConnection.Http = {
    type: "http",
    authToken: false,
    http: {
      url: getCurrentUrl(),
    },
  }
  // 与 ui-mac renderer/index.tsx surfaceComponents 同语义:挂载前一次性解析;闸关 ⇒ 不注入。
  const surfaces: AppSurfaces = {}
  const sessionSurface = alphaSessionWorkspaceSurface()
  if (sessionSurface) surfaces.session = sessionSurface
  render(
    () => (
      <PlatformProvider value={platform}>
        <AppBaseProviders>
          <AppInterface
            defaultServer={ServerConnection.Key.make(getDefaultUrl())}
            canonicalLocalServer={ServerConnection.key(server)}
            servers={[server]}
            disableHealthCheck
            surfaces={surfaces}
          />
        </AppBaseProviders>
      </PlatformProvider>
    ),
    root,
  )
}
