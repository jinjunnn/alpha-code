// REQ-156:**直连 BYOK 节点**的 `max_tokens` 取该模型上游实读受理上限。
//
// `#1238`(REQ-153 AC2)只解决了平台代理节点那一半 —— 它的判据是「baseURL 逐字 == ALPHA_BASE_URL
// ⇒ 不发 max_tokens,由网关按 route 上限填」。直连 BYOK 节点**没有网关**,没人替它填,于是它一直
// 发着上游默认的 `OUTPUT_TOKEN_MAX = 32_000`(`platform-output-cap.test.ts` 那条
// 「直连 BYOK 节点:maxOutputTokens 原样(上游的 32000)」正是把这个状态钉住的)。
//
// ── 为什么不能用 config `limit.output`,也不能用全局 env ────────────────────────────────
//   `transform.ts:1418` `maxOutputTokens(model, cap) = Math.min(model.limit.output, cap) || cap`。
//   · 只写 config `limit.output`:实测 `131072` → **仍 32000**(config 只能往低调,抬不上去);
//   · 只抬 env `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX`:它是**全局**的,`Math.min(0, env) || env`
//     会把 env 值发给**每一个**没声明 `limit.output` 的 config 模型 —— 包括本表没有读数的 6 个 BYOK id
//     和用户自己加的自定义节点。而上游对超出自己上限的 `max_tokens` 是**硬 400**(下方实读),
//     所以「抬 env」= 给一批我们没量过的模型发一个我们没验过的数,方向不安全;它还会改
//     `session/overflow.ts` 的 compaction 算术。
//   ⇒ 落点与 `#1238` 同一条缝:alpha 自有插件的 `chat.params`(跑在 transform 之后,
//     `request.ts:118`),只改这一次请求,逐模型,查得到读数才写。
//
// ── 上限从哪来:上游自己报的,不是文档页 ──────────────────────────────────────────────
//   2026-09-07 实打(owner 授权,`docs/verification/2026-09-07-byok-output-cap/`)。每个模型三点:
//   ① 发一个结构性非法的 `max_tokens: 99999999` —— 上游在 400 里**自报合法区间**(零 token 生成,零费用);
//   ② 按自报值顶格再发一次 —— HTTP 200、`finish_reason=stop`(证明这个数**真的被受理**,不是只是没被拒);
//   ③ 自报值 +1 再发一次 —— HTTP 400(证明边界**就在**那个数上,而不是探针恰好没碰到)。
//   ①单独不成立:全是 400 的探针分不出「拒绝」与「探针自己坏了」,②③ 是它的自检。
//
// ── fail-closed ──────────────────────────────────────────────────────────────────────
//   本表**只列实打过的**。目录里另外 6 个 BYOK id(MiniMax / 通义三个 / Kimi 两个)本机无凭据,
//   探不了 ⇒ 不在表里 ⇒ 一个字节都不改,保持今天的 32000。少发不会错,多发是 400。
//   新增一个 BYOK 模型而忘了量它,`byok-output-cap.test.ts` 的双向漂移锁会红(两个方向都锁:
//   表里有目录没有 / 目录里有表没有且不在 UNREAD 名单 —— `#1265` 的教训:只锁一个方向等于没锁)。

/** 一条实读记录。`baseURL` 参与判据:目录里那个 provider 的 baseURL 变了(换域名 / 换代理),
 *  这条读数就不再适用于它,必须重新量 —— 而不是把一个对别的端点量出来的数发过去。 */
export type ByokOutputCapReading = {
  /** 引擎侧 provider id(`byokEngineId(catalogID)` = `<id>-byok`)。 */
  engineProviderID: string
  /** 发到线上的模型名(`Model.api.id`)—— 上限是**上游看到的那个模型**的属性。 */
  apiModelID: string
  /** 目录里该 provider 的 `baseURL`,逐字。 */
  baseURL: string
  /** 上游自报并实测受理的最大 `max_tokens`。 */
  value: number
  /** 实读日期(ISO)。 */
  readOn: string
  /** 上游自报区间的原文片段 —— 留着,下次复读时对得上才算没漂。 */
  selfReported: string
}

