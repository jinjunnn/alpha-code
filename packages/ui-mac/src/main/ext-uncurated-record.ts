// REQ-099 #306:未策展安装(自定义 MCP / npm 导入 / folder / git / agent 导入)的唯一落账入口。
//
// Codex 裁决要点:
//   · 单次 upsertRecordV2 = 双账本原子写(records[] + 派生 v1 receipts[],降级可读);绝不
//     addReceipt 前置 —— 那会让首装 generation 被顶成 2(upsert 把既有 v1 视作前代)。
//   · 参数面收窄:没有 digest / catalogId / 显式 generation 的通道;catalog 供给链字段只能由
//     planner 提交面产生(decodeRecordV2 的 #306 不变量在读写两侧兜底)。
//   · 冲突 fail-closed:账本键是 (kind,name),光看 id 不够 —— 同键已有 catalog 来源的 v2 record
//     或 v1 receipt,或 skill 的 generation store 在盘,一律拒绝:未策展不得顶替 catalog 安装,
//     否则卸载按 store 存在性走代际删除,会拆掉 catalog 代际、留下 flat 孤儿。

import { findReceipt } from "./alpha-installs"
import { hasSkillGeneration } from "./ext-skill-generations"
import { lookupForUninstall, upsertRecordV2, type LedgerV2Write, type ScopeIdentity } from "./ext-receipt-v2"
import { nextDesiredState } from "./ext-install-policy"
import type { AppEnvironment } from "./alpha-environment"
import type { InstallReceiptOrigin, InstallReceiptType } from "../preload/types"

export type UncuratedOrigin = Exclude<InstallReceiptOrigin, "catalog">

export type UncuratedInstallInput = {
  kind: InstallReceiptType
  name: string
  origin: UncuratedOrigin
  environment: AppEnvironment
  scope: ScopeIdentity
  version?: string
  configKey?: string
  files?: string[]
}

/**
 * 冲突预检(Codex review #355 high):用 lookupForUninstall 做损坏可见的账本查询 —— findRecordV2
 * 会静默排除损坏 record,「损坏 catalog v2」不能成为未策展覆盖的通道(fail-closed);v1 catalog
 * receipt 无论 v2 在不在都查(v1/v2 错位 = 异常态,同样拒绝)。fs 安装方写盘前也调本预检,
 * 免得复制/覆盖后才被拒(补偿面最小化)。检查与 upsert 之间无 await(main 单事件循环内同步),
 * 无 TOCTOU 交错窗口。
 */
export function checkUncuratedConflict(root: string, kind: InstallReceiptType, name: string): { ok: true } | { ok: false; reason: string } {
  const found = lookupForUninstall(root, kind, name)
  if (found.status === "corrupt-match" || found.status === "ledger-corrupt")
    return { ok: false, reason: `refusing uncurated record: ledger state for ${kind}:${name} is corrupt (fail closed)` }
  if (found.status === "valid" && found.record.origin === "catalog")
    return { ok: false, reason: `refusing uncurated record: ${kind}:${name} is a catalog install — uninstall it first` }
  const v1 = findReceipt(root, kind, name)
  if (v1?.origin === "catalog")
    return { ok: false, reason: `refusing uncurated record: ${kind}:${name} has a catalog v1 receipt — uninstall it first` }
  if (kind === "skill" && hasSkillGeneration(root, name))
    return { ok: false, reason: `refusing uncurated record: skill "${name}" is generation-managed — uninstall it first` }
  return { ok: true }
}

/** 未策展安装落账(id 恒 `user:<name>`;generation 由 upsert 计算)。desiredState 走统一分类器
 *  (#395):非目录 intake = 用户显式导入,分类为 enabled;既有记录当前策略优先。 */
export function recordUncuratedInstall(root: string, input: UncuratedInstallInput): LedgerV2Write {
  const conflict = checkUncuratedConflict(root, input.kind, input.name)
  if (!conflict.ok) return conflict
  return upsertRecordV2(root, {
    id: `user:${input.name}`,
    name: input.name,
    kind: input.kind,
    environment: input.environment,
    scope: input.scope,
    desiredState: nextDesiredState(root, input.kind, input.name, { origin: input.origin }),
    origin: input.origin,
    installedAt: new Date().toISOString(),
    ...(input.version ? { version: input.version } : {}),
    ...(input.configKey ? { configKey: input.configKey } : {}),
    ...(input.files ? { files: input.files } : {}),
  })
}
