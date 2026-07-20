// REQ-059 T3b:agent md(frontmatter + body)→ 引擎 config agent 条目 —— 桥退役后全局 agent 经
// 当前环境 `alpha.jsonc` 的 `agent.<name>` 条目进引擎(G1/OPENCODE_CONFIG 通道),不再造 `.opencode` 桥。
//
// 解析器纪律(沿 ext-import-validate:不引 YAML 解析器):只认 alpha 自有 agent 资产/创建流实际用到的
// 受限形状 —— 顶层平铺 `key: value` + `permission:` 一~两层嵌套(tool: action 或 tool 下 pattern→action)。
// 解析不动(未知顶层键 / 更深嵌套 / 列表语法)→ fail-closed loud:拒装比装出一个字段静默丢失的 agent 好
// (C28 反 placebo)。prompt = body 内联进条目(md 文件仍写盘作内容真源/人读;编辑文件不生效是诚实边界,
// 改 agent 请重装或经 hub)。

export type AgentEntryResult =
  | { ok: true; entry: Record<string, unknown> }
  | { ok: false; reason: string }

const SCALAR_KEYS = new Set(["description", "mode", "model", "temperature", "top_p", "color", "steps", "hidden", "disable", "variant"])
const NUMERIC_KEYS = new Set(["temperature", "top_p", "steps"])
const BOOLEAN_KEYS = new Set(["hidden", "disable"])
const ACTIONS = new Set(["allow", "deny", "ask"])

export function agentMdToEntry(text: string): AgentEntryResult {
  if (!text.startsWith("---")) return { ok: false, reason: "missing frontmatter" }
  const end = text.indexOf("\n---", 3)
  if (end === -1 || end > 8192) return { ok: false, reason: "unterminated frontmatter" }
  const block = text.slice(3, end).replace(/^\r?\n/, "")
  const body = text.slice(end + 4).replace(/^\r?\n/, "").trim()

  const entry: Record<string, unknown> = {}
  const lines = block.split("\n")
  let i = 0
  while (i < lines.length) {
    const raw = lines[i]
    if (!raw.trim() || raw.trim().startsWith("#")) {
      i++
      continue
    }
    if (/^\s/.test(raw)) return { ok: false, reason: `unexpected indentation at frontmatter line: ${raw.trim()}` }
    const m = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(raw)
    if (!m) return { ok: false, reason: `unparsable frontmatter line: ${raw.trim()}` }
    const key = m[1]
    const val = m[2].trim()

    if (key === "permission") {
      if (val) return { ok: false, reason: "permission must be a nested block" }
      const { value, next } = parseNested(lines, i + 1, 1)
      if ("error" in value) return { ok: false, reason: value.error }
      entry.permission = value.obj
      i = next
      continue
    }
    if (key === "name") {
      i++ // 文件名即名字;frontmatter name 只跳过,不进条目(config agent 条目键名 = agent 名)
      continue
    }
    if (!SCALAR_KEYS.has(key)) return { ok: false, reason: `unsupported frontmatter key: ${key}` }
    if (!val) return { ok: false, reason: `empty value for: ${key}` }
    const unquoted = val.replace(/^["']|["']$/g, "")
    if (NUMERIC_KEYS.has(key)) {
      const n = Number(unquoted)
      if (!Number.isFinite(n)) return { ok: false, reason: `non-numeric value for ${key}: ${val}` }
      entry[key] = n
    } else if (BOOLEAN_KEYS.has(key)) {
      if (unquoted !== "true" && unquoted !== "false") return { ok: false, reason: `non-boolean value for ${key}: ${val}` }
      entry[key] = unquoted === "true"
    } else {
      entry[key] = unquoted
    }
    i++
  }

  if (typeof entry.description !== "string" || !entry.description) return { ok: false, reason: "description is required" }
  if (!body) return { ok: false, reason: "empty prompt body" }
  entry.prompt = body
  return { ok: true, entry }
}

/** 解析缩进嵌套块(permission 及其下一层 pattern map)。depth 1 = permission 直下,2 = pattern map。 */
function parseNested(
  lines: string[],
  start: number,
  depth: number,
): { value: { obj: Record<string, unknown> } | { error: string }; next: number } {
  const obj: Record<string, unknown> = {}
  let i = start
  let indent: number | null = null
  while (i < lines.length) {
    const raw = lines[i]
    if (!raw.trim() || raw.trim().startsWith("#")) {
      i++
      continue
    }
    const lead = raw.length - raw.trimStart().length
    if (lead === 0) break // 回到顶层
    if (indent === null) indent = lead
    if (lead < indent) break // 回到上一层
    if (lead > indent) return { value: { error: `unexpected deeper indentation: ${raw.trim()}` }, next: i }
    const m = /^([A-Za-z0-9_.*"'-]+|"[^"]+")\s*:\s*(.*)$/.exec(raw.trim())
    if (!m) return { value: { error: `unparsable permission line: ${raw.trim()}` }, next: i }
    const key = m[1].replace(/^["']|["']$/g, "")
    const val = m[2].trim().replace(/^["']|["']$/g, "")
    if (val) {
      if (!ACTIONS.has(val)) return { value: { error: `invalid permission action for ${key}: ${val}` }, next: i }
      obj[key] = val
      i++
    } else {
      if (depth >= 2) return { value: { error: `nesting too deep at: ${key}` }, next: i }
      const inner = parseNested(lines, i + 1, depth + 1)
      if ("error" in inner.value) return inner
      obj[key] = inner.value.obj
      i = inner.next
    }
  }
  return { value: { obj }, next: i }
}
