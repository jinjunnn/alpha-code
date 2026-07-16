// shared/ext-journal-admin — REQ-100 #375:journal 管理面的 wire DTO(main 产出、preload 透传、
// renderer 按 kind 分派)。放 shared 层(#348 ext-capability-authorization 同款先例):main 与
// preload 引用同一真源,判别联合不在桥接层退化为 unknown。UI 归 Hub,此处只是类型合同。

export type RetainedJournalEntry = {
  kind: "retained"
  rootIdentity: string
  /** journal 目录项文件名(定位符;txId 只作展示 —— 畸形件文件名/体内 txId 可不一致)。 */
  entryId: string
  /** root-relative。 */
  path: string
  txId: string
  /** 体内 txId 与文件名派生不一致时二者都留。 */
  bodyTxId?: string
  op: "install" | "uninstall" | "rollback"
  state: string
  keys: string[]
  /** 该 journal 提供的去重 digest mark 数(CAS 后果展示,裁决防呆)。 */
  markDigestCount: number
  reason: string
  reasonSource: "structure" | "state"
  retireEligible: boolean
  journalSha256: string
  bytes: number
  firstSeenAt: string
  firstSeenAtSource: "birthtime" | "mtime"
  stagingPresent: boolean
}

export type JournalAdminEntry =
  | RetainedJournalEntry
  | { kind: "already-quarantined"; rootIdentity: string; entryId: string; path: string; bytes: number; firstSeenAt: string; firstSeenAtSource: "birthtime" | "mtime" }
  | { kind: "malformed-entry"; rootIdentity: string; entryId: string; path: string; reason: string }
  | { kind: "unreadable-root"; rootIdentity: string; reason: string }
  | { kind: "retire-incomplete"; rootIdentity: string; receiptPath: string; entryId: string; txId: string; destinationPresent: boolean }

export type JournalAdminScope = { kind: "global"; environment: "dev" | "prod" | "beta" } | { kind: "project"; projectDir: string }

/** retire 请求线格(renderer → main;两个确认 flag 必须字面 true,见 decode)。 */
export type JournalRetireIntentWire = {
  scope: JournalAdminScope
  entryId: string
  txId: string
  journalSha256: string
  note: string
  liveStateChecked: true
  casMarkRemovalAcknowledged: true
}

export type JournalRetireResult =
  | { ok: true; entryId: string; txId: string; movedTo: string; receiptPath: string; markDigestCount: number; stagingPresent: boolean; recoveryOutcome: string }
  | { ok: false; reason: string }
