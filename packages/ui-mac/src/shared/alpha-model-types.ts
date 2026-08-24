// Shared model-catalog types (main builds the config from JSON; preload/renderer consume the
// catalog via window.api.models.catalog()). Keeping these in src/shared avoids cross-bundle value
// imports between main and preload — only the (erased) types travel.
//
// Single source of truth for the catalog DATA is main/alpha-models.json (ADR-014 "config-driven,
// no hardcode"). Edit the JSON to add/retire models, retune 展示元数据(显示名 / reasoning / web /
// variants), or change presets — no code.
//
// REQ-127 #679 / ADR-039:本地目录**没有价格轴**。平台代理的计价倍数只由网关 `GET /v1/models`
// 下发(`PlatformModel.pricing` + `EffectiveCatalog.pricingBasisModelId`);此前那套本地写死的
// `tiers`(标准/高级/旗舰)与逐模型 `tier` 是**第二个价格权威**,并且对未收录的线上模型一律合成
// 最便宜的一档 —— 它已被删除,不得以任何形式回来。

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

/** Engine-facing provider id for an injected BYOK direct node. We deliberately DON'T reuse the display
 *  id (e.g. "deepseek") for the sidecar/opencode provider: those collide with the models.dev provider
 *  ids, and opencode's ModelsDevPlugin registers an integration for every models.dev provider that has
 *  env keys. The upstream availability gate (packages/core catalog) then only counts a key it finds in
 *  `request.body.apiKey` — but the `@ai-sdk/openai-compatible` path puts the key in `api.settings.apiKey`
 *  — so the provider is judged unavailable, its models never appear in /api/model, and the picker shows
 *  "当前不可用". Injecting under a non-models.dev id (`<id>-byok`) takes the same "no integration →
 *  available" path the platform `alpha` provider already uses. Display id, keyStatus, gateway allowlist
 *  and the key store keep the plain id; only the engine provider id + the picker's engine lookup use this.
 *  MUST stay in lockstep between the config injector (main/alpha-models.ts) and the picker
 *  (renderer/model-picker-core.ts). */
export const byokEngineId = (id: string): string => `${id}-byok`

/** Inverse of {@link byokEngineId}: is this engine-facing provider id an injected BYOK direct node?
 *  REQ-109 #595 uses it as the one fact that decides "this selection is a local BYOK direct node, so
 *  it does not depend on platform login/entitlement or on the engine's model list being loaded". */
export const isByokEngineId = (providerID: string): boolean => providerID.endsWith("-byok")

/** #681 / ADR-039:平台下发的**双倍数**。相对基准模型(`EffectiveCatalog.pricingBasisModelId`)
 *  未缓存 token 单价之比;平台已 half-up 到一位小数。客户端只本地化展示 —— 不做除法、不 rounding、
 *  不加权、不折叠成单一 scalar(折叠对至少一侧必然错)。 */
export type PricingMultiplier = { input: number; output: number }

/** A model fronted by the alpha-platform proxy (代理节点). Visible always (locked when logged-out). */
export type PlatformModel = {
  id: string
  name: string
  /** #681:平台目录给的双倍数,**远端权威**;缺失 = 没有有效 V2/LKG,该行不得声称任何价格。
   *  本地 alpha-models.json 永远不产出它(那正是 REQ-127 要消灭的本地价格主张)。 */
  pricing?: PricingMultiplier
  reasoning?: boolean
  web?: boolean
  /** 推理档位表(alpha-models.json variants:档名 → 引擎 request 参数)。REQ-055:AlphaComposer 的
   *  effort chip 以 Object.keys(variants) 为档位真源(本地状态,提交时作 variant 参数)。 */
  variants?: Record<string, Record<string, unknown>>
}

export type AlphaModelCatalog = {
  version: string
  /** default selection "<providerID>/<modelID>" or null (null = don't force a default).
   *  这是**引擎 config 的 `model` 字段**(opencode 原生契约),与下面的 `defaultPlatformModel`
   *  不是同一根轴 —— 别把两者混用。 */
  defaultModel: string | null
  /** #679:renderer 自动默认平台代理模型时唯一允许的依据,值是**裸 model id**(如
   *  `"deepseek-v4-flash"`),不是 `defaultModel` 的 `"<providerID>/<modelID>"` 形态。
   *  `null` 或该 id 不在生效目录中 ⇒ **不自动默认任何平台模型**(降级到 BYOK / 空态)。
   *  绝不允许「挑一个便宜的」或「挑第一个」:客户端已经没有价格权威,任何挑选都是在重新发明它。 */
  defaultPlatformModel: string | null
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

/** window.api.models.catalog() 实际返回:catalog 的**平台段**经 edition 清单过滤后的视图 + 来源标注。
 *  platformModels 已按网关清单收窄(真实 registry id);**byokProviders 原样透出** —— REQ-109 #595
 *  撤销了 edition 收窄,BYOK 目录只由本地 alpha-models.json 决定(docs/contracts/byok-availability.md)。 */
export type EffectiveCatalog = AlphaModelCatalog & {
  liveSync: LiveSyncInfo
  /** #681 / ADR-039:`PlatformModel.pricing` 那些倍数相对的基准模型 id;`null` = 没有有效 V2/LKG,
   *  平台段计价状态为 unavailable。**基准是单位定义,不是目录成员** —— 平台明确声明消费方不得假设
   *  它出现在 platformModels 里(edition 白名单可以把它筛掉)。基准由平台下发,客户端不硬编码:
   *  平台换基准,展示跟着变才是诚实的。 */
  pricingBasisModelId: string | null
}

/** #1084:平台模型目录**刷新**的失败结局(main → renderer 的可观察出口)。
 *  `code` 是 `fetchPlatformModels()` 已经算出来的稳定分类码(`rate_limited` / `unauthorized` /
 *  `http-503` / `network` / `contract-incompatible` …),或落盘侧的 `snapshot-rejected` /
 *  `cache-write-failed`。**不是散文** —— 散文槽随时会变、可能带租户信息,不进 UI。
 *  刷新成功 ⇒ 整个值为 `null`(出口清空)。 */
export type CatalogRefreshFailure = {
  code: string
  /** ISO 时间戳:同一个码连续失败时,用户仍看得出「刚刚又失败了一次」。 */
  at: string
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
