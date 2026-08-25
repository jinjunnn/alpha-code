// 取证用 electron 替身。只为让 main 侧真模块能**加载**;每一个被断言的行为都跑真代码。
export type Sent = { wcId: number; channel: string; payload: unknown }
export const sent: Sent[] = []
export const handlers = new Map<string, (...args: unknown[]) => unknown>()
const noop = () => {}

export function makeWebContents(id: number) {
  const listeners = new Map<string, (() => void)[]>()
  return {
    id,
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => sent.push({ wcId: id, channel, payload }),
    once: (event: string, fn: () => void) => listeners.set(event, [...(listeners.get(event) ?? []), fn]),
    on: (event: string, fn: () => void) => listeners.set(event, [...(listeners.get(event) ?? []), fn]),
    removeListener: noop,
    emit: (event: string) => (listeners.get(event) ?? []).forEach((fn) => fn()),
  }
}

export const electronStub = {
  app: {
    getPath: () => "/tmp/alpha-402-userdata",
    getName: () => "alpha",
    getVersion: () => "0.0.0-probe",
    getAppPath: () => "/tmp/alpha-402-userdata",
    isPackaged: false,
    on: noop, once: noop, setPath: noop,
    whenReady: async () => {},
  },
  crashReporter: { start: noop },
  netLog: { startLogging: async () => {}, stopLogging: async () => {} },
  shell: { openExternal: async () => {}, openPath: async () => "", showItemInFolder: noop },
  BrowserWindow: { getAllWindows: () => [] as unknown[], fromWebContents: () => undefined },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
    on: noop,
    removeHandler: noop,
  },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] as string[] }) },
  session: { defaultSession: {} },
  nativeTheme: { on: noop },
  Menu: { setApplicationMenu: noop },
  clipboard: { writeText: noop },
  systemPreferences: {},
  powerMonitor: { on: noop },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (v: string) => Buffer.from(v),
    decryptString: (b: Buffer) => b.toString(),
  },
  protocol: { handle: noop, registerSchemesAsPrivileged: noop },
  net: { fetch: globalThis.fetch },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 } }) },
  Tray: class {},
  Notification: class { show() {} },
  webContents: { getAllWebContents: () => [] as unknown[] },
}
