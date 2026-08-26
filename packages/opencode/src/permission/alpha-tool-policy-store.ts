// alpha 自有文件(basename `alpha-*`;ADR-043 谓词因子②)。
//
// REQ-131 / #1128 —— 用户工具策略的 **versioned 持久化**(#724 CLOSE_DECIDE §5)。
//
// · 文档按 `(account subject 或 anonymous, workspace/project identity)` 分区,一分区一文件;
//   文件名 = 分区 canonical JSON 的 sha256 —— 不把账户/路径明文写进文件名,
//   分区明文写在**文档体内**,加载时与当前分区核对:核不上(把别的账户的文件拷过来)
//   = quarantine,不是静默采用。
// · 文件不存在 = 首次使用,采用批准默认(`absent`,不是错误)。
// · 文档损坏 / 部分非法 / 未知版本 / 分区不符 / selector 重复 = **整份 quarantine**:
//   不得静默忽略一条可能原本是 deny 的坏记录。恢复入口是 `reset`(把坏文件挪去
//   `.quarantined-<ts>` 备份,回到默认),给 Settings(#1130)呈现。
// · 写入原子:tmp + rename,不留半截文档。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { createHash } from "node:crypto"
import path from "path"
import {
  parseToolPolicyDocument,
  selectorKey,
  type ToolPolicyDocumentV1,
  type ToolPolicyPartition,
  type ToolPolicyRecord,
} from "@opencode-ai/schema/alpha-tool-policy"

/**
 * canonical JSON(键排序、丢 undefined)—— 域内既有算法(alpha-cloud-authority 同款)。
 * 用于分区文件名与 binding digest;非 JSON 值 loud fail,不静默吞。
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error("tool policy evidence contains a non-JSON value")
  return encoded
}

export function canonicalJsonDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`
}

export function policyFilePath(baseDir: string, partition: ToolPolicyPartition): string {
  const digest = canonicalJsonDigest({ account: partition.account, workspace: partition.workspace })
  return path.join(baseDir, `${digest.slice("sha256:".length)}.json`)
}

export type PolicyLoadResult =
  | { status: "ok"; doc: ToolPolicyDocumentV1 }
  | { status: "absent" }
  | { status: "quarantined"; reason: string; file: string }

/** selector 唯一性(§3):重复 = 两条记录可能互相矛盾,静默取一条会丢 deny ⇒ 整份坏。 */
function duplicateSelector(records: readonly ToolPolicyRecord[]): string | undefined {
  const seen = new Set<string>()
  for (const record of records) {
    const key = selectorKey(record.selector)
    if (seen.has(key)) return key
    seen.add(key)
  }
  return undefined
}

export function loadPolicyDocument(baseDir: string, partition: ToolPolicyPartition): PolicyLoadResult {
  const file = policyFilePath(baseDir, partition)
  if (!existsSync(file)) return { status: "absent" }
  let doc: ToolPolicyDocumentV1
  try {
    doc = parseToolPolicyDocument(JSON.parse(readFileSync(file, "utf8")))
  } catch (error) {
    return {
      status: "quarantined",
      reason: `tool policy document failed to parse: ${error instanceof Error ? error.message : String(error)}`,
      file,
    }
  }
  if (doc.partition.account !== partition.account || doc.partition.workspace !== partition.workspace)
    return {
      status: "quarantined",
      reason: "tool policy document belongs to a different account/workspace partition",
      file,
    }
  const duplicate = duplicateSelector(doc.records)
  if (duplicate !== undefined)
    return { status: "quarantined", reason: `duplicate selector record: ${duplicate}`, file }
  return { status: "ok", doc }
}

export function savePolicyDocument(
  baseDir: string,
  partition: ToolPolicyPartition,
  records: readonly ToolPolicyRecord[],
): void {
  const duplicate = duplicateSelector(records)
  if (duplicate !== undefined) throw new Error(`duplicate selector record: ${duplicate}`)
  // decode 一遍 = 写入前走完整 schema 校验(binding digest 在场性、canonical 规范形…),
  // 坏记录在写入者手里 loud fail,而不是落盘后让所有工具进 quarantine。
  const doc = parseToolPolicyDocument({
    version: 1,
    partition: { account: partition.account, workspace: partition.workspace },
    records,
  })
  const file = policyFilePath(baseDir, partition)
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(doc, null, 2))
  renameSync(tmp, file)
}

/** quarantine 恢复入口:坏文件挪去带时间戳的备份,下次加载回到 `absent`(批准默认)。 */
export function resetPolicyDocument(
  baseDir: string,
  partition: ToolPolicyPartition,
): { backup?: string } {
  const file = policyFilePath(baseDir, partition)
  if (!existsSync(file)) return {}
  const backup = `${file}.quarantined-${Date.now()}`
  renameSync(file, backup)
  return { backup }
}
