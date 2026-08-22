import windowState from "electron-window-state"
import { resolveThemeVariant } from "@opencode-ai/ui/theme/resolve"
import type { DesktopTheme } from "@opencode-ai/ui/theme/types"
import oc2ThemeJson from "../../../ui/src/theme/themes/oc-2.json"
import { app, BrowserWindow, dialog, net, nativeImage, nativeTheme, protocol, shell, type WebContents } from "electron"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { TitlebarTheme } from "../preload/types"
import { trackDeepLinkRenderer } from "./deep-links"
import { exportDebugLogs, write as writeLog } from "./logging"
import { cspPlatformEligible } from "./platform"
import { corsRelaxAllowed, createAlphaOriginRegistry, RENDERER_CSP } from "./renderer-security"
import { HTML_PREVIEW_SCHEME } from "../shared/html-preview"
import { safeErrorName, safeRouteLabel } from "./renderer-diagnostic-redaction"
import { getStore } from "./store"
import { PINCH_ZOOM_ENABLED_KEY } from "./store-keys"
import { createUnresponsiveSampler } from "./unresponsive"
import { markStartupTimeline } from "./startup-timeline"

const root = dirname(fileURLToPath(import.meta.url))
const rendererRoot = join(root, "../renderer")
const rendererProtocol = "oc"
const rendererHost = "renderer"
const clipboardWritePermission = "clipboard-sanitized-write"
const notificationPermission = "notifications"
const rendererPermissions = new Set([clipboardWritePermission, notificationPermission])
const recoveryWebContents = new WeakSet<WebContents>()
const oc2Theme = oc2ThemeJson as DesktopTheme
const oc2Background = {
  light: resolveThemeVariant(oc2Theme.light, false)["background-base"],
  dark: resolveThemeVariant(oc2Theme.dark, true)["background-base"],
}
const documentPolicyHeader = "Document-Policy"
const jsCallStacksDocumentPolicy = "include-js-call-stacks-in-crash-reports"

// C24:CORS 放宽收敛 + 打包态 CSP(纯逻辑在 renderer-security.ts)。CSP 仅打包态注入(dev 的
// vite/HMR 需要宽松环境);平台资格经 seam(darwin 原状 + win32 纳入,ADR-026 §5 加固面对齐;
// WSL 非回环地址风险与真机批验证注记见 platform/index.cspPlatformEligible);逃生 ALPHA_CSP_DISABLE=1。
const rendererCsp = RENDERER_CSP
const shouldInjectCsp = () => app.isPackaged && cspPlatformEligible() && process.env.ALPHA_CSP_DISABLE !== "1"

// #898(SEC):唯一的 registered-origin 集合实例,只活在本模块闭包里 —— 从不经 preload/ipc.ts
// 暴露写入口,renderer/扩展代码结构上无法自行注册。当前没有任何调用方往里 register(内嵌
// sidecar 与 WSL 远端 sidecar 今天都只用 127.0.0.1 回环地址,已被 isLoopbackUrl 覆盖),留空
// 即是默认拒:win32 上未注册的非回环 origin 不再拿到 ACAO。将来若出现需要放宽的非回环
// Alpha 服务(例如真正的 WSL 远端地址),由该服务自己的启动/健康检查/退出路径调用
// registry.register/revoke,不得走 IPC 让 renderer 决定放行谁。
const alphaOriginRegistry = createAlphaOriginRegistry()

protocol.registerSchemesAsPrivileged([
  {
    scheme: rendererProtocol,
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
    },
  },
  // REQ-096(#188):隔离 HTML preview 的一次性静态 host scheme。registerSchemesAsPrivileged
  // 全应用只允许调用一次,故在此挂载;仅 standard(host/相对路径解析必需)—— 不给 secure、
  // 不给 supportFetchAPI,能力面最小化。handler 本体按 preview session 注册于 html-preview-host.ts。
  { scheme: HTML_PREVIEW_SCHEME, privileges: { standard: true } },
])

