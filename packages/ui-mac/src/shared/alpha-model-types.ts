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
