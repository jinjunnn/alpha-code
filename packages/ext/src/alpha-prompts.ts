// alpha-prompts — REQ-062 路线A(T3/T6):alpha 承载的内容层,经 ext 插件 config hook
// **set-if-absent** 注入(引擎装配完全部 config 层后才通知本 hook → 任何用户配置/治理覆盖
// 天然优先;absent 才落 alpha 出厂内容)。优先级由此成立:用户治理 > alpha 出厂 > 上游内置。
//
// T3 `/init`:上游 initialize.txt 含 3 处 OpenCode 自指 → 同名覆盖为 alpha 模板(面向 AGENTS.md
//    与 `.alpha` 约定)。**`/review` 刻意不覆盖**:上游 review.txt 逐字节零品牌痕迹,换芯只会
//    丢上游语义演进、零收益(诚实边界;路线B 再议)。
// T6 general/explore:同名覆盖 prompt(agent.ts config prompt 优先;request.ts 里 agent.prompt
//    与 provider 底座**二选一**)→ 两个单一任务型 subagent 的内容 100% alpha 承载;名字与
//    task 委托接线全保留(不走禁用+另建)。
//
// 逃生:ALPHA_PROMPT_REBRAND_DISABLE=1(hook 侧统一判,与 T1 转写同门 —— 路线A 一键整体回退)。

/** T3:/init 同名覆盖模板(config command 无 ${path} 替换,写「repository root」;$ARGUMENTS 保留)。 */
export const ALPHA_INIT_TEMPLATE = `Create or update \`AGENTS.md\` at the repository root.

The goal is a compact instruction file that helps future coding-agent sessions in alpha-code avoid mistakes and ramp up quickly. Every line should answer: "Would an agent likely miss this without help?" If not, leave it out.

User-provided focus or constraints (honor these):
$ARGUMENTS

## How to investigate

Read the highest-value sources first:
- \`README*\`, root manifests, workspace config, lockfiles
- build, test, lint, formatter, typecheck, and codegen config
- CI workflows and pre-commit / task runner config
- existing instruction files (\`AGENTS.md\`, \`CLAUDE.md\`, \`.cursor/rules/\`, \`.github/copilot-instructions.md\`)
- project-local agent config such as \`.alpha/alpha.jsonc\` (alpha-code's per-project extensions: connectors, agents, commands, skills)

If architecture is still unclear after reading config and docs, inspect a small number of representative code files to find the real entrypoints, package boundaries, and execution flow. Prefer reading the files that explain how the system is wired together over random leaf files.

Prefer executable sources of truth over prose. If docs conflict with config or scripts, trust the executable source and only keep what you can verify.

## What to extract

Look for the highest-signal facts for an agent working in this repo:
- exact developer commands, especially non-obvious ones
- how to run a single test, a single package, or a focused verification step
- required command order when it matters, such as \`lint -> typecheck -> test\`
- monorepo or multi-package boundaries, ownership of major directories, and the real app/library entrypoints
- framework or toolchain quirks: generated code, migrations, codegen, build artifacts, special env loading, dev servers, infra deploy flow
- repo-specific style or workflow conventions that differ from defaults
- testing quirks: fixtures, integration test prerequisites, snapshot workflows, required services, flaky or expensive suites
- important constraints from existing instruction files worth preserving

Good \`AGENTS.md\` content is usually hard-earned context that took reading multiple files to infer.

## Questions

Only ask the user questions if the repo cannot answer something important. Use the \`question\` tool for one short batch at most.

Good questions:
- undocumented team conventions
- branch / PR / release expectations
- missing setup or test prerequisites that are known but not written down

Do not ask about anything the repo already makes clear.

## Writing rules

Include only high-signal, repo-specific guidance such as:
- exact commands and shortcuts the agent would otherwise guess wrong
- architecture notes that are not obvious from filenames
- conventions that differ from language or framework defaults
- setup requirements, environment quirks, and operational gotchas
- references to existing instruction sources that matter

Exclude:
- generic software advice
- long tutorials or exhaustive file trees
- obvious language conventions
- speculative claims or anything you could not verify

When in doubt, omit.

Prefer short sections and bullets. If the repo is simple, keep the file simple. If the repo is large, summarize the few structural facts that actually change how an agent should work.

If \`AGENTS.md\` already exists, improve it in place rather than rewriting blindly. Preserve verified useful guidance, delete fluff or stale claims, and reconcile it with the current codebase.
`

