// Shared model-catalog types (main builds the config from JSON; preload/renderer consume the
// catalog via window.api.models.catalog()). Keeping these in src/shared avoids cross-bundle value
// imports between main and preload — only the (erased) types travel.
//
// REQ-237 `#1556`:目录数据有两个远程权威 —— 平台模型的名称 / 品牌 / 能力由网关 `GET /v1/models`(V3 `display`)
// 下发;BYOK 预置目录由 `GET /v1/byok-catalog` 下发(main/alpha-models.json 只留它的首启引导副本)。端点 / Key 名 /
// 协议适配器只在 App 内置适配器表 main/byok-adapters.ts。
//
// REQ-127 #679 / ADR-039:本地目录**没有价格轴**。平台代理的计价倍数只由网关 `GET /v1/models`
// 下发(`PlatformModel.pricing` + `EffectiveCatalog.pricingBasisModelId`);此前那套本地写死的
// `tiers`(标准/高级/旗舰)与逐模型 `tier` 是**第二个价格权威**,并且对未收录的线上模型一律合成
// 最便宜的一档 —— 它已被删除,不得以任何形式回来。

/** A BYOK (自带 Key) provider as the picker and the engine injection see it —— REQ-237 `#1556` 起是**投影**,
 *  不是随包数据:provider 身份、名称、preset、模型与逐模型元数据来自已应用 BYOK 目录(远程 `GET /v1/byok-catalog`
 *  或随包首启引导,ByokCatalogV1),`compat` / `baseURL` / `keyEnv` / `pico` 来自 App 内置适配器表
 *  (main/byok-adapters.ts)。唯一的投影函数是 main/alpha-models.ts `projectByokProviders`。 */
export type ByokProvider = {
  id: string
  name: string
  /** show as a quick-preset card in the add-provider flow. */
  preset: boolean
  compat: "openai" | "anthropic"
  baseURL: string
  keyEnv: string
  pico: { letter: string; color: string }
  models: string[]
  /** 逐模型元数据(键 = `models` 里每一个 id,来自 BYOK 目录)。读它的只有 {@link byokModelMeta}。
   *  REQ-153 #1267 的教训(`glm-4.5-air` 无徽标却锁在思考档)仍成立:元数据必须是这个 provider 自己的,
   *  `#1556` 起每个模型都有,不再借平台同名条目。 */
  modelMeta: Record<string, ByokModelMeta>
  /** REQ-228 #1420:逐模型「能不能看图」(BYOK 目录的 `image_input`,schema 必填)。注入时落成引擎 config 的
   *  `modalities.input`(→ `capabilities.input.image`)。 */
  imageInput: Record<string, boolean>
}

/** {@link ByokProvider.modelMeta} 的值:刻意没有 pricing —— 直连节点不经网关,没有平台计价倍数;REQ-127 #679 /
 *  ADR-039 不允许本地出现任何价格主张。 */
