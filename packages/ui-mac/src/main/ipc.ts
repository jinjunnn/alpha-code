import { execFile } from "node:child_process"
import { stat } from "node:fs/promises"
import { basename } from "node:path"
import { app, BrowserWindow, Notification, clipboard, dialog, ipcMain, shell } from "electron"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"
import type { DesktopMenuAction } from "@opencode-ai/app/desktop-menu"

import type { AuthMode, AuthState, FatalRendererError, ServerReadyData, TitlebarTheme } from "../preload/types"
import { getAlphaEnvironment } from "./alpha-environment"
import { runDesktopMenuAction } from "./desktop-menu-actions"
import { alphaUserWorkspaceDir, ensureUserWorkspaceDir } from "./alpha-user-workspace"
import { resolveAppPath } from "./apps"
import { editorCliName } from "./platform"
import { assertAttachmentBudget, createPickedFileAuthorizations } from "./attachment-picker"
import { getStore } from "./store"
import { GLOBAL_RENDERER_STORE, TABS_KEY, TABS_RECENT_KEY } from "./tabs-preclean"
import { getPinchZoomEnabled, setPinchZoomEnabled, setTitlebar, updateTitlebar } from "./windows"
import type { UpdaterController } from "./updater-controller"
import { createUpdaterSubscriptions } from "./updater-subscriptions"
import { isManagedRunArtifactPath } from "./artifact-external-open"
import { assertGenericStoreAccess } from "./store-keys"

const pickerFilters = (ext?: string[]) => {
  if (!ext || ext.length === 0) return undefined
  return [{ name: "Files", extensions: ext }]
}

export const pickedFiles = createPickedFileAuthorizations() // REQ-033:agent 导入 preview 复用同一授权注册表(codex H1)

type Deps = {
  killSidecar: () => Promise<void> | void
  relaunch: () => void
  awaitInitialization: () => Promise<ServerReadyData>
  consumeInitialDeepLinks: () => Promise<string[]> | string[]
  getDefaultServerUrl: () => Promise<string | null> | string | null
  setDefaultServerUrl: (url: string | null) => Promise<void> | void
  getDisplayBackend: () => Promise<string | null>
  setDisplayBackend: (backend: string | null) => Promise<void> | void
  parseMarkdown: (markdown: string) => Promise<string> | string
  checkAppExists: (appName: string) => Promise<boolean> | boolean
  resolveAppPath: (appName: string) => Promise<string | null>
  updater: UpdaterController
  showUpdater: () => Promise<void> | void
  setBackgroundColor: (color: string) => void
  exportDebugLogs: () => Promise<string>
  recordFatalRendererError: (error: FatalRendererError) => Promise<void> | void
  /** REQ-014:tabs 毒键预清的完成信号;store-get 对 tabs 两键首读等它(runTabsPreclean 保证有硬时限)。 */
  tabsPrecleanDone?: Promise<void>
  auth: {
    getState: () => AuthState
    start: () => Promise<void>
    logout: () => Promise<void>
    setMode: (mode: AuthMode) => Promise<void>
    enableProxy: () => void
  }
}

