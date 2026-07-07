// Shared model-catalog types (main builds the config from JSON; preload/renderer consume the
// catalog via window.api.models.catalog()). Keeping these in src/shared avoids cross-bundle value
// imports between main and preload — only the (erased) types travel.
//
// Single source of truth for the catalog DATA is main/alpha-models.json (ADR-014 "config-driven,
// no hardcode"). Edit the JSON to add/retire models, retune tier/倍率, or change presets — no code.

export type Tier = "flag" | "pro" | "std"

/** A BYOK (自带 Key) provider. `builtin` ones ride opencode's models.dev catalog (whitelist only);
 *  non-builtin ones are presets surfaced in the "添加节点" flow (provider.add writes a full def). */
export type ByokProvider = {
  id: string
  name: string
  /** opencode already knows this provider (models.dev) → inject whitelist + enable when key in env. */
  builtin?: boolean
  /** show as a quick-preset card in the add-provider flow. */
  preset?: boolean
  compat: "openai" | "anthropic"
  baseURL: string
  keyEnv: string
  pico: { letter: string; color: string }
  models: string[]
}

/** A model fronted by the alpha-platform proxy (代理节点). Visible always (locked when logged-out). */
export type PlatformModel = {
  id: string
  name: string
  tier: Tier
  reasoning?: boolean
  web?: boolean
  /** 推理档位表(alpha-models.json variants:档名 → 引擎 request 参数)。REQ-055:AlphaComposer 的
   *  effort chip 以 Object.keys(variants) 为档位真源(本地状态,提交时作 variant 参数)。 */
  variants?: Record<string, Record<string, unknown>>
}

export type AlphaModelCatalog = {
  version: string
  /** default selection "<providerID>/<modelID>" or null (null = don't force a default). */
  defaultModel: string | null
  tiers: Record<Tier, { label: string; mult: string }>
  /** the alpha-platform gateway provider shell (models come from platformModels). */
  platformProvider: { id: string; name: string; npm: string; pico: { letter: string; color: string } }
  platformModels: PlatformModel[]
  byokProviders: ByokProvider[]
  /** ids (into byokProviders) shown as quick-preset cards in the add-provider flow. */
  presetIds: string[]
}

// ── REQ-001:edition 白名单(B 网关权威源)──────────────────────────────────────────────────────

/** 目录来源标注(picker 降级提示用,B20):
 *  "live" = 本次会话内刚从网关同步;"cache" = 用上次成功同步的本地缓存;"static" = 无缓存,内置 snapshot。 */
export type LiveSyncInfo = {
  status: "live" | "cache" | "static"
  fetchedAt?: string
  edition?: string
}

/** window.api.models.catalog() 实际返回:catalog 经 edition 白名单过滤后的视图 + 来源标注。
 *  platformModels 已按网关白名单收窄(真实 registry id);byokProviders 已按 edition 收窄
 *  (用户自定义节点不经此目录,不受影响)。 */
export type EffectiveCatalog = AlphaModelCatalog & { liveSync: LiveSyncInfo }

// ── custom-provider add/test IPC (window.api.providers.*) ───────────────────────────────────────

export type ProviderInput = {
  id: string
  name: string
  compat: "openai" | "anthropic"
  baseURL: string
  apiKey: string
  models: string[]
}
export type ProviderTestInput = {
  compat: "openai" | "anthropic"
  baseURL: string
  apiKey: string
  model: string
}
export type ProviderResult = { ok: true } | { ok: false; reason: string }
export type ProviderTestResult = { ok: true; ms: number } | { ok: false; reason: string }

// Per-provider BYOK key state for the picker. Builtin providers are injected as opencode CONFIG
// providers (alpha-models.ts), so opencode lists their models whether or not a key exists — the
// picker can't tell "keyed" from "unkeyed" without this. `source`: "env" = the provider's keyEnv is
// set in the (main) process env (alpha.env/shell); "config" = an inline apiKey in opencode.jsonc;
// "none" = no usable key (→ row is locked, click opens the configure form).
export type ProviderKeyState = {
  configured: boolean
  /** "keychain" = alpha's encrypted BYOK store (alpha-byok-keys, the source of truth); "env" = keyEnv
   *  in process env (alpha.env/shell export); "config" = inline apiKey in opencode.jsonc; "none" = no
   *  key. ("auth" = legacy opencode auth.json — no longer produced; kept in the union pending UI cleanup.) */
  source: "keychain" | "env" | "config" | "auth" | "none"
  hint?: string
}
export type ProviderKeyStatus = Record<string, ProviderKeyState>
