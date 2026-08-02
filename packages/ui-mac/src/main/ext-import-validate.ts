// REQ-019 T6:导入校验的纯函数层(无 electron / fs 依赖,bun test 可直测)。
// 外来内容纪律(PR #73 教训):只解析 frontmatter,绝不执行导入内容;解析器刻意极简
// (只认顶层 `key: value` 行),不引 YAML 解析器,不解析嵌套 —— 少一个解析器面。

import { isExtensionName } from "../shared/extension-name"

/** REQ-128 Phase 3(基线 §14 R2-b):Alpha 没有对应语义的**调用控制**字段。
 *  出现任一即具名跳过该技能(owner 裁决 C)——判据是「这个顶层键在不在」,与它的值无关。 */
export const SKILL_CONTROL_FIELD_KEYS: readonly string[] = ["allowed-tools", "argument-hint", "disable-model-invocation", "user-invocable"]

/** REQ-128 Phase 3(基线 §14 R2-b):frontmatter **顶层键存在性**探测。
 *
 *  为什么不能用下面那个 `fields` 字典回答「这个键在不在」:它的行正则要求**冒号后有非空标量**,
 *  所以块式写法(`allowed-tools:` 后跟换行 YAML 列表)整个不进字典 —— 真实语料里
 *  `allowed-tools` 的块式 7 份、标量式 1 份(frontmatter 内实测),据字典判会得到一个假的「没有」。
 *
 *  **仍然零新增解析器**(本文件抬头的 PR #73 决策不动):不解析块式的值、不引 YAML、不解析嵌套,
 *  只回答键的**存在性**。顶层性由「键名顶格」判定 —— 缩进行是块内内容,不是顶层键;
 *  这比 `fields` 的 `line.trim()` 更严,不会把 `permission:` 下的 `edit:` 误报成顶层键。 */
function topLevelKeyNames(block: string): string[] {
  const keys = new Set<string>()
  for (const rawLine of block.split("\n")) {
    const m = /^([A-Za-z][A-Za-z0-9_-]*)[ \t]*:/.exec(rawLine.replace(/\r$/, ""))
    if (m) keys.add(m[1].toLowerCase())
  }
  return [...keys].sort()
}

export function parseSkillFrontmatter(
  text: string,
): { ok: true; name: string; description: string; keys: string[] } | { ok: false; reason: string } {
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
  if (!isExtensionName(name)) return { ok: false, reason: `非法 frontmatter:name 缺失或不合法(${name || "空"})` }
  if (!description) return { ok: false, reason: "非法 frontmatter:description 缺失" }
  // `keys` = 顶层键名全集(块式与标量式一视同仁)。既有两个消费点只读 name/description,
  // 结构化扩展不影响它们;REQ-128 的控制字段判定只读这一个字段。
  return { ok: true, name, description, keys: topLevelKeyNames(block) }
}

/** REQ-098 #335:产品策展的可信 Git forge 主机 allowlist(SSRF 收口)。
 *  importSkillGit 校验后对 clone 目标零强制,故必须限到可信公网 forge —— exact/dot-boundary
 *  匹配即封死 localhost/回环/私网/link-local/IP 字面量/单标签主机,并**关闭 DNS rebinding**
 *  (攻击者无法把 github.com 指向私网;Codex 裁决 Q5)。自托管 forge 后续走显式配置项。 */
export const GIT_FORGE_ALLOWLIST: readonly string[] = ["github.com", "gitlab.com", "bitbucket.org", "codeberg.org", "git.sr.ht"]

/** https-only Git 地址校验(#335 起 allowlist 制;WHATWG URL 解析规范化 IPv4 各编码后判定,
 *  不再纯正则)。放行 = https 协议 ∧ 无 userinfo ∧ 默认端口(443)∧ 无 query/fragment ∧
 *  hostname(剥尾点)命中 allowlist(exact 或 dot-boundary 子域)∧ 真实 repo 路径段。
 *  execFile 参数数组免 shell 注入是另一层(clone 侧另加 http.followRedirects=false 挡重定向逃逸)。 */
export function validGitUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.length > 500) return false
  // review r1 Minor:空 query/fragment 分隔符(`repo?` / `repo#`)会让 search/hash getter 返 ""
  // 绕过下方判定 —— 合法 git URL 从不含 ? 或 #,原串出现即拒(合同不静默放宽)。
  if (url.includes("?") || url.includes("#")) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== "https:") return false
  if (parsed.username !== "" || parsed.password !== "") return false // 不接受 userinfo
  if (parsed.port !== "") return false // 默认 443 规范化为 "";任何显式非 443 端口拒
  if (parsed.search !== "" || parsed.hash !== "") return false // 无 query/fragment(纵深)
  const host = parsed.hostname.replace(/\.$/, "") // 剥尾点(localhost. / name.localhost. 绕过)
  const allowed = GIT_FORGE_ALLOWLIST.some((h) => host === h || host.endsWith(`.${h}`))
  if (!allowed) return false // localhost/私网/IP 字面量/单标签/非 allowlist 全在此拒
  // 真实 repo 路径段(裸 host 规范化为 "/" 被拒;首字符须非斜杠,拒 `//` 无段路径,review r1 Minor)。
  return /^\/[\w.~-][\w./~-]*$/.test(parsed.pathname)
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
  if (!isExtensionName(name)) return { ok: false, reason: `name 缺失或不合法(${name || "空"})` }
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
