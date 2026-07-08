// REQ-060 项目级扩展物 `.alpha`-only:把 `<project>/.alpha/alpha.jsonc` 的项目级引擎配置合并进一份
// per-instance cfg(纯逻辑,electron-free,单测覆盖)。消费方 = @alpha-code/ext 的 config hook。
//
// 合并语义:项目级条目补进 cfg 的命名域(mcp/agent/command),existing(全局)优先不覆盖(项目「新增」
// 而非「覆盖全局」的语义在此阶段——覆盖策略留 T1 信任门后细化);skills 走 { paths:[] } object 并集
// (与全局 REQ-059 同一 schema 教训,数组会被引擎拒)。plugin 不在此(走 host fan-out,ADR-006 生 TS 雷)。

import { join, resolve } from "node:path"

/** REQ-060 边界(真机发现):home 目录实例的 `<dir>/.alpha` 就是全局 `~/.alpha` —— 其 alpha.jsonc 是
 *  全局引擎配置(已经 G1/OPENCODE_CONFIG 注入),不是项目配置。项目级通道(config hook / plugin
 *  fan-out)对这种目录必须整体跳过:否则全局 mcp 被信任门误 gated(噪声 loud + 将来 UI 会对 home
 *  弹「信任你自己的全局配置」的 consent),且 home 侧一旦误授 consent,`~/.alpha/plugins/`(vendored
 *  全局插件,已走 config.plugin[])会被 fan-out 双重加载。 */
export function isGlobalAlphaDir(directory: string, globalAlphaRoot: string): boolean {
  return resolve(join(directory, ".alpha")) === resolve(globalAlphaRoot)
}

export type MergeResult = {
  /** 本次实际补进 cfg 的顶层域(loud 日志/审计)。 */
  added: string[]
  /** 因未信任被跳过的可执行域(如 ["mcp"])→ 上层据此记「项目待 consent」,驱动 UI 弹窗。 */
  gatedExecutable: string[]
}

/** 信任门(REQ-060 §3):mcp = 可执行连接器,只在 trustExecutable 时加载;agent/command/skills = 文本注入,恒加载。 */
export function mergeProjectConfig(
  cfg: Record<string, unknown>,
  projectJsoncText: string,
  opts: { trustExecutable?: boolean } = {},
): MergeResult {
  let proj: unknown
  try {
    proj = JSON.parse(stripJsonc(projectJsoncText))
  } catch {
    return { added: [], gatedExecutable: [] } // 项目文件坏,不注入(诚实降级,调用方已 loud)
  }
  if (!isObj(proj)) return { added: [], gatedExecutable: [] }
  const added: string[] = []
  const gatedExecutable: string[] = []
  const trust = opts.trustExecutable ?? false

  // mcp = 可执行连接器 → 信任门。未信任:跳过 + 记 gated(不 merge → 引擎发现不到)。
  if (isObj(proj.mcp) && Object.keys(proj.mcp as Record<string, unknown>).length > 0) {
    if (trust) {
      if (mergeNamed(cfg, proj.mcp as Record<string, unknown>, "mcp")) added.push("mcp.*")
    } else {
      gatedExecutable.push("mcp")
    }
  }

  // agent/command = 文本注入(低风险)→ 恒加载。
  for (const key of ["agent", "command"] as const) {
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

  return { added, gatedExecutable }
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
