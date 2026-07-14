import type { DesktopMenuAction } from "@opencode-ai/app/desktop-menu"
import type { WslServersPlatform } from "@opencode-ai/app/wsl/types"
import type { UpdaterState } from "@opencode-ai/app/updater"
import type { AlphaEndpoints } from "../shared/alpha-config"
import type { ArtifactDescriptor } from "../shared/cloud-artifact-descriptor"
import type { ResolvedSurfaces, SurfaceId } from "../shared/alpha-surfaces"
import type { AutomationEvent, AutomationGlobalState, AutomationTask, AutomationSchedule } from "../shared/automation-types"
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

// alpha-code ↔ platform auth (see main/alpha-auth.ts + docs/contracts/platform-integration.md). Defined
// here so main, preload and renderer share one shape (the established cross-bundle type pattern).
export type AuthMode = "byok" | "platform"
export type AuthStatus = "logged-out" | "logged-in"
export type AuthState = {
  status: AuthStatus
  mode: AuthMode
  account?: { email?: string; plan?: string }
  expiresAt?: number
}
// B11 复扫行16:登录链失败原因(main 只送 code,文案由 renderer i18n 映射)。
export type AuthErrorCode = "provider_error" | "invalid_callback" | "state_mismatch" | "exchange_failed"

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
  status: "success" | "pending"
}
/** Result envelope: the payload, or an error code (not-authenticated / unauthorized / http-NNN / network). */
export type AccountResult<T> = T | { error: string }

// Extension-hub install receipts (REQ-018): alpha's record of installed items and the files/config
// keys each install owns. Engine visibility truth remains the SDK (mcp.status / app.skills / …);
// receipts ⨝ SDK drives installed/pending-reload UI states, uninstall and update.
/** REQ-037:治理真源形状(main alpha-governance.ts 与 renderer 共用)。 */
export interface AlphaGovernance {
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
  /** REQ-092:平台 status 现携带 descriptor 数组(schemaVersion=1;旧部署缺省)。 */
  artifacts?: CloudArtifactDescriptor[]
  result?: unknown
  error: string | null
}
/** REQ-092 跨端 artifact descriptor(镜像真相源 shared/cloud-artifact-descriptor.ts ← 平台 PR #42)。 */
export type CloudArtifactDescriptor = ArtifactDescriptor
/** artifacts 列表条目:新平台 = 完整 descriptor + 便利字段(mime/content_url);旧部署 = 纯 meta。
 *  两种形态都零内容字段 —— 内容唯一经 main 的流式下载 IPC(REQ-092 AC#1/#5)。 */
export type CloudArtifactMeta = { id: string; name?: string; mime?: string; size?: number; sha256?: string; content_url?: string } & Partial<
  Omit<CloudArtifactDescriptor, "id" | "name" | "size" | "sha256">
>
export type CloudArtifactList = { job_id: string; status: string; artifacts: CloudArtifactMeta[]; artifact_ids: string[]; result?: unknown }
/** REQ-092:下载进度(main 推送;IPC 上只有计数,永远没有内容字节)。 */
export type CloudArtifactProgress = { runId: string; artifactId: string; bytes: number; total?: number; percent?: number }
/** REQ-092:下载结果 —— 落盘路径 + 完整性结论,或分类错误码(错误文案已剥 token)。 */
export type CloudArtifactDownloadResult =
  | { ok: true; path: string; bytes: number; sha256: string; verification: "verified" | "unverified"; via: "stream" | "inline-compat" }
  | { ok: false; error: string; detail?: string }
