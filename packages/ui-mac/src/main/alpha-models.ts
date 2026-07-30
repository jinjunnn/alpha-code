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
// Keys are written as {file:<userData>/alpha-secrets/<VAR>} refs (A6) — opencode resolves them at
// config load (config/variable.ts). The files are materialized by main right before every sidecar
// fork (syncSecretFiles), so "provider is keyed" is now a FILE-presence question, not an env one:
// the sidecar env is allowlisted (sidecar-env.ts) and never carries key values.
//
// Escape hatch: ALPHA_MODELS_DISABLE=1 skips this entirely.

import catalog from "./alpha-models.json"
import type { AlphaModelCatalog } from "../shared/alpha-model-types"
import { byokEngineId } from "../shared/alpha-model-types"
import { projectPlatformModels, readCatalogSnapshot } from "./alpha-live-allowlist"
import { hasSecretFile, secretFileRef } from "./alpha-secret-files"
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

export function buildAlphaModelConfig(userDataPath: string): AlphaModelConfig | undefined {
  if (process.env.ALPHA_MODELS_DISABLE === "1") return undefined

  const provider: Record<string, unknown> = {}
  const enabled: string[] = []

  // REQ-001:B 网关 edition 白名单(main 经 syncLiveAllowlist 同步的本地 catalog LKG;缺失/损坏/旧代
  // → 不限制,内置 snapshot 兜底,fail-open)。约束对象**只有平台模型清单**;用户自定义节点(下方
  // readUserProviderIds)不受限;BYOK 目录自 REQ-109 #595 起也不受限 —— owner 裁决 BYOK 走全主权,
  // 本地 alpha-models.json 即权威,平台不得远程干预(契约 docs/contracts/byok-availability.md)。
  const snapshot = readCatalogSnapshot(userDataPath)

  // (1) BYOK 直连节点 (方案 C): inject each catalog provider that HAS a key (opt-in) as a FULL custom
  // provider — npm/baseURL/models come from the catalog (alpha-code defines them, independent of
  // models.dev), and the apiKey is a {file:} ref into the secret channel (fed by the alpha keychain /
  // shell / alpha.env via main's syncSecretFiles at fork, A6). No key file → not injected, so the
  // picker only shows keyed BYOK nodes. Calls go DIRECT to the provider's baseURL (never via the gateway).
  for (const p of CATALOG.byokProviders) {
    if (!p.keyEnv || !hasSecretFile(userDataPath, p.keyEnv)) continue
    const npm = p.compat === "anthropic" ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible"
    const models: Record<string, { name: string }> = {}
    for (const m of p.models) models[m] = { name: m }
    // Inject under a non-models.dev engine id (`<id>-byok`) so opencode's availability gate doesn't
    // filter these out via the models.dev integration collision (see byokEngineId). Display id, key
    // status, gateway allowlist and the key store all keep the plain `p.id`.
    const engineId = byokEngineId(p.id)
    provider[engineId] = {
      npm,
      name: p.name,
      options: { baseURL: p.baseURL, apiKey: secretFileRef(userDataPath, p.keyEnv) },
      models,
    }
    enabled.push(engineId)
  }

  // (2) ALPHA platform gateway -- a custom OpenAI-compatible provider whose key is fronted by ALPHA
  // (代发). Auto-joins the allowlist (front of list) only once ALPHA_BASE_URL points at the gateway
  // AND the key file exists (a URL with no key would only produce doomed 401 calls).
  // REQ-001:模型清单以 live 白名单为准(网关 registry 真实 id;展示名经 snapshot 富化,未知 id 用
  // id 本名),无缓存 → 静态 snapshot(原行为)。
  if (process.env.ALPHA_BASE_URL && hasSecretFile(userDataPath, "ALPHA_API_KEY")) {
    const pp = CATALOG.platformProvider
    // REQ-127 #681:平台段走与 picker 完全相同的那一份投影。此前这里自制 nameById/variantsById/source
    // 三段装配,于是「什么算有效缓存」有两份定义 —— 空缓存时 picker 给 0 行、引擎配置给静态 9 行。
    // REQ-029:variants(推理档)随投影下发 —— 引擎 request 层 merge 进 options(echo 实验实锤
    // reasoningEffort→reasoning_effort / reasoning:{effort} 原样透传,网关 spread 透传)。
    // 引擎配置**不写 pricing**:那是展示用的,不进 opencode 的 provider 契约。
    const models: Record<string, { name: string; variants?: Record<string, Record<string, unknown>> }> = {}
    for (const m of projectPlatformModels(CATALOG.platformModels, snapshot)) {
      models[m.id] = { name: m.name, ...(m.variants ? { variants: m.variants } : {}) }
    }
    provider[pp.id] = {
      npm: pp.npm,
      name: pp.name,
      options: { baseURL: process.env.ALPHA_BASE_URL, apiKey: secretFileRef(userDataPath, "ALPHA_API_KEY") },
      models,
    }
    enabled.unshift(pp.id)
  }

  // (3) User-added custom providers (via window.api.providers.add → opencode.jsonc provider[<id>]).
  // opencode REPLACES (not unions) enabled_providers on config merge and OPENCODE_CONFIG_CONTENT is
  // merged last, so a custom provider that isn't in THIS allowlist gets dropped. Merge the user's
  // configured provider ids in so they survive. providers-add immediately drives the shared respawn
  // path, so this next-fork allowlist is reflected by the renderer's next real model.list. See build.md §6.
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
