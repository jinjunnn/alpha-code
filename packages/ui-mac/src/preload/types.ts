import type { DesktopMenuAction } from "@opencode-ai/app/desktop-menu"
import type { WslServersPlatform } from "@opencode-ai/app/wsl/types"
import type { UpdaterState } from "@opencode-ai/app/updater"
import type { AlphaEndpoints } from "../shared/alpha-config"
import type {
  AuthorizationConfirmationWire,
  CapabilityDiffWire,
  TxStageNonAuthorizeWire,
} from "../shared/ext-capability-authorization"
import type { JournalAdminEntry, JournalRetireIntentWire, JournalRetireResult } from "../shared/ext-journal-admin"
import type {
  SessionGrantResultWire,
  SessionGrantWire,
  SessionGrantsEndedEventWire,
} from "../shared/ext-session-grant-wire"
// #408:preload/index.ts 只许 import "./types"(ext-security-boundaries AC4③ 装载路径钉)—— wire 类型经此转口。
export type { SessionGrantsEndedEventWire } from "../shared/ext-session-grant-wire"
import type { ArtifactDescriptor } from "../shared/cloud-artifact-descriptor"
import type { ResolvedSurfaces, SurfaceId } from "../shared/alpha-surfaces"
import type { RecoveryAction, RecoveryActionResult, RecoveryIncidentWire } from "../shared/recovery"
import type {
  AlphaSettings,
  ExtensionStorageResult,
  ExtensionStorageSnapshot,
  SettingsReadResult,
  SettingsValidateResult,
  SettingsWriteResult,
} from "../shared/settings-adapters"
import type {
  AutomationEvent,
  AutomationGlobalState,
  AutomationTask,
  AutomationSchedule,
} from "../shared/automation-types"
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

export type SidecarGenerationReason = "boot" | "token-only" | "structural"
export type SidecarGenerationState = {
  status: "recovering" | "ready"
  generation: number
  reason: SidecarGenerationReason
}

export const STARTUP_TIMELINE_CHANNEL = "startup-timeline-mark"
export const RENDERER_STARTUP_MARK_NAMES = [
  "renderer.root.mount",
  "renderer.composer.mount",
  "renderer.composer.auth_epoch.increment",
  "renderer.home.workspace.provisional_to_real",
  "renderer.home.account_summary.start",
  "renderer.home.account_summary.end",
  "renderer.home.model_list.start",
  "renderer.home.model_list.end",
  "renderer.home.model_list.retry_tick",
  "renderer.sidecar.generation.received",
  "renderer.sse.reconnected",
  "renderer.retry_backoff.cancel",
  "renderer.generation.interruption",
] as const
export type RendererStartupMarkName = (typeof RENDERER_STARTUP_MARK_NAMES)[number]
export type StartupTimelineValue = string | number | boolean | null
export type StartupTimelineExtra = Record<string, StartupTimelineValue>
export type RendererStartupMarkPayload = {
  name: RendererStartupMarkName
  rendererNow: number
  extra?: StartupTimelineExtra
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

// Renderer/preload projection of the safe contract-health wire. The runtime authority and decoder
// remain in @alpha-code/contracts-consumer; this type intentionally carries no producer payload.
export type ContractFailure = {
  code: "contract-incompatible"
  surface: "identity" | "endpoint-discovery" | "account" | "model-catalog" | "cloud-http" | "cloud-mcp" | "artifact"
  expected_version: 1
  received_version: number | "missing" | "unknown"
  reason: "schema-validation" | "size-limit" | "route-purpose-mismatch"
}

// alpha-code ↔ platform auth (see main/alpha-auth.ts + docs/contracts/platform-integration.md). Defined
// here so main, preload and renderer share one shape (the established cross-bundle type pattern).
export type AuthMode = "byok" | "platform"
export type AuthStatus = "logged-out" | "logged-in"
export type AuthState = {
  status: AuthStatus
  mode: AuthMode
  account?: { email?: string; plan?: string }
  expiresAt?: number
  /** 登录态的平台代理凭证是否已经验证可用；过期续期与瞬态恢复窗口必须保持 recovering。 */
  platformStatus?: "ready" | "recovering"
}
// B11 复扫行16:登录链失败原因(main 只送 code,文案由 renderer i18n 映射)。
export type AuthErrorCode =
  | "provider_error"
  | "invalid_callback"
  | "state_mismatch"
  | "exchange_failed"
  | "contract_incompatible"

// alpha account summary — balance / membership / token usage, read from the alpha-platform (B)
// in-region account-server using the stored JWT. Shared cross-bundle like AuthState. Contract:
// alpha-platform docs/contracts/account-billing.md (GET /v1/account/summary).
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
  status: "success" | "failed"
}
/** Result envelope: the payload, or an error code (not-authenticated / unauthorized / http-NNN / network). */
export type AccountResult<T> = T | { error: string }

// Extension-hub install receipts (REQ-018): alpha's record of installed items and the files/config
// keys each install owns. Engine visibility truth remains the SDK (mcp.status / app.skills / …);
// receipts ⨝ SDK drives installed/pending-reload UI states, uninstall and update.
/** REQ-037:治理真源形状(main alpha-governance.ts 与 renderer 共用)。 */
export interface AlphaBuiltinPolicy {
  version: 1
  mode: "denylist" | "allowlist"
  agents: { hide: string[]; disable: string[]; allow: string[]; override: Record<string, Record<string, unknown>> }
  /** REQ-067:deny = 用户自禁;allowFactory = 对「出厂默认禁」项的解禁(出厂禁本身内置、零明文)。 */
  skills: { deny: string[]; allowFactory: string[] }
  commands: { override: Record<string, { template: string; description?: string }> }
}

