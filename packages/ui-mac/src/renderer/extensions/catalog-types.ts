// Shared types for the Extension Hub (定制中心). Pure types — no runtime, no opencode imports.
// Mirrors resources/alpha-catalog.json and the v2 data model in
// docs/designs/2026-06-22-arch-extension-hub.md. The MCP config shape matches opencode's
// ConfigV2.MCP (packages/core/src/config/mcp.ts): the discriminant is "local" | "remote"
// (NOT stdio/sse), local carries `command`+`environment`, remote carries `url`+`headers`.

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
  /** REQ-032:远程资产清单(phase 1 仅 skill/agent 文本;sha256 钉死,main 下载校验)。 */
  remoteAsset?: { version: string; files: Array<{ path: string; sha256: string; bytes: number; url: string }> }
}

export interface Catalog {
  version: string
  entries: CatalogEntry[]
}

/** Live install state of one extension, derived from SDK truth (NOT persisted by alpha). */
export interface InstalledState {
  name: string
  type: CatalogType
  /** MCP: whether the server is currently connected. */
  connected?: boolean
  /** MCP: whether opencode considers it enabled (vs disconnected/disabled). */
  enabled?: boolean
  error?: string
}

export type RuntimeCheck = { ok: true } | { ok: false; missing: string }
