// gen-skill-paths — REQ-100 #310:把 skill generation 的 live 目录投影进 `cfg.skills.paths`。
//
// 生产 skill 安装的物理真源 = `<alphaRoot>/ext-store/skill--<name>/generations/<genId>`,live 版本由
// 各 key 的 `current.json` 指针指定(main 侧 ext-transaction 原子写)。发现层不落磁盘配置:本模块在
// ext config hook 里**从磁盘现读** current.json 并把 live generation 目录内存注入 skills.paths ——
// 每次 config 重建(dispose→refresh,安装后触发)都反映最新 generation,current.json 是唯一原子真源。
// 与 injectFactorySkillPaths 同通道(内存注入生效,磁盘零痕迹)。

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const GEN_NAME = /^gen-\d{6,}-[a-f0-9]{6,}$/
const SAFE_KEY = /^skill--[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/

function liveGenerationDir(alphaRoot: string, key: string): string | null {
  const store = join(alphaRoot, "ext-store", key)
  let text: string
  try {
    text = readFileSync(join(store, "current.json"), "utf8")
  } catch {
    return null
  }
  let genId: unknown
  try {
    genId = (JSON.parse(text) as { generation?: unknown }).generation
  } catch {
    return null
  }
  if (typeof genId !== "string" || !GEN_NAME.test(genId)) return null
  const dir = join(store, "generations", genId)
  try {
    return statSync(dir).isDirectory() ? dir : null
  } catch {
    return null
  }
}

/** #395(REQ-104)+ Codex r1 Blocker 2:账本 desiredState 投影门,**严格 decoder**(#394 硬约束)——
 *  只注入账本确证 enabled 的 skill key(允许集,非禁用集)。installs.json 缺失/不可解析/无该 skill
 *  记录 = **不注入**(fail closed):generation 目录与账本记录由同一事务原子落位(installSkillGeneration
 *  commitReceipt),孤儿 generation = 失败/回滚残留,不得复活;损坏账本让被禁用技能重新加载是禁用
 *  强制的漏洞。desiredState 缺失/非法 = 记录不良构 → 不注入(严格门,与主 decoder 同排除)。 */
function enabledSkillKeys(alphaRoot: string): Set<string> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(alphaRoot, "installs.json"), "utf8"))
  } catch {
    return null // 缺失/不可解析 → 无从确证任何 skill 为 enabled → 全部不注入(fail closed)
  }
  const records = parsed && typeof parsed === "object" && Array.isArray((parsed as { records?: unknown }).records) ? ((parsed as { records: unknown[] }).records) : []
  // 严格 record 形状门(Codex r3/r4 Blocker:须与主进程 decodeRecordV2 **同强度**,否则畸形重复记录
  // 绕过主进程排除、复活被禁用技能)。逐字段镜像 decodeRecordV2 的枚举/类型/范围校验(ext 无法 import
  // ui-mac decoder,故此处保持镜像 —— 任一侧改动须同步;drift 由本注释与 Codex review 兜底)。
  const KINDS = new Set(["mcp", "skill", "agent", "command", "plugin", "bundle", "cloud"])
  const ENVIRONMENTS = new Set(["prod", "beta", "dev"])
  const ORIGINS = new Set(["catalog", "created", "imported", "imported-claude", "imported-agents"])
  const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
  const isStr = (v: unknown, re?: RegExp): v is string => typeof v === "string" && v.length > 0 && v.length <= 512 && (!re || re.test(v))
  const isWellFormedV2 = (r: unknown): r is { kind: string; name: string; desiredState: string } => {
    if (!r || typeof r !== "object") return false
    const o = r as Record<string, unknown>
    if (o.schemaVersion !== 2) return false
    if (!isStr(o.id) || !isStr(o.name, SAFE_NAME)) return false
    if (!isStr(o.kind) || !KINDS.has(o.kind)) return false
    if (!isStr(o.environment) || !ENVIRONMENTS.has(o.environment)) return false
    if (!isStr(o.origin) || !ORIGINS.has(o.origin)) return false
    // scope:global(仅 kind)或 project(kind + 绝对 projectPath + 64-hex projectPathHash)。
    if (!o.scope || typeof o.scope !== "object") return false
    const sc = o.scope as Record<string, unknown>
    if (sc.kind === "global") {
      if (Object.keys(sc).some((k) => k !== "kind")) return false
    } else if (sc.kind === "project") {
      if (!isStr(sc.projectPath) || !sc.projectPath.startsWith("/")) return false
      if (!isStr(sc.projectPathHash, /^[0-9a-f]{64}$/)) return false
    } else return false
    if (typeof o.generation !== "number" || !Number.isInteger(o.generation) || o.generation < 1) return false
    if (!isStr(o.installedAt) || Number.isNaN(Date.parse(o.installedAt))) return false
    return o.desiredState === "enabled" || o.desiredState === "disabled"
  }
  const out = new Set<string>()
  for (const r of records) {
    if (!isWellFormedV2(r)) continue // 畸形/不完整记录 fail closed(与主进程 decoder 同排除)
    if (r.kind === "skill" && r.desiredState === "enabled") out.add(`skill--${r.name}`)
  }
  return out
}

/** 枚举 `<alphaRoot>/ext-store/skill--*` 的 live generation 目录(升序,稳定;#395 过账本 enabled 门)。 */
export function skillGenerationLiveDirs(alphaRoot: string): string[] {
  const storeRoot = join(alphaRoot, "ext-store")
  let entries: string[]
  try {
    entries = readdirSync(storeRoot)
  } catch {
    return []
  }
  const enabled = enabledSkillKeys(alphaRoot)
  if (enabled === null) return [] // 账本不可读 → 无 enabled 确证 → 不注入任何技能(fail closed)
  const dirs: string[] = []
  for (const name of entries) {
    if (!SAFE_KEY.test(name)) continue
    if (!enabled.has(name)) continue
    const live = liveGenerationDir(alphaRoot, name)
    if (live) dirs.push(live)
  }
  return dirs.sort()
}

/** 把 live generation 目录注入 `cfg.skills.paths`(去重)。返回新增的目录。 */
export function injectSkillGenerationPaths(cfg: Record<string, unknown>, alphaRoot: string | undefined): string[] {
  if (!alphaRoot) return []
  const dirs = skillGenerationLiveDirs(alphaRoot)
  if (dirs.length === 0) return []
  const skills =
    cfg.skills && typeof cfg.skills === "object" && !Array.isArray(cfg.skills)
      ? (cfg.skills as Record<string, unknown>)
      : ((cfg.skills = {}) as Record<string, unknown>)
  const paths = Array.isArray(skills.paths) ? (skills.paths as unknown[]) : ((skills.paths = []) as unknown[])
  const added: string[] = []
  for (const d of dirs) {
    if (paths.includes(d)) continue
    paths.push(d)
    added.push(d)
  }
  return added
}
