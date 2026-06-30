// alpha-code's curated model menu, injected into opencode's config by the sidecar (see
// sidecar.ts -> injectAlphaConfig). Everything here rides opencode's NATIVE config contract, so
// it touches zero upstream source and survives every fork-sync (ADR-005/006/007).
//
// CONFIG-DRIVEN (ADR-014): the catalog DATA lives in ./alpha-models.json — the single source of
// truth. This file only READS that JSON and assembles opencode's native config. Add/retire models,
// retune tier/倍率, or change presets by editing the JSON, NOT this code.
//
// The four native levers (runtime: packages/opencode/src/provider/provider.ts):
//   - enabled_providers: HARD allowlist. When set, ONLY these provider ids are visible.
//   - provider.<id>.whitelist: per-provider model allowlist (the only "keep only these" lever;
//     listing under `.models` MERGES with the models.dev catalog instead of restricting).
//   - provider.<id> with { npm, options:{ baseURL, apiKey }, models }: a custom OpenAI-compatible
//     ("@ai-sdk/openai-compatible") / Anthropic ("@ai-sdk/anthropic") gateway.
//   - model: "<providerID>/<modelID>" -- the default selection.
//
// Keys are written as {env:VAR}; opencode resolves them against the sidecar's process.env (which
// inherits the user's login-shell env via preferAppEnv()/loadShellEnv before the fork).
//
// Escape hatch: ALPHA_MODELS_DISABLE=1 skips this entirely.

import catalog from "./alpha-models.json"
import type { AlphaModelCatalog, ProviderKeyStatus } from "../shared/alpha-model-types"
import { readConfiguredProviderKeys, readUserProviderIds } from "./ext-config"

const CATALOG = catalog as unknown as AlphaModelCatalog

/** The full model catalog (for window.api.models.catalog -> renderer picker). */
export function getModelCatalog(): AlphaModelCatalog {
  return CATALOG
}

/**
 * Per-provider BYOK key state for the picker (window.api.providers.keyStatus). A builtin provider is
 * "configured" if its keyEnv is set in the (main) process env — which holds alpha.env + shell keys,
 * loaded before the sidecar forks, so this matches exactly what opencode will see — OR if the user's
 * opencode.jsonc has an inline apiKey for it. Custom providers (config-only) are reported too.
 * Limitation: a key stored solely via opencode's native `auth login` is not visible here (P1).
 */
export function getProviderKeyStatus(): ProviderKeyStatus {
  const cfgKeyed = readConfiguredProviderKeys()
  // Masked tail only (never the full key) so the renderer can show WHICH key is set, not its value.
  const last4 = (k?: string) => (k && k.length >= 4 ? k.slice(-4) : k ? "••" : undefined)
  const out: ProviderKeyStatus = {}
  for (const p of CATALOG.byokProviders) {
    const envVal = p.keyEnv ? process.env[p.keyEnv] : undefined
    out[p.id] = envVal
      ? { configured: true, source: "env", hint: last4(envVal) }
      : cfgKeyed.has(p.id)
        ? { configured: true, source: "config", hint: last4(cfgKeyed.get(p.id)) }
        : { configured: false, source: "none" }
  }
  // Custom providers (not in the catalog) carry their key inline → always "config".
  for (const [id, key] of cfgKeyed) if (!out[id]) out[id] = { configured: true, source: "config", hint: last4(key) }
  return out
}

export type AlphaModelConfig = {
  enabled_providers: string[]
  model?: string
  provider: Record<string, unknown>
}

export function buildAlphaModelConfig(): AlphaModelConfig | undefined {
  if (process.env.ALPHA_MODELS_DISABLE === "1") return undefined

  const provider: Record<string, unknown> = {}
  const enabled: string[] = []

  // (1) 国产 built-ins -- in the models.dev catalog, so they only need a model whitelist plus their
  // key in the env (see byokProviders[].keyEnv). Non-builtin entries (e.g. Kimi) are presets for the
  // 添加节点 flow and are NOT auto-injected here.
  for (const p of CATALOG.byokProviders) {
    if (!p.builtin) continue
    provider[p.id] = { whitelist: p.models }
    enabled.push(p.id)
  }

  // (2) ALPHA platform gateway -- a custom OpenAI-compatible provider whose key is fronted by ALPHA
  // (代发). Auto-joins the allowlist (front of list) only once ALPHA_BASE_URL points at the gateway.
  if (process.env.ALPHA_BASE_URL) {
    const pp = CATALOG.platformProvider
    const models: Record<string, { name: string }> = {}
    for (const m of CATALOG.platformModels) models[m.id] = { name: m.name }
    provider[pp.id] = {
      npm: pp.npm,
      name: pp.name,
      options: { baseURL: process.env.ALPHA_BASE_URL, apiKey: "{env:ALPHA_API_KEY}" },
      models,
    }
    enabled.unshift(pp.id)
  }

  // (3) User-added custom providers (via window.api.providers.add → opencode.jsonc provider[<id>]).
  // opencode REPLACES (not unions) enabled_providers on config merge and OPENCODE_CONFIG_CONTENT is
  // merged last, so a custom provider that isn't in THIS allowlist gets dropped. Merge the user's
  // configured provider ids in so they survive (visible after the next reconnect). See build.md §6.
  for (const id of readUserProviderIds()) {
    if (!enabled.includes(id)) enabled.push(id)
  }

  // Default model: env override wins, else catalog default, else none (never force a default whose
  // key may be absent). Format "<providerID>/<modelID>".
  const model = process.env.ALPHA_DEFAULT_MODEL ?? CATALOG.defaultModel ?? undefined

  return {
    enabled_providers: enabled,
    ...(model ? { model } : {}),
    provider,
  }
}