/** B3/ADR-019 artifact 回流:写 <projectDir>/.alpha/runs/<runId>/ 的结果清单(main 侧 alpha-workdir.ts)。 */
export type CloudRunManifest = { ok: true; dir: string; files: string[]; warnings: string[] } | { ok: false; reason: string }
/** SSE 进度事件(job.snapshot / job.started / job.running / workflow.step.completed / job.completed|failed|cancelled / error)。 */
export type CloudJobEvent = { event: string; data: unknown; id?: string }
/** Same shape as AccountResult; distinct alias for the cloud jobs surface. */
export type CloudResult<T> = T | { error: string }
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
  /** 旧单根布局根(迁移的只读 source;dev 环境下 = mutableRoot)。 */
  legacyRoot: string
  /** ALPHA_GLOBAL_DIR 预置覆盖生效(测试隔离/开发者显式 export)。 */
  rootOverridden: boolean
  updaterFeedChannel: "latest" | "beta" | null
}

export type ElectronAPI = {
  killSidecar: () => Promise<void>
  /** B11 复扫行11:sidecar 连崩自愈停手 → 侧栏持久 banner;重试重置阶梯并 in-place respawn。 */
  retrySidecar: () => Promise<void>
  onSidecarFatal: (cb: (e: { attempts: number }) => void) => () => void
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
  /** REQ-084:启动期 surface 选择。resolve 每次加载读一次(env > pin > 发布默认 + 崩溃降级);
   *  reportFailure 只落盘供下次加载判定 —— 绝不热切换。 */
  surfaces: {
    resolve: () => Promise<ResolvedSurfaces>
    reportFailure: (payload: { surface: SurfaceId; error: string }) => Promise<void>
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
    /** REQ-036 出厂技能名单(skills.paths 注入的技能名;ALPHA_FACTORY_SKILLS_DISABLE 时为空)——
     *  hub 用来把对应 catalog 条目标成「出厂内置」而非「可安装」(S18 X1)。 */
    factorySkillIds: () => Promise<string[]>
    /** REQ-037 上游能力治理(真源 ~/.alpha/governance.json;物化 home jsonc 受控叶子,apply 后
     *  renderer 需自行 refreshEngine() 使 dispose 热生效)。 */
    govRead: () => Promise<{ gov: AlphaGovernance; protection: { hard: string[]; alphaInjected: string[]; confirm: string[] }; factoryDenied: string[] }>
    govApply: (
      gov: AlphaGovernance,
      visibleAgents: string[],
      confirmBuildDisable?: boolean,
    ) => Promise<{ ok: boolean; reason?: string; violations: { kind: string; name: string; reason: string }[]; written: number; removedStale: number }>
    govReset: () => Promise<{ ok: boolean; reason?: string }>
    /** REQ-033:agent 导入两段式(codex 审计后:preview 经 picker token 授权读,confirm 只收
     *  previewId —— 写入内容为 main 侧留存的 preview 产物,renderer 不可提供内容)。 */
    importAgentPreview: (token: string, filePath: string) => Promise<
      | { ok: true; previewId: string; name: string; format: "opencode" | "claude-code"; mapping: Array<{ source: string; value: string; target: string | null; note: string }>; composed: string }
      | { ok: false; reason: string }
    >
    importAgentConfirm: (previewId: string) => Promise<{ ok: true; files?: string[] } | { ok: false; reason: string }>
    /** REQ-032:远程 catalog(main 拉取+ed25519 验签+ETag 缓存;source 指示回退层级,renderer 内置兜底)。 */
    remoteCatalog: () => Promise<
      | { source: "remote" | "cache"; catalog: unknown; version: string; fetchedAt: string; error?: string }
      | { source: "none"; error: string }
    >
    /** REQ-032:远程技能安装 —— renderer 只传 catalogId;name/清单/版本由 main 从已验签 catalog
     *  重新派生(codex H1 信任边界),下载 sha256 钉死 + builtin 同管线写盘/桥/账本。 */
    installRemoteSkill: (catalogId: string) => Promise<{ ok: true; files?: string[] } | { ok: false; reason: string }>
    /** REQ-046:远程 agent 安装 —— 同 installRemoteSkill 信任边界(main 从已验签 catalog 派生),
     *  资产约定 = 单个顶层 .md 文件;写盘/桥/账本走 writeAgent 同管线。 */
    installRemoteAgent: (catalogId: string) => Promise<{ ok: true; files?: string[] } | { ok: false; reason: string }>
    installPlugin: (pkg: string, meta?: InstallMeta) => Promise<{ ok: true } | { ok: false; reason: string }>
    installBuiltinSkill: (
      builtinAssetKey: string,
      name: string,
      target?: InstallTarget,
      meta?: InstallMeta,
    ) => Promise<{ ok: true; files?: string[] } | { ok: false; reason: string }>
    // REQ-019 T3:详情页 SKILL.md 预览(只读,资产键校验 + 256KB 帽;未打包时诚实失败)
    readBuiltinSkill: (builtinAssetKey: string) => Promise<{ ok: true; content: string } | { ok: false; reason: string }>
    // REQ-019 T6:导入。folder = main 自弹目录选择器,用户实选目录即来源(REQ-098 #255:renderer
    // 不再传 srcDir),校验 SKILL.md frontmatter → 复制入 .alpha + receipt(imported);git = https-only
    // 浅克隆临时目录 → 同校验。外来内容绝不执行,symlink 不复制。
    importSkillFolder: (
      target?: InstallTarget,
    ) => Promise<{ ok: true; files?: string[]; name?: string } | { ok: false; canceled?: boolean; reason: string }>
    importSkillGit: (
      url: string,
      target?: InstallTarget,
    ) => Promise<{ ok: true; files?: string[]; name?: string } | { ok: false; reason: string }>
    // REQ-023 T2:vendored 供给链 —— 官方 agent md 资产安装;vendored 插件零网络安装
    // (复制 resources/plugins/<key> → ~/.alpha/plugins + plugin[] 绝对路径)。
    installBuiltinAgent: (
      builtinAssetKey: string,
      name: string,
      target?: InstallTarget,
      meta?: InstallMeta,
    ) => Promise<{ ok: true; files?: string[] } | { ok: false; reason: string }>
    installVendoredPlugin: (
      vendoredAssetKey: string,
      name: string,
      meta?: InstallMeta,
    ) => Promise<{ ok: true; files?: string[] } | { ok: false; reason: string }>
    // REQ-018 安装账本:global(~/.alpha)+ project(<dir>/.alpha)receipts 合并只读视图
    listInstalls: (projectDir?: string) => Promise<InstallLedgerView>
    // REQ-018 T6:按 receipt 精确卸载(删文件/拆桥/去 config 项/吊销密钥/去账)
    uninstall: (receipt: InstallReceipt) => Promise<{ ok: true; files?: string[] } | { ok: false; reason: string }>
    // REQ-018 T3:存量迁移(旧 XDG 根 → .alpha)。scan 报告 legacy 清单 + enabled 门控;removeLegacy 删旧位。
    migrateScan: () => Promise<{ enabled: boolean; inventory: LegacyInventory }>
    // REQ-044:候选 provenance 终审(排除项 main.log [req044-provenance] 留痕)。
    migrateVerify: (requests: ProvenanceRequest[]) => Promise<ProvenanceVerdict[]>
    removeLegacy: (
      type: "skill" | "agent" | "mcp" | "plugin",
      name: string,
    ) => Promise<{ ok: true; removed: string[] } | { ok: false; reason: string }>
    // REQ-020 T4:启用云 pipeline = receipts-only(进本机可用列表,不落文件、不写引擎 config);
    // 停用走 uninstall(type:"cloud" → 去账)。
    enableCloud: (id: string, name: string, meta?: InstallMeta) => Promise<{ ok: true; warning?: string } | { ok: false; reason: string }>
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
    /** directory:B16 显式通道 —— 提供项目目录时,首次派发弹 per-项目 PIPL 同意门(main 侧);
     *  缺省则跳过 per-项目门(隐式告知由登录流承担)。 */
    dispatch: (envelope: CloudJobEnvelope, directory?: string) => Promise<CloudResult<CloudDispatchResult>>
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
    nlLlm: (text: string, projectDir: string) => Promise<
      | { ok: true; name: string; schedule: AutomationSchedule; prompt: string }
      | { ok: false; reason: string }
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
