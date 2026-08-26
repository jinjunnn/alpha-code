// Shared types for the Extension Hub (定制中心). Pure types — no runtime, no opencode imports.
// Mirrors resources/alpha-catalog.json. The MCP config shape matches opencode's
// ConfigV2.MCP (packages/core/src/config/mcp.ts): the discriminant is "local" | "remote"
// (NOT stdio/sse), local carries `command`+`environment`, remote carries `url`+`headers`.

import type { CatalogPackageViewV1 } from "../../shared/catalog-package-view"

export type CatalogType = "mcp" | "skill" | "plugin" | "bundle" | "agent" | "cloud"
export type CatalogSource = "official" | "community" | "alpha" | "user"

/** opencode ConfigV2.MCP.Local — the object passed to sdk.mcp.add for a local (stdio) server. */
export interface McpLocalConfig {
  type: "local"
  command: string[]
  environment?: Record<string, string>
}
/** opencode ConfigV2.MCP.Remote — the object passed to sdk.mcp.add for a remote server. */
export interface McpRemoteConfig {
  type: "remote"
  url: string
  headers?: Record<string, string>
}
export type McpConfig = McpLocalConfig | McpRemoteConfig

export interface McpInstallSpec {
  kind: "mcp"
  mcpType: "local" | "remote"
  command?: string[]
  url?: string
  headersTemplate?: Record<string, string>
  /** Env var names the user must supply before connect (rendered into headers/environment). */
  requiredEnvVars?: string[]
  /** Binaries to which-check before install (e.g. ["uv"], ["node"]). */
  runtimeDep?: string[]
  /** China-mirror fallback command when the primary registry is slow/blocked. */
  mirrorCommand?: string[]
  /** Unverified claim carried from the catalog — surfaced as 「待核实」 on the detail page (D5). */
  _verify?: string
}

export interface SkillInstallSpec {
  kind: "skill"
  source: "builtin" | "remote"
  builtinAssetKey?: string
  remoteIndexUrl?: string
  targetDir: "alpha-skills" | "global"
  /** Unverified claim carried from the catalog — surfaced as 「待核实」 on the detail page (D5). */
  _verify?: string
}

export interface PluginInstallSpec {
  kind: "plugin"
  package: string
  version?: string
  options?: Record<string, unknown>
  mirrorRegistry?: string
  /** REQ-023 T2:随 app 打包的自包含 JS 资产键(resources/plugins/<name>)。存在时安装 =
   *  复制 + plugin[] 写绝对路径 —— 零网络;npm@钉版仅作无资产条目的 fallback。 */
  vendoredAssetKey?: string
  /** REQ-023 T1:V2 远程直链预留字段(下载器不在 M2 实现,占位防 schema churn)。 */
  downloadUrl?: string
  /** Unverified claim carried from the catalog — surfaced as 「待核实」 on the detail page (D5). */
  _verify?: string
}

export interface AgentInstallSpec {
  kind: "agent"
  /** REQ-046:remote = C 侧远程资产通道(单 .md,sha256 钉死,与 skill 同管线)——新增 agent 零发版。 */
  source: "builtin" | "remote"
  /** resources/agents/<name>.md — vendored md asset (REQ-023 T1;source=builtin 必填). */
  builtinAssetKey?: string
  /** Unverified claim carried from the catalog — surfaced as 「待核实」 on the detail page (D5). */
  _verify?: string
}

/** REQ-020 T4:云 pipeline 条目(B 侧 gateway pipelines.ts 已 live 的 kind)。「启用」= receipts-only
 *  (进本机可用列表供会话/自动化选用,不落文件、不写引擎 config)—— 不经任何 installer。 */
export interface CloudPipelineSpec {
  kind: "cloud"
  /** B 侧 pipeline 注册表键(alpha-platform gateway/src/pipelines.ts)。 */
  pipelineKind: "research" | "code-review" | "docs"
  /** 输入契约(详情页展示;dispatch 构造与此对齐)。 */
  inputContract: { field: string; description: string; required?: boolean }[]
  /** A 侧派发默认预算;上限为 B 侧按租户 clamp 的天花板(policy 永远赢)。 */
  budgetDefaults: { max_iter: number; max_tokens: number; max_wall_clock_sec: number }
  budgetLimits: { max_iter: number; max_tokens: number; max_wall_clock_sec: number }
  /** 执行层描述(仅展示;tier 路由对 A 不可见,ADR-013)。 */
  tier: string
  /** 上行数据明细 —— 出境内容如实列举(ADR-021 数据边界)。 */
  upstreamData: string[]
  /** Unverified claim carried from the catalog — surfaced as 「待核实」 on the detail page (D5). */
  _verify?: string
}