export type InstallReceiptType = "mcp" | "skill" | "agent" | "command" | "plugin" | "bundle" | "cloud"
export type InstallReceiptScope = "global" | "project"
export type InstallReceiptOrigin = "catalog" | "created" | "imported" | "imported-claude" | "imported-agents"
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
/** REQ-100 #313:key-based 卸载/列代/回滚意图 —— renderer 不供 receipt/绝对路径(ADR-028 §1)。 */
export type UninstallKeyIntent =
  | { type: InstallReceiptType; name: string; scope: "global" }
  | { type: InstallReceiptType; name: string; scope: "project"; projectDir: string }
/** REQ-104 #395:key-based 启停意图(卸载同信任边界 + 目标态)。 */
export type SetStateKeyIntent = UninstallKeyIntent & {
  state: "enabled" | "disabled"
  /** #397:curated 条目复审过期后的 enable 显式确认位(确认对话后重发)。 */
  confirmExpiredReview?: boolean
}
/** #397:enable 闸的机器可判别拒绝码(过期确认 / 会话级拒持久启用 / 审核数据不可核实)。 */
export type SetStateRefusalCodeWire =
  | "session-grant-persistent-enable"
  | "expired-review-confirmation-required"
  | "curation-unverifiable"
/** REQ-100 #313:generation 历史条目(安全元数据面;eligible = 有可读快照可离线回滚)。 */
export type SkillGenerationInfo = {
  genId: string
  current: boolean
  version?: string
  manifestDigest?: string
  installedAt?: string
  eligible: boolean
}
/** Legacy installs found in the shared XDG config dir, offered for migration to .alpha (REQ-018 T3). */
export type LegacyInventory = {
  root: string
  skills: string[]
  agents: string[]
  mcp: { name: string; config: Record<string, unknown> }[]
  plugins: string[]
}
/** REQ-044:迁移候选的 provenance 校验请求/裁决(main 侧与打包资产/catalog 形状比对;只放行 alpha 自装)。 */
export type ProvenanceRequest =
  | { type: "skill"; name: string; builtinAssetKey?: string }
  | {
      type: "mcp"
      name: string
      spec: {
        mcpType: "local" | "remote"
        command?: string[]
        mirrorCommand?: string[]
        url?: string
        requiredEnvVars?: string[]
        headerNames?: string[]
      }
    }
  | { type: "plugin"; name: string; package: string }
export type ProvenanceVerdict = { type: "skill" | "mcp" | "plugin"; name: string; verified: boolean; reason: string }
/** Install destination: the frozen current-environment root or a specific project's .alpha. */
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
  schema_version: 1
  job_id: string
  status: "queued"
  autonomy: "pipeline" | "bounded-agent"
  kind?: string
  urls: { status: string; events: string; result: string }
}
export type CloudJobStatus = {
  schema_version: 1
  job_id: string
  status: "queued" | "running" | "blocked" | "completed" | "failed" | "cancelled"
  autonomy: "pipeline" | "bounded-agent"
  kind?: string
  progress: { phase: string; completed_steps?: number; total_steps?: number }
  counters?: { model_calls: number; tokens_in: number; tokens_out: number; cost_usd: number }
  artifact_ids: string[]
  /** REQ-092:平台 status 现携带 descriptor 数组(schemaVersion=1;旧部署缺省)。 */
  artifacts?: CloudArtifactDescriptor[]
  result?: unknown
  error: string | null
}
/** REQ-092 跨端 artifact descriptor(镜像真相源 shared/cloud-artifact-descriptor.ts ← 平台 PR #42)。 */
export type CloudArtifactDescriptor = ArtifactDescriptor
/** artifacts 列表条目:新平台 = 完整 descriptor + 便利字段(mime/content_url);旧部署 = 纯 meta。
 *  两种形态都零内容字段 —— 内容唯一经 main 的流式下载 IPC(REQ-092 AC#1/#5)。 */
export type CloudArtifactMeta = {
  id: string
  name?: string
  mime?: string
  size?: number
  sha256?: string
  content_url?: string
} & Partial<Omit<CloudArtifactDescriptor, "id" | "name" | "size" | "sha256">>
export type CloudArtifactList = {
  schema_version: 1
  job_id: string
  status: CloudJobStatus["status"]
  artifacts: CloudArtifactDescriptor[]
  artifact_ids: string[]
  result: unknown
}
/** REQ-092:下载进度(main 推送;IPC 上只有计数,永远没有内容字节)。 */
export type CloudArtifactProgress = {
  runId: string
  artifactId: string
  bytes: number
  total?: number
  percent?: number
}
/** REQ-092:下载结果 —— 落盘路径 + 完整性结论,或分类错误码(错误文案已剥 token)。 */
export type CloudArtifactDownloadResult =
  | {
      ok: true
      path: string
      bytes: number
      sha256: string
      verification: "verified" | "unverified"
      via: "stream"
    }
  | { ok: false; error: string; detail?: string }
/** B3/ADR-019 artifact 回流:写 <projectDir>/.alpha/runs/<runId>/ 的结果清单(main 侧 alpha-workdir.ts)。 */
export type CloudRunManifest =
  | { ok: true; dir: string; files: string[]; warnings: string[] }
  | { ok: false; reason: string }
