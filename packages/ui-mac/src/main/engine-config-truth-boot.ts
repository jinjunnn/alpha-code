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
import {
  alphaJsoncPath,
  alphaSkillsDir,
  ensureSkillsPath,
  isAlphaOwnedConfig,
  isJunkOnlyDir,
  planConfigMerge,
} from "./engine-config-truth"

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
  // T3:全局 skills 经 skills.paths(文件通道生效)发现 ~/.alpha/skills —— 恒定注入(非迁移物),
  // 使桥退役后引擎仍能发现出厂+装的技能。幂等。
  const skillsAdded = ensureSkillsPath(plan.merged, alphaSkillsDir())
  const added = [...plan.added, ...(skillsAdded ? ["skills[]"] : [])]

  let migrated = false
  if (plan.changed || skillsAdded) {
    try {
      fs.mkdirSync(path.dirname(truth), { recursive: true })
      const tmp = `${truth}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(plan.merged, null, 2) + "\n", "utf8")
      fs.renameSync(tmp, truth)
      log?.log(`[req059] engine config truth updated ~/.alpha/alpha.jsonc`, { added })
      migrated = true
    } catch (error) {
      log?.warn(`[req059] failed to write alpha.jsonc during reconcile`, { error: String(error) })
      return { skipped: false, migrated: false, added: [], bailedOut: "write failed" }
    }
  }

  // T3:migration/injection 落定后清理 ~/.opencode —— 拆自有链、删已迁配置,junk-only 则整目录删。
  // 只在 legacy owned(未 bail-out)时执行:含用户内容的机器保留 + loud(§风险)。
  cleanupOpencodeHome(log)

  return { skipped: false, migrated, added }
}

/**
 * T3 桥退役 + `~/.opencode` 清理:拆 alpha 自有 symlink(指向 ~/.alpha 的 skills/agents/commands 链)、
 * 删已迁的 opencode.jsonc/.json + `.alpha-bak-*` 残留;剩余仅引擎 junk 白名单 → 整目录删除。
 * 含用户自建内容(非链、非 junk)→ 保留 + loud(降级共存,ADR-019 §4)。幂等、best-effort。
 */
function cleanupOpencodeHome(log?: Logger): void {
  const dir = opencodeHomeDir()
  const alphaRoot = alphaGlobalRoot()
  try {
    if (!fs.existsSync(dir)) return
  } catch {
    return
  }
  // 1. 拆 alpha 自有的 skills 类目 symlink(dir-link 指向 ~/.alpha/skills)。用户真实目录/异源链不碰。
  //    T3 本批只退役 skills 桥(skills.paths 文件通道接管);agents/commands 桥退役 + 条目化 = T3b
  //    (引擎无 agent/command paths,需读 md 写 config 条目;本机无全局 agent/command 验证物,不阻塞)。
  for (const kind of ["skills"]) {
    const p = path.join(dir, kind)
    try {
      const st = fs.lstatSync(p)
      if (st.isSymbolicLink()) {
        const target = fs.readlinkSync(p)
        const resolved = path.isAbsolute(target) ? target : path.resolve(dir, target)
        if (resolved === path.join(alphaRoot, kind) || resolved.startsWith(alphaRoot + path.sep)) {
          fs.unlinkSync(p)
          log?.log(`[req059] unbridged ~/.opencode/${kind} (pointed into ~/.alpha)`)
        }
      }
    } catch {
      /* not present / not a link → nothing to unbridge */
    }
  }
  // 2. 删已迁的 alpha 引擎配置文件 + 会话残留备份(内容已 merge 进真源,幂等安全)。
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f === "opencode.jsonc" || f === "opencode.json" || f.startsWith("opencode.jsonc.alpha-bak") || f.startsWith("opencode.json.alpha-bak")) {
        try {
          fs.unlinkSync(path.join(dir, f))
        } catch {
          /* best effort */
        }
      }
    }
  } catch {
    /* unreadable dir */
  }
  // 3. 剩余仅引擎 junk → 整目录删;含用户内容 → 保留 loud。
  try {
    const residual = fs.readdirSync(dir)
    if (isJunkOnlyDir(residual, [])) {
      fs.rmSync(dir, { recursive: true, force: true })
      log?.log(`[req059] removed ~/.opencode (only engine junk remained)`)
    } else if (residual.length > 0) {
      log?.warn(`[req059] ~/.opencode retained — user-authored content present`, { residual: residual.slice(0, 8) })
    }
  } catch {
    /* best effort */
  }
}
