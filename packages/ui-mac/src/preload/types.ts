import type { DesktopMenuAction } from "@opencode-ai/app/desktop-menu"
import type { WslServersPlatform } from "@opencode-ai/app/wsl/types"
import type { UpdaterState } from "@opencode-ai/app/updater"
import type { AlphaEndpoints } from "../shared/alpha-config"
import type {
  AlphaModelCatalog,
  ProviderInput,
  ProviderKeyStatus,
  ProviderResult,
  ProviderTestInput,
  ProviderTestResult,
} from "../shared/alpha-model-types"
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
export type AccountWindow = { usedCredits: number; limitCredits: number; resetsInMin: number }
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

// alpha-platform (B) cloud jobs API (ADR-016) — unified dispatch/status over the `cloud` worker.
// tier (T1/T2/T3) is invisible here (B routes internally); autonomy discriminates pipeline vs bounded-agent.
export type CloudJobEnvelope = {
  autonomy: "pipeline" | "bounded-agent"
  kind?: string // pipeline: research|code-review|docs|office-report|data-analysis|bugfix|migration
  input?: Record<string, unknown> // pipeline input
  objective?: string // bounded-agent objective
  capabilities?: string[] // bounded-agent: drives B's tier-router (web_search|code_exec|file_mutation)
  budget?: { max_iter?: number; max_tokens?: number; max_wall_clock_sec?: number }
  constraints?: { allowed_tools?: string[]; denied_paths?: string[]; network?: "none" | "restricted" | "open" }
  output_schema?: Record<string, unknown>
}
export type CloudDispatchResult = {
  api_version: string
  job_id: string
  status: string
  autonomy: string
  kind?: string
  urls: { status: string; events: string; result: string }
}
export type CloudJobStatus = {
  api_version: string
  job_id: string
  status: "queued" | "running" | "blocked" | "completed" | "failed" | "cancelled"
  autonomy: string
  kind?: string
  progress: { phase: string; completed_steps?: number; total_steps?: number }
  counters?: { model_calls: number; tokens_in: number; tokens_out: number; cost_usd: number }
  artifact_ids: string[]
  result?: unknown
  error: string | null
}
/** Same shape as AccountResult; distinct alias for the cloud jobs surface. */
export type CloudResult<T> = T | { error: string }

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
  writeClipboard: (text: string) => Promise<boolean>
  showNotification: (title: string, body?: string) => void
  getWindowFocused: () => Promise<boolean>
  setWindowFocus: () => Promise<void>
  showWindow: () => Promise<void>
  relaunch: () => void
  /** Resolved backend endpoints (env > userData pin > login discovery > default). Renderer reads these
   *  instead of baking the URLs. */
  endpoints: () => Promise<AlphaEndpoints>
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
    enableProxy: () => Promise<void>
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
  // alpha cloud jobs (ADR-016): dispatch a cloud job + poll status, via the main-held JWT (bearer never
  // reaches the renderer). The MCP facade path (agent-triggered cloud.* tools) is wired separately via
  // sidecar.ts mcp.servers.cloud; this HTTP surface is for app-driven dispatch/status.
  cloud: {
    dispatch: (envelope: CloudJobEnvelope) => Promise<CloudResult<CloudDispatchResult>>
    status: (jobId: string) => Promise<CloudResult<CloudJobStatus>>
  }
  // alpha model catalog (config-driven, from main/alpha-models.json) for the model picker.
  models: {
    catalog: () => Promise<AlphaModelCatalog>
  }
  // custom provider add/test (writes opencode.jsonc provider[]; 1-token-chat connectivity probe).
  providers: {
    add: (input: ProviderInput) => Promise<ProviderResult>
    test: (input: ProviderTestInput) => Promise<ProviderTestResult>
    /** Read-only BYOK key state per provider id (drives the picker's 需 Key / 已配置 gating). */
    keyStatus: () => Promise<ProviderKeyStatus>
    /** Store a catalog BYOK provider's key in alpha's encrypted keychain (alpha-byok-keys). */
    setKey: (id: string, key: string) => Promise<ProviderResult>
    /** Drop a catalog BYOK provider's key from alpha's keychain. */
    removeKey: (id: string) => Promise<ProviderResult>
    /** Remove an off-catalog custom provider's inline key/definition from opencode.jsonc (env untouched). */
    remove: (id: string) => Promise<ProviderResult>
  }
}
