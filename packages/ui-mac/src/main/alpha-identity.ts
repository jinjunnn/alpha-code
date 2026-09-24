// alpha-code's brand identity + per-session capability awareness, injected globally as an opencode
// instruction file by the sidecar (see sidecar.ts → injectAlphaConfig).
//
// Scope discipline: this layer sets the product name and only *informs* the agent which
// alpha-specific capabilities are live in THIS session. It must NOT re-tune coding behavior — that
// rides on opencode's behavior-tuned base prompt, and (when opted in) on the separate, explicitly
// behavior-changing alpha-behavior layer (see alpha-behavior.ts, ADR-015). Capability lines are
// purely factual ("X is available"), never instructions on how to write code.

export interface AlphaCapabilities {
  /**
   * 这一轮模型的工具表里**至少有一个** web search 工具(本地 keyless `websearch` 或云
   * `cloud_cloud_web_search`)。两条腿都对**每个** provider 可见,所以提示里那句
   * "not just the default provider" 对两条腿都成立(`#1414` 勘破 §3.2)。
   */
  websearch?: boolean
  /** The cloud tool gateway (`cloud.*` MCP) is registered this session (ADR-002 dispatch seam). */
  cloudDispatch?: boolean
}

/**
 * 把「工具表的在场性」折成提示里的能力事实。`#1414` 基线 §三 **S4**:提示里声称的能力必须与
 * 模型工具表里的在场性一致。本函数曾经自己读 `ALPHA_WEBSEARCH_DISABLE` / `OPENCODE_ENABLE_EXA`
 * 再判一遍(勘破 §6 点名的第四处各算各的,与真闸不同源 ⇒ 可以「提示说有、工具表里没有」),
 * 现在**不再自己判**:入参就是两条腿各自的在场性,由唯一算得出它们的那一处
 * (`alpha-config-injection.ts`,它握着判据并消费真闸的 deny 判决)算好送进来。
 * 本模块必须保持**零 import**(ext 的登记簿直接 import 它,拖进 main 世界违反 ADR-006),
 * 所以同源的保证只能落在调用点 + 四格闸门 `websearch-prompt-tool-parity.test.ts`。
 */
export function buildAlphaCapabilities(input: {
  /** 本地 keyless `websearch` 这一轮在不在模型工具表里。 */
  localWebSearch: boolean
  /** 云 `cloud_cloud_web_search` 这一轮在不在模型工具表里。 */
  cloudWebSearch: boolean
  /** 云 MCP server(`cloud.*` 工具面)这一轮注册了没有。 */
  cloudDispatch: boolean
}): AlphaCapabilities {
  return {
    websearch: input.localWebSearch || input.cloudWebSearch,
    cloudDispatch: input.cloudDispatch,
  }
}

export function buildAlphaIdentity(caps: AlphaCapabilities = {}): string {
  const out: string[] = [
    "# Code Puppy",
    "",
    // REQ-062 T2:不再向模型披露底层引擎名("built on opencode" 是「自称 alpha-code (opencode)」
    // 的另一半根因;引擎名对回答"这是什么产品"没有正向价值)。
    "You are running inside **Code Puppy**, a macOS coding agent.",
    'When the user asks what app, product, or tool this is, refer to yourself as "Code Puppy".',
  ]

  const capLines: string[] = []
  if (caps.websearch)
    capLines.push(
      "- Web search is enabled for every model in this app (not just the default provider) — reach for it whenever a task needs current or external information.",
    )
  if (caps.cloudDispatch)
    capLines.push(
      "- A cloud tool gateway is connected: when `cloud.*` tools appear in your tool list you may dispatch heavy non-coding work (deep research, long batch jobs) to them and fold the result back into the session.",
    )

  if (capLines.length) out.push("", "## Capabilities available this session", ...capLines)

  out.push(
    "",
    "This note sets the product name and the capability facts above. In every other respect behave exactly as configured — do not change your coding behavior here.",
  )
  return out.join("\n") + "\n"
}

// Backwards-compatible default with no capabilities asserted. Prefer buildAlphaIdentity(caps).
export const ALPHA_IDENTITY_MD = buildAlphaIdentity()
