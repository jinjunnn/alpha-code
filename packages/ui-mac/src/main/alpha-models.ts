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
import type { AlphaModelCatalog } from "../shared/alpha-model-types"
import { readUserProviderIds } from "./ext-config"
// NOTE: this module is loaded by the SIDECAR (utilityProcess) via buildAlphaModelConfig, so it must
// stay electron-free. getProviderKeyStatus (which reads the safeStorage keychain) lives in the
// main-only alpha-provider-status.ts for that reason — do NOT import alpha-byok-keys here.

const CATALOG = catalog as unknown as AlphaModelCatalog

/** The full model catalog (for window.api.models.catalog -> renderer picker). */
export function getModelCatalog(): AlphaModelCatalog {
  return CATALOG
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

  // (1) BYOK 直连节点 (方案 C): inject each catalog provider that HAS a key (opt-in) as a FULL custom
  // provider — npm/baseURL/models come from the catalog (alpha-code defines them, independent of
  // models.dev), and the apiKey is inlined from the env (fed by the alpha keychain via
  // injectByokKeysIntoEnv, or a shell/alpha.env export). No key → not injected, so the picker only
  // shows keyed BYOK nodes. Calls go DIRECT to the provider's baseURL (never via the gateway).
  for (const p of CATALOG.byokProviders) {
    const key = p.keyEnv ? process.env[p.keyEnv] : undefined
    if (!key) continue
    const npm = p.compat === "anthropic" ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible"
    const models: Record<string, { name: string }> = {}
    for (const m of p.models) models[m] = { name: m }
    provider[p.id] = { npm, name: p.name, options: { baseURL: p.baseURL, apiKey: key }, models }
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
