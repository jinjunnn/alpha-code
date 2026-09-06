// REQ-153 #1238:harness 侧 `max_tokens` 跟随网关 route 上限 —— 做法是**对平台代理节点不发 `max_tokens`**,
// 让网关(route 上限的唯一权威)自己填。
//
// ── 32000 的来源(2026-09-06 实跑定位,单变量,假上游捕获本仓真 CLI 的请求体)──────────────
//   `packages/opencode/src/provider/transform.ts:18`   `OUTPUT_TOKEN_MAX = 32_000`
//   `packages/opencode/src/provider/transform.ts:1394` `maxOutputTokens(model, cap = OUTPUT_TOKEN_MAX)
//                                                       = Math.min(model.limit.output, cap) || cap`
//   `packages/opencode/src/session/llm/request.ts:133` 以 `flags.outputTokenMax`(env
//   `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX`,`effect/runtime-flags.ts:52`)当 cap 调它;
//   config 声明的模型 `limit.output` 缺省为 0(`provider/provider.ts:1497`)⇒ `Math.min(0, 32000) = 0 || 32000`。
//   实测:limit.output=100 → 100;limit.output=131072 → **仍 32000**(config 只能往低调);
//   env 200000 + limit.output 131072 → 131072;env 200000 单独 → 200000。
//
// ── 为什么是「不发」而不是「填 route 上限」──────────────────────────────────────────────────
//   · 网关 `/v1/models`(ModelCatalogV2)**不下发** `maxOutputTokens`,harness 拿不到 route 值;
//     写进 alpha-models.json 就是第二份权威(票面明令不写死常量)。
//   · 网关两条 wire 都是 `min(客户端值(如有), route.maxOutputTokens)`,客户端不传 ⇒ 上游收 route 值
//     (alpha-platform `lib/openai-wire.ts finalizeOpenAIRequest` / `worker.ts:1924`,生产函数实跑确认)。
//     ⇒ 不发 = 精确跟随 route,网关抬多少 harness 就跟多少,零同步成本。
//   · 全局 env cap 会同时抬直连 BYOK 节点(智谱对超模型上限的 max_tokens 直接 400)并改变 models.dev
//     模型的 compaction 阈值(`session/overflow.ts`);本钩子跑在 transform 之后(`request.ts:118`),
//     只改这一次请求的 `maxOutputTokens`,overflow 算术不受影响。上游同款先例:`plugin/cloudflare.ts:64-74`。
//
// ── 判据:哪个节点是「平台代理」────────────────────────────────────────────────────────────
//   注入侧(`ui-mac/src/main/alpha-models.ts`)只在 `ALPHA_BASE_URL` 存在时创建平台节点,且把
//   `options.baseURL` **逐字**写成该 env 值;`ALPHA_BASE_URL` 在 sidecar env 白名单内(`sidecar-env.ts`)。
//   于是「provider.options.baseURL === ALPHA_BASE_URL」与注入侧是同一个事实,不需要第二份 id 清单。
//   严格相等(不 normalize 尾斜杠):两边写的是同一个字符串,normalize 只会引入一格「看起来相等其实
//   不是同一节点」的判断。直连 BYOK / 用户自定义节点 baseURL 不同 ⇒ 保持上游行为(仍发 32000)。

export type PlatformOutputCapInput = {
  /** `input.provider.options.baseURL`(chat.params 钩子拿到的 provider 配置)。 */
  providerBaseURL: unknown
  /** `process.env.ALPHA_BASE_URL`(引擎进程的 env)。 */
  alphaBaseURL: string | undefined
}

export type PlatformOutputCapDecision =
  | { omit: true; reason: "platform-gateway" }
  | { omit: false; reason: "no-alpha-base-url" | "not-platform-provider" }

/** 该请求要不要把 `maxOutputTokens` 置空(= 请求体不带 `max_tokens`,由网关按 route 上限填)。 */
export function platformOutputCap(input: PlatformOutputCapInput): PlatformOutputCapDecision {
  const alpha = input.alphaBaseURL
  if (typeof alpha !== "string" || alpha.length === 0) return { omit: false, reason: "no-alpha-base-url" }
  if (typeof input.providerBaseURL !== "string" || input.providerBaseURL !== alpha)
    return { omit: false, reason: "not-platform-provider" }
  return { omit: true, reason: "platform-gateway" }
}
