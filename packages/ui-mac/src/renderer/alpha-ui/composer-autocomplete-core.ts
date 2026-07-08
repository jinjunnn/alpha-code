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