let backgroundColor: string | undefined
let relaunchHandler = () => {
  app.relaunch()
  app.exit(0)
}
const titlebarThemes = new WeakMap<BrowserWindow, Partial<TitlebarTheme>>()
const pinchZoomEnabled = new WeakMap<BrowserWindow, boolean>()
const titlebarHeight = 40
const maxZoomLevel = 10
const minZoomLevel = 0.2

export function setRelaunchHandler(handler: () => void) {
  relaunchHandler = handler
}

export function setBackgroundColor(color: string) {
  backgroundColor = color
  BrowserWindow.getAllWindows().forEach((win) => win.setBackgroundColor(color))
}

export function getBackgroundColor(): string | undefined {
  return backgroundColor
}

function iconsDir() {
  return app.isPackaged ? join(process.resourcesPath, "icons") : join(root, "../../resources/icons")
}

function iconPath() {
  const ext = process.platform === "win32" ? "ico" : "png"
  return join(iconsDir(), `icon.${ext}`)
}

function tone() {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light"
}

function defaultBackgroundColor() {
  return oc2Background[tone()]
}

function overlay(theme: Partial<TitlebarTheme> = {}, zoom = 1) {
  const mode = theme.mode ?? tone()
  return {
    color: "#00000000",
    symbolColor: mode === "dark" ? "white" : "black",
    height: Math.max(titlebarHeight, Math.round(titlebarHeight * zoom)),
  }
}

export function setTitlebar(win: BrowserWindow, theme: Partial<TitlebarTheme> = {}) {
  titlebarThemes.set(win, theme)
  updateTitlebar(win)
}

export function updateTitlebar(win: BrowserWindow) {
  if (process.platform !== "win32") return
  win.setTitleBarOverlay(overlay(titlebarThemes.get(win), win.webContents.getZoomFactor()))
}

export function setPinchZoomEnabled(enabled: boolean) {
  getStore().set(PINCH_ZOOM_ENABLED_KEY, enabled)
  for (const win of BrowserWindow.getAllWindows()) {
    pinchZoomEnabled.set(win, enabled)
    win.webContents.send("pinch-zoom-enabled-changed", enabled)
    if (!enabled && win.webContents.getZoomFactor() !== 1) win.webContents.setZoomFactor(1)
    updateZoom(win)
  }
}

export function getPinchZoomEnabled() {
  return getStore().get(PINCH_ZOOM_ENABLED_KEY) === true
}

export function setDockIcon() {
  if (process.platform !== "darwin") return
  const icon = nativeImage.createFromPath(join(iconsDir(), "dock.png"))
  if (!icon.isEmpty()) app.dock?.setIcon(icon)
}

