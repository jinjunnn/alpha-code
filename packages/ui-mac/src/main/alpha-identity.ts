// alpha-code's brand identity + per-session capability awareness, injected globally as an opencode
// instruction file by the sidecar (see sidecar.ts → injectAlphaConfig).
//
// Scope discipline: this layer sets the product name and only *informs* the agent which
// alpha-specific capabilities are live in THIS session. It must NOT re-tune coding behavior — that
// rides on opencode's behavior-tuned base prompt, and (when opted in) on the separate, explicitly
// behavior-changing alpha-behavior layer (see alpha-behavior.ts, ADR-015). Capability lines are
// purely factual ("X is available"), never instructions on how to write code.

export interface AlphaCapabilities {
  /** Web search is open to every provider this session (ADR-009). */
  websearch?: boolean
  /** The cloud tool gateway (`cloud.*` MCP) is registered this session (ADR-002 dispatch seam). */
  cloudDispatch?: boolean
}

export function buildAlphaIdentity(caps: AlphaCapabilities = {}): string {
  const out: string[] = [
    "# alpha-code",
    "",
    // REQ-062 T2:不再向模型披露底层引擎名("built on opencode" 是「自称 alpha-code (opencode)」
    // 的另一半根因;引擎名对回答"这是什么产品"没有正向价值)。
    "You are running inside **alpha-code**, a macOS coding agent.",
    'When the user asks what app, product, or tool this is, refer to yourself as "alpha-code".',
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
