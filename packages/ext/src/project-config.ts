// REQ-060 项目级扩展物 `.alpha`-only:把 `<project>/.alpha/alpha.jsonc` 的项目级引擎配置合并进一份
// per-instance cfg(纯逻辑,electron-free,单测覆盖)。消费方 = @alpha-code/ext 的 config hook。
//
// 合并语义:项目级条目补进 cfg 的命名域(mcp/agent/command),existing(全局)优先不覆盖(项目「新增」
// 而非「覆盖全局」的语义在此阶段——覆盖策略留 T1 信任门后细化);skills 走 { paths:[] } object 并集
// (与全局 REQ-059 同一 schema 教训,数组会被引擎拒)。plugin 不在此(走 host fan-out,ADR-006 生 TS 雷)。

/** 合并结果:本次实际补进的顶层域(供 loud 日志/审计;空数组 = 项目无扩展或全已存在)。 */
export function mergeProjectConfig(cfg: Record<string, unknown>, projectJsoncText: string): string[] {
  let proj: unknown
  try {
    proj = JSON.parse(stripJsonc(projectJsoncText))
  } catch {
    return [] // 解析失败 = 项目文件坏,不注入(诚实降级,调用方已 try/catch loud)
  }
  if (!isObj(proj)) return []
  const added: string[] = []

  for (const key of ["mcp", "agent", "command"] as const) {
    if (isObj(proj[key]) && mergeNamed(cfg, proj[key] as Record<string, unknown>, key)) added.push(`${key}.*`)
  }

  // skills.paths 并集(object schema;去重,existing 在前)
  const projPaths = isObj(proj.skills) && Array.isArray((proj.skills as Record<string, unknown>).paths)
    ? ((proj.skills as Record<string, unknown>).paths as unknown[])
    : []
  if (projPaths.length > 0) {
    const cur = isObj(cfg.skills) && Array.isArray((cfg.skills as Record<string, unknown>).paths)
      ? ((cfg.skills as Record<string, unknown>).paths as unknown[])
      : []
    const union = [...cur]
    let touched = false
    for (const p of projPaths) if (!union.includes(p)) (union.push(p), (touched = true))
    if (touched) {
      cfg.skills = { ...(isObj(cfg.skills) ? (cfg.skills as Record<string, unknown>) : {}), paths: union }
      added.push("skills.paths")
    }
  }

  return added
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)

/** 命名域补 absent(existing/全局优先)。返回是否有新增。 */
function mergeNamed(cfg: Record<string, unknown>, src: Record<string, unknown>, key: string): boolean {
  const cur = isObj(cfg[key]) ? { ...(cfg[key] as Record<string, unknown>) } : {}
  let touched = false
  for (const [name, val] of Object.entries(src)) {
    if (!(name in cur)) {
      cur[name] = val
      touched = true
    }
  }
  if (touched) cfg[key] = cur
  return touched
}

/** 极简 jsonc → json:去 // 行注释与 /* *​/ 块注释 + 尾逗号。够用于 alpha 自写的项目 alpha.jsonc。 */
function stripJsonc(text: string): string {
  let out = ""
  let inStr = false
  let strCh = ""
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const n = text[i + 1]
    if (inStr) {
      out += c
      if (c === "\\") {
        out += n ?? ""
        i++
      } else if (c === strCh) inStr = false
      continue
    }
    if (c === '"' || c === "'") {
      inStr = true
      strCh = c
      out += c
      continue
    }
    if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++
      out += "\n"
      continue
    }
    if (c === "/" && n === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i++
      continue
    }
    out += c
  }
  // 尾逗号:`,` 后跟(空白)`}` 或 `]`
  return out.replace(/,(\s*[}\]])/g, "$1")
}
