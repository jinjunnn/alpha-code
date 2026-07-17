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
import { agentMdToEntry } from "./agent-md-entry"
import { persistAgentEntry } from "./ext-config"
import {
  alphaJsoncPath,
  alphaSkillsDir,
  ensureSkillsPath,
  isAlphaOwnedConfig,
  isJunkOnlyDir,
  planConfigMerge,
  rewriteFactorySkillPaths,
  stripFactoryBuiltinPolicyLeaves,
} from "./engine-config-truth"
import { FACTORY_SKILL_IDS } from "./factory-skills"
import { FACTORY_DENIED_SKILLS } from "./alpha-builtin-policy"

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

export type ReconcileOptions = {
  /** REQ-065(修订):出厂路径已改内存注入(env → ext config hook),不再写入 alpha.jsonc。
   *  此参数现用于**剥离**历史版本写盘的出厂条目:传 [](reconcile 成功时的常态)= 只清不加;
   *  不传 = 不动该组(factory reconcile 失败时的保守态/测试兼容)。 */
  factorySkillDirs?: string[]
}

/**
 * Migrate legacy engine config into the alpha truth file. Copy-don't-delete + idempotent.
 * Returns an outcome for logging/telemetry (never throws on a migration miss — reconcile is best-effort).
 */
export function reconcileEngineConfigTruth(log?: Logger, opts?: ReconcileOptions): ReconcileOutcome {
  if (process.env.ALPHA_JSONC_TRUTH_DISABLE === "1" || process.env.ALPHA_LEGACY_INSTALL_ROOT === "1") {
    return { skipped: true, reason: "escape hatch set (ALPHA_JSONC_TRUTH_DISABLE / ALPHA_LEGACY_INSTALL_ROOT)" }
  }
  const truth = alphaJsoncPath()
  const legacyFile = legacyOpencodePath()
  const xdgFile = xdgConfigPath()

  const existing = readJsonc(truth)
  const legacy = readJsonc(legacyFile)
  const xdg = readJsonc(xdgFile)

  // Ownership judgement only gates the legacy ~/.opencode MIGRATION (alpha wrote it wholesale) — NOT the
  // skills.paths injection below. Critical: a bail-out (e.g. an mcp without a receipt) must NOT block
  // skills.paths, or factory skills would go dark on exactly the machines that keep their legacy config.
  let bailedOut: string | undefined
  let legacyToMerge = legacy
  if (legacy) {
    const receipts = readLedger(alphaGlobalRoot()).receipts
    const receiptMcpNames = new Set(receipts.filter((r) => r.type === "mcp").map((r) => r.name))
    const receiptPluginKeys = new Set(
      receipts.filter((r) => r.type === "plugin").map((r) => r.configKey ?? r.name),
    )
    const verdict = isAlphaOwnedConfig({ parsed: legacy, receiptMcpNames, receiptPluginKeys })
    if (!verdict.owned) {
      log?.warn(`[req059] legacy ~/.opencode config not alpha-owned — skipping MIGRATION (kept in place): ${verdict.reason}`)
      bailedOut = verdict.reason
      legacyToMerge = undefined // don't migrate legacy content; skills.paths still injected below
    } else if (verdict.unaccountedMcp && verdict.unaccountedMcp.length > 0) {
      // .opencode 是 alpha 领地 → 迁移;但这些 mcp 无 receipt(早期装的记账丢),loud 留痕(卸载/更新
      // 对它们会失真,直到 receipt 补齐)。用户拍板「放宽」:记账不全不阻断品牌收敛。
      log?.warn(`[req059] migrating legacy mcp without receipts (bookkeeping incomplete)`, {
        unaccounted: verdict.unaccountedMcp.slice(0, 8),
      })
    }
  }

  // XDG provider domain is lifted only when we're not bailing out (bail = leave the legacy world intact).
  const xdgProvider = !bailedOut && xdg && "provider" in xdg ? { provider: xdg.provider } : undefined

  const plan = planConfigMerge(existing, legacyToMerge, xdgProvider)
  // T3:全局 skills 经 skills.paths(文件通道生效)发现 ~/.alpha/skills —— 恒定注入(非迁移物,独立于
  // ownership bail),使桥退役后引擎仍能发现**用户装的**技能。幂等。
  const skillsAdded = ensureSkillsPath(plan.merged, alphaSkillsDir())
  // REQ-065:出厂技能条目组重写 —— 直指 app 资源(不再经 ~/.alpha/skills 链中转;.alpha 只承载
  // 用户自有内容)。每启动重写,跟随 app 安装路径/版本变化;stale 出厂路径按名单+布局判定移除。
  const factoryRewritten = opts?.factorySkillDirs
    ? rewriteFactorySkillPaths(plan.merged, opts.factorySkillDirs, FACTORY_SKILL_IDS)
    : false
  // REQ-067:剥离历史物化的「出厂默认禁」明文(permission.skill deny + 占位 command)——
  // 该行为现由 env → ext hook 内存注入,用户配置零痕迹。幂等,无条件执行(只针对出厂清单名)。
  const denyStripped = stripFactoryBuiltinPolicyLeaves(plan.merged, FACTORY_DENIED_SKILLS)
  const added = [
    ...plan.added,
    ...(skillsAdded ? ["skills[]"] : []),
    ...(factoryRewritten ? ["skills.factory[]"] : []),
    ...(denyStripped ? ["factory-deny-stripped"] : []),
  ]

  let migrated = false
  if (plan.changed || skillsAdded || factoryRewritten || denyStripped) {
    try {
      fs.mkdirSync(path.dirname(truth), { recursive: true })
      const tmp = `${truth}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(plan.merged, null, 2) + "\n", "utf8")
      fs.renameSync(tmp, truth)
      log?.log(`[req059] engine config truth updated ~/.alpha/alpha.jsonc`, { added })
      migrated = true
    } catch (error) {
      log?.warn(`[req059] failed to write alpha.jsonc during reconcile`, { error: String(error) })
      return { skipped: false, migrated: false, added: [], bailedOut: bailedOut ?? "write failed" }
    }
  }

  // Bail-out → leave ~/.opencode fully intact (legacy mcp/plugin still read by the engine). Only clean up
  // when the legacy world is alpha-owned (or absent) so nothing user-authored is touched.
  if (bailedOut) return { skipped: false, migrated, added, bailedOut }

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
  // 0.(T3b)存量 agents 桥 → 条目化迁移 + 拆链:~/.alpha/agents/*.md → agentMdToEntry → alpha.jsonc
  //    agent 条目;**全部成功才拆 agents 桥**(任一转换失败 → loud 保留桥 = 该 agent 继续经桥可见,
  //    诚实降级)。幂等:persistAgentEntry 覆盖写同值;无 agents 目录/无桥 → no-op。
  migrateAgentBridges(dir, alphaRoot, log)
  // 1. 拆 alpha 自有的类目 symlink(dir-link 指向 ~/.alpha/<kind>)。用户真实目录/异源链不碰。
  //    skills = REQ-059 T3(skills.paths 文件通道接管);agents 由上一步全权处理(迁移成功才拆);
  //    commands = 防御性(无写入方,预留目录,若存在 alpha 链一并拆)。
  for (const kind of ["skills", "commands"]) {
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

/**
 * T3b:存量 agents 桥的条目化迁移。桥形态两种(alpha-bridge):目录级 dir-link
 * `~/.opencode/agents → ~/.alpha/agents`,或真实目录内的逐条目链。逐 md 转换写条目;
 * **全部成功才拆链**(部分失败 → 保留桥,loud;下次启动重试 —— persistAgentEntry 幂等)。
 */
function migrateAgentBridges(opencodeDir: string, alphaRoot: string, log?: Logger): void {
  const bridged = path.join(opencodeDir, "agents")
  const alphaAgents = path.join(alphaRoot, "agents")
  let form: "dir-link" | "item-links" | null = null
  const itemLinks: string[] = []
  try {
    const st = fs.lstatSync(bridged)
    if (st.isSymbolicLink()) {
      const target = fs.readlinkSync(bridged)
      const resolved = path.isAbsolute(target) ? target : path.resolve(opencodeDir, target)
      if (resolved === alphaAgents || resolved.startsWith(alphaRoot + path.sep)) form = "dir-link"
    } else if (st.isDirectory()) {
      for (const f of fs.readdirSync(bridged)) {
        const p = path.join(bridged, f)
        try {
          const ls = fs.lstatSync(p)
          if (!ls.isSymbolicLink()) continue
          const target = fs.readlinkSync(p)
          const resolved = path.isAbsolute(target) ? target : path.resolve(bridged, target)
          if (resolved.startsWith(alphaRoot + path.sep)) itemLinks.push(p)
        } catch {
          /* skip */
        }
      }
      if (itemLinks.length > 0) form = "item-links"
    }
  } catch {
    return // no agents bridge at all
  }
  if (!form) return

  // 迁移:真源 md 全部转换成条目(alpha.jsonc);任一失败 → 保留桥 loud。
  let mds: string[] = []
  try {
    mds = fs.existsSync(alphaAgents) ? fs.readdirSync(alphaAgents).filter((f) => f.endsWith(".md")) : []
  } catch {
    mds = []
  }
  for (const f of mds) {
    const name = f.slice(0, -3)
    let content: string
    try {
      content = fs.readFileSync(path.join(alphaAgents, f), "utf8")
    } catch (error) {
      log?.warn(`[req059-t3b] agent md unreadable — bridge kept`, { file: f, error: String(error) })
      return
    }
    const parsed = agentMdToEntry(content)
    if (!parsed.ok) {
      log?.warn(`[req059-t3b] agent "${name}" not convertible (${parsed.reason}) — bridge kept for all agents`)
      return
    }
    const persisted = persistAgentEntry(name, parsed.entry)
    if (!persisted.ok) {
      log?.warn(`[req059-t3b] agent "${name}" entry write failed (${persisted.reason}) — bridge kept`)
      return
    }
  }
  // 全部条目就位 → 拆桥
  try {
    if (form === "dir-link") {
      fs.unlinkSync(bridged)
    } else {
      for (const p of itemLinks) fs.unlinkSync(p)
      if (fs.readdirSync(bridged).length === 0) fs.rmSync(bridged, { recursive: true, force: true })
    }
    log?.log(`[req059-t3b] agents bridge retired (${mds.length} agent(s) migrated to alpha.jsonc entries)`)
  } catch (error) {
    log?.warn(`[req059-t3b] agents bridge unlink failed`, { error: String(error) })
  }
}
