// REQ-059 全局层:alpha 引擎配置真源 = `<current-environment-root>/alpha.jsonc`(经 G1 = OPENCODE_CONFIG 注入,
// sidecar 内 injectAlphaConfig 设 env;source T0 spike audits/2026-07-07-req059-060-t0-spike)。
//
// 本模块是 electron-free 纯逻辑核(单测覆盖),只做「判定 + 计划计算」,不落盘、不读环境:
//   1. 路径常量派生(alpha.jsonc / legacy ~/.opencode / XDG);
//   2. 存量所有权判定(一份 config 是否 alpha 自有、可整体安全迁移 —— 否则 bail-out loud);
//   3. `~/.opencode` junk-only 判定(拆走 alpha 物后仅剩引擎 bootstrap 垃圾 → 整目录可删);
//   4. 迁移合并计划(legacy jsonc + XDG provider → alpha.jsonc,copy-don't-delete + 幂等)。
// 运行时接线(sidecar 注入 / ext-config 写入切换 / reconcile 落盘)在各消费方,不在此。

import path from "node:path"
import { resolveAlphaGlobalRoot } from "./alpha-environment"

/** 当前环境 canonical mutable root；无快照时只接受已校验的派生 ALPHA_GLOBAL_DIR。 */
export function alphaGlobalRoot(): string {
  return resolveAlphaGlobalRoot()
}

/** The single alpha engine-config truth file for the frozen current environment. alpha always writes `.jsonc`. */
export function alphaJsoncPath(): string {
  return path.join(alphaGlobalRoot(), "alpha.jsonc")
}

/** Global factory/installed skills truth dir. Engine discovers it via `skills:[...]` in the alpha.jsonc
 *  FILE channel (factory-skills实测:env skills.paths 不生效、文件 config 生效 → G1 承载,桥退役 T3). */
export function alphaSkillsDir(): string {
  return path.join(alphaGlobalRoot(), "skills")
}

/**
 * Idempotently ensure `config.skills.paths` contains `skillsDir` (absolute). Returns true if changed.
 * 引擎 config schema:`skills` = { paths: string[] }(OBJECT,不是数组)—— 真机 ConfigInvalidError 实证
 * "Expected object | undefined, got [...]"。也自愈把早期误写成数组的存量重写成正确形态。
 */
export function ensureSkillsPath(config: Record<string, unknown>, skillsDir: string): boolean {
  const s = config.skills
  const validObj = s && typeof s === "object" && !Array.isArray(s)
  const cur = validObj && Array.isArray((s as Record<string, unknown>).paths) ? ((s as Record<string, unknown>).paths as unknown[]) : []
  // 已是正确形态且含目标 → no-op。
  if (validObj && cur.includes(skillsDir)) return false
  const rest = validObj ? { ...(s as Record<string, unknown>) } : {}
  rest.paths = cur.includes(skillsDir) ? cur : [...cur, skillsDir]
  config.skills = rest
  return true
}

/** REQ-065:一条 skills.paths 条目是否「出厂资源路径」—— alpha 资源布局段 + **出厂名单内**的
 *  basename 双重判定(同 isAlphaFactoryLink 精神;名单外的同布局路径视为用户自加,不动)。 */
export function isFactoryResourcePath(p: string, factoryNames: readonly string[]): boolean {
  const norm = p.split("\\").join("/").replace(/\/+$/, "")
  const m = /\/(resources|Resources)\/(skills|factory-skills)\/([^/]+)$/.exec(norm)
  return !!m && factoryNames.includes(m[3])
}

/**
 * REQ-065:重写 skills.paths 里的「出厂技能资源路径」组。**修订(用户拍板 2026-07-08)**:出厂路径
 * 不再写入用户配置(改由 env → ext config hook 内存注入,见 factory-skills.ts),本函数的现役用途
 * = 传 [] **剥离**历史版本写盘的出厂条目(布局+出厂名单双重判定;用户自加路径与当前环境 skills
 * 用户安装物目录一概不动)。追加分支保留(通用性/测试),生产不再走。幂等;返回是否有改动。
 */
