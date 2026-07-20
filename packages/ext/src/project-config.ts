// REQ-060 项目级扩展物 `.alpha`-only:把 `<project>/.alpha/alpha.jsonc` 的项目级引擎配置合并进一份
// per-instance cfg(纯逻辑,electron-free,单测覆盖)。消费方 = @alpha-code/ext 的 config hook。
//
// 合并语义:项目级条目补进 cfg 的命名域(mcp/agent/command),existing(全局)优先不覆盖(项目「新增」
// 而非「覆盖全局」的语义在此阶段——覆盖策略留 T1 信任门后细化);skills 走 { paths:[] } object 并集
// (与全局 REQ-059 同一 schema 教训,数组会被引擎拒)。plugin 不在此(走 host fan-out,ADR-006 生 TS 雷)。

import { lstatSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, normalize, relative, resolve } from "node:path"

export type ProjectDirectoryIdentity = "project" | "retired-home" | "unknown"

/** home 项目边界三态：realpath 无法确认一律 unknown，由调用方 fail-closed 拒绝项目通道。 */
export function projectDirectoryIdentity(directory: string, homeDir: string = homedir()): ProjectDirectoryIdentity {
  try {
    const candidate = normalize(realpathSync(directory))
    const home = normalize(realpathSync(homeDir))
    return candidate === home ? "retired-home" : "project"
  } catch {
    return "unknown"
  }
}

/** sidecar/ext 无 main 快照，必须只消费 main 已派生的 canonical root。 */
export function requireAlphaGlobalRoot(value: string | undefined = process.env.ALPHA_GLOBAL_DIR, homeDir: string = homedir()): string {
  const raw = value?.trim()
  if (!raw || !isAbsolute(raw)) throw new Error("ALPHA_GLOBAL_DIR requires an absolute initialized root")
  const candidate = normalize(raw)
  const retired = normalize(join(homeDir, ".alpha"))
  if (related(candidate, retired)) throw new Error("ALPHA_GLOBAL_DIR is related to the retired global root")
  try {
    const canonical = normalize(realpathSync(candidate))
    const stat = lstatSync(candidate)
    if (stat.isSymbolicLink() || !stat.isDirectory() || canonical !== candidate)
      throw new Error("ALPHA_GLOBAL_DIR is not the canonical directory")
    const home = normalize(realpathSync(homeDir))
    const retiredCanonical = (() => {
      try {
        return normalize(realpathSync(retired))
      } catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error
        return join(home, ".alpha")
      }
    })()
    if (related(canonical, retiredCanonical)) throw new Error("ALPHA_GLOBAL_DIR resolves to the retired global root")
    return canonical
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("ALPHA_GLOBAL_DIR")) throw error
    throw new Error("ALPHA_GLOBAL_DIR identity cannot be confirmed", { cause: error })
  }
}

function related(left: string, right: string): boolean {
  return sameOrInside(left, right) || sameOrInside(right, left)
}

function sameOrInside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

export type MergeResult = {
  /** 本次实际补进 cfg 的顶层域(loud 日志/审计)。 */
  added: string[]
  /** 因未信任被跳过的可执行域(如 ["mcp"])→ 上层据此记「项目待 consent」,驱动 UI 弹窗。 */
  gatedExecutable: string[]
}

/** 信任门(REQ-060 §3):mcp = 可执行连接器,只在 trustExecutable 时加载;agent/command/skills = 文本注入,恒加载。
 *  opts.directory:项目根 —— skills.paths 的相对条目("./…")以此解析为绝对(项目可移动,alpha.jsonc 存相对)。 */
export function mergeProjectConfig(
  cfg: Record<string, unknown>,
  projectJsoncText: string,
  opts: { trustExecutable?: boolean; directory?: string } = {},
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

  // skills.paths 并集(object schema;去重,existing 在前);相对条目按项目根解析为绝对
  const rawPaths = isObj(proj.skills) && Array.isArray((proj.skills as Record<string, unknown>).paths)
    ? ((proj.skills as Record<string, unknown>).paths as unknown[])
    : []
  const projPaths = rawPaths.map((p) =>
    typeof p === "string" && p.startsWith("./") && opts.directory ? resolve(opts.directory, p) : p,
  )
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
export function stripJsonc(text: string): string {
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
