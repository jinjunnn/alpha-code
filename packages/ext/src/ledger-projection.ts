// ledger-projection — REQ-104 #395:从安装账本(installs.json)的 desiredState 派生 mcp/agent/plugin
// 的**运行时启用投影**(每次 config-hook 重建时施加,与 skill 注入门 gen-skill-paths 同一真源模型)。
//
// 为什么在 hook 派生而非安装期写死:启停(set-state)因此 = 纯账本单写(原子 rename,恢复平凡、零
// 分叉),config 无需随之改写;账本永远是启用态唯一真源,disk 上的 alpha.jsonc 保持「正常条目」,
// 引擎看到的内存 cfg 由本模块按账本投影。安装期恒写正常条目 → 首次 config-load 前 hook 已施加投影。
//
// 严格 decoder(Codex r1 Blocker 2 同纪律):installs.json 缺失/不可解析 → **不改 cfg**(既不启也不禁
// —— 无账本信息时不擅自动 config;唯一有权威判据的启停面是账本,读不到就不投影,交由既有 config)。
// 与 skill 注入门的差异:skill 无账本 = 不注入(那里 generation 目录本就靠账本确证);mcp/agent/plugin
// 的条目本就在 alpha.jsonc(用户/安装写入),无账本时保持原样是安全默认(不误禁用户手写连接器)。

import { readFileSync } from "node:fs"
import { join } from "node:path"

type LedgerRecord = { kind?: unknown; name?: unknown; desiredState?: unknown; configKey?: unknown }

function readLedgerRecords(alphaRoot: string): LedgerRecord[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(alphaRoot, "installs.json"), "utf8"))
  } catch {
    return null
  }
  const recs = parsed && typeof parsed === "object" ? (parsed as { records?: unknown }).records : undefined
  return Array.isArray(recs) ? (recs as LedgerRecord[]) : []
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)

/** plugin[] 条目的引擎 load 身份 spec 头(字符串或 [spec, options] 元组的首项)。 */
function pluginSpecHead(x: unknown): string | null {
  if (typeof x === "string") return x
  if (Array.isArray(x) && typeof x[0] === "string") return x[0]
  return null
}

/**
 * 按账本 desiredState 投影 cfg 的 mcp/agent/plugin 启用态(就地改内存 cfg;返回施加的动作数,仅调试用)。
 *   · mcp/agent:disabled → 叶设 `disabled:true`;enabled → 剥离 Alpha 管理的 `disabled` 键(用户手写的
 *     其它 disabled 语义不在账本管辖内 —— 仅当账本有该记录时才动,无记录的条目一概不碰)。
 *   · plugin:disabled → 从 `cfg.plugin[]` 移除该扩展的条目(按 configKey 匹配:`plugin:<spec>` 精确头,
 *     `plugin-path:<jsPath>` 按字符串/元组首项等值);enabled → 不动(安装/置换已把正常条目写进 plugin[])。
 * 账本不可读 → 返回 0,cfg 不动(严格但不误伤:启停唯一权威是账本,读不到就不投影)。
 */
export function applyLedgerEnableProjection(cfg: Record<string, unknown>, alphaRoot: string | undefined): number {
  if (!alphaRoot) return 0
  const records = readLedgerRecords(alphaRoot)
  if (records === null) return 0
  let applied = 0

  const disabledPluginSpecs = new Set<string>()
  for (const rec of records) {
    if (!isObj(rec) || typeof rec.name !== "string") continue
    const disabled = rec.desiredState === "disabled"
    if (rec.kind === "mcp" || rec.kind === "agent") {
      const map = cfg[rec.kind]
      if (!isObj(map)) continue
      const leaf = map[rec.name]
      if (!isObj(leaf)) continue
      if (disabled && leaf.disabled !== true) {
        leaf.disabled = true
        applied++
      } else if (!disabled && leaf.disabled === true) {
        delete leaf.disabled
        applied++
      }
    } else if (rec.kind === "plugin" && disabled) {
      const ck = typeof rec.configKey === "string" ? rec.configKey : ""
      const spec = ck.startsWith("plugin:") ? ck.slice("plugin:".length) : ck.startsWith("plugin-path:") ? ck.slice("plugin-path:".length) : ""
      if (spec) disabledPluginSpecs.add(spec)
    }
  }

  if (disabledPluginSpecs.size > 0 && Array.isArray(cfg.plugin)) {
    const before = (cfg.plugin as unknown[]).length
    cfg.plugin = (cfg.plugin as unknown[]).filter((x) => {
      const head = pluginSpecHead(x)
      return head === null || !disabledPluginSpecs.has(head)
    })
    applied += before - (cfg.plugin as unknown[]).length
  }

  return applied
}
