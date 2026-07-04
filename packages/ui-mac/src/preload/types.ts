import type { DesktopMenuAction } from "@opencode-ai/app/desktop-menu"
import type { WslServersPlatform } from "@opencode-ai/app/wsl/types"
import type { UpdaterState } from "@opencode-ai/app/updater"
import type { AlphaEndpoints } from "../shared/alpha-config"
import type {
  AlphaModelCatalog,
  EffectiveCatalog,
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

// Extension-hub install receipts (REQ-018): alpha's record of installed items and the files/config
// keys each install owns. Engine visibility truth remains the SDK (mcp.status / app.skills / …);
// receipts ⨝ SDK drives installed/pending-reload UI states, uninstall and update.
export type InstallReceiptType = "mcp" | "skill" | "agent" | "command" | "plugin" | "bundle" | "cloud"
export type InstallReceiptScope = "global" | "project"
export type InstallReceiptOrigin = "catalog" | "created" | "imported"
export type InstallReceipt = {
  /** catalog entry id (e.g. "mcp:markitdown") or "user:<name>" for created/imported items */
  id: string
  /** install name: mcp server key / skill dir / agent file basename */
  name: string
  type: InstallReceiptType
  scope: InstallReceiptScope
  version?: string
  /** ISO timestamp */
  installedAt: string
  origin: InstallReceiptOrigin
  /** absolute paths owned by this install (fs types + bridge symlinks) */
  files?: string[]
  /** config ownership, e.g. "mcp.markitdown" / "plugin:opencode-notify@0.3.1" */
  configKey?: string
}
export type InstallLedgerView = { global: InstallReceipt[]; project: InstallReceipt[]; warnings: string[] }
/** Legacy installs found in the shared XDG config dir, offered for migration to .alpha (REQ-018 T3). */
export type LegacyInventory = {
  root: string
  skills: string[]
  agents: string[]
  mcp: { name: string; config: Record<string, unknown> }[]
  plugins: string[]
}
/** Install destination: global (~/.alpha + ~/.opencode bridge) or a specific project's .alpha. */
export type InstallTarget = { scope: "global" } | { scope: "project"; projectDir: string }
/** Catalog provenance recorded into the receipt (id + catalog snapshot version for update checks). */
export type InstallMeta = { catalogId?: string; version?: string }

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
export type CloudArtifactMeta = { id: string; name?: string; mime?: string; size?: number; content_url?: string }
export type CloudArtifactList = { job_id: string; status: string; artifacts: CloudArtifactMeta[]; artifact_ids: string[]; result?: unknown }
export type CloudArtifactContent = { name: string; mime: string; base64: string }
/** B3/ADR-019 artifact 回流:写 <projectDir>/.alpha/runs/<runId>/ 的结果清单(main 侧 alpha-workdir.ts)。 */
export type CloudRunManifest = { ok: true; dir: string; files: string[]; warnings: string[] } | { ok: false; reason: string }
/** SSE 进度事件(job.snapshot / job.started / job.running / workflow.step.completed / job.completed|failed|cancelled / error)。 */
export type CloudJobEvent = { event: string; data: unknown; id?: string }
/** Same shape as AccountResult; distinct alias for the cloud jobs surface. */
export type CloudResult<T> = T | { error: string }
/** B gateway /v1/models 的一条 live 模型(真相源 allowlist)。 */
export type PlatformLiveModel = { id: string; provider?: string; minPlan?: string }

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
    persistMcp: (
      name: string,
      server: Record<string, unknown>,
      meta?: InstallMeta,
      /** env var names in server.environment whose values are secrets → routed to the {file:} channel */
      secretVars?: string[],
    ) => Promise<{ ok: true } | { ok: false; reason: string }>
    removeMcp: (name: string) => Promise<{ ok: true } | { ok: false; reason: string }>
    checkRuntime: (tool: string) => Promise<{ ok: boolean }>
    // B11/B23:全局配置健康(broken=引擎会整份忽略用户配置)
    configHealth: () => Promise<{ broken: boolean; reason?: string; path?: string }>
    writeSkill: (
      name: string,
      description: string,
      body: string,
      target?: InstallTarget,
    ) => Promise<{ ok: true; files?: string[] } | { ok: false; reason: string }>
    writeAgent: (
      name: string,
      content: string,
      target?: InstallTarget,
    ) => Promise<{ ok: true; files?: string[] } | { ok: false; reason: string }>
    installPlugin: (pkg: string, meta?: InstallMeta) => Promise<{ ok: true } | { ok: false; reason: string }>
    installBuiltinSkill: (
      builtinAssetKey: string,
      name: string,
      target?: InstallTarget,
      meta?: InstallMeta,
    ) => Promise<{ ok: true; files?: string[] } | { ok: false; reason: string }>
    // REQ-019 T3:详情页 SKILL.md 预览(只读,资产键校验 + 256KB 帽;未打包时诚实失败)
    readBuiltinSkill: (builtinAssetKey: string) => Promise<{ ok: true; content: string } | { ok: false; reason: string }>
    // REQ-019 T6:导入。folder = 校验 SKILL.md frontmatter → 复制入 .alpha + receipt(imported);
    // git = https-only 浅克隆临时目录 → 同校验。外来内容绝不执行,symlink 不复制。
    importSkillFolder: (
      srcDir: string,
      target?: InstallTarget,
    ) => Promise<{ ok: true; files?: string[]; name?: string } | { ok: false; reason: string }>
    importSkillGit: (
      url: string,
      target?: InstallTarget,
    ) => Promise<{ ok: true; files?: string[]; name?: string } | { ok: false; reason: string }>
    // REQ-018 安装账本:global(~/.alpha)+ project(<dir>/.alpha)receipts 合并只读视图
    listInstalls: (projectDir?: string) => Promise<InstallLedgerView>
    // REQ-018 T6:按 receipt 精确卸载(删文件/拆桥/去 config 项/吊销密钥/去账)
    uninstall: (receipt: InstallReceipt) => Promise<{ ok: true; files?: string[] } | { ok: false; reason: string }>
    // REQ-018 T3:存量迁移(旧 XDG 根 → .alpha)。scan 报告 legacy 清单 + enabled 门控;removeLegacy 删旧位。
    migrateScan: () => Promise<{ enabled: boolean; inventory: LegacyInventory }>
    removeLegacy: (
      type: "skill" | "agent" | "mcp" | "plugin",
      name: string,
    ) => Promise<{ ok: true; removed: string[] } | { ok: false; reason: string }>
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
    cancel: (jobId: string) => Promise<CloudResult<{ job_id: string; status: string }>>
    artifacts: (jobId: string) => Promise<CloudResult<CloudArtifactList>>
    fetchArtifact: (artifactId: string) => Promise<CloudResult<CloudArtifactContent>>
    // B3/ADR-019 回流:终态后把 run(status/contract/artifacts)写进 <directory>/.alpha/runs/<runId>/。
    saveRun: (directory: string, runId: string, contract?: CloudJobEnvelope) => Promise<CloudRunManifest>
    // 订阅 SSE 进度:main 流式 /events → 推 cloud-job-event。onEvent 注册监听,返回取消函数。
    subscribe: (jobId: string) => Promise<{ ok: boolean }>
    unsubscribe: (jobId: string) => Promise<{ ok: boolean }>
    onEvent: (cb: (payload: { jobId: string } & CloudJobEvent) => void) => () => void
  }
  // alpha model catalog for the model picker. REQ-001:catalog = effective 视图(内置 snapshot 按
  // B 网关 edition 白名单收窄 + liveSync 来源标注);platformLive 拉取顺带刷新本地白名单缓存。
  models: {
    catalog: () => Promise<EffectiveCatalog>
    platformLive: () => Promise<CloudResult<{ models: PlatformLiveModel[]; edition?: string; byokProviders: string[] | null }>>
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
