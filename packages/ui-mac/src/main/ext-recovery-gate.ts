// REQ-100 #347 —— 写方事务准入 gate:每次 install/uninstall/rollback/set-state/residuals-clean
// 前,把「恢复 → 终态探测 → 操作」链在同一准入临界区里执行,会话内残留的非终态 journal 不再
// 等重启,且绝不在分叉账本上继续写。
//
// 锁语义(Codex 裁决 #347-1 的实现口径,如实成文):
//   · **进程内**:per-root 异步 mutex 把 恢复→探测→操作 串成一条所有权链 —— 同进程内不存在
//     「恢复后释放再竞争」窗口(所有生产写方都经本 gate,mutex 内没有第二个写方可插入)。
//   · **跨进程**:文件级 bundle 锁仲裁不变 —— 恢复不抢活锁(活锁 = 在途事务,gate 如实拒绝);
//     操作自身持文件锁执行。第二个 app 实例在探测与操作取锁之间塞入并完成一笔事务的窗口
//     理论存在(单实例桌面拓扑下无生产触发面),其残留 journal 会被下一次 gate 收敛。
//
// 放行判据(Codex 裁决:不能只看 result.ok,也不用 recoveryClean —— 那是迁移谓词):
//   1. recoverExtensionTransactions ok(活锁/根非法 → 拒);
//   2. 本轮无 corrupt journal(不可解析件已移 .corrupt-* 留证 → 本轮拒,下轮无 corrupt 放行;
//      诊断步骤见 docs/runbooks/extension-tx-journal.md);
//   3. 恢复后重新探测:journal 目录可枚举 且 全部 journal 已终态(aborted/rolled-back 是终态,
//      不阻断)。
import { probeTransactionJournals, recoverExtensionTransactions, type RecoverOptions } from "./ext-transaction"

export type GateRefusal = { ok: false; reason: string }

export type RecoveryGate = {
  /** 在 root 的写准入临界区内执行 op:先恢复收敛并按终态探测放行,拒则返回 GateRefusal(op 不执行)。 */
  withRecoveredWrite<T>(root: string, op: () => Promise<T>): Promise<T | GateRefusal>
}

/** per-root 进程内 mutex + 恢复准入。recoveryOpts 按 root 构造(seam 必须写传入的 root)。
 *  log:准入耗时观测(review #376 m4:每次准入 = 同步 journal 扫描 ×(恢复+GC+探测),GC 后
 *  上限 ~100 张终态件,首次面对大量存量时无界 —— 超阈值 loud,供性能回归定位)。 */
export function makeRecoveryGate(recoveryOpts: (root: string) => RecoverOptions, log?: (message: string) => void): RecoveryGate {
  const chains = new Map<string, Promise<unknown>>()
  const SLOW_ADMIT_MS = 250
  async function admit(root: string): Promise<{ ok: true } | GateRefusal> {
    const startedAt = Date.now()
    try {
      return await admitInner(root)
    } finally {
      const ms = Date.now() - startedAt
      if (ms > SLOW_ADMIT_MS) log?.(`[req100-recovery-gate] slow admission: ${ms}ms for ${root}`)
    }
  }
  async function admitInner(root: string): Promise<{ ok: true } | GateRefusal> {
    const rec = await recoverExtensionTransactions(root, recoveryOpts(root))
    if (!rec.ok) return { ok: false, reason: `ledger recovery incomplete — operation refused: ${rec.reason ?? "unknown"}` }
    const corrupt = rec.reports.find((r) => r.corrupt)
    if (corrupt)
      return {
        ok: false,
        reason: `corrupt transaction journal quarantined this run (${corrupt.txId}) — inspect per docs/runbooks/extension-tx-journal.md, then retry`,
      }
    const probe = probeTransactionJournals(root)
    if (probe.unreadableDir) return { ok: false, reason: "transaction journal directory cannot be enumerated — operation refused (fail closed)" }
    const open = probe.entries.find((j) => !j.terminal)
    if (open)
      return {
        ok: false,
        reason: `non-terminal transaction journal remains after recovery (${open.txId}:${open.state}) — operation refused; see docs/runbooks/extension-tx-journal.md`,
      }
    return { ok: true }
  }
  return {
    async withRecoveredWrite<T>(root: string, op: () => Promise<T>): Promise<T | GateRefusal> {
      const prev = (chains.get(root) ?? Promise.resolve()).catch(() => {})
      let release!: () => void
      const myTurn = new Promise<void>((r) => (release = r))
      const tail = prev.then(() => myTurn)
      chains.set(root, tail)
      await prev
      try {
        const admitted = await admit(root)
        if (!admitted.ok) return admitted
        return await op()
      } finally {
        release()
        if (chains.get(root) === tail) chains.delete(root)
      }
    },
  }
}

/** #347 结构性接入(Codex 裁决:不用源码文本合同,用统一注册辅助 + 行为测试):
 *  写 handler 一律由本函数构造 —— 先解析 root(解析失败原样返回,零副作用),再过 gate,
 *  拒绝时 body 不执行。测试直接调用返回的 callback 断言「先恢复、拒绝短路、root 正确」。 */
export function gatedWriteHandler<A extends unknown[], T>(
  gate: RecoveryGate,
  resolveRoot: (...args: A) => { ok: true; root: string } | { ok: false; reason: string },
  body: (...args: A) => Promise<T>,
): (...args: A) => Promise<T | GateRefusal> {
  return async (...args: A) => {
    const resolved = resolveRoot(...args)
    if (!resolved.ok) return resolved
    return gate.withRecoveredWrite(resolved.root, () => body(...args))
  }
}