export function rewriteFactorySkillPaths(
  config: Record<string, unknown>,
  factoryDirs: readonly string[],
  factoryNames: readonly string[],
): boolean {
  const s = config.skills
  const validObj = !!s && typeof s === "object" && !Array.isArray(s)
  const cur = validObj && Array.isArray((s as Record<string, unknown>).paths) ? ((s as Record<string, unknown>).paths as unknown[]) : []
  const next = cur.filter((p) => typeof p !== "string" || !isFactoryResourcePath(p, factoryNames))
  for (const d of factoryDirs) if (!next.includes(d)) next.push(d)
  // 无 skills 键(或非法形态)且无可写内容 → no-op(不给从未有 skills 的配置塞空键;
  // 非法形态的归一由先行的 ensureSkillsPath 负责)。
  const changed = next.length !== cur.length || next.some((v, i) => v !== cur[i]) || (!validObj && next.length > 0)
  if (!changed) return false
  const rest = validObj ? { ...(s as Record<string, unknown>) } : {}
  rest.paths = next
  config.skills = rest
  return true
}

/**
 * REQ-067:剥离历史版本物化进 alpha.jsonc 的「出厂默认禁」明文(它们改由内存注入,用户配置零痕迹):
 *   - `permission.skill.<n> === "deny"`(n ∈ 出厂清单)→ 删;
 *   - 随之 permission.skill 只剩治理打底 `{"*": "allow"}`(引擎默认即 allow,冗余)→ 删整个 skill 键;
 *     permission 空 → 删 permission;
 *   - `command.<n>`(n ∈ 出厂清单)且 description 以「(已禁用)」开头(治理占位指纹)→ 删;
 *     用户自建同名 command(无该指纹)不碰。
 * 幂等;返回是否有改动。
 */
export function stripFactoryBuiltinPolicyLeaves(config: Record<string, unknown>, factoryNames: readonly string[]): boolean {
  let changed = false
  const permission = config.permission
  if (permission && typeof permission === "object" && !Array.isArray(permission)) {
    const perm = permission as Record<string, unknown>
    const skill = perm.skill
    if (skill && typeof skill === "object" && !Array.isArray(skill)) {
      const sk = skill as Record<string, unknown>
      for (const n of factoryNames) {
        if (sk[n] === "deny") {
          delete sk[n]
          changed = true
        }
      }
      const keys = Object.keys(sk)
      if (changed && (keys.length === 0 || (keys.length === 1 && keys[0] === "*" && sk["*"] === "allow"))) {
        delete perm.skill
        if (Object.keys(perm).length === 0) delete config.permission
      }
    }
  }
  const command = config.command
  if (command && typeof command === "object" && !Array.isArray(command)) {
    const cmd = command as Record<string, unknown>
    for (const n of factoryNames) {
      const c = cmd[n]
      if (c && typeof c === "object" && typeof (c as Record<string, unknown>).description === "string" && ((c as Record<string, unknown>).description as string).startsWith("(已禁用)")) {
        delete cmd[n]
        changed = true
      }
    }
    if (changed && Object.keys(cmd).length === 0) delete config.command
  }
  return changed
}

/** alpha 会写进 alpha.jsonc 的引擎 config 顶层域。存量文件顶层键越界 = 疑用户手写混入 → 不迁。 */
export const ALPHA_CONFIG_TOP_KEYS = new Set([
  "$schema",
  "mcp",
  "plugin",
  "agent",
  "permission",
  "command",
  "provider",
])

/** `~/.opencode` 内属引擎 plugin-bootstrap 的产物(非 alpha 内容)。拆走 alpha 物后目录只剩这些
 *  → 整目录可删(REQ-052「拆空 ~/.opencode/skill」先例;引擎不自发重建,paths.ts home walk 只发现已存在目录)。 */
