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

/** #395(REQ-104)账本 desiredState 投影门 —— 只注入 main 确证 enabled 的 skill key(允许集,非
 *  禁用集)。Codex r5(步骤5):ext 无法 import ui-mac 的 decodeRecordV2,此前逐字段镜像 decoder
 *  存在永久漂移风险(未知键/version/digest/files/transaction/id 前缀不变量漏校)—— 改为 **main 用
 *  真 decoder 算出允许集写独立派生文件 `skills-enabled.json`**(ext-receipt-v2 与账本锁步写,方向
 *  排序:收窄先行;boot reconcile 自愈 backfill),hook 只读该文件。
 *  缺失/不可解析/形状异常 = 无从确证任何 skill 为 enabled → 全部不注入(fail closed):孤儿
 *  generation、损坏账本、升级空窗一律走安全侧;条目须匹配受管 key 形状(SAFE_KEY)。 */
function enabledSkillKeys(alphaRoot: string): Set<string> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(alphaRoot, "skills-enabled.json"), "utf8"))
  } catch {
    return null // 缺失/不可解析 → fail closed
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const o = parsed as { v?: unknown; keys?: unknown }
  if (o.v !== 1 || !Array.isArray(o.keys)) return null // 未知版本/形状 → fail closed
  const out = new Set<string>()
  for (const k of o.keys) {
    if (typeof k === "string" && SAFE_KEY.test(k)) out.add(k)
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
