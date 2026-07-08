// prompt-rebrand — REQ-062 路线A(T1):系统提示词品牌转写(ADR-015 2026-07-08 修订)。
//
// 机制:`experimental.chat.system.transform` 是唯一能触及 provider 底座 + environment 的零-fork
// 接缝(packages/plugin/src/index.ts:291-296;request.ts 触发)。到手的 system 段是
// 「底座 + environment + 用户 instructions(AGENTS.md/CLAUDE.md)+ skills」**join 后的单串** ——
// 因此绝不做全局词替换(会篡改用户自己的文本 = 对模型撒谎),只做**精选子串对**转写
// (ADR-007 brand-i18n 同款纪律):每条 from 都是上游底座 .txt 的逐字节原文,用户文本撞上的
// 概率趋零;上游改版导致 from 失配 = 该句不再出现 → 由 residual 审计 warn 兜底(不静默)。
//
// 纪律(REQ-062):
//   - 真实事物名不转:opencode.json(c) / .opencode 路径 / @opencode-ai 包名 / CLI 等实体引用
//     (本模块只按整句替换,天然不触及);
//   - 漏改 warn:转写后残留「You are opencode」行首句 / anomalyco 仓指引 / opencode.ai 文档域 →
//     报 warning(每进程每签名一次,防每条消息刷屏);用户 instructions 里的合法提及也会触发
//     (如 alpha-code 仓自身),warning 是诚实提示而非错误;
//   - 逃生 ALPHA_PROMPT_REBRAND_DISABLE=1(hook 侧判,本模块纯函数);
//   - 底座改版复核:tests 逐条断言 from 子串仍存在于上游 .txt(sync 后红 = 清单需复核,
//     与 ADR-015 合并验证 / sync tripwire 呼应)。

export const REBRAND_TO = "alpha-code"

export type RebrandRule = {
  id: string
  /** 上游底座逐字节原文(tests 断言仍在;失配 = 上游改版,该条静默不再命中 → residual 审计接手)。 */
  from: string
  to: string
  /** 断言 from 存在的上游文件(相对 packages/opencode/src/session/prompt/),供 drift 锁测。 */
  file: string
}

export const REBRAND_RULES: readonly RebrandRule[] = [
  // ── 自指首句(8 底座 + copilot)────────────────────────────────────────────
  {
    id: "identity-anthropic-codex",
    from: "You are OpenCode, the best coding agent on the planet.",
    to: "You are alpha-code, the best coding agent on the planet.",
    file: "anthropic.txt",
  },
  {
    id: "identity-default-trinity",
    from: "You are opencode, an interactive CLI tool that helps users with software engineering tasks.",
    to: "You are alpha-code, an interactive coding agent that helps users with software engineering tasks.",
    file: "default.txt",
  },
  {
    id: "identity-beast",
    from: "You are opencode, an agent - please keep going",
    to: "You are alpha-code, an agent - please keep going",
    file: "beast.txt",
  },
  {
    id: "identity-kimi",
    from: "You are OpenCode, an interactive general AI agent running on a user's computer.",
    to: "You are alpha-code, an interactive general AI agent running on a user's computer.",
    file: "kimi.txt",
  },
  {
    id: "identity-gpt",
    from: "You are OpenCode, You and the user share the same workspace",
    to: "You are alpha-code, You and the user share the same workspace",
    file: "gpt.txt",
  },
  {
    id: "identity-gemini",
    from: "You are opencode, an interactive CLI agent specializing in software engineering tasks.",
    to: "You are alpha-code, an interactive coding agent specializing in software engineering tasks.",
    file: "gemini.txt",
  },
  {
    id: "identity-copilot",
    from: "Your name is opencode",
    to: "Your name is alpha-code",
    file: "copilot-gpt-5.txt",
  },
  // ── help/feedback 指引块(指向上游 TUI 快捷键与 GitHub 仓,对 alpha 用户全部失实 → 整块剔除)──
  {
    id: "help-feedback-anthropic",
    from: "If the user asks for help or wants to give feedback inform them of the following:\n- ctrl+p to list available actions\n- To give feedback, users should report the issue at\n  https://github.com/anomalyco/opencode\n\n",
    to: "",
    file: "anthropic.txt",
  },
  {
    id: "help-feedback-default",
    from: "If the user asks for help or wants to give feedback inform them of the following:\n- /help: Get help with using opencode\n- To give feedback, users should report the issue at https://github.com/anomalyco/opencode/issues\n\n",
    to: "",
    file: "default.txt",
  },
  // ── 产品问答指引(原文指向 opencode.ai 文档 → 改为按会话可观测事实自答,不指外部文档)──
  {
    id: "docs-guidance-anthropic",
    from: 'When the user directly asks about OpenCode (eg. "can OpenCode do...", "does OpenCode have..."), or asks in second person (eg. "are you able...", "can you do..."), or asks how to use a specific OpenCode feature (eg. implement a hook, write a slash command, or install an MCP server), use the WebFetch tool to gather information to answer the question from OpenCode docs. The list of available docs is available at https://opencode.ai/docs',
    to: 'When the user directly asks about this product (eg. "can it do...", "does it have..."), or asks in second person (eg. "are you able...", "can you do..."), answer as alpha-code from what you can observe in this session and its configuration; do not point the user at external docs you have not verified.',
    file: "anthropic.txt",
  },
  {
    id: "docs-guidance-default",
    from: "When the user directly asks about opencode (eg 'can opencode do...', 'does opencode have...') or asks in second person (eg 'are you able...', 'can you do...'), first use the WebFetch tool to gather information to answer the question from opencode docs at https://opencode.ai",
    to: "When the user directly asks about this product (eg 'can it do...', 'does it have...') or asks in second person (eg 'are you able...', 'can you do...'), answer as alpha-code from what you can observe in this session and its configuration.",
    file: "default.txt",
  },
  // ── 正文自指(anthropic 客观性段)──────────────────────────────────────────
  {
    id: "objectivity-anthropic",
    from: "It is best for the user if OpenCode honestly applies the same rigorous standards",
    to: "It is best for the user if alpha-code honestly applies the same rigorous standards",
    file: "anthropic.txt",
  },
] as const

/** 转写后残留审计:仍像「上游自指/指引」的形态 → warning(上游改版清单失配,或用户文本合法提及)。 */
const RESIDUAL_PATTERNS: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: "identity-line", re: /^you are opencode\b/im },
  { id: "name-line", re: /^your name is opencode\b/im },
  { id: "upstream-repo", re: /github\.com\/anomalyco\/opencode/i },
  { id: "upstream-docs", re: /https?:\/\/opencode\.ai/i },
]

export type RebrandResult = { system: string[]; changed: boolean; warnings: string[] }

/** 纯函数:对 system 段做精选子串转写 + 残留审计。不修改入参。 */
export function rebrandSystem(system: readonly string[]): RebrandResult {
  const out: string[] = []
  const warnings: string[] = []
  let changed = false
  for (const seg of system) {
    let t = seg
    for (const rule of REBRAND_RULES) {
      if (t.includes(rule.from)) t = t.split(rule.from).join(rule.to)
    }
    if (t !== seg) changed = true
    for (const p of RESIDUAL_PATTERNS) {
      if (p.re.test(t)) warnings.push(`residual ${p.id} after rebrand — upstream base drifted or user text mentions it (curated list may need review)`)
    }
    out.push(t)
  }
  return { system: out, changed, warnings }
}