export function createMainWindow() {
  const state = windowState({
    defaultWidth: 1280,
    defaultHeight: 800,
  })

  const mode = tone()
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    show: false,
    autoHideMenuBar: true,
    title: "alpha-code",
    icon: iconPath(),
    backgroundColor: backgroundColor ?? defaultBackgroundColor(),
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hidden" as const,
          trafficLightPosition: { x: 12, y: 14 },
        }
      : {}),
    ...(process.platform === "win32"
      ? {
          frame: false,
          titleBarStyle: "hidden" as const,
          titleBarOverlay: overlay({ mode }),
        }
      : {}),
    webPreferences: {
      preload: join(root, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // REQ-103 AC4④(#195):Electron ≥5 默认已禁 webview 标签;此处显式钉死,防未来无声回归
      // (ext-security-boundaries.test 源级扫描要求每个窗口创建点都写明 false)。
      webviewTag: false,
    },
  })

  allowRendererPermissions(win)
  wireWindowRecovery(win, "main")
  // Deep-link stream ownership (REQ-089 AC4). Wired HERE, not at the boot call site, because this
  // function is also the `window.new` menu action's window factory: a renderer that could drain
  // the queue but never report reload/crash/destruction would strand or lose links silently.
  trackDeepLinkRenderer(win.webContents)

  // C1: keep the renderer boxed in our own origin. contextIsolation/sandbox don't gate IPC by origin,
  // so a navigation or window.open to hostile content would still run with the full preload bridge.
  // Block off-origin navigations + in-app popups; hand real web/mail links to the OS instead.
  const externalize = (raw: string) => {
    try {
      const p = new URL(raw).protocol
      if (p === "https:" || p === "http:" || p === "mailto:") void shell.openExternal(raw)
    } catch {
      /* ignore unparseable */
    }
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    externalize(url)
    return { action: "deny" as const }
  })
  win.webContents.on("will-navigate", (event, navUrl) => {
    if (isRendererUrl(navUrl)) return
    event.preventDefault()
    externalize(navUrl)
  })

  win.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
    const { requestHeaders } = details
    if (corsRelaxAllowed(details.url, process.platform, alphaOriginRegistry))
      upsertKeyValue(requestHeaders, "Access-Control-Allow-Origin", ["*"])
    callback({ requestHeaders })
  })

  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const { responseHeaders = {} } = details
    addRendererHeaders(details.url, responseHeaders)
    callback({ responseHeaders })
  })

  state.manage(win)
  loadWindow(win, "index.html")
  wireZoom(win)

  win.once("show", () => markStartupTimeline("main.window.first_show"))
  win.once("ready-to-show", () => {
    markStartupTimeline("main.window.ready_to_show")
    win.show()
  })

  // alpha-code dev verification hook (env-gated, no effect in normal use):
  // ALPHA_SHOT=<png> captures the rendered window after ALPHA_SHOT_DELAY ms then quits.
  if (process.env.ALPHA_SHOT) {
    setTimeout(
      async () => {
        try {
          const { writeFile } = await import("node:fs/promises")
          // optional: click the "open project" button so we capture the populated
          // project view (the picker is short-circuited by ALPHA_OPEN_DIR).
          if (process.env.ALPHA_OPEN_DIR) {
            const r = await win.webContents
              .executeJavaScript(
                `(()=>{
                const all=[...document.querySelectorAll('button,[role=button],a,[data-component]')];
                let el=all.find(e=>/folder-add/i.test(e.outerHTML||''))
                  || all.find(e=>/打开项目|添加项目|open\\s*project/i.test(e.textContent||''));
                if(!el){const p=document.elementFromPoint(303,129); el=p&&(p.closest('button,[role=button],a')||p);}
                if(el){el.click(); return 'clicked '+el.tagName+' "'+(el.textContent||'').trim().slice(0,16)+'"';}
                return 'notfound';
              })()`,
              )
              .catch((e) => "err:" + e.message)
            console.log("[alpha-open] folder-add:", JSON.stringify(r))
            await new Promise((res) => setTimeout(res, 5000))
            // then start a new session to land on the chat composer
            const r2 = await win.webContents
              .executeJavaScript(
                `(()=>{const b=[...document.querySelectorAll('button,[role=button],a')].find(e=>/新建会话|new\\s*session/i.test(e.textContent||''));if(b){b.click();return 'clicked '+(e=>e.textContent.trim().slice(0,12))(b)}return 'no-new-session'})()`,
              )
              .catch((e) => "err:" + e.message)
            console.log("[alpha-open] new-session:", JSON.stringify(r2))
            await new Promise((res) => setTimeout(res, 5000))
          }
          // optional: click a button by visible text before capture (e.g. open the Extension Hub),
          // so we can screenshot a surface that needs one interaction. Env-gated, no normal effect.
          if (process.env.ALPHA_SHOT_CLICK) {
            const want = process.env.ALPHA_SHOT_CLICK
            const clicked = await win.webContents
              .executeJavaScript(
                `(()=>{const want=${JSON.stringify(want)};` +
                  `const el=[...document.querySelectorAll('button,[role=button],a')]` +
                  `.find(e=>((e.textContent||'').includes(want)));` +
                  `if(el){el.click();return 'clicked:'+want}return 'notfound:'+want})()`,
              )
              .catch((e) => "err:" + e.message)
            console.log("[alpha-shot] click:", JSON.stringify(clicked))
            await new Promise((res) => setTimeout(res, 1800))
          }
          // optional: force the color scheme (light|dark) before capture, so dev verification can
          // shoot both modes deterministically without toggling the OS appearance. alpha-ui tokens
          // and opencode's CSS both key off documentElement[data-color-scheme]. Env-gated, no normal effect.
          if (process.env.ALPHA_SHOT_SCHEME) {
            await win.webContents
              .executeJavaScript(
                `document.documentElement.dataset.colorScheme=${JSON.stringify(process.env.ALPHA_SHOT_SCHEME)};` +
                  `getComputedStyle(document.documentElement).getPropertyValue('--a-bg-subtle');`,
              )
              .catch((e) => "err:" + e.message)
            await new Promise((res) => setTimeout(res, 700))
          }
          const img = await win.webContents.capturePage()
          await writeFile(process.env.ALPHA_SHOT as string, img.toPNG())
          console.log("[alpha-shot]", process.env.ALPHA_SHOT, JSON.stringify(img.getSize()))
        } catch (e) {
          console.error("[alpha-shot] failed", e)
        } finally {
          const { app } = await import("electron")
          app.exit(0)
        }
      },
      Number(process.env.ALPHA_SHOT_DELAY ?? 18000),
    )
  }

  return win
}

