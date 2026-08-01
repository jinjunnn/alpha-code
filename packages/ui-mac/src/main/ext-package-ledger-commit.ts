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
import { decodePackageMutationEnvelopeV1, type PackageLedgerMutationV1 } from "./ext-package-ledger-v3"
import { applyPackageMutation, upsertRecordsV2 } from "./ext-receipt-v2"
import type { TxCommitRecord } from "./ext-transaction"

/**
 * 提交一次事务的账本副作用。失败一律 **throw** —— 事务层据此把 journal 保持在非终态,
 * 下次启动前滚重试;吞掉错误会把「账没写」写成 committed。
 */
export function commitTransactionLedger(root: string, records: TxCommitRecord[]): void {
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
  const mutation: PackageLedgerMutationV1 = {
    ...decoded.value,
    transactionId: carrier.txId,
    ...(decoded.value.packageRecord ? { packageRecord: { ...decoded.value.packageRecord, transactionId: carrier.txId } } : {}),
    childRecordMutations: recoveryReceiptInputs(records).map((input) => ({ op: "upsert" as const, input })),
  }
  const written = applyPackageMutation(root, mutation)
  if (!written.ok) throw new Error(`package ledger mutation commit failed: ${written.reason}`)
}