export const OPENCODE_JUNK_ENTRIES = new Set([
  "package.json",
  "node_modules",
  "package-lock.json",
  "bun.lock",
  ".gitignore",
])

/** 治理面:REQ-037 alpha 会写的引擎治理叶子域(与 ext-config builtinPolicyPathAllowed 同口径的顶层集)。 */
const GOVERNANCE_TOP_KEYS = new Set(["agent", "permission", "command"])

export type OwnershipInput = {
  /** 解析后的存量 config 对象(jsonc parse 结果)。 */
  parsed: Record<string, unknown> | undefined
  /** receipts 里 mcp 类的 server 名集合(configKey `mcp.<name>` 或 name)。 */
  receiptMcpNames: Set<string>
  /** receipts 里 plugin 类的标识集合(configKey `plugin:<pkg>@<ver>` 或 name)。 */
  receiptPluginKeys: Set<string>
}

export type OwnershipVerdict =
  | { owned: true; unaccountedMcp?: string[] }
  | { owned: false; reason: string }

/**
 * 一份存量引擎配置是否「alpha 自有」→ 可整体安全迁进真源。
 *
 * 关键前提(用户 2026-07-07 拍板「放宽」):`~/.opencode/opencode.jsonc` 是 **alpha 的 REQ-018 专用
 * 写入领地** —— 用户手写配置在 XDG(`~/.config/opencode`)或项目,不写这里。所以里面的 mcp **都是
 * alpha 装的**,有无 receipt 只是记账完整性(早期装的 receipt 可能丢),**不是所有权问题**。
 *
 * 判定:
 *   ① 顶层键 ⊆ ALPHA_CONFIG_TOP_KEYS —— 唯一 bail-out 条件(挡住 keybinds/theme/model 等非 alpha 域
 *      = 疑用户手写混入);
 *   ② mcp 名不在 receiptMcpNames → **不 bail-out**,记入 unaccountedMcp 供调用方 loud 记账(记账自愈
 *      由迁移后重建 receipt 处理,不在此)。
 * 顶层键越界 → bail-out(保留原布局,功能零损失,品牌收敛该机暂缓 —— REQ-059 §风险)。
 */
export function isAlphaOwnedConfig(input: OwnershipInput): OwnershipVerdict {
  const obj = input.parsed
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    // 空/非对象:没有 alpha 物可迁,视作 owned(no-op 迁移),让 junk 判定决定目录去留。
    return { owned: true }
  }
  const topKeys = Object.keys(obj)
  const stray = topKeys.filter((k) => !ALPHA_CONFIG_TOP_KEYS.has(k))
  if (stray.length > 0) {
    return { owned: false, reason: `unrecognized top-level keys (user-authored?): ${stray.slice(0, 3).join(", ")}` }
  }
  // mcp 记账不全 → 仍 owned(.opencode 是 alpha 领地),但把无 receipt 的名字暴露出去供 loud 日志。
  const mcp = obj.mcp
  let unaccountedMcp: string[] | undefined
  if (mcp && typeof mcp === "object" && !Array.isArray(mcp)) {
    const unaccounted = Object.keys(mcp as Record<string, unknown>).filter((n) => !input.receiptMcpNames.has(n))
    if (unaccounted.length > 0) unaccountedMcp = unaccounted
  }
  return { owned: true, unaccountedMcp }
}

/**
 * `~/.opencode` 拆走 alpha 自有物(symlink 桥、迁走的 jsonc)后,剩余条目是否只有引擎 junk。
 * `configFileNames` = 已迁移/将删的 alpha config 文件名(如 opencode.jsonc/opencode.json),
 * 从判定里排除(它们本轮会被迁移/删除)。剩余全部 ∈ OPENCODE_JUNK_ENTRIES → 整目录可删。
 */