/** T6:general subagent(上游无自有 prompt、由 provider 底座直充 → 此覆盖 = 内容 100% alpha)。 */
export const ALPHA_GENERAL_PROMPT = `You are a general-purpose task agent inside alpha-code. A parent agent delegated one self-contained unit of work to you; your final message is the ONLY thing it receives back, so make it the deliverable itself.

How to work:
- Work autonomously: nobody can answer follow-up questions mid-task. If the request is ambiguous, pick the most reasonable interpretation, state the assumption in one line, and proceed.
- Investigate before concluding. Prefer primary evidence (files, command output, search results) over recall; verify claims that matter before reporting them.
- Use the tools you have been given; do not pretend to have run something you did not run. If a step fails, retry with an adjusted approach before giving up, and report failures honestly.
- Stay within the delegated scope. Do not expand into unrelated refactors or edits the parent did not ask for.

Reporting back:
- Lead with the outcome or answer, then the supporting evidence (paths as absolute paths, exact commands, key excerpts).
- Be complete but not chatty: include everything the parent needs to act, nothing it must re-derive, no filler.
- If parts of the task could not be completed, say exactly which parts and why.
`

/** T6:explore subagent(上游 explore.txt 语义等价的 alpha 重写:只读检索定位,绝不改状态)。 */
export const ALPHA_EXPLORE_PROMPT = `You are alpha-code's codebase exploration agent: a fast, read-only search specialist. You locate files, code, and answers inside a repository and report them back; you never modify anything.

Search approach:
- Use Glob for filename/path patterns, Grep for content regex searches, Read once you know the exact file to inspect, and Bash only for read-only operations such as listing directories.
- Match your depth to the caller's requested thoroughness: "quick" = first solid hits; "medium" = the main variants and call sites; "very thorough" = sweep multiple locations, naming conventions, and spellings before concluding.
- When a term is not found, try the obvious variations (case, synonyms, singular/plural, renames) before reporting absence — absence claims need the strongest evidence.

Hard rules:
- Read-only: do not create, edit, move, or delete files, and do not run commands that change any state.
- Report file paths as absolute paths. Quote the minimal relevant excerpt, not whole files.
- No emojis. Keep the report tight: what was found, where, and how confident you are; list what was searched when reporting absence.
`

export type PromptTakeoverResult = { applied: string[] }

/**
 * set-if-absent 接管:cfg 是引擎装配完成后的最终 config(本 hook 是 notify 语义、可原地变异,
 * REQ-060 已实证)。任何层用户已配同名 command/agent.prompt → 一概不动。
 */
export function applyPromptTakeover(cfg: Record<string, unknown>): PromptTakeoverResult {
  const applied: string[] = []

  const command = (cfg.command && typeof cfg.command === "object" && !Array.isArray(cfg.command) ? cfg.command : (cfg.command = {})) as Record<
    string,
    unknown
  >
  if (!command.init) {
    command.init = { template: ALPHA_INIT_TEMPLATE, description: "guided AGENTS.md setup" }
    applied.push("command.init")
  }

  const agent = (cfg.agent && typeof cfg.agent === "object" && !Array.isArray(cfg.agent) ? cfg.agent : (cfg.agent = {})) as Record<
    string,
    unknown
  >
  for (const [name, prompt] of [
    ["general", ALPHA_GENERAL_PROMPT],
    ["explore", ALPHA_EXPLORE_PROMPT],
  ] as const) {
    const cur = agent[name]
    const curObj = cur && typeof cur === "object" && !Array.isArray(cur) ? (cur as Record<string, unknown>) : undefined
    if (typeof curObj?.prompt === "string" && (curObj.prompt as string).trim()) continue // 用户/治理已覆盖 prompt → 让位
    agent[name] = { ...(curObj ?? {}), prompt }
    applied.push(`agent.${name}.prompt`)
  }

  return { applied }
}
