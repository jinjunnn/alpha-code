import type { DesktopMenuAction } from "@opencode-ai/app/desktop-menu"
import type { WslServersPlatform } from "@opencode-ai/app/wsl/types"
import type { UpdaterState } from "@opencode-ai/app/updater"
export type {
  WslDistroProbe,
  WslInstalledDistro,
  WslJob,
  WslOnlineDistro,
  WslOpencodeCheck,
  WslRuntimeCheck,
  WslServerConfig,
  WslServerItem,
  WslServerRuntime,
  WslServersEvent,
  WslServersState,
} from "@opencode-ai/app/wsl/types"

export type ServerReadyData = {
  url: string
  username: string | null
  password: string | null
}

export type WslServersAPI = WslServersPlatform
export type UpdaterAPI = {
  subscribe: (cb: (state: UpdaterState) => void) => Promise<() => void>
  check: () => Promise<UpdaterState>
  install: () => Promise<void>
}

export type LinuxDisplayBackend = "wayland" | "auto"
export type TitlebarTheme = {
  mode: "light" | "dark"
}
export type FatalRendererError = {
  error: string
  url: string
  version?: string
  platform: string
  os?: string
}

// alpha-code ↔ platform auth (see main/alpha-auth.ts + docs/platform-integration.md §C). Defined
// here so main, preload and renderer share one shape (the established cross-bundle type pattern).
export type AuthMode = "byok" | "platform"
export type AuthStatus = "logged-out" | "logged-in"
export type AuthState = {
  status: AuthStatus
  mode: AuthMode
  account?: { email?: string; plan?: string }
  expiresAt?: number
}

// alpha account summary — balance / membership / token usage, read from the alpha-platform (B)
// in-region account-server using the stored JWT. Shared cross-bundle like AuthState. Contract:
// alpha-platform docs/alpha-code-account-integration.md (GET /v1/account/summary).
export type AccountWindow = { usedTokens: number; limitTokens: number; resetsInMin: number }
export type AccountPlan =
  | {
      id: string
      name: string
      status: "active"
      window5h: AccountWindow
      window7d: AccountWindow
      renewsAt: string
      daysLeft: number
    }
  | { id: "none"; status: "none" }
export type AccountSummary = {
  balanceFen: number
  walletUsedFen: number
  plan: AccountPlan
  usage: { todayTokens: number; weekTokens: number; tasksThisMonth: number }
  usageSeries: Array<{ date: string; tokens: number }>
}
export type AccountTransaction = {
  id: string
  type: "recharge" | "subscription" | "usage" | "bonus"
  title: string
  amountFen: number
  createdAt: string
  status: "success" | "pending"
}
/** Result envelope: the payload, or an error code (not-authenticated / unauthorized / http-NNN / network). */
export type AccountResult<T> = T | { error: string }

export type ElectronAPI = {
  killSidecar: () => Promise<void>
  installCli: () => Promise<string>
  awaitInitialization: () => Promise<ServerReadyData>
  wslServers: WslServersAPI
  updater: UpdaterAPI
  consumeInitialDeepLinks: () => Promise<string[]>
  getDefaultServerUrl: () => Promise<string | null>
  setDefaultServerUrl: (url: string | null) => Promise<void>
  getDisplayBackend: () => Promise<LinuxDisplayBackend | null>
  setDisplayBackend: (backend: LinuxDisplayBackend | null) => Promise<void>
  parseMarkdownCommand: (markdown: string) => Promise<string>
  checkAppExists: (appName: string) => Promise<boolean>
  resolveAppPath: (appName: string) => Promise<string | null>
  storeGet: (name: string, key: string) => Promise<string | null>
  storeSet: (name: string, key: string, value: string) => Promise<void>
  storeDelete: (name: string, key: string) => Promise<void>
  storeClear: (name: string) => Promise<void>
  storeKeys: (name: string) => Promise<string[]>
  storeLength: (name: string) => Promise<number>

  getWindowCount: () => Promise<number>
  onMenuCommand: (cb: (id: string) => void) => () => void
  onDeepLink: (cb: (urls: string[]) => void) => () => void

  openDirectoryPicker: (opts?: {
    multiple?: boolean
    title?: string
    defaultPath?: string
  }) => Promise<string | string[] | null>
  openFilePicker: (opts?: {
    multiple?: boolean
    title?: string
    defaultPath?: string
    extensions?: string[]
  }) => Promise<{ token: string; files: { path: string; name: string; size: number }[] } | null>
  readPickedFile: (token: string, path: string) => Promise<ArrayBuffer>
  releasePickedFiles: (token: string) => Promise<void>
  saveFilePicker: (opts?: { title?: string; defaultPath?: string }) => Promise<string | null>
  openLink: (url: string) => void
  openPath: (path: string, app?: string) => Promise<void>
  readClipboardImage: () => Promise<{ buffer: ArrayBuffer; width: number; height: number } | null>
  showNotification: (title: string, body?: string) => void
  getWindowFocused: () => Promise<boolean>
  setWindowFocus: () => Promise<void>
  showWindow: () => Promise<void>
  relaunch: () => void
  getZoomFactor: () => Promise<number>
  setZoomFactor: (factor: number) => Promise<void>
  getPinchZoomEnabled: () => Promise<boolean>
  setPinchZoomEnabled: (enabled: boolean) => Promise<void>
  onPinchZoomEnabledChanged: (cb: (enabled: boolean) => void) => () => void
  onZoomFactorChanged: (cb: (factor: number) => void) => () => void
  setTitlebar: (theme: TitlebarTheme) => Promise<void>
  runDesktopMenuAction: (action: DesktopMenuAction) => Promise<void>
  setBackgroundColor: (color: string) => Promise<void>
  exportDebugLogs: () => Promise<string>
  recordFatalRendererError: (error: FatalRendererError) => Promise<void>
  auth: {
    getState: () => Promise<AuthState>
    start: () => Promise<void>
    logout: () => Promise<void>
    setMode: (mode: AuthMode) => Promise<void>
    subscribe: (cb: (state: AuthState) => void) => () => void
  }
  // Extension Hub (定制中心): thin privileged operations the renderer can't do itself. persistMcp
  // writes the user's opencode.jsonc (durable); the live add/connect happens in the renderer over
  // the SDK. See ADR-014 §4/§8.
  ext: {
    persistMcp: (name: string, server: Record<string, unknown>) => Promise<{ ok: true } | { ok: false; reason: string }>
    removeMcp: (name: string) => Promise<{ ok: true } | { ok: false; reason: string }>
    checkRuntime: (tool: string) => Promise<{ ok: boolean }>
    writeSkill: (
      name: string,
      description: string,
      body: string,
    ) => Promise<{ ok: true } | { ok: false; reason: string }>
    writeAgent: (name: string, content: string) => Promise<{ ok: true } | { ok: false; reason: string }>
    installPlugin: (pkg: string) => Promise<{ ok: true } | { ok: false; reason: string }>
    installBuiltinSkill: (
      builtinAssetKey: string,
      name: string,
    ) => Promise<{ ok: true } | { ok: false; reason: string }>
  }
  // alpha account (balance / membership / usage) read from the alpha-platform (B) account-server
  // using the main-held JWT. The renderer gets only the resolved summary, never the token.
  account: {
    summary: () => Promise<AccountResult<AccountSummary>>
    transactions: (limit?: number) => Promise<AccountResult<{ transactions: AccountTransaction[] }>>
  }
}
