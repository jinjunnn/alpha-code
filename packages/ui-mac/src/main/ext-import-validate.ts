// REQ-019 T6:导入校验的纯函数层(无 electron / fs 依赖,bun test 可直测)。
// 外来内容纪律(PR #73 教训):只解析 frontmatter,绝不执行导入内容;解析器刻意极简
// (只认顶层 `key: value` 行),不引 YAML 解析器,不解析嵌套 —— 少一个解析器面。

export const SAFE_IMPORT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

export function parseSkillFrontmatter(
  text: string,
): { ok: true; name: string; description: string } | { ok: false; reason: string } {
  if (!text.startsWith("---")) return { ok: false, reason: "非法 frontmatter:缺少 --- 头" }
  const end = text.indexOf("\n---", 3)
  if (end === -1 || end > 8192) return { ok: false, reason: "非法 frontmatter:未闭合" }
  const block = text.slice(3, end)
  const fields: Record<string, string> = {}
  for (const line of block.split("\n")) {
    const m = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.+)$/.exec(line.trim())
    if (m) fields[m[1].toLowerCase()] = m[2].trim().replace(/^["']|["']$/g, "")
  }
  const name = fields["name"] ?? ""
  const description = fields["description"] ?? ""
  if (!SAFE_IMPORT_NAME.test(name)) return { ok: false, reason: `非法 frontmatter:name 缺失或不合法(${name || "空"})` }
  if (!description) return { ok: false, reason: "非法 frontmatter:description 缺失" }
  return { ok: true, name, description }
}

/** https-only Git 地址白名单(execFile 参数数组免 shell 注入;这里只挡协议与形状)。 */
export function validGitUrl(url: unknown): url is string {
  return typeof url === "string" && url.length <= 500 && /^https:\/\/[\w.-]+(:\d+)?\/[\w./~-]+$/.test(url)
}

// ── REQ-033:Agent 导入 + 轻转换(Claude Code 格式 → opencode 原语;显式映射,不静默改写)──
// 口径 = ADR-023 安装期转换器:映射逐项声明 map/unsupported,不支持字段 loud 提示而非静默丢弃。

export type AgentFieldMapping = { source: string; value: string; target: string | null; note: string }
export type AgentImportPreview =
  | { ok: true; name: string; format: "opencode" | "claude-code"; mapping: AgentFieldMapping[]; composed: string }
  | { ok: false; reason: string }

const OC_AGENT_KEYS = new Set(["mode", "temperature", "permission", "model", "description", "tools", "hidden", "disable", "color", "steps", "variant"])

export function parseAgentImport(text: string): AgentImportPreview {
  if (text.length > 256 * 1024) return { ok: false, reason: "文件过大(>256KB)" }
  if (!text.startsWith("---")) return { ok: false, reason: "非法 agent 文件:缺少 frontmatter --- 头" }
  const end = text.indexOf("\n---", 3)
  if (end === -1 || end > 8192) return { ok: false, reason: "非法 agent 文件:frontmatter 未闭合" }
  const block = text.slice(3, end)
  const body = text.slice(end + 4).replace(/^\r?\n/, "")
  const fields: Record<string, string> = {}
  for (const line of block.split("\n")) {
    const m = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.+)$/.exec(line.trim())
    if (m) fields[m[1].toLowerCase()] = m[2].trim().replace(/^["']|["']$/g, "")
  }
  const name = fields["name"] ?? ""
  if (!SAFE_IMPORT_NAME.test(name)) return { ok: false, reason: `name 缺失或不合法(${name || "空"})` }
  if (!fields["description"]) return { ok: false, reason: "description 缺失" }

  // 格式识别:有 opencode 专属键(mode/temperature/permission)→ 原生直入;
  // tools 为逗号串(Claude Code 白名单形)或 model 为别名(sonnet/opus/haiku/inherit)→ Claude Code。
  const hasOcKeys = ["mode", "temperature", "permission"].some((k) => k in fields)
  const claudeToolsList = typeof fields["tools"] === "string" && /^[A-Za-z][A-Za-z0-9_]*(\s*,\s*[A-Za-z][A-Za-z0-9_]*)+$/.test(fields["tools"] ?? "")
  const claudeModelAlias = ["sonnet", "opus", "haiku", "inherit"].includes((fields["model"] ?? "").toLowerCase())
  const format: "opencode" | "claude-code" = hasOcKeys ? "opencode" : claudeToolsList || claudeModelAlias || !("mode" in fields) ? "claude-code" : "opencode"

  if (format === "opencode") {
    // 原生格式:未知键提示但保留原文直入(引擎自会校验)。
    const mapping: AgentFieldMapping[] = Object.entries(fields).map(([k, v]) => ({
      source: k,
      value: v,
      target: k,
      note: OC_AGENT_KEYS.has(k) || k === "name" ? "原生字段,直接使用" : "非标准键,原样保留(引擎可能忽略)",
    }))
    return { ok: true, name, format, mapping, composed: text.endsWith("\n") ? text : `${text}\n` }
  }

  // Claude Code → opencode 显式映射。
  const mapping: AgentFieldMapping[] = []
  const out: string[] = [`name: ${name}`, `description: ${fields["description"]}`, "mode: subagent"]
  mapping.push({ source: "name", value: name, target: "文件名/agent 名", note: "映射" })
  mapping.push({ source: "description", value: fields["description"], target: "description", note: "映射" })
  mapping.push({ source: "(默认)", value: "subagent", target: "mode", note: "Claude Code agent 均为子 agent 语义,映射为 mode: subagent" })
  if (fields["model"]) {
    mapping.push({ source: "model", value: fields["model"], target: null, note: "不映射:模型别名是 Claude Code 专属,保持 opencode 默认模型(可装后在治理/agent 设置中改)" })
  }
  if (fields["tools"]) {
    mapping.push({ source: "tools", value: fields["tools"], target: null, note: "不映射:Claude Code 的工具白名单语义与 opencode permission 体系不对应 —— 需要限权请在装后配置 agent permission(诚实降级,不做半吊子映射)" })
  }
  for (const k of Object.keys(fields)) {
    if (!["name", "description", "model", "tools"].includes(k)) {
      mapping.push({ source: k, value: fields[k], target: null, note: "不映射:无 opencode 等价字段" })
    }
  }
  const composed = `---\n${out.join("\n")}\n---\n\n${body}${body.endsWith("\n") ? "" : "\n"}`
  return { ok: true, name, format, mapping, composed }
}
