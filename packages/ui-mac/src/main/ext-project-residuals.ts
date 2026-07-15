// ADR-030(REQ-098 #372):project-scope catalog/seed 受管安装已收回(planner 写盘前稳定拒绝),
// 但历史残留不可假设为零 —— 测试/dev 构建/直连 IPC 都可能在 <project>/.alpha 留下 catalog 账、
// generation store 或事务 journal。本模块提供两件事:
//   1. detect:只读报告(项目打开/显式检查时呈现;零写入,identity fail-closed);
//   2. clean:显式触发、幂等、受控根内的 generation-aware 清理 —— 有账走 uninstallByKey
//      (skill 带店 = journaled store+ledger teardown;agent = 既有 flat 管理面),ghost 店
//      (有店无账)直接走 uninstallExtensionTransaction。
// 铁律:任何非终态/不可读 journal 在场 = 在途手术未收敛 → 整单 fail-closed,零自动删除;
// 绝不做全盘项目扫描 —— 只看调用方交来的这个项目根。
import fs from "node:fs"
import path from "node:path"

import { alphaRoot } from "./alpha-workdir"
import { uninstallByKey, type PlannerDeps } from "./ext-install-planner"
import { projectScopeIdentity, readLedgerV2, removeRecordV2, type InstallRecordV2 } from "./ext-receipt-v2"
import { skillGenerationKey } from "./ext-skill-generations"
import { probeTransactionJournals, uninstallExtensionTransaction, type TxJournalProbe } from "./ext-transaction"

const STORE_DIR = "ext-store"
const SKILL_KEY_PREFIX = "skill--"

export type ProjectResidualRecord = { type: InstallRecordV2["kind"]; name: string; hasStore: boolean }

export type ProjectResidualReport = {
  ok: true
  projectPath: string
  /** 项目账本里 origin=catalog 的 v2 record(收回路径的落账残留)。 */
  catalogRecords: ProjectResidualRecord[]
  /** ext-store 里有店无账的 generation key(崩溃/半清理遗留)。 */
  ghostStoreKeys: string[]
  /** 非终态或不可读 journal —— 在场即阻断清理(在途手术未收敛,需先显式恢复/隔离)。 */
  openJournals: TxJournalProbe[]
  /** 账本解码告警(损坏 record 已被 fail-closed 排除,如实透传)。 */
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

function listStoreKeys(root: string): string[] {
  try {
    return fs
      .readdirSync(path.join(root, STORE_DIR), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

/** 只读检测:项目根内收回路径的残留清单。identity fail-closed;零写入。 */
export function detectProjectCatalogResiduals(projectDir: unknown): ProjectResidualDetect {
  const resolved = projectRootOf(projectDir)
  if (!resolved.ok) return resolved
  const { root, projectPath } = resolved

  const ledger = readLedgerV2(root)
  const storeKeys = listStoreKeys(root)
  const catalogRecords: ProjectResidualRecord[] = ledger.records
    .filter((r) => r.origin === "catalog")
    .map((r) => ({
      type: r.kind,
      name: r.name,
      hasStore: r.kind === "skill" && storeKeys.includes(skillGenerationKey(r.name)),
    }))
  const recordSkillKeys = new Set(
    catalogRecords.filter((r) => r.type === "skill").map((r) => skillGenerationKey(r.name)),
  )
  // 任何项目根内的 ext-store 目录都属于收回的受管安装路径(项目导入技能从不建店)——
  // 无对应 catalog record 即 ghost。
  const ghostStoreKeys = storeKeys.filter((k) => !recordSkillKeys.has(k))
  const openJournals = probeTransactionJournals(root).filter((j) => !j.terminal)

  return { ok: true, projectPath, catalogRecords, ghostStoreKeys, openJournals, warnings: ledger.warnings }
}

export type ProjectResidualCleanOutcome =
  | {
      ok: true
      cleaned: string[]
      failed: Array<{ item: string; reason: string }>
    }
  | { ok: false; reason: string }

/** 显式清理:先检测,openJournals 在场整单 fail-closed;逐项隔离失败(单项失败不拖垮其余),
 *  幂等 —— 重跑对已清项 no-op。删除只发生在受控面:uninstallByKey(账本权威)与
 *  uninstallExtensionTransaction(journaled 店删 + 幂等去账)。 */
export async function cleanProjectCatalogResiduals(
  projectDir: unknown,
  deps: PlannerDeps,
): Promise<ProjectResidualCleanOutcome> {
  const detected = detectProjectCatalogResiduals(projectDir)
  if (!detected.ok) return detected
  if (detected.openJournals.length > 0)
    return {
      ok: false,
      reason: `fail closed: ${detected.openJournals.length} open transaction journal(s) in project root (e.g. ${detected.openJournals[0]!.txId}:${detected.openJournals[0]!.state}) — resolve/recover explicitly before cleanup`,
    }
  const resolved = projectRootOf(projectDir)
  if (!resolved.ok) return resolved
  const { root, projectPath } = resolved

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
        // ghost = 无账;removeRecordV2 幂等(缺账返回 ok/removed:null),防店账竞态下漏删。
        if (key.startsWith(SKILL_KEY_PREFIX)) {
          const rm = removeRecordV2(root, "skill", key.slice(SKILL_KEY_PREFIX.length))
          if (!rm.ok) throw new Error(rm.reason)
        }
      },
    })
    if (r.ok) cleaned.push(item)
    else failed.push({ item, reason: r.reason })
  }
  return { ok: true, cleaned, failed }
}
