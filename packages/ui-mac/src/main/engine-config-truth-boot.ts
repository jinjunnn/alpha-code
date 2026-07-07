// REQ-059 T2:启动 reconcile —— 存量引擎配置迁进真源 `~/.alpha/alpha.jsonc`(copy-don't-delete)。
//
// 读 legacy(`~/.opencode/opencode.jsonc`,REQ-018 时代 mcp/plugin/治理键)+ XDG provider 域 →
// 所有权判定(isAlphaOwnedConfig,越界/非账内 mcp = bail-out loud 不迁,保留原布局功能零损失)→
// planConfigMerge(幂等 + existing 优先)→ 写 alpha.jsonc。**不删源**:`~/.opencode` 清理(拆桥 +
// 删目录)属 T3(桥退役),迁移期两处内容一致(merge 幂等),引擎从两处读无冲突。
//
// 逃生:ALPHA_JSONC_TRUTH_DISABLE=1 / ALPHA_LEGACY_INSTALL_ROOT=1 → 不迁(回旧行为,与 sidecar 注入
// 及 ext-config 写入目标三侧一致)。启动早期(sidecar fork 前)调用一次;幂等,重复启动 no-op。

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { parse } from "jsonc-parser"
import { alphaGlobalRoot } from "./alpha-installs"
import { opencodeHomeDir } from "./alpha-bridge"
import { readLedger } from "./alpha-installs"
import { alphaJsoncPath, isAlphaOwnedConfig, planConfigMerge } from "./engine-config-truth"

type Logger = { log: (m: string, meta?: unknown) => void; warn: (m: string, meta?: unknown) => void }

export type ReconcileOutcome =
  | { skipped: true; reason: string }
  | { skipped: false; migrated: boolean; added: string[]; bailedOut?: string }

/** Mirror ext-config userConfigDir()/userConfigPath() for the shared XDG provider domain. */
function xdgConfigPath(): string {
  const dir = process.env.OPENCODE_CONFIG_DIR
    ? process.env.OPENCODE_CONFIG_DIR
    : process.env.XDG_CONFIG_HOME
      ? path.join(process.env.XDG_CONFIG_HOME, "opencode")
      : path.join(os.homedir(), ".config", "opencode")
  const jsonc = path.join(dir, "opencode.jsonc")
  const json = path.join(dir, "opencode.json")
  if (fs.existsSync(jsonc)) return jsonc
  if (fs.existsSync(json)) return json
  return jsonc
}

function legacyOpencodePath(): string {
  const dir = opencodeHomeDir()
  const jsonc = path.join(dir, "opencode.jsonc")
  const json = path.join(dir, "opencode.json")
  if (fs.existsSync(jsonc)) return jsonc
  if (fs.existsSync(json)) return json
  return jsonc
}

function readJsonc(file: string): Record<string, unknown> | undefined {
  try {
    if (!fs.existsSync(file)) return undefined
    const parsed = parse(fs.readFileSync(file, "utf8")) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/**
 * Migrate legacy engine config into the alpha truth file. Copy-don't-delete + idempotent.
 * Returns an outcome for logging/telemetry (never throws on a migration miss — reconcile is best-effort).
 */
export function reconcileEngineConfigTruth(log?: Logger): ReconcileOutcome {
  if (process.env.ALPHA_JSONC_TRUTH_DISABLE === "1" || process.env.ALPHA_LEGACY_INSTALL_ROOT === "1") {
    return { skipped: true, reason: "escape hatch set (ALPHA_JSONC_TRUTH_DISABLE / ALPHA_LEGACY_INSTALL_ROOT)" }
  }
  const truth = alphaJsoncPath()
  const legacyFile = legacyOpencodePath()
  const xdgFile = xdgConfigPath()

  const existing = readJsonc(truth)
  const legacy = readJsonc(legacyFile)
  const xdg = readJsonc(xdgFile)

  // Ownership judgement only applies to the legacy ~/.opencode file (alpha wrote it wholesale).
  // The XDG file is the engine's own home — we only lift its `provider` domain out, never judge/delete it.
  if (legacy) {
    const receipts = readLedger(alphaGlobalRoot()).receipts
    const receiptMcpNames = new Set(receipts.filter((r) => r.type === "mcp").map((r) => r.name))
    const receiptPluginKeys = new Set(
      receipts.filter((r) => r.type === "plugin").map((r) => r.configKey ?? r.name),
    )
    const verdict = isAlphaOwnedConfig({ parsed: legacy, receiptMcpNames, receiptPluginKeys })
    if (!verdict.owned) {
      log?.warn(`[req059] legacy ~/.opencode config not alpha-owned — skipping migration (kept in place): ${verdict.reason}`)
      return { skipped: false, migrated: false, added: [], bailedOut: verdict.reason }
    }
  }

  // Only the provider domain is lifted from XDG (the rest of XDG belongs to the engine).
  const xdgProvider = xdg && "provider" in xdg ? { provider: xdg.provider } : undefined

  const plan = planConfigMerge(existing, legacy, xdgProvider)
  if (!plan.changed) return { skipped: false, migrated: false, added: [] }

  try {
    fs.mkdirSync(path.dirname(truth), { recursive: true })
    const tmp = `${truth}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(plan.merged, null, 2) + "\n", "utf8")
    fs.renameSync(tmp, truth)
    log?.log(`[req059] migrated engine config into ~/.alpha/alpha.jsonc`, { added: plan.added })
    return { skipped: false, migrated: true, added: plan.added }
  } catch (error) {
    log?.warn(`[req059] failed to write alpha.jsonc during reconcile`, { error: String(error) })
    return { skipped: false, migrated: false, added: [], bailedOut: "write failed" }
  }
}
