// composer-autocomplete-core — PURE logic for the home composer's slash/@ menus (REQ-038), kept
// solid-free so bun test can exercise it directly (composer-autocomplete.tsx wires it to signals).
// Behaviour parity notes live in composer-autocomplete.tsx; this file is the mechanics.

export type TriggerView = { mode: "slash" | "at"; query: string; tokenStart: number; caret: number }

export type MentionPart =
  | { type: "agent"; name: string; content: string }
  | { type: "file"; path: string; content: string }

const AT_TOKEN = /(^|\s)@(\S*)$/

/** Derive the active menu trigger from the text + caret.
 *  slash: the whole input is a single "/token" still being typed (a following space closes the menu —
 *  upstream slash popover parity). @: a token ending AT the caret that starts with "@" on a word
 *  boundary. Returns null when neither applies. */
export function detectTrigger(text: string, caret: number): TriggerView | null {
  const slash = /^\/(\S*)$/.exec(text)
  if (slash && caret >= 1) return { mode: "slash", query: slash[1].toLowerCase(), tokenStart: 0, caret }
  const upToCaret = text.slice(0, caret)
  const at = AT_TOKEN.exec(upToCaret)
  if (at) {
    const tokenStart = upToCaret.length - at[2].length - 1 // index of "@"
    return { mode: "at", query: at[2].toLowerCase(), tokenStart, caret }
  }
  return null
}

/** A stable signature for the current trigger token — Esc stores it so the menu stays dismissed for
 *  THIS token only and re-opens on any change (upstream parity). */
export function triggerSignature(v: TriggerView, text: string): string {
  return v.mode === "slash" ? `slash:${text}` : `at:${v.tokenStart}:${text.slice(v.tokenStart + 1, v.caret)}`
}

/** Replace the trigger token with the selected mention, returning the next text + caret. */
export function applyMention(text: string, v: TriggerView, content: string): { text: string; caret: number } {
  const next = text.slice(0, v.tokenStart) + content + " " + text.slice(v.caret)
  return { text: next, caret: v.tokenStart + content.length + 1 }
}

/* ── REQ-066 斜杠菜单卫生:治理过滤 + 来源归类(纯逻辑;composer-autocomplete.tsx 只接线)── */

export type CommandOrigin = "builtin" | "skill" | "project" | "mcp" | "imported"

/** 引擎内置命令名。command.list 里它们 source 恒为 "command"(与 config 命令同源),身份只能按
 *  名字判;config 同名覆盖(如将来 REQ-062 换 alpha 模板)不改变其内置身份。 */
export const ENGINE_BUILTIN_COMMANDS: ReadonlySet<string> = new Set(["init", "review"])

/** T1 治理禁用过滤:deny 的 skill 不进菜单 —— 按名字对治理真源 skills.deny 判定,不靠
 *  「(已禁用)」文案前缀(脆弱)。同一个名字覆盖两种形态:skill 源条目,以及被治理占位
 *  command 覆盖后的 command 源条目(materializeEdits 写 command.<n>.template → 引擎同名
 *  覆盖使 source 变 "command")。引擎侧占位 template 保留:手动键入完整命令名仍得到诚实
 *  说明(纵深不拆)。 */
export function filterGovernanceDenied<T extends { name: string }>(
  commands: readonly T[],
  deniedSkills: ReadonlySet<string>,
): T[] {
  return commands.filter((c) => !deniedSkills.has(c.name))
}

/** T2 来源归类:command.list 的 source 字段 × receipts(skill 且 origin=imported)× 引擎内置
 *  名单交叉。source 缺省(旧引擎)按 config 命令处理 → "project"。 */
export function commandOrigin(cmd: { name: string; source?: string }, importedSkills: ReadonlySet<string>): CommandOrigin {
  if (ENGINE_BUILTIN_COMMANDS.has(cmd.name)) return "builtin"
  if (cmd.source === "mcp") return "mcp"
  if (cmd.source === "skill") return importedSkills.has(cmd.name) ? "imported" : "skill"
  return "project"
}

export const COMMAND_ORIGIN_LABEL: Record<CommandOrigin, string> = {
  builtin: "内置",
  skill: "技能",
  project: "项目",
  mcp: "MCP",
  imported: "导入",
}

/* ── REQ-072:分组 / 来源四档 / 中文映射 / 搜索排序(纯逻辑;composer-autocomplete.tsx 接线)── */

export type SlashSection = "builtin" | "skill" | "project" | "mcp"

export const SLASH_SECTION_ORDER: readonly SlashSection[] = ["builtin", "skill", "project", "mcp"]

export const SLASH_SECTION_LABEL: Record<SlashSection, string> = {
  builtin: "内置命令",
  skill: "技能",
  project: "项目",
  mcp: "MCP",
}