/** 实读表。**只增实打过的**;改动必须同批更新 `docs/verification/2026-09-07-byok-output-cap/`。 */
export const BYOK_OUTPUT_CAP_READINGS: readonly ByokOutputCapReading[] = [
  {
    engineProviderID: "zhipuai-byok",
    apiModelID: "glm-5.2",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    value: 131072,
    readOn: "2026-09-07",
    selfReported: "max_tokens参数非法：限制数值范围[1,131072]",
  },
  {
    engineProviderID: "zhipuai-byok",
    apiModelID: "glm-4.5-air",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    value: 98304,
    readOn: "2026-09-07",
    selfReported: "max_tokens参数非法：限制数值范围[1,98304]",
  },
  {
    engineProviderID: "deepseek-byok",
    apiModelID: "deepseek-v4-flash",
    baseURL: "https://api.deepseek.com/v1",
    value: 393216,
    readOn: "2026-09-07",
    selfReported: "Invalid max_tokens value, the valid range of max_tokens is [1, 393216]",
  },
  {
    engineProviderID: "deepseek-byok",
    apiModelID: "deepseek-v4-pro",
    baseURL: "https://api.deepseek.com/v1",
    value: 393216,
    readOn: "2026-09-07",
    selfReported: "Invalid max_tokens value, the valid range of max_tokens is [1, 393216]",
  },
]

/** 目录里**有**、但本机没有凭据因而**没量**的 BYOK 模型。它们保持上游 32000。
 *  这不是"以后再说"的清单,是漂移锁的另一半:目录新增一个 id 而两边都没登记 ⇒ 测试红,
 *  逼一次显式选择(量它,或者写进这里说明为什么量不了)。 */
export const BYOK_OUTPUT_CAP_UNREAD: readonly { apiModelID: string; why: string }[] = [
  { apiModelID: "MiniMax-M2", why: "本机无 MINIMAX_API_KEY,探不了受理上限" },
  { apiModelID: "qwen3.8-max-preview", why: "本机无 DASHSCOPE_API_KEY,探不了受理上限" },
  { apiModelID: "qwen-plus", why: "本机无 DASHSCOPE_API_KEY,探不了受理上限" },
  { apiModelID: "qwen3-coder-plus", why: "本机无 DASHSCOPE_API_KEY,探不了受理上限" },
  { apiModelID: "kimi-k2", why: "本机无 MOONSHOT_API_KEY,探不了受理上限" },
  { apiModelID: "moonshot-v1-128k", why: "本机无 MOONSHOT_API_KEY,探不了受理上限" },
]

export type ByokOutputCapInput = {
  /** `input.model.providerID`。 */
  engineProviderID: unknown
  /** `input.model.api.id` —— 线上模型名。 */
  apiModelID: unknown
  /** `input.provider.options.baseURL`。 */
  providerBaseURL: unknown
  /** `output.maxOutputTokens` 当前值(transform 算出来的那个)。 */
  current: unknown
}

export type ByokOutputCapDecision =
  | { raise: true; value: number }
  | { raise: false; reason: "no-reading" | "base-url-mismatch" | "not-a-number" | "already-at-or-above" }

/**
 * 该请求要不要把 `maxOutputTokens` 抬到实读上限。
 *
 * **只抬不降**:`current` 已经 ≥ 读数时不动。理由是 config `limit.output` 是用户/配置**主动往低调**
 * 的合法旋钮(上游语义就是 `Math.min`),我们没有理由去覆盖一个比我们更保守的显式选择;
 * `current` 不是数(别的插件已置空 = 「这次别发 max_tokens」)时同样不动。
 */
export function byokOutputCap(input: ByokOutputCapInput): ByokOutputCapDecision {
  const reading = BYOK_OUTPUT_CAP_READINGS.find(
    (r) => r.engineProviderID === input.engineProviderID && r.apiModelID === input.apiModelID,
  )
  if (!reading) return { raise: false, reason: "no-reading" }
  if (typeof input.providerBaseURL !== "string" || input.providerBaseURL !== reading.baseURL)
    return { raise: false, reason: "base-url-mismatch" }
  if (typeof input.current !== "number" || !Number.isFinite(input.current))
    return { raise: false, reason: "not-a-number" }
  if (input.current >= reading.value) return { raise: false, reason: "already-at-or-above" }
  return { raise: true, value: reading.value }
}