/** SSE 进度事件(job.snapshot / job.started / job.running / workflow.step.completed / job.completed|failed|cancelled / error)。 */
export type CloudJobEvent = { event: string; data: unknown; id?: string }
/** Same shape as AccountResult; distinct alias for the cloud jobs surface. */
export type CloudResult<T> = T | { error: string }
export type UploadFindingKind = "contact" | "identity" | "credential" | "protected" | "unknown"
export type UploadPreview = {
  pipeline: "code-review"
  fileCount: number
  totalBytes: number
  files: Array<{ path: string; sizeBytes: number; sensitive: boolean }>
  findings: Array<{ kind: UploadFindingKind; fileCount: number }>
  purpose: "artifact.upload"
  retentionClass: "standard"
}
export type CloudUploadIntent = { kind: "code-review" }
export type CloudUploadResult =
  | { status: "consent-required"; requestId: string; preview: UploadPreview }
  | { status: "sent"; privacy: "clear" | "confirmed"; job: CloudDispatchResult; directory: string }
  | { status: "cancelled" }
  | {
      status: "failed"
      error:
        | "not-authenticated"
        | "upload-selection-invalid"
        | "upload-file-limit"
        | "upload-size-limit"
        | "upload-control-limit"
        | "upload-path-invalid"
        | "upload-file-unreadable"
        | "upload-not-text"
        | "upload-consent-issuance-failed"
        | "upload-consent-invalid"
        | "upload-dispatch-failed"
        | "upload-main-gate-required"
    }
/** B gateway /v1/models 的一条 live 模型(真相源 allowlist)。 */
export type PlatformLiveModel = { id: string; provider?: string; minPlan?: string }

// REQ-093(#185):run artifact manifest 只读查询面的共享形状。真源在 main 侧 electron-free 模块
// (artifact-manifest / artifact-service);type-only 引入,renderer 拿到 descriptor + 本地状态
// (savedPath 为 run 目录内相对路径 —— 响应内无绝对路径、无 bearer)。
import type {
  ArtifactInspectResult,
  ArtifactReadRef,
  ArtifactReadResult,
  ProjectUsageResult,
  RunArtifactsListResult,
  RunUsageResult,
} from "../main/artifact-service"
import type { ArtifactExternalOpenResult } from "../main/artifact-external-open"
import type {
  ArtifactQuickLookResult,
  RunArtifactIdentity,
} from "../main/artifact-quick-look"
export type {
  ArtifactInspectResult,
  ArtifactReadRef,
  ArtifactReadResult,
  LegacyRunFile,
  ProjectArtifactUsage,
  ProjectUsageResult,
  RunArtifactUsage,
  RunArtifactsListResult,
  RunUsageResult,
} from "../main/artifact-service"
export type {
  ArtifactManifestV1,
  LocalArtifactRecord,
  LocalArtifactState,
  ManifestArtifactEntry,
} from "../main/artifact-manifest"

// REQ-103(#195):governance 只读视图形状(真源 main/ext-inventory.ts;shared/ext-ownership +
// ext-states 的五维/三态纯值)。
import type { ExtInventory } from "../main/ext-inventory"
export type { InventoryRow, ExtInventory } from "../main/ext-inventory"

// REQ-096(#188):隔离 HTML preview 控制通道形状(真源 shared/html-preview.ts;host 本体在
// main/html-preview-host.ts)。renderer 只见 opaque previewId —— 一次性 host 的 URL/token、
// 文件字节与绝对路径永不过 IPC。
import type { HtmlPreviewClosedEvent, HtmlPreviewOpenResult, HtmlPreviewStatus } from "../shared/html-preview"
export type {
  HtmlPreviewClosedEvent,
  HtmlPreviewCloseReason,
  HtmlPreviewOpenResult,
  HtmlPreviewStatus,
} from "../shared/html-preview"

/** REQ-098:App 运行环境快照(main 启动时由打包状态 + 构建渠道解析后冻结;renderer 只读,无写面)。 */
export type AlphaEnvironmentInfo = {
  environment: "prod" | "beta" | "dev"
  registryChannel: "stable" | "preview" | "dev"
  buildChannel: "dev" | "beta" | "prod"
  packaged: boolean
  /** 本环境的可变状态根(config/receipts/grants/secret refs/enabled state 的分域落点)。 */
  mutableRoot: string
  /** 共享 canonical 基根(REQ-102:CAS 落 <casBaseRoot>/cas,三环境 mutable root 落 env/ 下)。 */
  casBaseRoot: string
  /** base 由 unpackaged override 或内部 onboarding 隔离参数提供。 */
  rootOverridden: boolean
  updaterFeedChannel: "latest" | "beta" | null
}

