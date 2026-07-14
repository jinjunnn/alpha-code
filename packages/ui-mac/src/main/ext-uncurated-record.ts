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
import { findRecordV2, upsertRecordV2, type LedgerV2Write, type ScopeIdentity } from "./ext-receipt-v2"
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

/** 未策展安装落账(id 恒 `user:<name>`,desiredState=enabled;generation 由 upsert 计算)。 */
export function recordUncuratedInstall(root: string, input: UncuratedInstallInput): LedgerV2Write {
  const existing = findRecordV2(root, input.kind, input.name)
  if (existing?.origin === "catalog")
    return { ok: false, reason: `refusing uncurated record: ${input.kind}:${input.name} is a catalog install — uninstall it first` }
  if (!existing) {
    const v1 = findReceipt(root, input.kind, input.name)
    if (v1?.origin === "catalog")
      return { ok: false, reason: `refusing uncurated record: ${input.kind}:${input.name} has a catalog v1 receipt — uninstall it first` }
  }
  if (input.kind === "skill" && hasSkillGeneration(root, input.name))
    return { ok: false, reason: `refusing uncurated record: skill "${input.name}" is generation-managed (catalog) — uninstall it first` }
  return upsertRecordV2(root, {
    id: `user:${input.name}`,
    name: input.name,
    kind: input.kind,
    environment: input.environment,
    scope: input.scope,
    desiredState: "enabled",
    origin: input.origin,
    installedAt: new Date().toISOString(),
    ...(input.version ? { version: input.version } : {}),
    ...(input.configKey ? { configKey: input.configKey } : {}),
    ...(input.files ? { files: input.files } : {}),
  })
}
