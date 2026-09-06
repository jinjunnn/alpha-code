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
  /** REQ-153 #1267:BYOK-only id 的**逐模型元数据槽**(键 = `models` 里的 id)。此前 BYOK 目录只有 id 列表,
   *  展示名 / 「推理」徽标 / 档位一律从平台**同名**条目派生;`glm-4.5-air` 平台侧没有同名条目,于是它无徽标、
   *  零档,而上游 `transform.options()` 对 `zhipuai*` + openai-compatible **无条件**写 `thinking: enabled` ——
   *  用户看到「不思考的快模型」,请求却锁在思考档。这个槽是 alpha 自有目录里给它徽标 + 开/关两档的唯一旋钮。
   *  读它的只有 {@link byokModelMeta};键不在 `models` 里、或与平台同名条目重叠,alpha-models.test.ts 当场红。 */
  modelMeta?: Record<string, ByokModelMeta>
}

/** {@link ByokProvider.modelMeta} 的值:与 `PlatformModel` 的展示元数据同形(刻意没有 pricing —— 直连节点不经网关,
 *  没有平台计价倍数;REQ-127 #679 / ADR-039 不允许本地出现任何价格主张)。 */
export type ByokModelMeta = {
  name?: string
  reasoning?: boolean
  /** 档名 → 引擎 request 参数,wire 形状按 `@ai-sdk/openai-compatible` 写(BYOK provider 全部 `compat: "openai"`)。
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

/** BYOK 行的展示名、推理能力与**推理档位**的**唯一**派生函数。两个来源,显式优先:
 *  ① `ByokProvider.modelMeta[id]`(REQ-153 #1267,BYOK-only id 自己的元数据槽);
 *  ② 平台目录**同名条目**(`PlatformModel`),没有槽时的派生路径。
 *  REQ-153 #1236:picker 打「推理」徽标(renderer/model-picker-core.ts)与 sidecar 往引擎写
 *  `capabilities.reasoning`(main/alpha-models.ts)必须都走这一个函数。此前两边各查一次:picker 查
 *  平台目录、注入只写 `{name}` ⇒ 徽标亮着而引擎 `reasoning === false`,`transform.ts:712` 首行即
 *  `return {}` —— UI 对用户说了假话。传入的 `platformModels` 应是 `projectPlatformModels` 的产物
 *  (两边同一份投影),不是裸 JSON。
 *  REQ-153 #1266:`variants` 同样由这里派生,同一份数据同时进 sidecar 注入(config `models.<id>.variants`,
 *  引擎与自己派生的档位表 mergeDeep)与 picker 的 BYOK 行(档位 chip 的列表)、会话投影
 *  (`composerModelFromRef`)、自动默认(`model-default-core` 第③级)。档位表的 wire 形状
 *  (`reasoningEffort` → `reasoning_effort`、`thinking` 原样透传)按 `@ai-sdk/openai-compatible` 写,
 *  前提是目录里每个 BYOK provider 都是 `compat: "openai"` —— alpha-models.test.ts 钉着这条不变量。
 *  REQ-153 #1267:`engineProviderID` 是引擎侧 id(`<id>-byok`,{@link byokEngineId}),四个调用点手里都有它;
 *  槽与同名平台条目**不得同时存在**(alpha-models.test.ts 钉着),所以「显式优先」在出货目录上永远不被触发,
 *  只是给一个确定的读法。 */
export function byokModelMeta(
  catalog: {
    platformModels: readonly Pick<PlatformModel, "id" | "name" | "reasoning" | "variants">[]
    byokProviders: readonly Pick<ByokProvider, "id" | "modelMeta">[]
  },
  engineProviderID: string,
  id: string,
): { name: string; reasoning: boolean; variants?: Record<string, Record<string, unknown>> } {
  const own = catalog.byokProviders.find((provider) => byokEngineId(provider.id) === engineProviderID)?.modelMeta?.[id]
  const display = own ?? catalog.platformModels.find((model) => model.id === id)
  return {
    name: display?.name ?? id,
    reasoning: !!display?.reasoning,
    ...(display?.variants ? { variants: display.variants } : {}),
  }
}

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