export type RecoveryWindowFatalReason = "renderer-load-failed" | "preload-failed" | "renderer-process-gone"

/** REQ-090 boot Recovery host. It is created before the product window and exposes only preload IPC. */
export function createRecoveryWindow(onFatal: (reason: RecoveryWindowFatalReason) => void) {
  const win = new BrowserWindow({
    width: 720,
    height: 610,
    minWidth: 420,
    minHeight: 520,
    show: false,
    closable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    title: "alpha-code · Recovery",
    icon: iconPath(),
    backgroundColor: defaultBackgroundColor(),
    ...(process.platform === "darwin" ? { titleBarStyle: "hidden" as const } : {}),
    webPreferences: {
      preload: join(root, "../preload/recovery.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  })

  recoveryWebContents.add(win.webContents)
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" as const }))
  win.webContents.on("will-navigate", (event, url) => {
    if (isRendererUrl(url)) return
    event.preventDefault()
  })
  win.webContents.on("did-fail-load", (_event, code, _description, _url, mainFrame) => {
    if (!mainFrame || code === -3) return
    onFatal("renderer-load-failed")
  })
  win.webContents.on("preload-error", () => onFatal("preload-failed"))
  win.webContents.on("render-process-gone", () => onFatal("renderer-process-gone"))
  win.once("ready-to-show", () => win.show())
  return win
}

export function loadRecoveryWindow(win: BrowserWindow) {
  loadWindow(win, "recovery.html")
}

export function isRecoveryWebContents(webContents: WebContents) {
  return recoveryWebContents.has(webContents)
}

export function registerRendererProtocol() {
  if (protocol.isProtocolHandled(rendererProtocol)) return

  protocol.handle(rendererProtocol, async (request) => {
    const url = new URL(request.url)
    if (url.host !== rendererHost) {
      writeLog("protocol", "rejected host", { url: request.url }, "warn")
      return new Response("Not found", { status: 404 })
    }

    const file = resolve(rendererRoot, `.${decodeURIComponent(url.pathname)}`)
    const rel = relative(rendererRoot, file)
    if (rel.startsWith("..") || isAbsolute(rel)) {
      writeLog("protocol", "rejected path", { url: request.url, file }, "warn")
      return new Response("Not found", { status: 404 })
    }

    try {
      const response = await net.fetch(pathToFileURL(file).toString())
      if (response.status >= 400) {
        writeLog(
          "protocol",
          "fetch failed",
          {
            url: request.url,
            file,
            status: response.status,
            statusText: response.statusText,
          },
          "error",
        )
      }
      return addDocumentPolicy(response, file)
    } catch (error) {
      writeLog("protocol", "fetch error", { url: request.url, file, error }, "error")
      return new Response("Not found", { status: 404 })
    }
  })
}

function loadWindow(win: BrowserWindow, html: string) {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    const url = new URL(html, devUrl)
    void win.loadURL(url.toString())
    return
  }

  void win.loadURL(`${rendererProtocol}://${rendererHost}/${html}`)
}

function wireWindowRecovery(win: BrowserWindow, name: string) {
  let showing = false
  const sampler = createUnresponsiveSampler(win, name)

  const handle = async (button: string | undefined, wait: boolean) => {
    if (button === "Export Logs") {
      const sampling = sampler.stopAndFlush()
      await exportDebugLogs().catch((error) => writeLog("main", "failed to export debug logs", { error }, "error"))
      if (wait && sampling) sampler.start()
      return true
    }
    if (button === "Relaunch") {
      sampler.stopAndFlush()
      relaunchHandler()
      return false
    }
    if (button === "Quit") {
      sampler.stopAndFlush()
      app.quit()
    }
    return false
  }

  const show = async (message: string, detail: string, wait: boolean) => {
    if (showing || win.isDestroyed()) return
    showing = true
    try {
      while (!win.isDestroyed()) {
        const buttons = wait ? ["Relaunch", "Export Logs", "Keep Waiting"] : ["Relaunch", "Export Logs", "Quit"]
        const result = await dialog.showMessageBox(win, {
          type: "warning",
          buttons,
          defaultId: 0,
          cancelId: 2,
          message,
          detail,
        })
        if (await handle(buttons[result.response], wait)) continue
        return
      }
    } finally {
      showing = false
    }
  }

  const failed = (
    event: string,
    errorCode: number,
    errorDescription: string,
    validatedURL: string,
    isMainFrame: boolean,
  ) => {
    writeLog(
      "window",
      "renderer load failed",
      {
        window: name,
        event,
        errorCode,
        routeId: safeRouteLabel(validatedURL),
        currentRouteId: safeRouteLabel(win.webContents.getURL()),
        isMainFrame,
      },
      "error",
    )

    if (!isMainFrame || errorCode === -3) return
    void show(
      "OpenCode failed to load",
      [`Window: ${name}`, `URL: ${validatedURL}`, `Error: ${errorCode} ${errorDescription}`].join("\n"),
      false,
    )
  }

  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    failed("did-fail-load", errorCode, errorDescription, validatedURL, isMainFrame)
  })
  win.webContents.on("did-fail-provisional-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    failed("did-fail-provisional-load", errorCode, errorDescription, validatedURL, isMainFrame)
  })
  win.webContents.on("render-process-gone", (_event, details) => {
    sampler.stopAndFlush()
    writeLog(
      "window",
      "renderer process gone",
      { window: name, routeId: safeRouteLabel(win.webContents.getURL()), reason: details.reason, exitCode: details.exitCode },
      "error",
    )
    void show(
      "OpenCode window terminated unexpectedly",
      [`Window: ${name}`, `Reason: ${details.reason}`, `Code: ${details.exitCode ?? "<unknown>"}`].join("\n"),
      false,
    )
  })
  win.on("unresponsive", () => {
    writeLog("window", "renderer unresponsive", { window: name, routeId: safeRouteLabel(win.webContents.getURL()) }, "error")
    sampler.start()
    void show("OpenCode is not responding", "You can relaunch the app, open the logs, or keep waiting.", true)
  })
  win.on("responsive", () => {
    writeLog("window", "renderer responsive", { window: name, routeId: safeRouteLabel(win.webContents.getURL()) }, "error")
    sampler.stopAndFlush()
  })
  win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    // #900:message 是 renderer 里任意 console.* 调用的实参(工具/终端输出、用户数据),没有安全
    // 的通用脱敏方式 —— 只保留触发匹配所需的字段,原文不落盘。
    if (message.toLowerCase().includes("terminal") || sourceId.toLowerCase().includes("terminal")) {
      writeLog("pty", "console", { window: name, level, line, sourceId })
    }
  })
  win.webContents.on("preload-error", (_event, _preloadPath, error) => {
    writeLog("preload", "preload error", { window: name, errorName: safeErrorName(error) }, "error")
  })
}