export type ElectronAPI = {
  killSidecar: () => Promise<void>
  sidecarGeneration: {
    getState: () => Promise<SidecarGenerationState>
    subscribe: (cb: (state: SidecarGenerationState) => void) => () => void
  }
  startupTimeline: {
    mark: (name: RendererStartupMarkName, rendererNow: number, extra?: StartupTimelineExtra) => void
  }
  contracts: {
    health: () => Promise<ContractFailure | null>
    subscribe: (cb: (failure: ContractFailure) => void) => () => void
  }
  recovery: {
    onIncident: (cb: (incident: RecoveryIncidentWire) => void) => () => void
    submit: (request: { incident: string; action: RecoveryAction }) => Promise<RecoveryActionResult>
  }
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
  /** REQ-090:authoritative default.dat/settings.v3 adapter; failures expose stable codes only. */
  settings: {
    read: () => Promise<SettingsReadResult>
    validate: (value: unknown) => Promise<SettingsValidateResult>
    write: (input: { value: AlphaSettings; expectedRevision: string }) => Promise<SettingsWriteResult>
  }
  /** REQ-090/#253:manual CAS GC; renderer receives only the closed aggregate projection. */
  extensionStorage: {
    snapshot: () => Promise<ExtensionStorageSnapshot>
    inspect: () => Promise<ExtensionStorageResult>
    collect: () => Promise<ExtensionStorageResult>
  }

  getWindowCount: () => Promise<number>
  onMenuCommand: (cb: (id: string) => void) => () => void
  onDeepLink: (cb: (urls: string[]) => void) => () => void

  openDirectoryPicker: (opts?: {
    multiple?: boolean
    title?: string
    defaultPath?: string
  }) => Promise<string | string[] | null>
  /** REQ-071/ADR-025:`~/Alpha` 默认用户工作目录路径(只查询,不建目录)。 */
  workspaceDefaultDir: () => Promise<string>
  /** lazy 供给:dir 省略或等于默认工作目录时创建并返回;其他路径 no-op(ok:false)。 */
  workspaceEnsureDefault: (dir?: string) => Promise<{ ok: boolean; dir?: string }>
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
  /** win32 专用:弹原生应用菜单(frameless 无菜单栏的可见入口;非 win32 无 handler,调用即拒绝)。REQ-076。 */
  popupAppMenu: () => Promise<void>
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
  /** REQ-098:App 环境快照(只读)。main 启动时解析后冻结;此 IPC 无参数、无对应写面 —— renderer
   *  既不能伪造环境,也没有任何通道改写环境根(AC#6)。 */
  environment: () => Promise<AlphaEnvironmentInfo>
  /** REQ-084/090:启动期 surface 选择 + crash admission。main 按 crashID 建立唯一 incident，
   *  renderer 只能持有安全 Recovery DTO；失败 surface 留在 Alpha 区域，不得回退 legacy。 */
  surfaces: {
    resolve: () => Promise<ResolvedSurfaces>
    reportFailure: (payload: { crashID: string; surface: SurfaceId }) => Promise<RecoveryIncidentWire>
  }
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
    /** B11 复扫行16:登录链失败(provider 拒绝/回调残缺/state 不匹配/兑换失败)→ toast 呈现。 */
    onError: (cb: (e: { code: AuthErrorCode }) => void) => () => void
  }
  // Extension Hub (定制中心): thin privileged operations the renderer can't do itself. persistMcp
  // writes the user's opencode.jsonc (durable); the live add/connect happens in the renderer over
  // the SDK. See ADR-014 §4/§8.
  ext: {
    /** 未策展 MCP 通道(catalog 外自定义连接器专用;REQ-099 #305:不收 meta —— 未策展安装
     *  拿不到 catalog 身份,防伪造 catalog 来源;catalog MCP 走 installCatalog)。 */
    persistMcp: (
      name: string,
      server: Record<string, unknown>,
      /** env var names in server.environment whose values are secrets → routed to the {file:} channel */
      secretVars?: string[],
    ) => Promise<{ ok: true } | { ok: false; reason: string }>
    removeMcp: (name: string) => Promise<{ ok: true } | { ok: false; reason: string }>
    checkRuntime: (tool: string) => Promise<{ ok: boolean }>
    // B11/B23:全局配置健康(broken=引擎会整份忽略用户配置)
    configHealth: () => Promise<{ broken: boolean; reason?: string; path?: string }>
    /** REQ-036 出厂技能名单(skills.paths 注入的技能名;ALPHA_FACTORY_SKILLS_DISABLE 时为空)——
     *  hub 用来把对应 catalog 条目标成「出厂内置」而非「可安装」(S18 X1)。 */
    factorySkillIds: () => Promise<string[]>
    /** REQ-037 上游能力治理(真源 <current-environment-root>/governance.json;物化 home jsonc 受控叶子,apply 后
     *  renderer 需自行 refreshEngine() 使 dispose 热生效)。 */
    builtinRead: () => Promise<{
      gov: AlphaBuiltinPolicy
      protection: { hard: string[]; alphaInjected: string[]; confirm: string[] }
      factoryDenied: string[]
    }>
    builtinApply: (
      gov: AlphaBuiltinPolicy,
      visibleAgents: string[],
      confirmBuildDisable?: boolean,
    ) => Promise<{
      ok: boolean
      reason?: string
      violations: { kind: string; name: string; reason: string }[]
      written: number
      removedStale: number
    }>
    builtinReset: () => Promise<{ ok: boolean; reason?: string }>
    /** REQ-033:agent 导入两段式(codex 审计后:preview 经 picker token 授权读,confirm 只收
     *  previewId —— 写入内容为 main 侧留存的 preview 产物,renderer 不可提供内容)。 */
    importAgentPreview: (
      token: string,
      filePath: string,
    ) => Promise<
      | {
          ok: true
          previewId: string
          name: string
          format: "opencode" | "claude-code"
          mapping: Array<{ source: string; value: string; target: string | null; note: string }>
          composed: string
        }
      | { ok: false; reason: string }
    >
    importAgentConfirm: (previewId: string) => Promise<{ ok: true; files?: string[] } | { ok: false; reason: string }>
    /** REQ-032:远程 catalog(main 拉取+ed25519 验签+ETag 缓存;source 指示回退层级,renderer 内置兜底)。
     *  REQ-098 #302:通道 = main 冻结环境快照(renderer 无输入权);via = 传输面,channel = 内容通道
     *  (结构化,勿解析 via)。 */
    remoteCatalog: () => Promise<
      | {
          source: "remote" | "cache"
          catalog: unknown
          version: string
          fetchedAt: string
          error?: string
          via: string
          channel: "stable" | "preview" | "dev"
        }
      | { source: "none"; error: string }
    >
    /** REQ-104 #397:SBOM(kind="sbom")/ 来源溯源(kind="provenance")blob 按需拉取。
     *  合同 §7.3 采信前置全在 main(bytes/sha256 精确匹配 + canonical 字节复验 + 剖面校验,
     *  拒重定向,5MiB 帽);renderer 零 URL/digest 输入权。失败不影响货架/启用判定,详情面
     *  如实报错;重试 = 重调本方法。 */
    curationBlob: (
      catalogId: string,
      kind: "sbom" | "provenance",
    ) => Promise<
      { ok: true; kind: "sbom" | "provenance"; sha256: string; data: unknown } | { ok: false; reason: string }
    >
    /** REQ-102 #316:packaged seed 浏览(main-owned 纯读安全投影 —— 零绝对路径/blob 布局/url;
     *  availability=bundled 与激活态正交;选装走 installCatalog 的 seed 意图,UI 归 REQ-103)。 */
    browseSeed: () => Promise<
      | {
          ok: true
          catalogVersion: string
          totalBytes: number
          hasNotice: boolean
          assets: Array<{
            id: string
            type: string
            version: string
            license: string
            source: string
            bytes: number
            fileCount: number
            availability: "bundled"
            platformCompatible: boolean
          }>
        }
      | { ok: false; reason: string }
    >
    /** 未策展 npm 插件通道(REQ-099 #305:不收 meta,同 persistMcp 理由;catalog 插件走 installCatalog)。 */
    installPlugin: (pkg: string) => Promise<{ ok: true } | { ok: false; reason: string }>
    /** REQ-100 #311 / REQ-099 #305:main-owned catalog 安装唯一入口(mcp/plugin/skill/agent/cloud/bundle)。
     *  liveMcp = 策略后配置 + 密钥真值(真值只可能是 renderer 本次 grants 交来的 —— 契约:main 绝不
     *  经此回传 keychain/main 侧来源的密钥),renderer 拿去 sdk.mcp.add 免重启连接。 */
    installCatalog: (
      intent:
        | {
            catalogId: string
            scope: { scope: "global" } | { scope: "project"; projectDir: string }
            grants?: {
              secrets?: Record<string, string>
              env?: Record<string, string>
              workspace?: string
              cnMirror?: boolean
            }
            /** #348:stage="authorize" 确认后的重驱决定(只交 confirmed;decidedAt 由 main 打戳)。 */
            authorization?: AuthorizationConfirmationWire
          }
        /** REQ-102 #317:选中随包 seed 资产安装(skill/global-only 首期);字节从共享 CAS 事务物化,
         *  seedDir/清单/版本/receipt 语义全 main-owned。 */
        | {
            source: "seed"
            assetId: string
            scope: { scope: "global" }
            authorization?: AuthorizationConfirmationWire
          },
    ) => Promise<
      | {
          ok: true
          kind: string
          name: string
          manifestDigest?: string
          liveMcp?: { name: string; config: Record<string, unknown> }
          installedDisabled?: true
          installed?: string[]
          skipped?: Array<{ id: string; reason: string }>
          warning?: string
        }
      /** #348:capability 授权闸 —— 零权威副作用暂停,带逐 item diff;确认后带 authorization 重驱同一通道。
       *  真判别联合(review minor):非 authorize 分支的 stage 类型排除 "authorize",中间层丢 diff 过不了类型检查。 */
      | { ok: false; stage: "authorize"; reason: string; authorization: CapabilityDiffWire[] }
      | { ok: false; reason: string; stage?: TxStageNonAuthorizeWire }
    >
    // REQ-019 T3:详情页 SKILL.md 预览(只读,资产键校验 + 256KB 帽;未打包时诚实失败)
    readBuiltinSkill: (
      builtinAssetKey: string,
    ) => Promise<{ ok: true; content: string } | { ok: false; reason: string }>
    // REQ-019 T6:导入。folder = main 自弹目录选择器,用户实选目录即来源(REQ-098 #255:renderer
    // 不再传 srcDir),校验 SKILL.md frontmatter → 复制入 .alpha + receipt(imported);git = https-only
    // 浅克隆临时目录 → 同校验。外来内容绝不执行,symlink 不复制。
    /** #336 r1:成功臂 warning = loud 诊断透传;projectionLag = 账本已 durable 但 skills 允许集
     *  发布失败(本次未注入,重启自愈)—— renderer 必须据此呈现「重启后生效」级提示。 */
    importSkillFolder: (
      target?: InstallTarget,
    ) => Promise<
      | { ok: true; files?: string[]; name?: string; warning?: string; projectionLag?: string }
      | { ok: false; canceled?: boolean; reason: string }
    >
    importSkillGit: (
      url: string,
      target?: InstallTarget,
    ) => Promise<
      | { ok: true; files?: string[]; name?: string; warning?: string; projectionLag?: string }
      | { ok: false; reason: string }
    >
    // REQ-018 安装账本:current-environment global + project(<dir>/.alpha) receipts 合并只读视图
    listInstalls: (projectDir?: string) => Promise<InstallLedgerView>
    /** REQ-100 #313:key-based v2 卸载 —— renderer 只提供 type/name/scope,receipt 事实由 main
     *  账本自查(ADR-028 §1);generation skill 走锁内 journaled store+ledger teardown。 */
    uninstallV2: (
      intent: UninstallKeyIntent,
    ) => Promise<{ ok: true; files?: string[]; warning?: string } | { ok: false; reason: string }>
    /** REQ-104 #395:key-based 启停 —— main 按账本自查。写序 = 账本翻转 + alpha.jsonc config 投影
     *  (两次写 + 失败补偿,非单事务);mcp/agent 的禁用**权威由 sidecar 注入 OPENCODE_CONFIG_CONTENT
     *  保证**(引擎最后加载 override),alpha.jsonc 投影仅 consistency;plugin 禁用 = 从 alpha.jsonc
     *  plugin[] 移除;skill 纯账本翻转(投影 = 引擎侧按账本注入)。enable 过 advisory 闸(R14)。 */
    setInstallState: (
      intent: SetStateKeyIntent,
    ) => Promise<{ ok: true; warning?: string } | { ok: false; reason: string; code?: SetStateRefusalCodeWire }>
    /** #397 PR-B:浏览/推荐面的公示阻断事实(main 派生已验公示;ids = 拦新激活的条目)。 */
    advisoryActive: () => Promise<{ ids: string[]; fresh: boolean }>
    /** REQ-100 #313:某 skill 的 generation 历史(current + 保留代)。只透安全元数据,不外泄绝对路径。 */
    listGenerations: (
      intent: UninstallKeyIntent,
    ) => Promise<{ ok: true; generations: SkillGenerationInfo[] } | { ok: false; reason: string }>
    /** REQ-100 #313:两版离线回滚 —— 目标 gen 健康门 + 锁内翻指针 + receipt 修订;任一前置失败零变更。 */
    rollback: (
      intent: UninstallKeyIntent,
      genId: string,
    ) => Promise<{ ok: true; previous: string | null } | { ok: false; reason: string }>
    // REQ-018 T3:存量迁移(旧 XDG 根 → .alpha)。scan 报告 legacy 清单 + enabled 门控;removeLegacy 删旧位。
    migrateScan: () => Promise<{ enabled: boolean; inventory: LegacyInventory }>
    // REQ-044:候选 provenance 终审(排除项 main.log [req044-provenance] 留痕)。
    migrateVerify: (requests: ProvenanceRequest[]) => Promise<ProvenanceVerdict[]>
    removeLegacy: (
      type: "skill" | "agent" | "mcp" | "plugin",
      name: string,
    ) => Promise<{ ok: true; removed: string[] } | { ok: false; reason: string }>
    /** REQ-060 信任门:项目含可执行扩展且未决策 → main 弹 per-project 确认;granted 后调用方 dispose 生效。 */
    trustCheck: (directory: string) => Promise<{ prompted: boolean; granted: boolean; persistError?: string }>
    /** REQ-063 外部生态导入门:项目含 .claude/.agents skills / CLAUDE.md 且未决策 → main 弹确认;
     *  「导入」= 转换落项目 .alpha(imported 后调用方 dispose 生效)。 */
    externalCheck: (directory: string) => Promise<{
      prompted: boolean
      imported: boolean
      importedSkills: string[]
      skipped: Array<{ name: string; reason: string }>
      claudeMd: "agents-md-created" | "agents-md-exists" | "none"
      persistError?: string
    }>
    /** ADR-030(#372):收回的 project 受管安装 —— 残留只读检测(项目打开位点另有 loud 日志)。
     *  unknown 店 / orphan agent 面 = 只报告;cleanBlockers = 账本失据,清理会整单拒。 */
    projectResidualsCheck: (projectDir: string) => Promise<
      | {
          ok: true
          projectPath: string
          catalogRecords: Array<{ type: string; name: string; hasStore: boolean }>
          ghostStoreKeys: string[]
          unknownStoreEntries: string[]
          orphanAgentFiles: string[]
          orphanAgentConfigEntries: string[]
          openJournals: Array<{ txId: string; op: string; state: string; terminal: boolean }>
          cleanBlockers: string[]
          warnings: string[]
        }
      | { ok: false; reason: string }
    >
    /** ADR-030(#372):显式清理(journal/账本失据 fail-closed;只删账本可证明的受控面)。
     *  #336:任一删账失败 → 整单 ok:false(cleaned/failed/reported 保留如实进度;幂等可重试)。 */
    projectResidualsClean: (
      projectDir: string,
    ) => Promise<
      | { ok: true; cleaned: string[]; reported: string[] }
      | {
          ok: false
          reason: string
          cleaned?: string[]
          failed?: Array<{ item: string; reason: string }>
          reported?: string[]
        }
    >
    /** REQ-100 #375:保留态 journal 只读诊断(global 三环境根恒聚合;projectDir 可选)。
     *  entries = 判别联合(kind: retained/already-quarantined/malformed-entry/unreadable-root/
     *  retire-incomplete);renderer 按 kind 分派(UI 归 Hub)。 */
    journalRetainedList: (intent?: {
      projectDir?: string
    }) => Promise<{ entries: JournalAdminEntry[] } | { ok: false; reason: string }>
    /** REQ-100 #375:显式 retire(entryId+fingerprint 定位;两个确认 flag 必须字面 true;
     *  UI 归 Hub —— 本通道只登记合同)。 */
    journalRetire: (intent: JournalRetireIntentWire) => Promise<JournalRetireResult>
    /** REQ-103(#195)governance 只读查询:逐扩展五维所有权 + availability/activation/health 三态
     *  (main 聚合真源 ext-inventory.ts;纯 JSON)。唯一 governance 通道 —— 无任何写面。 */
    inventoryView: (projectDir?: string) => Promise<ExtInventory>
    /** #408:labs(session-grant)条目的会话级启用。grant 纯 main 内存(sidecar 代际栅栏),
     *  零持久面(账本/config/注入 env 全不动)。ok 后调用方须对**同 directory** 调引擎
     *  POST /mcp/:name/connect 热连;引擎 global.disposed 后须经本通道 re-assert(重校验失败 =
     *  旧 grant 已被 main 撤下,开关必须回落)。复审过期拒绝码 = expired-review-confirmation-required,
     *  带 confirmExpiredReview:true 重试。 */
    sessionGrant: (input: {
      catalogId: string
      directory: string
      confirmExpiredReview?: boolean
    }) => Promise<SessionGrantResultWire>
    /** #408:撤销(幂等;directory 维度 —— 只撤该 instance 空间的授权,调用方随后对同 directory
     *  调 /mcp/:name/disconnect)。同条目多 directory 激活 = 多条 grant,经 sessionGrants 枚举可尽撤。 */
    sessionGrantRevoke: (input: {
      catalogId: string
      directory: string
    }) => Promise<{ ok: true } | { ok: false; reason: string; code: "session-grant-refused" }>
    /** #408:当前会话的 grant 全集(会话结束/未启动 = 空;含各 grant 的 directory)。 */
    sessionGrants: () => Promise<{ grants: SessionGrantWire[] }>
    /** #408:会话结束事件(蓄意停止 = sidecar-stop / 崩溃 = sidecar-exit)—— 收到即把全部会话
     *  开关归位;respawn 后的 renderer reload 重查空集 = 双保险。返回退订函数。 */
    onSessionGrantsEnded: (cb: (e: SessionGrantsEndedEventWire) => void) => () => void
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
    /** Grandfathered input.diff/code-review dispatch. Explicit files use upload below. */
    dispatch: (envelope: CloudJobEnvelope) => Promise<CloudResult<CloudDispatchResult>>
    /** Main picks, reads, classifies and freezes explicit files. Sensitive scope returns a preview only. */
    upload: (intent: CloudUploadIntent) => Promise<CloudUploadResult>
    confirmUpload: (requestId: string) => Promise<CloudUploadResult>
    cancelUpload: (requestId: string) => Promise<CloudUploadResult>
    status: (jobId: string) => Promise<CloudResult<CloudJobStatus>>
    cancel: (jobId: string) => Promise<CloudResult<{ job_id: string; status: string }>>
    artifacts: (jobId: string) => Promise<CloudResult<CloudArtifactList>>
    /** REQ-092:descriptor-only 下载 —— renderer 只送 descriptor/meta,main 流式写入
     *  <directory>/.alpha/runs/<runId>/artifacts/(bearer 与内容字节都不过 IPC);
     *  进度经 onArtifactProgress 推回,结果 = 落盘路径或分类错误。 */
    downloadArtifact: (
      directory: string,
      runId: string,
      artifact: CloudArtifactMeta | CloudArtifactDescriptor,
    ) => Promise<CloudArtifactDownloadResult>
    /** 取消本窗口对该 artifact 的进行中下载(main abort → .part 清理,结果回 cancelled)。 */
    cancelArtifactDownload: (artifactId: string) => Promise<{ ok: boolean }>
    /** 订阅下载进度(既有事件订阅 preload 模式;返回退订函数)。 */
    onArtifactProgress: (cb: (p: CloudArtifactProgress) => void) => () => void
    // B3/ADR-019 回流:终态后把 run(status/contract/artifacts)写进 <directory>/.alpha/runs/<runId>/。
    saveRun: (directory: string, runId: string, contract?: CloudJobEnvelope) => Promise<CloudRunManifest>
    // 订阅 SSE 进度:main 流式 /events → 推 cloud-job-event。onEvent 注册监听,返回取消函数。
    subscribe: (jobId: string) => Promise<{ ok: boolean }>
    unsubscribe: (jobId: string) => Promise<{ ok: boolean }>
    onEvent: (cb: (payload: { jobId: string } & CloudJobEvent) => void) => () => void
    // REQ-020 T4(ADR-021 §1 diff-only):hub code-review dispatch 的 diff 采集。工作树有变更取
    // `git diff HEAD`,干净树回退最近一次 commit;非 git 仓库/无 diff 诚实报错。
    gitDiff: (
      directory: string,
    ) => Promise<{ ok: true; diff: string; source: "worktree" | "last-commit" } | { ok: false; reason: string }>
  }
  // REQ-093(#185):run artifact manifest 只读查询(artifacts.json + 磁盘 reconcile)。刻意无写面:
  // 下载归 cloud artifact 通道(#184),删除/GC 是 main 内部服务钩子(保留策略未定前不暴露)。
  runArtifacts: {
    /** manifest + 磁盘 reconcile 列表(missing/mismatch 降级持久化;legacy 文件只读发现)。 */
    list: (directory: string, runId: string) => Promise<RunArtifactsListResult>
    /** 按 artifact id 解析 descriptor + 本地状态。 */
    inspect: (directory: string, runId: string, artifactId: string) => Promise<ArtifactInspectResult>
    /** 单 run 字节/件数核算(manifest 账面 + 盘上 stat 真相)。 */
    usage: (directory: string, runId: string) => Promise<RunUsageResult>
    /** 项目级(managed project)核算 + 集中基线数字(REQ-093 §5;执行策略不在此)。 */
    projectUsage: (directory: string) => Promise<ProjectUsageResult>
    /** REQ-093 AC#4「打开前复核」钩子(#186):全量 sha256 比对,不符降级持久化。 */
    verify: (directory: string, runId: string, artifactId: string) => Promise<ArtifactInspectResult>
    /** REQ-094/095(#186/#187)受控内容读取 —— Workbench 预览唯一取字节入口:
     *  只可寻址 run artifacts/ 内文件;text ≤2 MiB 截断 + 诚实标记;bytes ≤20 MiB 超限拒绝。 */
    read: (
      directory: string,
      runId: string,
      ref: ArtifactReadRef,
      opts?: { mode?: "text" | "bytes"; maxBytes?: number },
    ) => Promise<ArtifactReadResult>
    /** Main-owned external open:identity-only input,manifest path re-resolution,and byte gate. */
    openExternal: (directory: string, runId: string, artifactId: string) => Promise<ArtifactExternalOpenResult>
    /** Main-owned macOS Quick Look:one identity object in,manifest containment + OOXML PASS re-check. */
    quickLook: (identity: RunArtifactIdentity) => Promise<ArtifactQuickLookResult>
  }
  // REQ-096(#188):隔离 HTML artifact preview 控制通道 —— main-owned 一次性静态 host
  // (html-preview-host.ts:独立 sandboxed 窗口、零 preload、一次性 partition/token)。
  // renderer 只拿 opaque previewId;字节/绝对路径/host URL/token 永不过 IPC。
  htmlPreview: {
    /** 打开隔离预览(manifest + ADR-019 守卫全过才开窗;并发上限内)。 */
    open: (directory: string, runId: string, artifactId: string) => Promise<HtmlPreviewOpenResult>
    /** 关闭预览(窗口销毁 → token 失效 → 一次性 partition 清空;幂等)。 */
    close: (previewId: string) => Promise<{ ok: boolean }>
    /** 存活性 + 被阻止资源清单(REQ-096 交付 7 供数;已关闭/未知 id 一律 ok:false)。 */
    status: (previewId: string) => Promise<HtmlPreviewStatus>
    /** 预览关闭/崩溃推送(用户直接关窗也会触发;返回退订函数)。 */
    onClosed: (cb: (e: HtmlPreviewClosedEvent) => void) => () => void
  }
  // 自动化定时任务(REQ-021 A1/ADR-022):CRUD + 全局暂停 + 登录时启动;调度/执行全在 main,
  // renderer 只读列表(含 nextFireAt/running 计算态)并订阅 automation-event 推送。
  automations: {
    list: () => Promise<{
      tasks: (AutomationTask & { nextFireAt: number | null; running: boolean })[]
      state: AutomationGlobalState
      loginItem: boolean
    }>
    save: (task: AutomationTask) => Promise<{ ok: true } | { ok: false; reason: string }>
    remove: (id: string) => Promise<{ ok: true } | { ok: false; reason: string }>
    toggle: (id: string, enabled: boolean) => Promise<{ ok: true } | { ok: false; reason: string }>
    pauseAll: (paused: boolean) => Promise<{ ok: true }>
    /** A2:立即运行(不改 next-fire;占并发位;计日 cap)。 */
    runNow: (id: string) => Promise<{ ok: true } | { ok: false; reason: string }>
    /** A2:LLM 辅助解析(规则失败时用户显式触发;临时会话一次抽取即删)。 */
    nlLlm: (
      text: string,
      projectDir: string,
    ) => Promise<
      { ok: true; name: string; schedule: AutomationSchedule; prompt: string } | { ok: false; reason: string }
    >
    /** A3:云侧状态回读(schedules=null 即离线)+ 错过 run 拉回。 */
    cloudSync: () => Promise<{
      schedules: Array<{ id: string; enabled: boolean; next_fire_at: number; disabled_reason: string | null }> | null
      pulled: { pulled: number } | { error: string }
    }>
    /** 读(无参)/写(带参)「登录时启动」。 */
    loginItem: (open?: boolean) => Promise<{ openAtLogin: boolean }>
    onEvent: (cb: (event: AutomationEvent) => void) => () => void
  }
  // alpha model catalog for the model picker. REQ-001:catalog = effective 视图(内置 snapshot 按
  // B 网关 edition 白名单收窄 + liveSync 来源标注);platformLive 拉取顺带刷新本地白名单缓存。
  models: {
    catalog: () => Promise<EffectiveCatalog>
    platformLive: () => Promise<
      CloudResult<{ models: PlatformLiveModel[]; edition?: string; byokProviders: string[] | null }>
    >
  }
  // custom provider add/test (writes alpha.jsonc provider[], respawns sidecar; 1-token probe).
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
