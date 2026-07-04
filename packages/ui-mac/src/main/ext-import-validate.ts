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