function addDocumentPolicy(response: Response, file: string) {
  if (!file.toLowerCase().endsWith(".html")) return response
  const headers = new Headers(response.headers)
  headers.set(documentPolicyHeader, jsCallStacksDocumentPolicy)
  // C24:protocol.handle 是文档响应的第二条路径,与 addRendererHeaders 保持一致注入 CSP。
  if (shouldInjectCsp()) headers.set("Content-Security-Policy", rendererCsp)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

function allowRendererPermissions(win: BrowserWindow) {
  win.webContents.session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(
      rendererPermissions.has(permission) &&
        isTrustedRendererUrl(details.requestingUrl) &&
        webContents.id === win.webContents.id,
    )
  })
  win.webContents.session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (!rendererPermissions.has(permission)) return false
    if (webContents && webContents.id !== win.webContents.id) return false
    return isTrustedRendererUrl(details.requestingUrl) || isTrustedRendererUrl(requestingOrigin)
  })
}

function isTrustedRendererUrl(value?: string) {
  return isRendererUrl(value)
}

function addRendererHeaders(value: string, headers: Record<string, any>) {
  if (corsRelaxAllowed(value, process.platform, alphaOriginRegistry)) {
    upsertKeyValue(headers, "Access-Control-Allow-Origin", ["*"])
    upsertKeyValue(headers, "Access-Control-Allow-Headers", ["*"])
  }
  if (isRendererUrl(value, true)) {
    upsertKeyValue(headers, documentPolicyHeader, [jsCallStacksDocumentPolicy])
    if (shouldInjectCsp()) upsertKeyValue(headers, "Content-Security-Policy", [rendererCsp])
  }
}

