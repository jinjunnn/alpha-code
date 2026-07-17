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
 *  强制的漏洞。desiredState 缺省(理论上不出现,decoder 必填)按 enabled(不误伤合法记录)。 */
function enabledSkillKeys(alphaRoot: string): Set<string> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(alphaRoot, "installs.json"), "utf8"))
  } catch {
    return null // 缺失/不可解析 → 无从确证任何 skill 为 enabled → 全部不注入(fail closed)
  }
  const records = parsed && typeof parsed === "object" && Array.isArray((parsed as { records?: unknown }).records) ? ((parsed as { records: unknown[] }).records) : []
  // 严格 record 形状门(Codex r3 Blocker:须与主进程 decodeRecordV2 同强度,否则畸形重复记录
  // {kind,name,desiredState:enabled} 会绕过主进程排除、复活被禁用技能)。校验 v2 schema + 核心
  // 必填字段的存在与类型(schemaVersion/id/name/kind/environment/scope/generation/installedAt/
  // desiredState)—— 不完整/畸形记录一律不进允许集(fail closed)。
  const isWellFormedV2 = (r: unknown): r is { kind: string; name: string; desiredState: string } => {
    if (!r || typeof r !== "object") return false
    const o = r as Record<string, unknown>
    return (
      o.schemaVersion === 2 &&
      typeof o.id === "string" &&
      typeof o.name === "string" &&
      typeof o.kind === "string" &&
      typeof o.environment === "string" &&
      !!o.scope &&
      typeof o.scope === "object" &&
      typeof o.generation === "number" &&
      typeof o.installedAt === "string" &&
      (o.desiredState === "enabled" || o.desiredState === "disabled")
    )
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
