// REQ-128 `#706`:事务落账的唯一入口。
//
// 一次扩展事务提交时,账本要么走 V2 的批量 child upsert(单装、生成、恢复前滚),要么走 V3 的
// **一个** `PackageLedgerMutationV1`(package 安装/更新/卸载)。判据只有一个:commit records
// 里有没有 root item 带来的 `packageMutation`。
//
// 为什么两条路必须共用这一个函数:主提交(`package-admission`)与崩溃前滚(`ext-ipc` 的
// recovery seam)如果各自拼一份 mutation,就有两份「同一个事务应该写成什么」的答案,exact replay
// 也就无从谈起 —— 前滚会写出与主提交不同的账本,而两边都自认为成功。

import { recoveryReceiptInputs } from "./ext-agent-install"
import { decodePackageMutationEnvelopeV1, type PackageChildRefV1, type PackageLedgerMutationV1 } from "./ext-package-ledger-v3"
import { applyPackageMutation, upsertRecordsV2 } from "./ext-receipt-v2"
import type { TxCommitRecord } from "./ext-transaction"

/**
 * `#698`(review R1 Blocker 1):离场 child 的实物清除接缝。
 *
 * **为什么挂在这里,而不是在事务之前。** 上一版在 `runExtensionTransaction` 开始**之前**就把离场
 * child 的实物删了,而事务直到 pre-switch probe(`ext-transaction.ts:1553`)与 receipt commit
 * (`:1591`)都还会 `rollbackAll`。于是「更新失败」时盘面是:旧图、旧 claim、旧 record 全在,
 * **而离场组件的实物已经没了** —— 正是 `#706` 刚消灭的「先动实物、后做判决」。
 *
 * 引擎在 receipt commit **成功之后**明确越过可回滚点(`:1595` 起「从此一切失败只前滚,绝不抛出、
 * 绝不回滚」)。所以唯一安全的destroy窗口就是本函数里、`applyPackageMutation` 成功之后:
 *   · 任何提交前的失败(锁 / precondition / staging / probe / switch / 崩溃)都到不了这里 ⇒ 零删除;
 *   · 账本 mutation 自己失败 ⇒ 照旧 throw ⇒ 引擎回滚 ⇒ 零删除;
 *   · 账本已 durable 而删除失败 ⇒ **绝不 throw**(throw 会让引擎回滚 live,而账本已经是新的 ——
 *     那是引擎自己点名禁止的「receipt durable + live 回旧」分叉),如实记 warning;
 *   · 崩在两者之间 ⇒ journal 非终态,恢复期重跑本函数:`applyPackageMutation` 判为 exact replay,
 *     删除幂等重放 ⇒ **可恢复**。这也是删除必须由 envelope 的 `childRemovals` 驱动的理由:
 *     账本已经不认识那些 child 了,只有 journal 还记得。
 */
export type PackageChildArtifactSeamV1 = {
  remove: (children: PackageChildRefV1[]) => { ok: boolean; reason?: string }
  /** 越过可回滚点之后的失败只能上报,不能改变事务结果。调用方把它折进用户可见的 warning。 */
  warnings: string[]
}

/**
 * 提交一次事务的账本副作用。失败一律 **throw** —— 事务层据此把 journal 保持在非终态,
 * 下次启动前滚重试;吞掉错误会把「账没写」写成 committed。
 */
export function commitTransactionLedger(root: string, records: TxCommitRecord[], seam?: PackageChildArtifactSeamV1): void {
  const carriers = records.filter((rec) => rec.packageMutation !== undefined)
  if (carriers.length > 1)
    throw new Error(`transaction carries ${carriers.length} package ledger mutations — only the root package item may carry one`)
  if (carriers.length === 0) {
    const inputs = recoveryReceiptInputs(records)
    if (inputs.length === 0) return
    const written = upsertRecordsV2(root, inputs)
    if (!written.ok) throw new Error(`receipt commit failed: ${written.reason}`)
    return
  }
  const carrier = carriers[0]!
  const decoded = decodePackageMutationEnvelopeV1(carrier.packageMutation)
  if (!decoded.ok) throw new Error(`package ledger mutation rejected (fail closed): ${decoded.errors.join("; ")}`)
  // transactionId 与 child 集合都来自**事务自己**,不接受 journal 里自带的副本 ——
  // 同一份 commit records 在主提交与前滚两条路上算出的 mutation 因此逐字相同。
  // 计划期还不知道事务会分到哪个 txId(`runExtensionTransaction` 自产),envelope 里那个是
  // 占位;真值在这里统一覆盖,包括写进 packageRecord 的那份。
  // `#698`:child mutation 有两个半场,来源不同,不可互相顶替 ——
  //   · **upsert** 由本次事务的 commit records 派生(装了什么,事务自己知道);
  //   · **remove** 由 envelope 携带(被删掉的 child 这次不产生任何 item,commit records 里没有它)。
  // remove 排在 upsert 之前:同一个 key 若两边都出现,那是调用方算错了,而「先删后写」会把它
  // 静默变成一次 upsert。所以下面显式拒绝这种交集,不靠顺序把矛盾抹平。
  const { childRemovals, ...envelope } = decoded.value
  const upserts = recoveryReceiptInputs(records).map((input) => ({ op: "upsert" as const, input }))
  const upsertKeys = new Set(upserts.map((entry) => `${entry.input.kind}:${entry.input.name}`))
  const collision = childRemovals.find((child) => upsertKeys.has(`${child.kind}:${child.name}`))
  if (collision)
    throw new Error(
      `package ledger mutation rejected (fail closed): ${collision.kind}:${collision.name} is both installed and removed by the same transaction`,
    )
  const mutation: PackageLedgerMutationV1 = {
    ...envelope,
    transactionId: carrier.txId,
    ...(envelope.packageRecord ? { packageRecord: { ...envelope.packageRecord, transactionId: carrier.txId } } : {}),
    childRecordMutations: [
      ...childRemovals.map((child) => ({ op: "remove" as const, kind: child.kind, name: child.name })),
      ...upserts,
    ],
  }
  // 接缝缺席而确实有东西要删 ⇒ 在**写账本之前**拒绝。这一步仍在可回滚区里,拒绝是安全的;
  // 放到写完之后再发现,就只剩「账本说没了、实物还在跑」一条路。
  if (childRemovals.length > 0 && !seam)
    throw new Error(
      `package ledger mutation rejected (fail closed): ${childRemovals
        .map((child) => `${child.kind}:${child.name}`)
        .join(", ")} must be removed from disk, but no artifact seam was supplied`,
    )
  const written = applyPackageMutation(root, mutation)
  if (!written.ok) throw new Error(`package ledger mutation commit failed: ${written.reason}`)
  if (childRemovals.length === 0 || !seam) return
  // 越过可回滚点。从这里开始只前滚:失败记 warning,绝不抛。
  try {
    const removal = seam.remove(childRemovals)
    if (!removal.ok)
      seam.warnings.push(
        `package children were removed from the ledger but their files/config could not be cleaned up: ${removal.reason ?? "unknown"} — recovery will retry`,
      )
  } catch (error) {
    seam.warnings.push(
      `package child artifact cleanup threw after the ledger was durable: ${error instanceof Error ? error.message : String(error)} — recovery will retry`,
    )
  }
}