/** 分节 = 类型维度(拍板②):技能(模型可自动装载)/ 纯命令(内置·项目)/ MCP 生成。 */
export function slashSection(origin: CommandOrigin): SlashSection {
  if (origin === "builtin") return "builtin"
  if (origin === "mcp") return "mcp"
  if (origin === "project") return "project"
  return "skill" // skill / imported
}

export type SourceTag = "内置" | "个人" | "项目" | "MCP"

/** 来源 = 归属维度(拍板①四档):出厂技能虽在「技能」节,归属是「内置」;自装/自建/导入 = 「个人」。 */
export function sourceTag(origin: CommandOrigin, name: string, factorySkills: ReadonlySet<string>): SourceTag {
  if (origin === "builtin") return "内置"
  if (origin === "mcp") return "MCP"
  if (origin === "project") return "项目"
  return factorySkills.has(name) ? "内置" : "个人"
}

/** 出厂件/引擎内置命令的中文简介 —— 仅展示层映射(SKILL.md 英文 description 面向模型匹配保留);
 *  外来第三方如实原文、不机译(拍板③)。 */
export const SLASH_DESC_ZH: Record<string, string> = {
  init: "初始化项目说明(生成 AGENTS.md 引导)",
  review: "审查代码改动(未提交 / 分支 / PR)",
  agents: "打开 Agent 管理(消息内用 @ 指派)",
  "skill-creator": "创建自定义技能",
  "agent-creator": "创建自定义 Agent",
  "customize-alpha": "配置与定制 alpha-code(连接器 / 技能 / 治理)",
  "integrate-project": "导入外部生态内容(.claude / .agents)",
  "alpha-workspace": "总结与记忆写入 Alpha 工作目录(Journal / Memory)",
}

export function displayDescription(item: { trigger: string; description?: string; title?: string }): string {
  return SLASH_DESC_ZH[item.trigger] ?? item.description ?? item.title ?? ""
}

/** 命中等级:0 名称前缀 > 1 名称包含 > 2 标题/简介命中(原文与中文映射都搜);-1 不中。 */
export function rankSlashMatch(item: { trigger: string; description?: string; title?: string }, q: string): number {
  if (!q) return 0
  const s = q.toLowerCase()
  const n = item.trigger.toLowerCase()
  if (n.startsWith(s)) return 0
  if (n.includes(s)) return 1
  const hay = `${item.title ?? ""} ${item.description ?? ""} ${displayDescription(item)}`.toLowerCase()
  if (hay.includes(s)) return 2
  return -1
}

export type SlashGroup<T> = { section: SlashSection; label: string; items: T[] }

/** 列表构建:无查询 = 分节 + 节内字母序;有查询 = 跨节合并,命中等级 → 名称序(拍板②)。
 *  全量不截断(根因② slice(0,12) 的替代);flat 是键盘索引真源,groups 只用于渲染。 */
export function buildSlashList<T extends { trigger: string; description?: string; title?: string; origin: CommandOrigin }>(
  entries: readonly T[],
  q: string,
): { flat: T[]; groups: Array<SlashGroup<T>> } {
  const byName = (a: T, b: T) => (a.trigger < b.trigger ? -1 : a.trigger > b.trigger ? 1 : 0)
  if (!q) {
    const groups: Array<SlashGroup<T>> = []
    for (const section of SLASH_SECTION_ORDER) {
      const items = entries.filter((e) => slashSection(e.origin) === section).sort(byName)
      if (items.length) groups.push({ section, label: SLASH_SECTION_LABEL[section], items })
    }
    return { flat: groups.flatMap((g) => g.items), groups }
  }
  const ranked = entries
    .map((e) => ({ e, r: rankSlashMatch(e, q) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || byName(a.e, b.e))
    .map((x) => x.e)
  return { flat: ranked, groups: [] }
}

/** Build the REAL prompt parts for the mentions still present in the submitted text (upstream
 *  build-request-parts.ts shapes — agent parts carry source offsets, file parts a file:// url).
 *  Mentions whose token was edited away are dropped. */
export function buildMentionParts(body: string, worktree: string, mentions: ReadonlyArray<MentionPart>): unknown[] {
  const parts: unknown[] = []
  for (const m of mentions) {
    const start = body.indexOf(m.content)
    if (start < 0) continue
    if (m.type === "agent") {
      parts.push({
        type: "agent",
        name: m.name,
        source: { value: m.content, start, end: start + m.content.length },
      })
    } else {
      const abs = m.path.startsWith("/") ? m.path : `${worktree.replace(/\/$/, "")}/${m.path}`
      // per-segment encoding (upstream encodeFilePath parity): encodeURI would leave `#`/`?` raw
      // and truncate such paths into fragment/query (codex audit)
      const encoded = abs.split("/").map(encodeURIComponent).join("/")
      parts.push({
        type: "file",
        mime: "text/plain",
        url: `file://${encoded}`,
        filename: m.path.split("/").pop(),
      })
    }
  }
  return parts
}
