// REQ-053 `#966`:两个子进程闸(req053-spawn-rotation / req053-clear-wiring)共用的 electron 替身。
//
// 为什么键面这么长:两个闸都**不 mock `./logging`**(要让真 `rotateServerLogs()` 跑),于是
// `electron-log/main.js` 会在模块顶层碰 electron 的一大片面。ESM 具名导入缺一个键不是「少一个
// 功能」,而是当场 `Export named 'netLog' not found`,整文件 0 pass —— 而 `0 fail` 恒成立。
// 键面照 `node_modules/electron-log/src/main/ElectronExternalApi.js` 逐条枚举,不是凭记忆。
import { EventEmitter } from "node:events"
import { join } from "node:path"

export type ElectronStubHooks = {
  /** app.getPath("userData") 的真源 —— 每个用例各自的临时根,故传函数不传值。 */
  userDataPath: () => string
  isPackaged?: () => boolean
  /** 按脚本依次应答;实现方负责把每次调用的 options 原样记下来。 */
  showMessageBox?: (options: Record<string, unknown>) => Promise<Record<string, unknown>>
  exit?: (code?: number) => void
}

export function createElectronStub(hooks: ElectronStubHooks): Record<string, unknown> {
  const appEvents = new EventEmitter()
  const stub: Record<string, unknown> = {
    app: {
      get isPackaged() {
        return hooks.isPackaged?.() ?? false
      },
      isReady: () => true,
      name: "alpha",
      getName: () => "alpha",
      getVersion: () => "0.0.0",
      getAppPath: () => hooks.userDataPath(),
      getPath: (name: string) => (name === "userData" ? hooks.userDataPath() : join(hooks.userDataPath(), name)),
      setPath: () => {},
      on: appEvents.on.bind(appEvents),
      once: appEvents.once.bind(appEvents),
      off: appEvents.off.bind(appEvents),
      exit: (code?: number) => hooks.exit?.(code),
      quit: () => hooks.exit?.(0),
    },
    ipcMain: {
      handle: () => {},
      removeHandler: () => {},
      on: () => {},
      once: () => {},
      off: () => {},
      removeListener: () => {},
    },
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showMessageBox: async (options: Record<string, unknown>) =>
        (await hooks.showMessageBox?.(options)) ?? { response: 0 },
      showErrorBox: () => {},
    },
    BrowserWindow: Object.assign(class {}, {
      getAllWindows: () => [],
      getFocusedWindow: () => null,
      fromWebContents: () => null,
    }),
    crashReporter: { start: () => {}, addExtraParameter: () => {} },
    shell: { openExternal: () => {}, openPath: () => {}, showItemInFolder: () => {} },
    net: { fetch: async () => new Response("{}") },
    session: { defaultSession: { webRequest: { onHeadersReceived: () => {} } } },
    Menu: { buildFromTemplate: () => ({ popup: () => {} }), setApplicationMenu: () => {} },
    utilityProcess: {
      fork: () => {
        throw new Error("unexpected utilityProcess.fork — the test must inject options.fork")
      },
    },
    safeStorage: { isEncryptionAvailable: () => false },
    nativeTheme: { on: () => {} },
    powerMonitor: { on: () => {} },
    netLog: { startLogging: async () => {}, stopLogging: async () => {}, currentlyLogging: false },
    contentTracing: {},
    globalShortcut: { register: () => {}, unregisterAll: () => {} },
    protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1, height: 1 } }) },
    clipboard: { writeText: () => {} },
    nativeImage: { createFromPath: () => ({}) },
    Notification: class {},
    Tray: class {},
    MenuItem: class {},
    webContents: { getAllWebContents: () => [] },
    inAppPurchase: {},
    powerSaveBlocker: {},
    systemPreferences: { getMediaAccessStatus: () => "granted" },
    desktopCapturer: {},
    autoUpdater: { on: () => {} },
    ShareMenu: class {},
    TouchBar: class {},
    BrowserView: class {},
    WebContentsView: class {},
    BaseWindow: class {},
    View: class {},
    IncomingMessage: class {},
    ClientRequest: class {},
    Session: class {},
    Cookies: class {},
    Debugger: class {},
    Dock: class {},
    NavigationHistory: class {},
    ServiceWorkers: class {},
    WebFrameMain: class {},
    WebRequest: class {},
    parseContentType: () => ({}),
    pushNotifications: {},
    utilityProcessImmediate: {},
  }
  stub.default = stub
  return stub
}