export type InstallSpec = McpInstallSpec | SkillInstallSpec | PluginInstallSpec | AgentInstallSpec | CloudPipelineSpec

export interface BundleItem {
  catalogEntryId: string
  optional: boolean
  installOrder: number
}

export interface CatalogEntry {
  id: string
  type: CatalogType
  name: string
  displayName: string
  description: string
  source: CatalogSource
  category: string
  license?: string
  redistributable?: boolean
  iconUrl?: string
  /** Present for non-bundle entries. */
  installSpec?: InstallSpec
  /** Present for bundle entries — references other CatalogEntry ids to fan out at install time. */
  bundleItems?: BundleItem[]
  /** MCP only (REQ-019 T3): curated tools the server provides — detail-page metadata, NOT
   *  exhaustive (the engine exposes no tools-query route; live probing is a flagged V2). */
  tools?: { name: string; description: string }[]
  /** Plugin only (REQ-019 T3): hooks the plugin registers — detail-page metadata. */
  hooks?: { name: string; description: string }[]
  /** Unverified claim carried from the catalog — surfaced as 「待核实」 on the detail page (D5). */
  _verify?: string
  /** REQ-032:条目级版本(远端 catalog 对可安装条目必填;缺失回退全局版本)——更新角标的粒度。 */
  version?: string
  /** REQ-032:远程资产清单(sha256 钉死,main 下载校验)。skill/agent = 安装载荷本体;
   *  REQ-102 #359 起 mcp/plugin 的 seed 条目也必须声明(双真源交叉验证输入):plugin = 离线
   *  运行载荷(plugin.js 等),mcp = 离线携带字节(安装语义仍派生自 installSpec,非运行载荷)。 */
  remoteAsset?: { version: string; files: Array<{ path: string; sha256: string; bytes: number; url: string }> }
  /** REQ-104 #397:策展对象(合同 alpha.catalog.curation.v1)。**刻意 unknown** —— 唯一采信
   *  入口 = shared/catalog-curation.ts decodeEntryCuration(fail-closed),禁止旁路直读。 */
  curation?: unknown
}

export interface Catalog {
  version: string
  entries: CatalogEntry[]
  /** REQ-128:main-owned safe views; raw package envelopes/payload refs never cross IPC. */
  packages?: CatalogPackageViewV1[]
}

/** ac#1136(REQ-128):随包 `alpha-catalog.json` 的**诚实 wire 形状** —— 已签名 release 的逐字
 *  镜像。`packages` 存在时是 raw `alpha.host-extension-package.v1` envelope(payloadRef 含 URL),
 *  **不是** `CatalogPackageViewV1`,故声明为 `unknown[]`:唯一采信入口 = main 侧
 *  package-installability 的解码器(resolveVerifiedPackageV1 / evaluateCatalogPackagesForHost)。
 *  把这个值铸成 `Catalog`(把 raw 说成 view)正是 ac#1136 崩溃能瞒过 typecheck 的原因;任何要把
 *  `packages` 递给 renderer 的路径必须先经 main 评估投影,不得直接赋值。 */
export interface BundledCatalogSnapshotV1 {
  version: string
  entries: CatalogEntry[]
  packages?: unknown[]
}

/** Live install state of one extension, derived from SDK truth (NOT persisted by alpha). */
export interface InstalledState {
  name: string
  type: CatalogType
  /** MCP: whether the server is currently connected. */
  connected?: boolean
  /** MCP: whether opencode considers it enabled (vs disconnected/disabled). */
  enabled?: boolean
  /**
   * MCP:引擎报的 `needs_auth` —— 该 server 走 OAuth 且当前没有可用令牌(`#733`)。
   *
   * 引擎的 `MCP.Status` 是**五臂**判别联合(connected / disabled / failed / needs_auth /
   * needs_client_registration),而这个投影从前只有 `connected` / `enabled` 两个布尔 ——
   * `needs_auth` 于是被折成「未连接」,用户看到一行灰字、没有任何可点的东西。
   * 少了这一位不是渲染问题,是**这个状态在下游结构上不存在**:UI 想补救也无从判起。
   */
  needsAuth?: boolean
  error?: string
}

export type RuntimeCheck = { ok: true } | { ok: false; missing: string }
