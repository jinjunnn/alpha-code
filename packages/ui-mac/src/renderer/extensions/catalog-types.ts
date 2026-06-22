// Shared types for the Extension Hub (定制中心). Pure types — no runtime, no opencode imports.
// Mirrors resources/alpha-catalog.json and the v2 data model in
// docs/designs/2026-06-22-arch-extension-hub.md. The MCP config shape matches opencode's
// ConfigV2.MCP (packages/core/src/config/mcp.ts): the discriminant is "local" | "remote"
// (NOT stdio/sse), local carries `command`+`environment`, remote carries `url`+`headers`.

export type CatalogType = "mcp" | "skill" | "plugin" | "bundle"
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
}

export interface SkillInstallSpec {
  kind: "skill"
  source: "builtin" | "remote"
  builtinAssetKey?: string
  remoteIndexUrl?: string
  targetDir: "alpha-skills" | "global"
}

export interface PluginInstallSpec {
  kind: "plugin"
  package: string
  version?: string
  options?: Record<string, unknown>
  mirrorRegistry?: string
}

export type InstallSpec = McpInstallSpec | SkillInstallSpec | PluginInstallSpec

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