function isRendererUrl(value?: string, html = false) {
  if (!value || !URL.canParse(value)) return false
  const url = new URL(value)
  if (html && !url.pathname.endsWith(".html")) return false
  if (url.protocol === `${rendererProtocol}:` && url.host === rendererHost) return true
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!devUrl || !URL.canParse(devUrl)) return false
  return url.origin === new URL(devUrl).origin
}

function wireZoom(win: BrowserWindow) {
  pinchZoomEnabled.set(win, getPinchZoomEnabled())
  win.webContents.setZoomFactor(1)
  win.webContents.on("zoom-changed", (event, zoomDirection) => {
    event.preventDefault()
    if (pinchZoomEnabled.get(win)) {
      win.webContents.setZoomFactor(clampZoom(win.webContents.getZoomFactor() + (zoomDirection === "in" ? 0.2 : -0.2)))
      updateZoom(win)
      return
    }
    if (win.webContents.getZoomFactor() !== 1) win.webContents.setZoomFactor(1)
    updateZoom(win)
  })
}

function clampZoom(value: number) {
  return Math.min(Math.max(value, minZoomLevel), maxZoomLevel)
}

function updateZoom(win: BrowserWindow) {
  updateTitlebar(win)
  win.webContents.send("zoom-factor-changed", win.webContents.getZoomFactor())
}

function upsertKeyValue(obj: Record<string, any>, keyToChange: string, value: any) {
  const keyToChangeLower = keyToChange.toLowerCase()
  for (const key of Object.keys(obj)) {
    if (key.toLowerCase() === keyToChangeLower) {
      // Reassign old key
      obj[key] = value
      // Done
      return
    }
  }
  // Insert at end instead
  obj[keyToChange] = value
}