export function isJunkOnlyDir(entries: string[], configFileNames: string[] = ["opencode.jsonc", "opencode.json"]): boolean {
  const cfg = new Set(configFileNames)
  const residual = entries.filter((e) => !cfg.has(e))
  if (residual.length === 0) return true // 只剩 config 文件(将删)→ 空目录可删
  return residual.every((e) => OPENCODE_JUNK_ENTRIES.has(e))
}

export type MergePlan = {
  /** 合并后的 alpha.jsonc 对象(alpha 既有为基,legacy/xdg 补 absent)。 */
  merged: Record<string, unknown>
  /** 相对 existing 是否有实际新增(false = 幂等 no-op,免写盘)。 */
  changed: boolean
  /** 本轮从 legacy/xdg 补进来的顶层路径(审计/日志用)。 */
  added: string[]
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)

/** 浅合并一个「命名条目」域(mcp/provider/agent/command):existing 优先(幂等),source 补 absent。 */
function mergeNamed(
  existing: Record<string, unknown>,
  source: Record<string, unknown> | undefined,
  key: string,
  added: string[],
): void {
  if (!isObj(source?.[key])) return
  const src = source[key] as Record<string, unknown>
  const cur = isObj(existing[key]) ? { ...(existing[key] as Record<string, unknown>) } : {}
  let touched = false
  for (const [name, val] of Object.entries(src)) {
    if (!(name in cur)) {
      cur[name] = val
      touched = true
    }
  }
  if (touched) {
    existing[key] = cur
    added.push(`${key}.*`)
  }
}

/**
 * 迁移合并计划:把 legacy(`~/.opencode/opencode.jsonc`)与 XDG provider 域**拷贝**进 alpha 真源既有内容。
 * copy-don't-delete(源不动,由调用方按 junk 判定决定删源)+ 幂等(existing 已有的键不覆盖,重复启动 no-op)。
 * merge 语义:命名条目域(mcp/provider/agent/command)逐名补 absent。
 *
 * **`plugin[]` 刻意不在 merge 语义里(ADR-040,`#832`)**:合并 legacy 的 `plugin[]` 就是「把一段
 * 第三方 JS 装进引擎、以同等权限执行」,而 ADR-040 裁定 Alpha 不再提供这个能力 —— 它不因为
 * 「来源是用户自己的旧配置」而变成另一件事。existing(`alpha.jsonc` 里已有的条目)原样穿过
 * 浅拷贝,本函数**既不加也不删**;删除归卸载侧(`removePlugin` / dangling 清扫)。
 * 想「顺手把这条并集加回来」的下一位:它加不回来 —— 落盘那一刻的咽喉会拒(`engine-plugin-seal.ts`),
 * 拒的后果是**整次 reconcile 不写盘**(skills.paths 注入一起停),不是只丢这一个键。
 */
export function planConfigMerge(
  existing: Record<string, unknown> | undefined,
  legacy: Record<string, unknown> | undefined,
  xdgProvider: Record<string, unknown> | undefined,
): MergePlan {
  const merged: Record<string, unknown> = isObj(existing) ? { ...existing } : {}
  if (!merged.$schema) merged.$schema = "https://opencode.ai/config.json"
  const added: string[] = []

  // legacy 命名域
  mergeNamed(merged, legacy, "mcp", added)
  mergeNamed(merged, legacy, "agent", added)
  mergeNamed(merged, legacy, "command", added)
  mergeNamed(merged, legacy, "permission", added)
  mergeNamed(merged, legacy, "provider", added)

  // XDG provider 域(拷贝迁移;existing/legacy 已有的 provider 名不覆盖)
  mergeNamed(merged, xdgProvider, "provider", added)

  // `plugin[]`:没有分支 —— 不读 legacy 的、不写 merged 的。existing 的那份已经随浅拷贝穿过去了。
  return { merged, changed: added.length > 0, added }
}
