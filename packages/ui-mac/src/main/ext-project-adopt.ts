// ext-project-adopt — REQ-099 #356:project 账本 v1→v2 adoption。
//
// migrateV1Ledger 的 project adoption 规则(realpath+hash 身份绑定、scope 不符/重复 retained、
// fail-closed 信封)早已完备(ext-receipt-v2),但只在 ledgerReady 对全局根调用过 —— project
// `.alpha/installs.json` 的 v1 存量从未被收编。本模块补齐触发面:项目 lifecycle 事件
// (ext-trust-check,main 首次得知已确认项目目录)中调用。
//
// 共享语义(Codex 裁决 A + 消费不变量 C,契约档 docs/contracts/extension-install-ledger.md §4):
// project `.alpha` 跨 app channel 共用且不做环境分根;adoption 将执行时 main 的 environment
// **如实**写入 record(先到先得的归因事实);environment 对 project 记录是归因字段,不是可见性、
// 操作资格或 channel namespace —— 任何读方不得按它过滤(readLedgerV2/findRecordV2/
// lookupForUninstall/ext-list-installs 均按 ledger/key/scope 操作,现状即如此)。
//
// 纪律:migrateV1Ledger 自身不持锁 —— 新的 installs.json 写方不得置身受控写体系之外,
// 故顺序 = 身份(realpath)→ recovery gate 准入(恢复收敛 + 终态探测,per-root mutex)→
// project bundle 锁 → 迁移;gate/锁只罩迁移,不横跨任何原生确认框。electron-free、DI。

import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { AppEnvironment } from "./alpha-environment"
import { alphaRoot } from "./alpha-workdir"
import { tryAcquireBundleLock } from "./ext-bundle-lock"
import { migrateV1Ledger, projectScopeIdentity } from "./ext-receipt-v2"
import type { RecoveryGate } from "./ext-recovery-gate"

export type AdoptOutcome =
  | { ok: true; migrated: number; retained: number; warnings: string[] }
  /** transient = busy/恢复未收敛 —— 账本零改动,下次 lifecycle 触发自然重试(adoption 幂等);
   *  非 transient = 身份/信封级拒绝,重试无意义(loud log 后人工看)。 */
  | { ok: false; transient: boolean; reason: string }

export async function adoptProjectLedger(
  projectDir: string,
  deps: { environment: AppEnvironment; gate: RecoveryGate },
): Promise<AdoptOutcome> {
  // 身份先行:realpath + hash(fail-closed);根由 realpath 派生,符号链接不产双根。
  const identity = projectScopeIdentity(projectDir)
  if (!identity.ok) return { ok: false, transient: false, reason: `fail closed: ${identity.reason}` }
  const projectPath = identity.scope.projectPath
  const root = alphaRoot(projectPath)
  if (!root) return { ok: false, transient: false, reason: `invalid project root: ${projectDir}` }
  // 无账本 = 无可收编:零写入直接返回(gate/锁会在 .alpha 里落地 lock/journal 目录 ——
  // 不给没有 .alpha 存量的项目制造写副作用)。幂等,存量出现后下次触发自然收编。
  if (!existsSync(join(root, "installs.json"))) return { ok: true, migrated: 0, retained: 0, warnings: [] }

  const res = await deps.gate.withRecoveredWrite(root, async (): Promise<AdoptOutcome> => {
    const lock = tryAcquireBundleLock(root, { txId: `adopt-${randomBytes(6).toString("hex")}` })
    if (!lock.ok) return { ok: false, transient: true, reason: `project ledger busy: ${lock.reason} — will retry on next open` }
    try {
      const m = migrateV1Ledger(root, deps.environment, projectPath)
      if (!m.ok) return { ok: false, transient: false, reason: m.reason }
      return { ok: true, migrated: m.migrated, retained: m.retained, warnings: m.warnings }
    } finally {
      lock.lock.release()
    }
  })
  // gate 拒绝(恢复未收敛/损坏 journal/目录不可枚举)= transient:零改动,后续触发重试。
  if (!res.ok && !("transient" in res)) return { ok: false, transient: true, reason: res.reason }
  return res
}
