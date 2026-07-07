// REQ-059 全局层:alpha 引擎配置真源 = `~/.alpha/alpha.jsonc`(经 G1 = OPENCODE_CONFIG 注入,
// sidecar 内 injectAlphaConfig 设 env;source T0 spike audits/2026-07-07-req059-060-t0-spike)。
//
// 本模块是 electron-free 纯逻辑核(单测覆盖),只做「判定 + 计划计算」,不落盘、不读环境:
//   1. 路径常量派生(alpha.jsonc / legacy ~/.opencode / XDG);
//   2. 存量所有权判定(一份 config 是否 alpha 自有、可整体安全迁移 —— 否则 bail-out loud);
//   3. `~/.opencode` junk-only 判定(拆走 alpha 物后仅剩引擎 bootstrap 垃圾 → 整目录可删);
//   4. 迁移合并计划(legacy jsonc + XDG provider → alpha.jsonc,copy-don't-delete + 幂等)。
// 运行时接线(sidecar 注入 / ext-config 写入切换 / reconcile 落盘)在各消费方,不在此。

import os from "node:os"
import path from "node:path"

/** `~/.alpha` global root (ALPHA_GLOBAL_DIR-overridable for tests). Mirrors alpha-installs.alphaGlobalRoot;
 *  kept here so this module stays dependency-light (os/path only) and can be imported by sidecar + ext-config. */
export function alphaGlobalRoot(): string {
  return process.env.ALPHA_GLOBAL_DIR || path.join(os.homedir(), ".alpha")
}

/** The single alpha engine-config truth file (`~/.alpha/alpha.jsonc`). alpha always writes `.jsonc`. */
export function alphaJsoncPath(): string {
  return path.join(alphaGlobalRoot(), "alpha.jsonc")
}

/** Global factory/installed skills truth dir. Engine discovers it via `skills:[...]` in the alpha.jsonc
 *  FILE channel (factory-skills实测:env skills.paths 不生效、文件 config 生效 → G1 承载,桥退役 T3). */
export function alphaSkillsDir(): string {
  return path.join(alphaGlobalRoot(), "skills")
}

/** Idempotently ensure `config.skills` contains `skillsDir` (absolute). Returns true if it added it. */
export function ensureSkillsPath(config: Record<string, unknown>, skillsDir: string): boolean {
  const cur = Array.isArray(config.skills) ? (config.skills as unknown[]) : []
  if (cur.includes(skillsDir)) return false
  config.skills = [...cur, skillsDir]
  return true
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

/** 治理面:REQ-037 alpha 会写的引擎治理叶子域(与 ext-config governancePathAllowed 同口径的顶层集)。 */
const GOVERNANCE_TOP_KEYS = new Set(["agent", "permission", "command"])

export type OwnershipInput = {
  /** 解析后的存量 config 对象(jsonc parse 结果)。 */
  parsed: Record<string, unknown> | undefined
  /** receipts 里 mcp 类的 server 名集合(configKey `mcp.<name>` 或 name)。 */
  receiptMcpNames: Set<string>
  /** receipts 里 plugin 类的标识集合(configKey `plugin:<pkg>@<ver>` 或 name)。 */
  receiptPluginKeys: Set<string>
}

export type OwnershipVerdict = { owned: true } | { owned: false; reason: string }

/**
 * 一份存量引擎配置是否「alpha 自有」→ 可整体安全迁进真源。判定(全满足才 owned):
 *   ① 顶层键 ⊆ ALPHA_CONFIG_TOP_KEYS(有越界键 = 用户手写混入);
 *   ② 每个 `mcp.<name>` 的 name ∈ receiptMcpNames(alpha 装过账;非账内 = 用户自建);
 *   ③ 每个 `plugin[]` 条目要么是 alpha 账内 plugin,要么是 alpha 自有树内绝对路径(交调用方以 receipt 兜);
 *   ④ 治理键(agent/permission/command)只是存在性放行(内容治理由 ext-config 白名单在写入时把关,
 *      迁移只搬不改)。
 * 任一不满足 → bail-out(不迁、loud、保留原布局,功能零损失,品牌收敛该机暂缓 —— REQ-059 §风险)。
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
  const mcp = obj.mcp
  if (mcp && typeof mcp === "object" && !Array.isArray(mcp)) {
    const foreign = Object.keys(mcp as Record<string, unknown>).filter((n) => !input.receiptMcpNames.has(n))
    if (foreign.length > 0) {
      return { owned: false, reason: `mcp servers not in alpha receipts: ${foreign.slice(0, 3).join(", ")}` }
    }
  }
  // agent/permission/command 存在性放行(治理内容不在迁移判定内);provider/plugin 交合并计划处理。
  return { owned: true }
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
 * merge 语义:命名条目域(mcp/provider/agent/command)逐名补 absent;plugin[] 数组并集去重。
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

  // plugin[] 数组并集(去重,保序:existing 先、legacy 补)
  const exPlugins = Array.isArray(merged.plugin) ? (merged.plugin as unknown[]) : []
  const lgPlugins = Array.isArray(legacy?.plugin) ? (legacy!.plugin as unknown[]) : []
  const union = [...exPlugins]
  let pluginTouched = false
  for (const p of lgPlugins) {
    if (!union.includes(p)) {
      union.push(p)
      pluginTouched = true
    }
  }
  if (pluginTouched || (Array.isArray(merged.plugin) && merged.plugin.length !== union.length)) {
    merged.plugin = union
    added.push("plugin[]")
  } else if (union.length > 0 && !Array.isArray(merged.plugin)) {
    merged.plugin = union
    added.push("plugin[]")
  }

  return { merged, changed: added.length > 0, added }
}
