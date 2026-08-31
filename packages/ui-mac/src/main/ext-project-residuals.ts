// ADR-030(REQ-098 #372):project-scope catalog/seed 受管安装已收回(planner 写盘前稳定拒绝),
// 但历史残留不可假设为零 —— 测试/dev 构建/直连 IPC 都可能在 <project>/.code-puppy 留下 catalog 账、
// generation store 或事务 journal。本模块提供两件事:
//   1. detect:只读报告(项目打开/显式检查时呈现;零写入,identity fail-closed);
//   2. clean:显式触发、幂等、受控面内的 generation-aware 清理 —— 有账走 uninstallByKey
//      (skill 带店 = journaled store+ledger teardown;agent = 既有 flat 管理面),ghost 店
//      (账本可证明无主)走 uninstallExtensionTransaction。
// fail-closed 铁律(Codex review PR#373 两 Blocker 的成文化):
//   · 删除只发生在「账本可证明」的前提下 —— 账本文件不可读、相关 key 有损坏 record、或含
//     不可归属的损坏 record(lookupForUninstall 的 corrupt-match / ledger-corrupt)→ 整单拒;
//   · ghost 判定只认 `skill--<safe-name>` 且具 generation-store 结构的目录;其余 ext-store
//     条目一律只报告(unknownStoreEntries),绝不删;
//   · 非终态/不可读 journal、journal 目录不可枚举 → 整单拒,零自动删除;
//   · orphan agent 面(.code-puppy/agents/*.md、alpha.jsonc agent 条目)只报告,永不自动清;
//   · 绝不做全盘项目扫描 —— 只看调用方交来的这个项目根。
// 并发窗口:detect→clean 非原子;兜底 = 清理起步前重新巡检 journal(拒绝新在途),且 skill
// 店删除本身是持 Bundle 锁的 journaled 事务(与任何并发事务串行);flat agent 删除由
// installer 层配置写锁保护(#342)。
import fs from "node:fs"
import path from "node:path"
import { parse as parseJsonc } from "jsonc-parser"

import { alphaRoot } from "./alpha-workdir"
import { uninstallByKey, type PlannerDeps } from "./ext-install-planner"
import { lookupForUninstall, projectScopeIdentity, readLedgerV2, removeRecordV2, type InstallRecordV2 } from "./ext-receipt-v2"
import { skillGenerationKey, skillStorePaths } from "./ext-skill-generations"
import { probeTransactionJournals, uninstallExtensionTransaction, type TxJournalProbe } from "./ext-transaction"