export function registerIpcHandlers(deps: Deps) {
  const updaterSubscriptions = createUpdaterSubscriptions()
  app.once("will-quit", updaterSubscriptions.clear)

  // REQ-098(AC#6):环境快照只读 IPC —— 回调零参数(不读任何 renderer 输入),返回启动时冻结的
  // 快照;不存在任何对应写面(环境只由 main 的构建事实解析,见 alpha-environment.ts)。
  ipcMain.handle("alpha-environment", () => getAlphaEnvironment())
  ipcMain.handle("kill-sidecar", () => deps.killSidecar())
  ipcMain.handle("await-initialization", () => deps.awaitInitialization())
  ipcMain.handle("consume-initial-deep-links", () => deps.consumeInitialDeepLinks())
  ipcMain.handle("get-default-server-url", () => deps.getDefaultServerUrl())
  ipcMain.handle("set-default-server-url", (_event: IpcMainInvokeEvent, url: string | null) =>
    deps.setDefaultServerUrl(url),
  )
  ipcMain.handle("get-display-backend", () => deps.getDisplayBackend())
  ipcMain.handle("set-display-backend", (_event: IpcMainInvokeEvent, backend: string | null) =>
    deps.setDisplayBackend(backend),
  )
  ipcMain.handle("parse-markdown", (_event: IpcMainInvokeEvent, markdown: string) => deps.parseMarkdown(markdown))
  ipcMain.handle("check-app-exists", (_event: IpcMainInvokeEvent, appName: string) => deps.checkAppExists(appName))
  ipcMain.handle("resolve-app-path", (_event: IpcMainInvokeEvent, appName: string) => deps.resolveAppPath(appName))
  ipcMain.handle("updater-subscribe", (event) => {
    const id = event.sender.id
    updaterSubscriptions.set(
      id,
      deps.updater.subscribe((state) => {
        if (event.sender.isDestroyed()) return updaterSubscriptions.delete(id)
        event.sender.send("updater-state", state)
      }),
    )
    event.sender.once("destroyed", () => updaterSubscriptions.delete(id))
  })
  ipcMain.handle("updater-unsubscribe", (event) => updaterSubscriptions.delete(event.sender.id))
  ipcMain.handle("updater-check", () => deps.updater.check())
  ipcMain.handle("updater-install", () => deps.updater.install())
  ipcMain.handle("set-background-color", (_event: IpcMainInvokeEvent, color: string) => deps.setBackgroundColor(color))
  ipcMain.handle("export-debug-logs", () => deps.exportDebugLogs())
  ipcMain.handle("record-fatal-renderer-error", (_event: IpcMainInvokeEvent, error: FatalRendererError) =>
    deps.recordFatalRendererError(error),
  )
  ipcMain.handle("auth-get-state", () => deps.auth.getState())
  ipcMain.handle("auth-start", () => deps.auth.start())
  ipcMain.handle("auth-logout", () => deps.auth.logout())
  ipcMain.handle("auth-set-mode", (_event: IpcMainInvokeEvent, mode: AuthMode) => deps.auth.setMode(mode))
  ipcMain.handle("auth-enable-proxy", () => deps.auth.enableProxy())
  ipcMain.handle("store-get", async (_event: IpcMainInvokeEvent, name: string, key: string) => {
    assertGenericStoreAccess(name, key)
    // REQ-014:renderer 恢复 tabs 路由的首读必须拿到预清后的数据(毒键 → 上游整屏崩,alpha 无 renderer
    // 侧恢复层)。只 gate 这两个键 —— 语言/其他键不受影响,窗口照常先开(A1 window-first 不回退)。
    if (name === GLOBAL_RENDERER_STORE && (key === TABS_KEY || key === TABS_RECENT_KEY) && deps.tabsPrecleanDone) {
      await deps.tabsPrecleanDone.catch(() => {})
    }
    try {
      const store = getStore(name)
      const value = store.get(key)
      if (value === undefined || value === null) return null
      return typeof value === "string" ? value : JSON.stringify(value)
    } catch {
      return null
    }
  })
  ipcMain.handle("store-set", (_event: IpcMainInvokeEvent, name: string, key: string, value: string) => {
    assertGenericStoreAccess(name, key)
    getStore(name).set(key, value)
  })
  ipcMain.handle("store-delete", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    assertGenericStoreAccess(name, key)
    getStore(name).delete(key)
  })
  ipcMain.handle("store-clear", (_event: IpcMainInvokeEvent, name: string) => {
    assertGenericStoreAccess(name)
    getStore(name).clear()
  })
  ipcMain.handle("store-keys", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store)
  })
  ipcMain.handle("store-length", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store).length
  })

  ipcMain.handle(
    "open-directory-picker",
    async (_event: IpcMainInvokeEvent, opts?: { multiple?: boolean; title?: string; defaultPath?: string }) => {
      // alpha-code: ALPHA_OPEN_DIR short-circuits the native dialog with a fixed
      // directory (used to auto-open a default project / for headless verification).
      if (process.env.ALPHA_OPEN_DIR) {
        const dir = process.env.ALPHA_OPEN_DIR
        return opts?.multiple ? [dir] : dir
      }
      // REQ-071/ADR-025:全部目录选择器统一默认落 ~/Alpha(调用方显式 defaultPath 优先)。
      // 打开选择器即「首次需要」→ lazy 供给;供给失败(如同名文件占位)退回系统默认,不阻断。
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", ...(opts?.multiple ? ["multiSelections" as const] : []), "createDirectory"],
        title: opts?.title ?? "Choose a folder",
        defaultPath: opts?.defaultPath ?? ensureUserWorkspaceDir() ?? undefined,
      })
      if (result.canceled) return null
      return opts?.multiple ? result.filePaths : result.filePaths[0]
    },
  )

  // REQ-071/ADR-025:~/Alpha 默认工作目录 —— 路径查询(不建)与 lazy 供给(仅对默认目录生效)。
  ipcMain.handle("alpha-workspace-default", () => alphaUserWorkspaceDir())
  ipcMain.handle("alpha-workspace-ensure", (_event: IpcMainInvokeEvent, dir?: unknown) => {
    const ensured = ensureUserWorkspaceDir(typeof dir === "string" ? dir : undefined)
    return ensured ? { ok: true, dir: ensured } : { ok: false }
  })

  ipcMain.handle(
    "open-file-picker",
    async (
      event: IpcMainInvokeEvent,
      opts?: { multiple?: boolean; title?: string; defaultPath?: string; extensions?: string[] },
    ) => {
      const result = await dialog.showOpenDialog({
        properties: ["openFile", ...(opts?.multiple ? ["multiSelections" as const] : [])],
        title: opts?.title ?? "Choose a file",
        defaultPath: opts?.defaultPath,
        filters: pickerFilters(opts?.extensions),
      })
      if (result.canceled) return null
      const files = await Promise.all(
        result.filePaths.map(async (filePath) => ({
          path: filePath,
          name: basename(filePath),
          size: (await stat(filePath)).size,
        })),
      )
      assertAttachmentBudget(files)
      const token = pickedFiles.add(event.sender.id, result.filePaths)
      return { token, files }
    },
  )

  ipcMain.handle("read-picked-file", async (event: IpcMainInvokeEvent, token: string, filePath: string) => {
    return pickedFiles.read(event.sender.id, token, filePath)
  })

  ipcMain.handle("release-picked-files", (event: IpcMainInvokeEvent, token: string) => {
    pickedFiles.release(event.sender.id, token)
  })

  ipcMain.handle(
    "save-file-picker",
    async (_event: IpcMainInvokeEvent, opts?: { title?: string; defaultPath?: string }) => {
      const result = await dialog.showSaveDialog({
        title: opts?.title ?? "Save file",
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return result.filePath ?? null
    },
  )

  ipcMain.on("open-link", (_event: IpcMainEvent, url: string) => {
    // Only hand web/mail links to the OS. A renderer-supplied file:// or custom app scheme could
    // invoke a local protocol handler, so anything else is dropped (C13).
    let scheme = ""
    try {
      scheme = new URL(url).protocol
    } catch {
      return
    }
    if (scheme !== "https:" && scheme !== "http:" && scheme !== "mailto:") return
    void shell.openExternal(url)
  })

  // C25:`open -a <app>` 是渲染层可达的任意应用启动原语(如 app=Terminal 会直接执行 path 参数)。
  // 收紧为编辑器/查看器白名单;白名单外降级为系统默认打开(不 exec,行为仍可用)。
  const ALLOWED_OPEN_APPS = new Set([
    "Visual Studio Code",
    "Cursor",
    "Zed",
    "Sublime Text",
    "TextEdit",
    "Xcode",
    "IntelliJ IDEA",
    "WebStorm",
    "PyCharm",
    "Finder",
  ])
  ipcMain.handle("open-path", async (_event: IpcMainInvokeEvent, path: string, app?: string) => {
    if (isManagedRunArtifactPath(path)) throw new Error("managed run artifacts require run-artifact-open-external")
    if (!app || !ALLOWED_OPEN_APPS.has(app)) return shell.openPath(path)
    // REQ-076 T2:win32 上 display 名不是可执行名("Visual Studio Code" ≠ code.exe)——
    // 经 seam 映射 CLI 名 + apps.resolveAppPath(where + .cmd→.exe)落成真实 .exe 后 execFile
    // (参数数组、无 shell,拒注入面);无对应物/未安装 → shell.openPath 诚实回退(ADR-026)。
    if (process.platform === "win32") {
      const cli = editorCliName(app)
      const exe = cli ? await resolveAppPath(cli) : null
      if (!exe) return shell.openPath(path)
      await new Promise<void>((resolve, reject) => {
        execFile(exe, [path], (err) => (err ? reject(err) : resolve()))
      })
      return
    }
    await new Promise<void>((resolve, reject) => {
      const [cmd, args] =
        process.platform === "darwin" ? (["open", ["-a", app, path]] as const) : ([app, [path]] as const)
      execFile(cmd, args, (err) => (err ? reject(err) : resolve()))
    })
  })

  ipcMain.handle("read-clipboard-image", () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    const buffer = image.toPNG().buffer
    const size = image.getSize()
    return { buffer, width: size.width, height: size.height }
  })

  // Write text to the system clipboard from the main process. Unlike the renderer's async Clipboard
  // API, this needs no transient user activation, so alpha actions (e.g. "复制对话") copy reliably.
  ipcMain.handle("write-clipboard", (_event, text: string) => {
    clipboard.writeText(typeof text === "string" ? text : String(text ?? ""))
    return true
  })

  ipcMain.on("show-notification", (_event: IpcMainEvent, title: string, body?: string) => {
    new Notification({ title, body }).show()
  })

  ipcMain.handle("get-window-count", () => BrowserWindow.getAllWindows().length)

  ipcMain.handle("get-window-focused", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isFocused() ?? false
  })

  ipcMain.handle("set-window-focus", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.focus()
  })

  ipcMain.handle("show-window", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.show()
  })

  ipcMain.on("relaunch", () => {
    deps.relaunch()
  })

  ipcMain.handle("get-zoom-factor", (event: IpcMainInvokeEvent) => event.sender.getZoomFactor())
  ipcMain.handle("set-zoom-factor", (event: IpcMainInvokeEvent, factor: number) => {
    event.sender.setZoomFactor(factor)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    updateTitlebar(win)
  })
  ipcMain.handle("get-pinch-zoom-enabled", () => getPinchZoomEnabled())
  ipcMain.handle("set-pinch-zoom-enabled", (_event: IpcMainInvokeEvent, enabled: boolean) => {
    setPinchZoomEnabled(enabled)
  })
  ipcMain.handle("set-titlebar", (event: IpcMainInvokeEvent, theme: TitlebarTheme) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    setTitlebar(win, theme)
  })
  ipcMain.handle("run-desktop-menu-action", (event: IpcMainInvokeEvent, action: DesktopMenuAction) => {
    runDesktopMenuAction(BrowserWindow.fromWebContents(event.sender), action, {
      checkForUpdates: () => void deps.showUpdater(),
      relaunch: deps.relaunch,
    })
  })
}

export function sendMenuCommand(win: BrowserWindow, id: string) {
  win.webContents.send("menu-command", id)
}

export function sendDeepLinks(win: BrowserWindow, urls: string[]) {
  win.webContents.send("deep-link", urls)
}