export type ByokModelMeta = {
  name: string
  reasoning?: boolean
  /** 档名 → 引擎 request 参数,wire 形状按 `@ai-sdk/openai-compatible` 写(BYOK 适配器全部 `compat: "openai"`)。
   *  `{ thinking: { type: "disabled" } }` 是**显式关闭**:智谱 2026-09-06 实打,`disabled` 真的不再回 `reasoning_content`,
   *  而 `type` 写错(如 `bogus`)会被上游**静默忽略并继续思考**(HTTP 仍 200)—— 值必须逐字是 `disabled`。 */
  variants?: Record<string, Record<string, unknown>>
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

/** BYOK 行的展示名、推理能力与**推理档位**的**唯一**派生函数,只读 BYOK 目录自己的逐模型元数据
 *  (`ByokProvider.modelMeta`)。REQ-237 `#1556`:此前没有槽的模型借**平台同名条目**的 name/reasoning/variants ——
 *  与目录自己的 `_variantsNote`「同一模型经直连与经 OpenRouter 形状不同,不得跨腿套用」矛盾;两类目录从此不互相借数据。
 *  REQ-153 #1236:picker 打「推理」徽标(renderer/model-picker-core.ts)与 sidecar 往引擎写
 *  `capabilities.reasoning`(main/alpha-models.ts)必须都走这一个函数 —— 两边各查一次就会出现徽标亮着而
 *  引擎 `reasoning === false`。REQ-153 #1266:`variants` 同样由这里派生,同一份数据同时进 sidecar 注入、
 *  picker 的 BYOK 行、会话投影(`composerModelFromRef`)与自动默认(`model-default-core` 第③级)。
 *  `engineProviderID` 是引擎侧 id(`<id>-byok`,{@link byokEngineId});目录里没有这个模型 ⇒ 名称回落 id、无徽标无档。 */
export function byokModelMeta(
  catalog: { byokProviders: readonly Pick<ByokProvider, "id" | "modelMeta">[] },
  engineProviderID: string,
  id: string,
): { name: string; reasoning: boolean; variants?: Record<string, Record<string, unknown>> } {
  const own = catalog.byokProviders.find((provider) => byokEngineId(provider.id) === engineProviderID)?.modelMeta?.[id]
  return {
    name: own?.name ?? id,
    reasoning: !!own?.reasoning,
    ...(own?.variants ? { variants: own.variants } : {}),
  }
}

/** #681 / ADR-039:平台下发的**双倍数**。相对基准模型(`EffectiveCatalog.pricingBasisModelId`)
 *  未缓存 token 单价之比;平台已 half-up 到一位小数。客户端只本地化展示 —— 不做除法、不 rounding、
 *  不加权、不折叠成单一 scalar(折叠对至少一侧必然错)。 */
export type PricingMultiplier = { input: number; output: number }

/** REQ-237 `#1556`:网关 ModelCatalogV3 每行的 `display`(名称 / 品牌 / 能力 / 档位),网关 registry 是唯一权威。 */
export type PlatformModelDisplay = {
  name: string
  brand: string
  reasoning?: boolean
  web?: boolean
  variants?: Record<string, Record<string, unknown>>
}

/** A model fronted by the alpha-platform proxy (代理节点). Visible always (locked when logged-out).
 *  REQ-237 `#1556`:每个字段都来自已应用的平台快照(id / pricing 来自目录行,其余来自该行的 `display`);
 *  没有有效快照 ⇒ 平台段为空,不再回退任何随包清单。 */
export type PlatformModel = {
  id: string
  name: string
  /** 品牌(`display.brand`),不是路由腿 `provider`(qwen 经 OpenRouter 路由,品牌仍是 qwen)。 */
  brand: string
  /** #681:平台目录给的双倍数,**远端权威**。 */
  pricing?: PricingMultiplier
  reasoning?: boolean
  web?: boolean
  /** 推理档位表(档名 → 引擎 request 参数)。REQ-055:AlphaComposer 的 effort chip 以 Object.keys(variants)
   *  为档位真源(本地状态,提交时作 variant 参数)。 */
  variants?: Record<string, Record<string, unknown>>
}

export type AlphaModelCatalog = {
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
  platformProvider: { id: string; name: string; npm: string }
  /** 已应用平台快照的投影;没有有效快照 ⇒ 空(「平台模型清单尚未获取」)。 */
  platformModels: PlatformModel[]
  /** 已应用 BYOK 目录 × 适配器表的投影。 */
  byokProviders: ByokProvider[]
  /** ids (into byokProviders) shown as quick-preset cards in the add-provider flow(= `preset` 为真者,目录顺序)。 */
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

/** window.api.models.catalog() 实际返回:已应用目录 + 来源标注。platformModels 是网关 edition 清单(真实 registry id);
 *  **byokProviders 从不按账户 / edition 收窄** —— REQ-109 #595;`#1556` 起它来自本机已应用 BYOK 目录
 *  (docs/contracts/byok-availability.md)。 */
export type EffectiveCatalog = AlphaModelCatalog & {
  liveSync: LiveSyncInfo
  /** #681 / ADR-039:`PlatformModel.pricing` 那些倍数相对的基准模型 id;`null` = 没有有效 V2/LKG,
   *  平台段计价状态为 unavailable。**基准是单位定义,不是目录成员** —— 平台明确声明消费方不得假设
   *  它出现在 platformModels 里(edition 白名单可以把它筛掉)。基准由平台下发,客户端不硬编码:
   *  平台换基准,展示跟着变才是诚实的。 */
  pricingBasisModelId: string | null
  /** `#1555`(方案 req236 §2.4):fork 前钉住、picker 与引擎都在用的那一份(已应用)。 */
  applied: CatalogVersions
  /** 后台刷新器最近一次落盘的那一份(已下载);与 `applied` 不同 = 新清单要等下次引擎换代才生效。 */
  downloaded: CatalogVersions
}

/** 两份目录各自的版本标识。`platformFetchedAt` = 平台快照的同步时刻,`null` = 没有有效快照;
 *  `byokVersion` = BYOK 目录的 `catalog_version`(远程或随包首启引导,取高者)。 */
export type CatalogVersions = { platformFetchedAt: string | null; byokVersion: number }

/** #1084:一份模型目录**刷新**的失败结局(main → renderer 的可观察出口)。
 *  `code` 是 `fetchPlatformModels()` 已经算出来的稳定分类码(`rate_limited` / `unauthorized` /
 *  `http-503` / `network` / `contract-incompatible` …),或落盘侧的 `snapshot-rejected` /
 *  `cache-write-failed`。**不是散文** —— 散文槽随时会变、可能带租户信息,不进 UI。
 *  刷新成功 ⇒ 整个值为 `null`(出口清空)。 */
export type CatalogRefreshFailure = {
  code: string
  /** ISO 时间戳:同一个码连续失败时,用户仍看得出「刚刚又失败了一次」。 */
  at: string
}

/** REQ-237 `#1556`(方案 §2.1 / I10):两份目录的刷新结局**各自**保存 —— 一份成功只清它自己那一格,
 *  另一份的失败仍可见。`alpha-catalog-health` invoke 与 `alpha-catalog-failure` 推送都发这个汇总。 */
export type CatalogRefreshHealth = { platform: CatalogRefreshFailure | null; byok: CatalogRefreshFailure | null }

// ── custom-provider add/test IPC (window.api.providers.*) ───────────────────────────────────────

export type ProviderInput = {
  id: string
  name: string
  compat: "openai" | "anthropic"
  baseURL: string
  apiKey: string
  models: string[]
  /** REQ-228 #1420:用户显式声明「能看图」的模型 id(必须 ⊂ `models`)。自定义节点没有可信的上游能力来源,
   *  不声明 ⇒ 看不了图(fail-closed)。原样进真源记录(custom-provider-truth.ts `imageInput`)。 */
  imageInput?: string[]
}
export type ProviderTestInput = {
  compat: "openai" | "anthropic"
  baseURL: string
  apiKey: string
  model: string
}
/**
 * `#1392`(基线 I4):添加自定义节点时地址被拒的**类别**,由出网派生同一个判据函数给出(main/network-egress-derived.ts
 * classifyBaseUrl —— 不是第二份判据)。renderer 据此用用户的语言说原因;`reason` 仍是英文原文兜底。
 */
export type ProviderAddressRejection = "invalid-url" | "not-https" | "loopback" | "host-shape" | "port"
export type ProviderResult = { ok: true } | { ok: false; reason: string; code?: ProviderAddressRejection }
export type ProviderTestResult = { ok: true; ms: number } | { ok: false; reason: string }

// Per-provider BYOK key state for the picker. Builtin providers are injected as opencode CONFIG
// providers (alpha-models.ts), so opencode lists their models whether or not a key exists — the
// picker can't tell "keyed" from "unkeyed" without this. `source`: "env" = the provider's keyEnv is
// set in the (main) process env (alpha.env/shell); "config" = an inline apiKey in opencode.jsonc;
// "none" = no usable key (→ row is locked, click opens the configure form).
export type ProviderKeyState = {
  configured: boolean
  /** "keychain" = alpha's encrypted key store (alpha-byok-keys, the source of truth; the only source with a
   *  last-4 `hint`); "env" = keyEnv in process env (alpha.env/shell export); "config" = a hand-written
   *  `{file:}` / `{env:}` reference in alpha.jsonc (alpha does not manage it; no hint — the value is never
   *  read); "needs-reentry" (REQ-226 `#1343`) = the alpha.jsonc block exists but its key is unusable — a
   *  pre-#1343 inline plaintext key the engine is no longer allowed to use, or alpha's keychain marker
   *  with no key in the store (keychain unavailable / re-signed / entry gone) — `configured:false`, no
   *  hint; the picker keeps the row visible but unavailable and asks for re-entry; "none" = no key.
   *  ("auth" = legacy opencode auth.json — no longer produced; kept in the union pending UI cleanup.) */
  source: "keychain" | "env" | "config" | "needs-reentry" | "auth" | "none"
  hint?: string
}
export type ProviderKeyStatus = Record<string, ProviderKeyState>