const STORE_DIR = "ext-store"
const SKILL_KEY_PREFIX = "skill--"
// 与 ext-transaction 的 SAFE_KEY 同构再加 skill-- 前缀:只有这种形状可能是收回路径的产物。
const SKILL_STORE_KEY = /^skill--[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/

export type ProjectResidualRecord = { type: InstallRecordV2["kind"]; name: string; hasStore: boolean }

export type ProjectResidualReport = {
  ok: true
  projectPath: string
  /** 项目账本里 origin=catalog 且 scope=project 的 v2 record(收回路径的落账残留;可清理面)。 */
  catalogRecords: ProjectResidualRecord[]
  /** 账本可证明无主(lookup=absent)的 skill generation store(可清理面)。 */
  ghostStoreKeys: string[]
  /** 非 skill--* 形状 / 无 generation-store 结构的 ext-store 条目 —— 只报告,绝不清。 */
  unknownStoreEntries: string[]
  /** 无任何账面依据的 agent 残留面(.code-puppy/agents/*.md 文件名、alpha.jsonc agent 键)—— 只报告。 */
  orphanAgentFiles: string[]
  orphanAgentConfigEntries: string[]
  /** 非终态或不可读 journal —— 在场即阻断清理。 */
  openJournals: TxJournalProbe[]
  /** 账本可证明性缺口(文件不可读/损坏 record/journal 目录不可枚举)—— 任一在场,清理整单拒。 */
  cleanBlockers: string[]
  /** 其余如实告警(误置 record、v1 receipt 占位、账本解码告警等)。 */
  warnings: string[]
}

export type ProjectResidualDetect = ProjectResidualReport | { ok: false; reason: string }

function projectRootOf(projectDir: unknown): { ok: true; root: string; projectPath: string } | { ok: false; reason: string } {
  if (typeof projectDir !== "string" || !path.isAbsolute(projectDir))
    return { ok: false, reason: "projectDir: required absolute path" }
  const identity = projectScopeIdentity(projectDir)
  if (!identity.ok) return { ok: false, reason: `fail closed: ${identity.reason}` }
  const root = alphaRoot(identity.scope.projectPath)
  if (!root) return { ok: false, reason: `fail closed: invalid project root: ${projectDir}` }
  return { ok: true, root, projectPath: identity.scope.projectPath }
}

function listStoreEntries(root: string): { keys: string[]; unknown: string[] } {
  let names: fs.Dirent[]
  try {
    names = fs.readdirSync(path.join(root, STORE_DIR), { withFileTypes: true })
  } catch {
    return { keys: [], unknown: [] }
  }
  const keys: string[] = []
  const unknown: string[] = []
  for (const e of names) {
    if (!e.isDirectory()) {
      unknown.push(e.name)
      continue
    }
    const sp = skillStorePaths(root, e.name.startsWith(SKILL_KEY_PREFIX) ? e.name.slice(SKILL_KEY_PREFIX.length) : e.name)
    const looksLikeStore = fs.existsSync(sp.generations) || fs.existsSync(sp.pointer)
    if (SKILL_STORE_KEY.test(e.name) && looksLikeStore) keys.push(e.name)
    else unknown.push(e.name)
  }
  return { keys: keys.sort(), unknown: unknown.sort() }
}

function listOrphanAgentSurfaces(root: string, hasAgentRecord: (name: string) => boolean): { files: string[]; configEntries: string[] } {
  const files: string[] = []
  try {
    for (const e of fs.readdirSync(path.join(root, "agents"), { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith(".md")) continue
      const name = e.name.slice(0, -".md".length)
      if (!hasAgentRecord(name)) files.push(e.name)
    }
  } catch {
    /* 无 agents 目录 */
  }
  const configEntries: string[] = []
  try {
    const parsed: unknown = parseJsonc(fs.readFileSync(path.join(root, "alpha.jsonc"), "utf8"))
    const agent = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>).agent : undefined
    if (agent && typeof agent === "object" && !Array.isArray(agent)) {
      for (const name of Object.keys(agent)) if (!hasAgentRecord(name)) configEntries.push(name)
    }
  } catch {
    /* 无 / 不可解析 alpha.jsonc:agent 面只报告,不因此阻断 */
  }
  return { files: files.sort(), configEntries: configEntries.sort() }
}

/** 只读检测:项目根内收回路径的残留清单与可证明性状态。identity fail-closed;零写入。 */
export function detectProjectCatalogResiduals(projectDir: unknown): ProjectResidualDetect {
  const resolved = projectRootOf(projectDir)
  if (!resolved.ok) return resolved
  const { root, projectPath } = resolved

  const cleanBlockers: string[] = []
  const warnings: string[] = []

  const ledger = readLedgerV2(root)
  warnings.push(...ledger.warnings)

  const catalogRecords: ProjectResidualRecord[] = []
  const { keys: storeKeys, unknown: unknownStoreEntries } = listStoreEntries(root)
  for (const r of ledger.records) {
    if (r.origin !== "catalog") continue
    if (r.scope.kind !== "project") {
      // 误置:catalog record 却非 project identity —— 无法证明归属,只报告绝不清(Codex M1)。
      warnings.push(`misplaced catalog record in project ledger (scope=${r.scope.kind}) — report-only: ${r.kind}:${r.name}`)
      continue
    }
    catalogRecords.push({
      type: r.kind,
      name: r.name,
      hasStore: r.kind === "skill" && storeKeys.includes(skillGenerationKey(r.name)),
    })
  }

  // ghost 判定走账本结构化四态(Codex B1):absent 才是可证明无主;corrupt-match/ledger-corrupt
  // 一律阻断整单;valid(非 catalog/project 面)与 v1 属反常占位,只报告。
  const boundKeys = new Set(catalogRecords.filter((r) => r.type === "skill").map((r) => skillGenerationKey(r.name)))
  const ghostStoreKeys: string[] = []
  for (const key of storeKeys) {
    if (boundKeys.has(key)) continue
    const name = key.slice(SKILL_KEY_PREFIX.length)
    const lookup = lookupForUninstall(root, "skill", name)
    if (lookup.status === "absent") ghostStoreKeys.push(key)
    else if (lookup.status === "corrupt-match" || lookup.status === "ledger-corrupt") cleanBlockers.push(`${key}: ${lookup.reason}`)
    else warnings.push(`store ${key} is bound to a non-cleanable ledger entry (${lookup.status}) — report-only`)
  }

  // 账本文件本身不可读 → 所有相关判定失据。storeKeys 为空时上面的 per-key 探测不会触发,
  // 这里补一次全局探测(任取一个不存在的 key 即可暴露 ledger-corrupt / unattributable)。
  const ledgerProbe = lookupForUninstall(root, "skill", "adr030-ledger-probe")
  if (ledgerProbe.status === "ledger-corrupt") cleanBlockers.push(ledgerProbe.reason)

  const hasAgentRecord = (name: string) => lookupForUninstall(root, "agent", name).status !== "absent"
  const orphanAgents = listOrphanAgentSurfaces(root, hasAgentRecord)

  const probed = probeTransactionJournals(root)
  if (probed.unreadableDir) cleanBlockers.push("transaction journal directory exists but cannot be enumerated — fail closed")
  const openJournals = probed.entries.filter((j) => !j.terminal)

  return {
    ok: true,
    projectPath,
    catalogRecords,
    ghostStoreKeys,
    unknownStoreEntries,
    orphanAgentFiles: orphanAgents.files,
    orphanAgentConfigEntries: orphanAgents.configEntries,
    openJournals,
    cleanBlockers,
    warnings,
  }
}

export type ProjectResidualCleanOutcome =
  /** #336:ok:true 只在**零失败**时成立(成功臂不再携带恒空 failed)。 */
  | {
      ok: true
      cleaned: string[]
      /** 只报告不清理的面(unknown 店 / orphan agent),供调用方如实呈现。 */
      reported: string[]
    }
  /** 任一删账/卸载失败 → 整单 ok:false(fail-closed 判别位跨 IPC 如实);cleaned/failed/reported
   *  保留,如实表达已完成的批处理进度(逐项隔离、幂等,重试收敛)。 */
  | { ok: false; reason: string; cleaned?: string[]; failed?: Array<{ item: string; reason: string }>; reported?: string[] }

/** 显式清理:先检测,cleanBlockers/openJournals 在场整单 fail-closed;起步前重新巡检 journal
 *  (缩小 detect→clean 窗口;店删除本身持锁 journaled,与并发事务串行)。逐项隔离失败,幂等。 */
export async function cleanProjectCatalogResiduals(
  projectDir: unknown,
  deps: PlannerDeps,
): Promise<ProjectResidualCleanOutcome> {
  const detected = detectProjectCatalogResiduals(projectDir)
  if (!detected.ok) return detected
  if (detected.cleanBlockers.length > 0)
    return { ok: false, reason: `fail closed: ledger not provably complete — ${detected.cleanBlockers[0]!}` }
  if (detected.openJournals.length > 0)
    return {
      ok: false,
      reason: `fail closed: ${detected.openJournals.length} open transaction journal(s) in project root (e.g. ${detected.openJournals[0]!.txId}:${detected.openJournals[0]!.state}) — resolve/recover explicitly before cleanup`,
    }
  const resolved = projectRootOf(projectDir)
  if (!resolved.ok) return resolved
  const { root, projectPath } = resolved

  // 起步前的新在途巡检(TOCTOU 缓解;窗内新开的事务在此显形)。
  const reprobe = probeTransactionJournals(root)
  if (reprobe.unreadableDir || reprobe.entries.some((j) => !j.terminal))
    return { ok: false, reason: "fail closed: a transaction appeared between detect and clean — retry after it settles" }

  const cleaned: string[] = []
  const failed: Array<{ item: string; reason: string }> = []

  for (const rec of detected.catalogRecords) {
    const item = `${rec.type}:${rec.name}`
    const r = await uninstallByKey({ type: rec.type, name: rec.name, scope: "project", projectDir: projectPath }, deps)
    if (r.ok) cleaned.push(item)
    else failed.push({ item, reason: r.reason })
  }
  for (const key of detected.ghostStoreKeys) {
    const item = `store:${key}`
    const r = await uninstallExtensionTransaction(root, key, {
      commitLedger: () => {
        // ghost = 已证明无账;removeRecordV2 幂等(缺账返回 ok/removed:null),防店账竞态下漏删。
        const rm = removeRecordV2(root, "skill", key.slice(SKILL_KEY_PREFIX.length))
        if (!rm.ok) throw new Error(rm.reason)
      },
    })
    if (r.ok) cleaned.push(item)
    else failed.push({ item, reason: r.reason })
  }
  const reported = [
    ...detected.unknownStoreEntries.map((e) => `unknown-store:${e}`),
    ...detected.orphanAgentFiles.map((f) => `orphan-agent-file:${f}`),
    ...detected.orphanAgentConfigEntries.map((n) => `orphan-agent-config:${n}`),
  ]
  // #336:单项失败不得包成外层成功 —— failed 非空即整单 ok:false(判别位跨 IPC 如实),
  // 进度字段保留(幂等,重试只补失败项)。
  if (failed.length > 0)
    return {
      ok: false,
      reason: `${failed.length} residual(s) failed to clean (e.g. ${failed[0]!.item}: ${failed[0]!.reason})`,
      cleaned,
      failed,
      reported,
    }
  return { ok: true, cleaned, reported }
}
