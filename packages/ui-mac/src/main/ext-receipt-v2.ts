// InstallRecordV2 (receipt v2) — REQ-099 Phase 1 / ADR-028 §4/§5.
//
// Storage: the SAME `<root>/installs.json` as the v1 ledger (alpha-installs.ts), upgraded to a
// dual-format file `{ v: 2, receipts: InstallReceipt[], records: InstallRecordV2[] }`:
//   · records[]  — the v2 truth (environment / scope identity / digests / generation chain /
//                  desired state / transaction seam);
//   · receipts[] — the v1-compatible view, kept in lockstep for the SAME (kind, name) so a
//                  rolled-back (older) build still sees every install (AC#6: upgrade & rollback
//                  lose nothing). alpha-installs.writeLedger carries records[] through opaquely.
//
// v1 compat policy (explicit, AC#6): v1-only receipts stay readable and operable (read-only
// compat — paths re-derived by kind+name exactly as today); migrateV1Ledger() converts them to
// records (generation 1, `migratedFrom: "v1"`, digest fields honestly absent, project identity
// bound to the CURRENT project root — the ledger physically lives inside it).
//
// Scope closure (ADR-028 §5, fail-closed): project records carry the install-time realpath +
// sha256 identity. Operations on project scope must re-derive the current realpath and match —
// a moved/renamed/symlink-swapped project or a corrupt record REFUSES the operation with a
// locatable reason; it never degrades to a global uninstall.
//
// Pure fs module: no electron, no logging imports (repo test discipline) — warnings are returned.

import * as fs from "node:fs"
import * as path from "node:path"
import type { InstallReceipt, InstallReceiptOrigin, InstallReceiptType } from "../preload/types"
import type { AppEnvironment } from "./alpha-environment"
import { canonicalJson, sha256Hex } from "./ext-manifest-v2"
import { validateReceipt } from "./alpha-installs"
import { writeFileAtomicSync } from "./ext-atomic-fs"

export const RECORD_SCHEMA_VERSION = 2 as const

export type ScopeIdentity =
  | { kind: "global" }
  | { kind: "project"; projectPath: string; projectPathHash: string }

export type DesiredState = "enabled" | "disabled"
export type TransactionState = "committed" | "pending" | "rolled-back"

export interface InstallRecordV2 {
  schemaVersion: typeof RECORD_SCHEMA_VERSION
  /** catalog entry id or `user:<name>`(未策展来源恒 user: 前缀,不可自称 catalog)。 */
  id: string
  name: string
  kind: InstallReceiptType
  /** REQ-098 环境(main 真源;renderer 零输入)。 */
  environment: AppEnvironment
  scope: ScopeIdentity
  version?: string
  /** 合成 ManifestV2 的 canonical digest(不进 manifest 本体);v1 迁移件如实缺省。 */
  manifestDigest?: string
  /** 字节负载聚合 digest(aggregateFilesDigest)。信任语义随来源:remote = 已验 catalog 清单聚合;
   *  builtin(REQ-098 #303 起)= 摄取时自算内容地址(一致性标识,不是独立上游真实性证明,该证明
   *  由 app 包签名承担);npm 负载由 npm 通道背书,如实缺省。digest 本身不编码来源 —— 消费方不得
   *  从有无/取值推断信任级别。 */
  payloadDigest?: string
  /** grant 键集 digest(secret 变量名/env 键/workspace 有无 —— 绝不含值)。 */
  grantDigest?: string
  /** REQ-101 signed channel metadata 预留。 */
  channelSequence?: number
  desiredState: DesiredState
  /** 单调递增代数;previousDigest 指上一代 manifestDigest,成链。 */
  generation: number
  previousDigest?: string
  origin: InstallReceiptOrigin
  /** 对账参考;卸载路径一律从受控根 + kind + name 重新派生,绝不以此为删除依据。 */
  files?: string[]
  configKey?: string
  /** REQ-100 事务接缝的落账位(本 REQ 内恒 committed;staging/rollback 机器归 REQ-100)。 */
  transaction?: { id: string; state: TransactionState }
  installedAt: string
  updatedAt?: string
  migratedFrom?: "v1"
}

const LEDGER_FILE = "installs.json"
const KINDS = new Set<string>(["mcp", "skill", "agent", "command", "plugin", "bundle", "cloud"])
const ORIGINS = new Set<string>(["catalog", "created", "imported", "imported-claude", "imported-agents"])
const ENVIRONMENTS = new Set<string>(["prod", "beta", "dev"])
const DESIRED = new Set<string>(["enabled", "disabled"])
const TX_STATES = new Set<string>(["committed", "pending", "rolled-back"])
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/

const RECORD_KEYS = new Set([
  "schemaVersion",
  "id",
  "name",
  "kind",
  "environment",
  "scope",
  "version",
  "manifestDigest",
  "payloadDigest",
  "grantDigest",
  "channelSequence",
  "desiredState",
  "generation",
  "previousDigest",
  "origin",
  "files",
  "configKey",
  "transaction",
  "installedAt",
  "updatedAt",
  "migratedFrom",
])
const SCOPE_KEYS_GLOBAL = new Set(["kind"])
const SCOPE_KEYS_PROJECT = new Set(["kind", "projectPath", "projectPathHash"])
const TX_KEYS = new Set(["id", "state"])

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

export type RecordDecode = { ok: true; record: InstallRecordV2 } | { ok: false; errors: string[] }

/** STRICT record decoder — 未知键/未知版本 loud 拒绝;损坏 record 不可被操作(fail closed)。 */
export function decodeRecordV2(input: unknown): RecordDecode {
  const errors: string[] = []
  if (!isObj(input)) return { ok: false, errors: ["record: must be an object"] }
  if (input.schemaVersion !== RECORD_SCHEMA_VERSION) {
    return { ok: false, errors: [`record.schemaVersion: unsupported version ${JSON.stringify(input.schemaVersion)} — this build only decodes ${RECORD_SCHEMA_VERSION}`] }
  }
  for (const key of Object.keys(input)) {
    if (!RECORD_KEYS.has(key)) errors.push(`record: unknown key "${key}" — refused (strict schema)`)
  }
  const str = (v: unknown, at: string, required: boolean, re?: RegExp): string | undefined => {
    if (v === undefined) {
      if (required) errors.push(`${at}: required`)
      return undefined
    }
    if (typeof v !== "string" || v.length === 0 || v.length > 512) {
      errors.push(`${at}: must be a non-empty string`)
      return undefined
    }
    if (re && !re.test(v)) {
      errors.push(`${at}: invalid format`)
      return undefined
    }
    return v
  }
  const id = str(input.id, "record.id", true)
  const name = str(input.name, "record.name", true, SAFE_NAME)
  const kind = str(input.kind, "record.kind", true)
  if (kind && !KINDS.has(kind)) errors.push(`record.kind: "${kind}" not a known kind`)
  const environment = str(input.environment, "record.environment", true)
  if (environment && !ENVIRONMENTS.has(environment)) errors.push(`record.environment: "${environment}" not a known environment`)

  let scope: ScopeIdentity | undefined
  if (!isObj(input.scope)) {
    errors.push("record.scope: required object")
  } else if (input.scope.kind === "global") {
    for (const key of Object.keys(input.scope)) if (!SCOPE_KEYS_GLOBAL.has(key)) errors.push(`record.scope: unknown key "${key}"`)
    scope = { kind: "global" }
  } else if (input.scope.kind === "project") {
    for (const key of Object.keys(input.scope)) if (!SCOPE_KEYS_PROJECT.has(key)) errors.push(`record.scope: unknown key "${key}"`)
    const projectPath = str(input.scope.projectPath, "record.scope.projectPath", true)
    const projectPathHash = str(input.scope.projectPathHash, "record.scope.projectPathHash", true, /^[0-9a-f]{64}$/)
    if (projectPath && !path.isAbsolute(projectPath)) errors.push("record.scope.projectPath: must be absolute")
    if (projectPath && projectPathHash && path.isAbsolute(projectPath)) scope = { kind: "project", projectPath, projectPathHash }
  } else {
    errors.push(`record.scope.kind: ${JSON.stringify(input.scope.kind)} not "global" | "project"`)
  }

  const version = str(input.version, "record.version", false)
  const manifestDigest = str(input.manifestDigest, "record.manifestDigest", false, DIGEST_RE)
  const payloadDigest = str(input.payloadDigest, "record.payloadDigest", false, DIGEST_RE)
  const grantDigest = str(input.grantDigest, "record.grantDigest", false, DIGEST_RE)
  if (input.channelSequence !== undefined && (typeof input.channelSequence !== "number" || !Number.isInteger(input.channelSequence) || input.channelSequence < 0))
    errors.push("record.channelSequence: must be a non-negative integer")
  const desiredState = str(input.desiredState, "record.desiredState", true)
  if (desiredState && !DESIRED.has(desiredState)) errors.push(`record.desiredState: "${desiredState}" not enabled|disabled`)
  if (typeof input.generation !== "number" || !Number.isInteger(input.generation) || input.generation < 1)
    errors.push("record.generation: must be an integer ≥ 1")
  const previousDigest = str(input.previousDigest, "record.previousDigest", false, DIGEST_RE)
  const origin = str(input.origin, "record.origin", true)
  if (origin && !ORIGINS.has(origin)) errors.push(`record.origin: "${origin}" not a known origin`)
  if (input.files !== undefined) {
    if (!Array.isArray(input.files) || input.files.some((f) => typeof f !== "string" || !path.isAbsolute(f)))
      errors.push("record.files: must be an array of absolute paths")
  }
  const configKey = str(input.configKey, "record.configKey", false)
  let transaction: { id: string; state: TransactionState } | undefined
  if (input.transaction !== undefined) {
    if (!isObj(input.transaction)) {
      errors.push("record.transaction: must be an object")
    } else {
      for (const key of Object.keys(input.transaction)) if (!TX_KEYS.has(key)) errors.push(`record.transaction: unknown key "${key}"`)
      const txId = str(input.transaction.id, "record.transaction.id", true)
      const txState = str(input.transaction.state, "record.transaction.state", true)
      if (txState && !TX_STATES.has(txState)) errors.push(`record.transaction.state: "${txState}" not a known state`)
      if (txId && txState && TX_STATES.has(txState)) transaction = { id: txId, state: txState as TransactionState }
    }
  }
  const installedAt = str(input.installedAt, "record.installedAt", true)
  if (installedAt && Number.isNaN(Date.parse(installedAt))) errors.push("record.installedAt: not a parseable timestamp")
  const updatedAt = str(input.updatedAt, "record.updatedAt", false)
  if (updatedAt && Number.isNaN(Date.parse(updatedAt))) errors.push("record.updatedAt: not a parseable timestamp")
  if (input.migratedFrom !== undefined && input.migratedFrom !== "v1") errors.push('record.migratedFrom: only "v1" is known')

  // REQ-099 #306:catalog 语义防混用(durable 不变量 —— 读与 upsert 全走本 decoder,一处兜底):
  // 非 catalog 来源:id 恒 "user:<name>",不得携带任何供给链字段(digest 族/channelSequence);
  // catalog 来源:id 必须带与 kind 匹配的保留前缀;command 不是 ManifestV2 kind,禁 catalog 来源。
  if (id && name && kind && KINDS.has(kind) && origin && ORIGINS.has(origin)) {
    if (origin === "catalog") {
      if (kind === "command") errors.push('record.origin: "catalog" not allowed for kind "command" (not a ManifestV2 kind)')
      else if (!id.startsWith(`${kind}:`)) errors.push(`record.id: catalog-origin record requires the reserved "${kind}:" prefix — got "${id}"`)
    } else {
      if (id !== `user:${name}`) errors.push(`record.id: non-catalog origin requires "user:${name}" — got "${id}" (catalog identity is not forgeable)`)
      if (manifestDigest || payloadDigest || grantDigest || previousDigest)
        errors.push("record: non-catalog origin must not carry supply-chain digests (manifest/payload/grant/previousDigest)")
      if (input.channelSequence !== undefined) errors.push("record.channelSequence: catalog-only field — refused for non-catalog origin")
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    record: {
      schemaVersion: RECORD_SCHEMA_VERSION,
      id: id!,
      name: name!,
      kind: kind as InstallReceiptType,
      environment: environment as AppEnvironment,
      scope: scope!,
      ...(version ? { version } : {}),
      ...(manifestDigest ? { manifestDigest } : {}),
      ...(payloadDigest ? { payloadDigest } : {}),
      ...(grantDigest ? { grantDigest } : {}),
      ...(typeof input.channelSequence === "number" ? { channelSequence: input.channelSequence } : {}),
      desiredState: desiredState as DesiredState,
      generation: input.generation as number,
      ...(previousDigest ? { previousDigest } : {}),
      origin: origin as InstallReceiptOrigin,
      ...(Array.isArray(input.files) ? { files: input.files as string[] } : {}),
      ...(configKey ? { configKey } : {}),
      ...(transaction ? { transaction } : {}),
      installedAt: installedAt!,
      ...(updatedAt ? { updatedAt } : {}),
      ...(input.migratedFrom === "v1" ? { migratedFrom: "v1" as const } : {}),
    },
  }
}

// ── scope identity(fail-closed)────────────────────────────────────────────────────────────────

/** 计算项目 scope identity:realpath(符号链接归一)+ NFC 归一后的 sha256。目录不存在/不可达 → 拒绝。 */
export function projectScopeIdentity(projectDir: string): { ok: true; scope: Extract<ScopeIdentity, { kind: "project" }> } | { ok: false; reason: string } {
  if (typeof projectDir !== "string" || !path.isAbsolute(projectDir)) return { ok: false, reason: "invalid project directory" }
  let real: string
  try {
    real = fs.realpathSync(projectDir)
    if (!fs.statSync(real).isDirectory()) return { ok: false, reason: "project directory is not a directory" }
  } catch {
    return { ok: false, reason: `project directory unreachable: ${projectDir}` }
  }
  return { ok: true, scope: { kind: "project", projectPath: real, projectPathHash: sha256Hex(real.normalize("NFC")) } }
}

/**
 * Fail-closed project identity check (AC#4): the current directory's identity must equal the
 * record's install-time identity. Moved/renamed project, symlink swap or unreachable dir all
 * REFUSE — the caller must never fall back to global scope.
 */
export function verifyProjectScope(record: InstallRecordV2, projectDir: string): { ok: true } | { ok: false; reason: string } {
  if (record.scope.kind !== "project") return { ok: false, reason: "record is not project-scoped" }
  const current = projectScopeIdentity(projectDir)
  if (!current.ok) return { ok: false, reason: `fail closed: ${current.reason}` }
  if (current.scope.projectPathHash !== record.scope.projectPathHash) {
    return {
      ok: false,
      reason: `fail closed: project identity mismatch — record was installed at "${record.scope.projectPath}", current is "${current.scope.projectPath}" (moved/renamed project?); refusing, NOT falling back to global`,
    }
  }
  return { ok: true }
}

// ── ledger IO(与 v1 同文件,双视图同步)────────────────────────────────────────────────────────

export type LedgerV2Read = {
  records: InstallRecordV2[]
  /** v1-only 存量(有 receipt 无 record)—— 只读兼容面。 */
  v1Only: InstallReceipt[]
  warnings: string[]
  /** Codex(增量 r13)Blocker:有 record 因损坏/重复/混合归属被**排除**(corruptKeys 非空或 unattributable
   *  或文件级 corrupt)。这些被排除的记录里可能有 disabled mcp/agent —— 它们不进 records、injection 拿不到、
   *  boot 投影也看不到 → disable 无从执行。调用方(boot)据此 fail-closed 阻断 sidecar。 */
  hasExcludedRecords: boolean
}

const ledgerPath = (root: string) => path.join(root, LEDGER_FILE)
const key = (kind: string, name: string) => `${kind}:${name}`

/** 损坏(解码失败)v2 record 的按 key 归属尝试。`corruptKeys` 收集能可靠提取 `kind:name` 的损坏项;
 *  `unattributable` = 至少一条损坏 record 连安全的 kind/name 都提不出 —— 无法证明卸载目标不是它,
 *  因此该账本内所有 v1 fallback 都必须拒绝(REQ-099 #256 fail-closed)。 */
type CorruptRecords = { corruptKeys: Set<string>; unattributable: boolean }

type ParsedLedger = {
  receipts: InstallReceipt[]
  records: InstallRecordV2[]
  recordWarnings: string[]
  receiptWarnings: string[]
  corruptRecords: CorruptRecords
  /** #378 r17(Blocker):解码失败条目的**原文保全** —— 重建写盘时必须原样带回,否则任何一次
   *  合法 upsert/remove 都会静默抹掉损坏记录及其所有权证据(不可逆数据丢失)。损坏 key 的
   *  操作仍被各闸拒绝;保全只保证证据不因无关写入蒸发。 */
  rawInvalidReceipts: unknown[]
  rawCorruptRecords: unknown[]
}

/** 从损坏 record 原始对象里独立提取 kind:name(不经严格 decoder)。两者都是合法字符串且 kind 已知
 *  才算可归属;否则返回 null(该损坏项无法安全归属到某个 key)。 */
function attemptCorruptKey(entry: unknown): string | null {
  if (!isObj(entry)) return null
  const rawKind = entry.kind
  const rawName = entry.name
  if (typeof rawKind !== "string" || !KINDS.has(rawKind)) return null
  if (typeof rawName !== "string" || rawName.length === 0 || rawName.length > 512 || !SAFE_NAME.test(rawName)) return null
  return key(rawKind, rawName)
}

/** #354(review 收敛):提交面**写前**账本健康探测 —— 损坏/不可读账本直接拒绝且原文件不动
 *  (不给 upsert 的 quarantine 触发机会;Codex 裁决必改 5 的拒绝分支)。由此健康账本 + 原子写
 *  失败 = 磁盘零变化,提交面无需整文件恢复 —— 恢复步骤本身才是跨进程竞态(捕获与失败恢复之间
 *  他写方的提交被覆盖)与「恢复后补偿再改账」的来源。缺失 = 合法空账。 */
export function probeLedgerForWrite(root: string): { ok: true } | { ok: false; reason: string } {
  let text: string
  try {
    text = fs.readFileSync(ledgerPath(root), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true }
    return {
      ok: false,
      reason: `install ledger unreadable (${error instanceof Error ? error.message : String(error)}) — refusing before any side effect`,
    }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, reason: `install ledger corrupt — refusing to write (quarantine is not a commit path); inspect ${ledgerPath(root)}` }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { ok: false, reason: `install ledger corrupt (non-object root) — refusing to write; inspect ${ledgerPath(root)}` }
  // r22 Major:提交面同样收信封 —— 未来版本拒写(读不懂的数据不得重建);records/receipts
  // 非数组 = 损坏,拒(quarantine 不是提交路径)。
  if ("v" in raw && raw.v !== undefined && raw.v !== 1 && raw.v !== 2) {
    const vLabel = typeof raw.v === "number" || typeof raw.v === "string" ? raw.v : "unknown"
    return { ok: false, reason: `install ledger envelope version ${vLabel} is newer than this build understands — refusing to write; inspect ${ledgerPath(root)}` }
  }
  if (("records" in raw && raw.records !== undefined && !Array.isArray(raw.records)) || ("receipts" in raw && raw.receipts !== undefined && !Array.isArray(raw.receipts)))
    return { ok: false, reason: `install ledger corrupt (non-array records/receipts) — refusing to write; inspect ${ledgerPath(root)}` }
  return { ok: true }
}

/** r19 Major:readError = 文件在场但读失败(EIO/EACCES 等瞬时故障)—— 绝不折叠成「健康空账」,
 *  否则 removeRecordV2 会 no-op 成功、卸载在记录仍在的情况下谎报完成。缺席(ENOENT/ENOTDIR)
 *  才是合法空账。 */
function parseLedger(root: string): { parsed: ParsedLedger; corrupt: boolean; readError?: string } {
  const empty: ParsedLedger = {
    receipts: [],
    records: [],
    recordWarnings: [],
    receiptWarnings: [],
    corruptRecords: { corruptKeys: new Set(), unattributable: false },
    rawInvalidReceipts: [],
    rawCorruptRecords: [],
  }
  let text: string
  try {
    text = fs.readFileSync(ledgerPath(root), "utf8")
  } catch (error) {
    const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null
    if (code === "ENOENT" || code === "ENOTDIR") return { parsed: empty, corrupt: false }
    return { parsed: empty, corrupt: false, readError: `install ledger unreadable (${error instanceof Error ? error.message : String(error)}): ${ledgerPath(root)}` }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { parsed: empty, corrupt: true }
  }
  if (!isObj(raw)) return { parsed: empty, corrupt: true }
  // r22 Major:信封收口 —— 未来版本信封(v 非 1/2)拒触碰(不是损坏,是本构建读不懂的数据,
  // 重建 = 摧毁);records/receipts 非数组不得折叠成「空」(下一次 upsert 整文件重建会连同
  // 所有权证据一起抹掉)—— 按损坏文件处理(写路径 quarantine 保字节 + 响亮警告)。
  if (raw.v !== undefined && raw.v !== 1 && raw.v !== 2) {
    const vLabel = typeof raw.v === "number" || typeof raw.v === "string" ? raw.v : "unknown"
    return { parsed: empty, corrupt: false, readError: `install ledger envelope version ${vLabel} is newer than this build understands — refusing to touch it: ${ledgerPath(root)}` }
  }
  if ((raw.records !== undefined && !Array.isArray(raw.records)) || (raw.receipts !== undefined && !Array.isArray(raw.receipts)))
    return { parsed: empty, corrupt: true }
  const receipts: InstallReceipt[] = []
  const receiptWarnings: string[] = []
  const rawInvalidReceipts: unknown[] = []
  if (Array.isArray(raw.receipts)) {
    for (const entry of raw.receipts) {
      if (validateReceipt(entry as InstallReceipt) === null) receipts.push(entry as InstallReceipt)
      else {
        receiptWarnings.push(`invalid v1 receipt ignored in ${ledgerPath(root)}`)
        rawInvalidReceipts.push(entry)
      }
    }
  }
  let records: InstallRecordV2[] = []
  const recordWarnings: string[] = []
  const rawCorruptRecords: unknown[] = []
  const corruptKeys = new Set<string>()
  let unattributable = false
  if (Array.isArray(raw.records)) {
    // 先按 key 分组已解码记录 + 保留其原始条目(重复检测后可整组转损坏,原文保全)。
    const decodedByKey = new Map<string, Array<{ record: InstallRecordV2; raw: unknown }>>()
    for (const entry of raw.records) {
      const decoded = decodeRecordV2(entry)
      if (decoded.ok) {
        const k = key(decoded.record.kind, decoded.record.name)
        const arr = decodedByKey.get(k) ?? []
        arr.push({ record: decoded.record, raw: entry })
        decodedByKey.set(k, arr)
        continue
      }
      recordWarnings.push(`corrupt v2 record excluded (fail closed — not operable) in ${ledgerPath(root)}: ${decoded.errors[0]}`)
      rawCorruptRecords.push(entry)
      const attributed = attemptCorruptKey(entry)
      if (attributed) corruptKeys.add(attributed)
      else unattributable = true
    }
    // Codex r11 Major:同 (kind,name) 有多条**均可解码**的记录 = 语义冲突(enable/disable 含义不明,
    // 派生允许集的 any-enabled 会误注入)—— **整组 fail-closed**:排除全部、标 corruptKey(下游 set-state/
    // uninstall/skills 派生一律拒该 key),原文保全供取证。
    for (const [k, group] of decodedByKey) {
      if (group.length > 1) {
        corruptKeys.add(k)
        for (const g of group) rawCorruptRecords.push(g.raw)
        recordWarnings.push(`conflicting duplicate v2 records for ${k} (${group.length}) excluded (fail closed) in ${ledgerPath(root)}`)
        continue
      }
      records.push(group[0].record)
    }
    // Codex r12 B3:一条有效 + 一条同 key 损坏 = 归属歧义 —— 有效那条也 fail-closed 排除(否则读侧/注入
    // 仍信它)。损坏兄弟已在上方把 key 加进 corruptKeys;此处把这些 key 的有效记录一并剔出 records。
    if (corruptKeys.size > 0) records = records.filter((r) => !corruptKeys.has(key(r.kind, r.name)))
  }
  // r18:字节级证据侧写 —— 结构保全经 JSON.parse→stringify 会丢重复键/原始词法;首次观测到
  // 损坏条目即把**原文件字节**按损坏集哈希落 `installs.json.evidence-<hex12>`(同一损坏集只落
  // 一份,后续重写不再增殖),取证不依赖工作文件。尽力而为:失败不阻塞(结构保全兜底)。
  if (rawCorruptRecords.length > 0 || rawInvalidReceipts.length > 0) {
    try {
      const setDigest = sha256Hex(Buffer.from(JSON.stringify({ rawCorruptRecords, rawInvalidReceipts }), "utf8")).slice(0, 12)
      const evidence = `${ledgerPath(root)}.evidence-${setDigest}`
      if (!fs.existsSync(evidence)) fs.writeFileSync(evidence, text, { flag: "wx" })
    } catch {
      /* 证据侧写尽力而为 */
    }
  }
  return {
    parsed: { receipts, records, recordWarnings, receiptWarnings, corruptRecords: { corruptKeys, unattributable }, rawInvalidReceipts, rawCorruptRecords },
    corrupt: false,
  }
}

function quarantineCorrupt(root: string): string | null {
  const file = ledgerPath(root)
  const quarantined = `${file}.corrupt-${Date.now()}`
  try {
    fs.renameSync(file, quarantined)
    return quarantined
  } catch {
    return null
  }
}

// ── #395 步骤5:skills「enabled 允许集」派生文件(hook 只读此文件,不再镜像 decoder)────────────

const SKILLS_ENABLED_FILE = "skills-enabled.json"

/** `<root>/skills-enabled.json` —— main 用真 decodeRecordV2 派生的 skill 允许集;
 *  @alpha-code/ext 的注入门只读此文件(缺失/损坏 = fail-closed 不注入)。 */
export function skillsEnabledPath(root: string): string {
  return path.join(root, SKILLS_ENABLED_FILE)
}

/** 从 raw records(含损坏保全条目)派生 enabled skill 允许集 —— **真 decoder** 判定:
 *  损坏/畸形记录解码失败自然排除,与主进程一切读侧同强度(未知键/digest/id 前缀等不变量全覆盖)。 */
function enabledSkillKeysFromRecords(records: readonly unknown[]): string[] {
  const keys = new Set<string>()
  for (const r of records) {
    const d = decodeRecordV2(r)
    if (d.ok && d.record.kind === "skill" && d.record.desiredState === "enabled") keys.add(`skill--${d.record.name}`)
  }
  return [...keys].sort()
}

function isAbsenceCode(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException)?.code
  return code === "ENOENT" || code === "ENOTDIR"
}

function readDerivationKeys(file: string): string[] | "absent" | "unknown" {
  let text: string
  try {
    text = fs.readFileSync(file, "utf8")
  } catch (e) {
    return isAbsenceCode(e) ? "absent" : "unknown"
  }
  try {
    const parsed = JSON.parse(text) as { v?: unknown; keys?: unknown } | null
    if (!parsed || typeof parsed !== "object" || parsed.v !== 1 || !Array.isArray(parsed.keys)) return "unknown"
    return parsed.keys.filter((k): k is string => typeof k === "string")
  } catch {
    return "unknown"
  }
}

const derivationTextOf = (keys: readonly string[]): string => JSON.stringify({ v: 1, keys }, null, 2) + "\n"

export type SkillsDerivationOutcome =
  | { ok: true }
  /** staleAllowList = 无法证明陈旧允许集已收窄(可能仍列已禁 skill)→ 调用方须 fail-closed。 */
  | { ok: false; reason: string; staleAllowList?: boolean }

/** #395 步骤5(boot 自愈,调用方持 bundle 锁):从账本重算 skills 派生允许集(`writeFileAtomicSync`
 *  单次原子写 = 掉电 durability + 完整写循环 + 目录 fsync)。账本文件级损坏/读错误 → 删派生文件
 *  (缺失 = hook fail-closed 不注入);删不掉陈旧允许集 = 可能仍列已禁 skill → staleAllowList。
 *  健康 → 原子重写(升级首启 backfill / 扩容失败残留收敛);写失败 = 旧派生可能过度授权 →
 *  staleAllowList。 */
export function reconcileSkillsDerivation(root: string): SkillsDerivationOutcome {
  const { parsed, corrupt, readError } = parseLedger(root)
  const file = skillsEnabledPath(root)
  if (corrupt || readError) {
    try {
      fs.unlinkSync(file)
    } catch (e) {
      if (!isAbsenceCode(e))
        return {
          ok: false,
          reason: `ledger unusable and stale skills allow-list could not be removed: ${e instanceof Error ? e.message : String(e)}`,
          staleAllowList: true,
        }
    }
    return { ok: true }
  }
  try {
    // Codex r12 B3:只喂**干净 records**(parsed.records 已排除损坏/重复 key);rawCorruptRecords 含能
    // 解码的重复条目,若重新解码会把已 fail-closed 的 skill 重新放进允许集 —— 绝不喂。
    const keys = enabledSkillKeysFromRecords(parsed.records)
    writeFileAtomicSync(file, derivationTextOf(keys))
    return { ok: true }
  } catch (error) {
    // 写失败 = 旧派生原样保留,可能列出已在账本禁用的 skill(过度授权)→ fail-closed。
    return { ok: false, reason: `skills allow-list write failed: ${error instanceof Error ? error.message : String(error)}`, staleAllowList: true }
  }
}

/** r17(Blocker):receipts/records 接受 unknown —— 重建视图必须能原样携带解码失败条目
 *  (rawInvalidReceipts/rawCorruptRecords),序列化本就与类型无关。
 *  #395 步骤5+6:skills 派生允许集与账本**锁步**,`writeFileAtomicSync` 原子写(掉电 durability +
 *  完整写循环,杜绝短写截断)。**方向排序(Codex r6 B4 修正)**:任何**移除**(收窄)必须在账本写
 *  之前落盘 —— 引擎绝不得看到已撤销的允许项;派生损坏(unknown)先写**空集**(最严格)。**新增**
 *  (扩容)必须在账本写之后 best-effort 发布 —— 账本授权在先才允许 hook 加载。pre-shrink 失败 =
 *  账本未写(回到起点,安全,ok:false);final publish 失败 = 账本已 durable + 派生停在更严格态
 *  (skill 少注入 = 安全侧,boot 自愈补齐,ok:true + loud)。 */
function writeLedgerFile(root: string, receipts: readonly unknown[], records: readonly unknown[]): { ok: true } | { ok: false; reason: string } {
  try {
    fs.mkdirSync(root, { recursive: true })
    const file = ledgerPath(root)
    const derivationFile = skillsEnabledPath(root)
    const nextKeys = enabledSkillKeysFromRecords(records)
    const cur = readDerivationKeys(derivationFile)
    // 收窄先行:算出「账本写之前必须落盘的更严格允许集」。
    //   · unknown(派生损坏)→ 空集(无从算交集,最严格 fail-closed)。
    //   · array 且有键将被移除 → current ∩ next(只留仍授权的,移除立即生效)。
    //   · absent / array 无移除 → 无需 pre-write。
    let preKeys: string[] | null = null
    if (cur === "unknown") preKeys = []
    else if (Array.isArray(cur)) {
      const intersection = cur.filter((k) => nextKeys.includes(k))
      if (intersection.length !== cur.length) preKeys = intersection
    }
    if (preKeys !== null) {
      try {
        writeFileAtomicSync(derivationFile, derivationTextOf(preKeys))
      } catch (error) {
        // 账本尚未写 → 回到起点(旧账本 + 旧派生一致),安全 fail-closed,用户/调用方可重试。
        return { ok: false, reason: `refusing ledger write: could not shrink skills allow-list first (a stale entry may still enable a disabled skill): ${error instanceof Error ? error.message : String(error)}` }
      }
    }
    writeFileAtomicSync(file, JSON.stringify({ v: 2, receipts, records }, null, 2) + "\n") // 账本 durable
    // 完整 next 发布(新增在账本之后):absent 首建、pre 后补新增、纯扩容都需要;已相等则跳过。
    const alreadyFinal = preKeys === null && Array.isArray(cur) && cur.length === nextKeys.length && cur.every((k) => nextKeys.includes(k))
    if (!alreadyFinal) {
      try {
        writeFileAtomicSync(derivationFile, derivationTextOf(nextKeys))
      } catch (error) {
        // 派生停在更严格态(空集 / 交集 / 旧集去掉移除项)= skill 少注入 = 安全侧;账本已 durable,
        // 下次 boot reconcile 按账本重算补齐。不让整体失败(账本才是真源)。
        console.error(`[req395] skills allow-list final publish failed (stays stricter, boot self-heals): ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "failed to write ledger" }
  }
}

/** Read the dual ledger. Corrupt FILE → empty + warning(写路径会 quarantine);corrupt record → excluded + warning。 */
export function readLedgerV2(root: string): LedgerV2Read {
  const { parsed, corrupt, readError } = parseLedger(root)
  const warnings = [...(readError ? [readError] : []), ...parsed.recordWarnings, ...parsed.receiptWarnings]
  if (corrupt) warnings.push(`installs.json unreadable: ${ledgerPath(root)}`)
  const recordKeys = new Set(parsed.records.map((r) => key(r.kind, r.name)))
  const v1Only = parsed.receipts.filter((r) => !recordKeys.has(key(r.type, r.name)))
  const hasExcludedRecords = corrupt || !!readError || parsed.corruptRecords.corruptKeys.size > 0 || parsed.corruptRecords.unattributable
  return { records: parsed.records, v1Only, warnings, hasExcludedRecords }
}

export function findRecordV2(root: string, kind: InstallReceiptType, name: string): InstallRecordV2 | null {
  const { records } = readLedgerV2(root)
  return records.find((r) => r.kind === kind && r.name === name) ?? null
}

/** 卸载前的单次解析、单次决策查询。REQ-099 #256:损坏 v2 record 绝不静默回退同账本 v1 receipt。
 *  - `valid`  该 key 有合法 v2 record → 按 record 卸载
 *  - `v1`     真正 v1-only(无配套 v2 record,且账本无归属歧义)→ 兼容卸载
 *  - `corrupt-match`  该 key 有损坏 v2 record 被排除 → 拒绝(禁止回退 v1)
 *  - `ledger-corrupt` 账本文件级损坏 / 存在不可归属的损坏 record → 拒绝该账本全部 v1 fallback
 *  - `absent` 该 key 无任何记录 */
export type UninstallLookup =
  | { status: "valid"; record: InstallRecordV2 }
  | { status: "v1"; receipt: InstallReceipt }
  | { status: "corrupt-match"; reason: string }
  | { status: "ledger-corrupt"; reason: string }
  | { status: "absent" }

export function lookupForUninstall(root: string, kind: InstallReceiptType, name: string): UninstallLookup {
  const { parsed, corrupt, readError } = parseLedger(root)
  if (readError) return { status: "ledger-corrupt", reason: readError }
  if (corrupt) return { status: "ledger-corrupt", reason: `installs.json unreadable: ${ledgerPath(root)}` }
  const k = key(kind, name)
  const record = parsed.records.find((r) => r.kind === kind && r.name === name)
  if (record) return { status: "valid", record }
  // 该 key 恰有损坏 v2 record 被排除 → 精确阻断,禁止回退 v1(损坏账本可诱导按错误字段删文件)。
  if (parsed.corruptRecords.corruptKeys.has(k))
    return { status: "corrupt-match", reason: `refusing uninstall: v2 record for ${k} is corrupt (fail closed — will not fall back to v1 receipt)` }
  // 账本里有连 key 都提不出的损坏 record → 无法证明目标不是它 → 阻断该账本所有 v1 fallback。
  if (parsed.corruptRecords.unattributable)
    return { status: "ledger-corrupt", reason: `refusing uninstall: ledger contains an unattributable corrupt v2 record (fail closed — no v1 fallback)` }
  const recordKeys = new Set(parsed.records.map((r) => key(r.kind, r.name)))
  const receipt = parsed.receipts.find((r) => r.type === kind && r.name === name && !recordKeys.has(key(r.type, r.name)))
  if (receipt) return { status: "v1", receipt }
  return { status: "absent" }
}

/** v2 record → v1 兼容 receipt(回滚可读视图;字段有损但 v1 语义完整)。 */
export function toV1Receipt(record: InstallRecordV2): InstallReceipt {
  return {
    id: record.id,
    name: record.name,
    type: record.kind,
    scope: record.scope.kind,
    ...(record.version ? { version: record.version } : {}),
    installedAt: record.installedAt,
    origin: record.origin,
    ...(record.files ? { files: record.files } : {}),
    ...(record.configKey ? { configKey: record.configKey } : {}),
  }
}

export type UpsertInput = Omit<InstallRecordV2, "schemaVersion" | "generation" | "previousDigest"> & {
  generation?: number
  previousDigest?: string
}

export type LedgerV2Write = { ok: true; record: InstallRecordV2; warnings: string[] } | { ok: false; reason: string }

/** #352(Codex 裁决必改 4):transaction exact-replay 幂等 —— 崩溃恢复会重放 commitReceipt,
 *  同 transaction.id 且**身份事实**一致时必须直接返回已有记录(绝不递增 generation/previous 链);
 *  同 id 但身份事实冲突 = txId 重用,显式拒绝(重用是伪造面)。非重放(无 prev / 无 txId / id 不同)
 *  返回 fresh 走正常新写。
 *  比较基准 = 「按 prev 的 generation/previousDigest 对齐后本会写出的记录」与 prev 的 canonical
 *  等值,**剔除可变归属字段 desiredState/updatedAt**(review #381:receipt 落盘后、journal 终态前,
 *  用户合法的启停/更新戳写方可以改这两个字段 —— 把它们算进冲突会让恢复前滚误判、事务回滚终态化,
 *  config/账本永久分叉;重放返回 prev 原样,后到的合法变更得以保留)。 */
function replayVerdict(
  prev: InstallRecordV2 | null,
  input: UpsertInput,
): { kind: "fresh" } | { kind: "replay"; record: InstallRecordV2 } | { kind: "conflict"; reason: string } {
  const txId = input.transaction?.id
  if (!prev || !txId || prev.transaction?.id !== txId) return { kind: "fresh" }
  const identity = (r: Record<string, unknown>): string => {
    const clone: Record<string, unknown> = { ...r }
    delete clone.desiredState
    delete clone.updatedAt
    return canonicalJson(clone)
  }
  const candidate = {
    ...input,
    schemaVersion: RECORD_SCHEMA_VERSION,
    generation: prev.generation,
    ...(prev.previousDigest ? { previousDigest: prev.previousDigest } : {}),
  }
  if (!prev.previousDigest) delete (candidate as { previousDigest?: string }).previousDigest
  if (identity(candidate) === identity(prev as unknown as Record<string, unknown>)) return { kind: "replay", record: prev }
  return {
    kind: "conflict",
    reason: `transaction id ${txId} reused for ${key(input.kind, input.name)} with conflicting facts — refusing (exact replay only)`,
  }
}

/**
 * Upsert by (kind, name): generation/previousDigest chain computed from the existing record
 * (a v1-only predecessor counts as generation 1 → new record is generation 2, `migratedFrom` noted
 * by the caller if desired). Writes BOTH views in lockstep for this key; other entries untouched.
 */
export function upsertRecordV2(root: string, input: UpsertInput): LedgerV2Write {
  const { parsed, corrupt, readError } = parseLedger(root)
  if (readError) return { ok: false, reason: `${readError} — refusing to write` }
  const warnings: string[] = [...parsed.recordWarnings, ...parsed.receiptWarnings]
  if (corrupt) {
    const q = quarantineCorrupt(root)
    warnings.push(q ? `corrupt ledger quarantined: ${q}` : "corrupt ledger could not be quarantined")
  }
  const k = key(input.kind, input.name)
  const prev = parsed.records.find((r) => key(r.kind, r.name) === k) ?? null
  const verdict = replayVerdict(prev, input)
  if (verdict.kind === "replay") return { ok: true, record: verdict.record, warnings }
  if (verdict.kind === "conflict") return { ok: false, reason: verdict.reason }
  // r17(Blocker):同 key 存在解码失败记录 = 所有权无从证明,拒写(证据由原文保全带回,人工
  // 处置后重试);unattributable 损坏连 key 都提不出,任何 fresh 写都无法自证不与其同 key,同拒。
  if (parsed.corruptRecords.corruptKeys.has(k))
    return { ok: false, reason: `refusing to write ${k}: ledger holds a corrupt v2 record for this key (fail closed — inspect ${ledgerPath(root)})` }
  if (parsed.corruptRecords.unattributable)
    return { ok: false, reason: `refusing to write ${k}: ledger holds an unattributable corrupt v2 record (fail closed — inspect ${ledgerPath(root)})` }
  const hadV1 = parsed.receipts.some((r) => key(r.type, r.name) === k)
  const record: InstallRecordV2 = {
    ...input,
    schemaVersion: RECORD_SCHEMA_VERSION,
    generation: input.generation ?? (prev ? prev.generation + 1 : hadV1 ? 2 : 1),
    ...(input.previousDigest ? { previousDigest: input.previousDigest } : prev?.manifestDigest ? { previousDigest: prev.manifestDigest } : {}),
    // Codex r7 B4:desiredState 的「当前策略优先」必须在写账本的原子点(锁内 prev)决定 —— 不能沿用
    // 调用方计划期(锁外)算的 input.desiredState。否则计划期读到 enabled、用户随后 disable、更新事务
    // 提交旧 enabled 会把禁用复活。prev 存在 = 更新,一律沿用 prev 当前 desiredState(启停只经 set-state
    // 通道改);fresh(无 prev)才用分类器传入值。
    ...(prev ? { desiredState: prev.desiredState } : {}),
  }
  const check = decodeRecordV2(record)
  if (!check.ok) return { ok: false, reason: `refusing to write invalid record: ${check.errors.join("; ")}` }
  const nextRecords = [...parsed.records.filter((r) => key(r.kind, r.name) !== k), check.record, ...parsed.rawCorruptRecords]
  const nextReceipts = [...parsed.receipts.filter((r) => key(r.type, r.name) !== k), toV1Receipt(check.record), ...parsed.rawInvalidReceipts]
  const written = writeLedgerFile(root, nextReceipts, nextRecords)
  if (!written.ok) return written
  return { ok: true, record: check.record, warnings }
}

export type LedgerV2BatchWrite = { ok: true; records: InstallRecordV2[]; warnings: string[] } | { ok: false; reason: string }

/**
 * 批量 upsert 单次写盘(REQ-100 #311):bundle 的多条 receipt 一次读、全校验、一次 rename 落盘 ——
 * 任一 record 非法即整批拒绝(不留半套 receipt)。同一账本内解析一次,按输入顺序累积(同 key 后写覆盖)。 */
export function upsertRecordsV2(root: string, inputs: UpsertInput[]): LedgerV2BatchWrite {
  if (inputs.length === 0) return { ok: false, reason: "batch upsert has no records" }
  const { parsed, corrupt, readError } = parseLedger(root)
  if (readError) return { ok: false, reason: `${readError} — refusing to write` }
  const warnings: string[] = [...parsed.recordWarnings, ...parsed.receiptWarnings]
  if (corrupt) {
    const q = quarantineCorrupt(root)
    warnings.push(q ? `corrupt ledger quarantined: ${q}` : "corrupt ledger could not be quarantined")
  }
  const recordsByKey = new Map(parsed.records.map((r) => [key(r.kind, r.name), r]))
  const receiptKeys = new Set(parsed.receipts.map((r) => key(r.type, r.name)))
  const committed: InstallRecordV2[] = []
  let freshWrites = 0
  for (const input of inputs) {
    const k = key(input.kind, input.name)
    const prev = recordsByKey.get(k) ?? null
    const verdict = replayVerdict(prev, input)
    if (verdict.kind === "conflict") return { ok: false, reason: verdict.reason }
    if (verdict.kind === "replay") {
      committed.push(verdict.record) // 幂等:重放件原样计入,不递增 generation
      continue
    }
    // r17(Blocker):fresh 写遇同 key 损坏记录/unattributable 损坏 = 拒整批(纯重放批在上方
    // continue,零写盘不受影响 —— 恢复重放不因旧损坏被卡)。
    if (parsed.corruptRecords.corruptKeys.has(k))
      return { ok: false, reason: `refusing to write ${k}: ledger holds a corrupt v2 record for this key (fail closed — inspect ${ledgerPath(root)})` }
    if (parsed.corruptRecords.unattributable)
      return { ok: false, reason: `refusing to write ${k}: ledger holds an unattributable corrupt v2 record (fail closed — inspect ${ledgerPath(root)})` }
    freshWrites++
    const hadV1 = receiptKeys.has(k)
    const record: InstallRecordV2 = {
      ...input,
      schemaVersion: RECORD_SCHEMA_VERSION,
      generation: input.generation ?? (prev ? prev.generation + 1 : hadV1 ? 2 : 1),
      ...(input.previousDigest ? { previousDigest: input.previousDigest } : prev?.manifestDigest ? { previousDigest: prev.manifestDigest } : {}),
      // Codex r7 B4:同 upsertRecordV2 —— 更新(prev 存在)在写点沿用 prev 当前 desiredState(锁内真值),
      // 不用计划期传入值,防「计划读 enabled → 用户 disable → 提交复活」。批内同 key 后写基于累积态。
      ...(prev ? { desiredState: prev.desiredState } : {}),
    }
    const check = decodeRecordV2(record)
    if (!check.ok) return { ok: false, reason: `refusing to write invalid record ${k}: ${check.errors.join("; ")}` }
    recordsByKey.set(k, check.record) // 后续同 key 基于已累积态派生 generation
    committed.push(check.record)
  }
  // review #381:纯重放批(恢复期常态)= 真 no-op —— 账本已含全部目标记录,零写盘直接返回;
  // 否则「账本暂时不可写」会让完全一致的前滚失败、引擎回滚 config,与已在账的 receipt 永久分叉。
  if (freshWrites === 0) return { ok: true, records: committed, warnings }
  // 用累积后的最终态重建两视图(committed 里同 key 只保留最后一条 = recordsByKey 的值)。
  const committedKeys = new Set(committed.map((r) => key(r.kind, r.name)))
  const finalRecords = [
    ...parsed.records.filter((r) => !committedKeys.has(key(r.kind, r.name))),
    ...committedKeys.size ? [...committedKeys].map((k) => recordsByKey.get(k)!) : [],
    ...parsed.rawCorruptRecords, // r17(Blocker):原文保全,重建不得抹证据
  ]
  const finalReceipts = [
    ...parsed.receipts.filter((r) => !committedKeys.has(key(r.type, r.name))),
    ...[...committedKeys].map((k) => toV1Receipt(recordsByKey.get(k)!)),
    ...parsed.rawInvalidReceipts,
  ]
  const written = writeLedgerFile(root, finalReceipts, finalRecords)
  if (!written.ok) return written
  return { ok: true, records: committed, warnings }
}

/** Remove by (kind, name) from BOTH views. Missing = ok(idempotent), removed record returned for teardown对账。 */
/** #346(review #374 Major):卸载 journal key(`<kind>--<name>`)的严格解析 —— 未知 kind /
 *  无分隔 / 空名一律 null。恢复期的账本删除对 null **必须抛错**(journal 保持非终态待诊断),
 *  绝不静默返回把「未删账」写成 uninstalled。 */
export function parseUninstallLedgerKey(key: string): { kind: InstallReceiptType; name: string } | null {
  const sep = key.indexOf("--")
  if (sep <= 0) return null
  const kind = key.slice(0, sep)
  const name = key.slice(sep + 2)
  if (kind !== "skill" && kind !== "agent" && kind !== "mcp" && kind !== "plugin" && kind !== "cloud") return null
  if (!name) return null
  return { kind, name }
}

export function removeRecordV2(root: string, kind: InstallReceiptType, name: string): { ok: true; removed: InstallRecordV2 | null } | { ok: false; reason: string } {
  const { parsed, corrupt, readError } = parseLedger(root)
  // r19 Major:读失败 ≠ 空账 —— 折叠成 no-op 成功会让卸载在记录仍在的情况下谎报完成。
  if (readError) return { ok: false, reason: `${readError} — refusing to remove` }
  if (corrupt) quarantineCorrupt(root)
  const k = key(kind, name)
  // r17(Blocker):同 key 损坏记录在场 = 无法证明删除目标不是它(lookupForUninstall 已挡装载面,
  // 这里挡直接调用方);无关 key 的损坏条目原文保全带回,删除不得顺手蒸发证据。
  if (parsed.corruptRecords.corruptKeys.has(k))
    return { ok: false, reason: `refusing to remove ${k}: ledger holds a corrupt v2 record for this key (fail closed — inspect ${ledgerPath(root)})` }
  if (parsed.corruptRecords.unattributable)
    return { ok: false, reason: `refusing to remove ${k}: ledger holds an unattributable corrupt v2 record (fail closed — inspect ${ledgerPath(root)})` }
  const removed = parsed.records.find((r) => key(r.kind, r.name) === k) ?? null
  const hadReceipt = parsed.receipts.some((r) => key(r.type, r.name) === k)
  if (!removed && !hadReceipt && !corrupt) return { ok: true, removed: null }
  const written = writeLedgerFile(
    root,
    [...parsed.receipts.filter((r) => key(r.type, r.name) !== k), ...parsed.rawInvalidReceipts],
    [...parsed.records.filter((r) => key(r.kind, r.name) !== k), ...parsed.rawCorruptRecords],
  )
  if (!written.ok) return written
  return { ok: true, removed }
}

/** desiredState 翻转(Hub 项目上下文「禁用」的 main 侧真源;引擎生效面由消费方处理)。 */
export function setDesiredStateV2(root: string, kind: InstallReceiptType, name: string, state: DesiredState): { ok: true } | { ok: false; reason: string } {
  const { parsed, readError } = parseLedger(root)
  if (readError) return { ok: false, reason: `${readError} — refusing to write` }
  const k = key(kind, name)
  // r18:与 upsert/remove 同款损坏闸 —— 同 key 损坏所有权不明、unattributable 无从自证,
  // desiredState 翻转同为写路径,一律拒(原文保全依旧带回,见下方重建)。
  if (parsed.corruptRecords.corruptKeys.has(k))
    return { ok: false, reason: `refusing to set desired state for ${k}: ledger holds a corrupt v2 record for this key (fail closed — inspect ${ledgerPath(root)})` }
  if (parsed.corruptRecords.unattributable)
    return { ok: false, reason: `refusing to set desired state for ${k}: ledger holds an unattributable corrupt v2 record (fail closed — inspect ${ledgerPath(root)})` }
  const rec = parsed.records.find((r) => key(r.kind, r.name) === k)
  if (!rec) return { ok: false, reason: `no v2 record for ${k} — fail closed (v1-only installs have no desired-state channel)` }
  const next: InstallRecordV2 = { ...rec, desiredState: state, updatedAt: new Date().toISOString() }
  const written = writeLedgerFile(
    root,
    [...parsed.receipts, ...parsed.rawInvalidReceipts],
    [...parsed.records.filter((r) => key(r.kind, r.name) !== k), next, ...parsed.rawCorruptRecords],
  )
  return written.ok ? { ok: true } : written
}

// ── v1 → v2 显式迁移(AC#6)────────────────────────────────────────────────────────────────────

/** #309 adoption 判别:一张 v1 receipt 要么安全迁为 v2 record,要么保留 v1-only(带可定位原因)。 */
export type MigrateReceiptOutcome = { status: "adopted"; record: InstallRecordV2 } | { status: "retained"; reason: string }

/**
 * 把一张 v1 receipt 迁为 v2 record(generation 1,digest 字段如实缺省,migratedFrom 标注)。
 * Codex #309 裁决:构造后必须过 decodeRecordV2(#306 catalog 语义不变量);非 catalog 来源且
 * id ≠ user:<name> 时做**单次**规范化重试(v2 id 是身份声明;v1 receipt 原样保留原 id,降级视图
 * 不变)。catalog 身份不可重建(缺 kind 前缀 / command+catalog)或仍不过 → retained,绝不丢条目。
 * environment 语义 = 本次 adoption 时点的运行环境(记录归属),不是历史安装渠道证据。
 */
export function migrateV1Receipt(
  receipt: InstallReceipt,
  environment: AppEnvironment,
  scope: ScopeIdentity,
): MigrateReceiptOutcome {
  const build = (id: string): InstallRecordV2 => ({
    schemaVersion: RECORD_SCHEMA_VERSION,
    id,
    name: receipt.name,
    kind: receipt.type,
    environment,
    scope,
    ...(receipt.version ? { version: receipt.version } : {}),
    desiredState: "enabled",
    generation: 1,
    origin: receipt.origin,
    ...(receipt.files ? { files: receipt.files } : {}),
    ...(receipt.configKey ? { configKey: receipt.configKey } : {}),
    installedAt: receipt.installedAt,
    migratedFrom: "v1",
  })
  const first = decodeRecordV2(build(receipt.id))
  if (first.ok) return { status: "adopted", record: first.record }
  if (receipt.origin !== "catalog" && receipt.id !== `user:${receipt.name}`) {
    const retry = decodeRecordV2(build(`user:${receipt.name}`))
    if (retry.ok) return { status: "adopted", record: retry.record }
    return { status: "retained", reason: retry.errors.join("; ") }
  }
  return { status: "retained", reason: first.errors.join("; ") }
}

/**
 * Explicit whole-ledger migration (#309): every SAFELY-adoptable v1-only receipt under `root` gets a
 * v2 record; the rest stay v1-only with a locatable warning (`<ledger> <kind>:<name>: <reason>`).
 * Project ledgers bind identity to their CURRENT project dir (the ledger physically lives inside it —
 * this is the adoption moment). Idempotent; never drops a receipt (rollback safety);
 * receipts[] 原样保留 = 降级可读。
 * fail-closed 面(Codex #309):parser 有排除项(非法 receipt / 损坏或不可归属 v2 record)时整次
 * 拒绝写盘 —— 「解析→重写」会把被排除的原始条目丢掉,原文件必须零改动;scope 与账本物理域不符、
 * 同 (kind,name) 重复 receipt 均 retained(绝不降级成 global / 任选一条冒充身份)。
 */
export function migrateV1Ledger(
  root: string,
  environment: AppEnvironment,
  projectDir?: string,
): { ok: true; migrated: number; retained: number; warnings: string[] } | { ok: false; reason: string } {
  const { parsed, corrupt, readError } = parseLedger(root)
  if (readError) return { ok: false, reason: `${readError} — refusing to migrate` }
  if (corrupt) return { ok: false, reason: `installs.json unreadable: ${ledgerPath(root)} — refusing to migrate a corrupt ledger` }
  // Codex review #357 Blocker:信封严格校验 —— parseLedger 对顶层是宽容读(缺 v/未知键/非数组
  // 集合都静默当空),迁移的「解析→重写」会把未来版本或畸形账本改写成本构建形状并丢数据。
  // 合法信封 = { v: 1|2, receipts?: [], records?: [] }(v1 writer 落 {v:1,receipts},v2 落 {v:2,…})。
  try {
    const raw = JSON.parse(fs.readFileSync(ledgerPath(root), "utf8")) as Record<string, unknown>
    for (const k of Object.keys(raw))
      if (k !== "v" && k !== "receipts" && k !== "records")
        return { ok: false, reason: `refusing migration: unknown ledger envelope key "${k}" — not this build's ledger shape (file left untouched)` }
    if (raw.v !== 1 && raw.v !== 2)
      return { ok: false, reason: `refusing migration: unsupported ledger version ${JSON.stringify(raw.v)} (file left untouched)` }
    if (raw.receipts !== undefined && !Array.isArray(raw.receipts))
      return { ok: false, reason: "refusing migration: ledger receipts is not an array (file left untouched)" }
    if (raw.records !== undefined && !Array.isArray(raw.records))
      return { ok: false, reason: "refusing migration: ledger records is not an array (file left untouched)" }
  } catch {
    /* 文件不存在 → 无账可迁(走 pending=0);JSON 损坏已被上面 corrupt 分支拦下 */
  }
  if (parsed.receiptWarnings.length > 0 || parsed.recordWarnings.length > 0 || parsed.corruptRecords.corruptKeys.size > 0 || parsed.corruptRecords.unattributable) {
    const detail = [...parsed.receiptWarnings, ...parsed.recordWarnings].join("; ")
    return { ok: false, reason: `refusing migration: ledger has excluded/corrupt entries — rewriting would drop them (file left untouched): ${detail}` }
  }
  const recordKeys = new Set(parsed.records.map((r) => key(r.kind, r.name)))
  const pending = parsed.receipts.filter((r) => !recordKeys.has(key(r.type, r.name)))
  if (pending.length === 0) return { ok: true, migrated: 0, retained: 0, warnings: [] }
  let scope: ScopeIdentity = { kind: "global" }
  if (projectDir !== undefined) {
    const identity = projectScopeIdentity(projectDir)
    if (!identity.ok) return { ok: false, reason: identity.reason }
    scope = identity.scope
  }
  const expectedScope = projectDir !== undefined ? "project" : "global"
  const dup = new Map<string, number>()
  for (const r of pending) dup.set(key(r.type, r.name), (dup.get(key(r.type, r.name)) ?? 0) + 1)
  const warnings: string[] = []
  const adopted: InstallRecordV2[] = []
  let retained = 0
  const at = (r: InstallReceipt) => `${ledgerPath(root)} ${r.type}:${r.name}`
  for (const r of pending) {
    if (dup.get(key(r.type, r.name))! > 1) {
      retained++
      warnings.push(`${at(r)}: duplicate v1 receipts for one key — retained as v1-only (cannot pick an identity)`)
      continue
    }
    if (r.scope !== expectedScope) {
      retained++
      warnings.push(`${at(r)}: receipt scope "${r.scope}" does not match this ${expectedScope} ledger — retained as v1-only`)
      continue
    }
    const out = migrateV1Receipt(r, environment, scope)
    if (out.status === "adopted") adopted.push(out.record)
    else {
      retained++
      warnings.push(`${at(r)}: ${out.reason} — retained as v1-only`)
    }
  }
  if (adopted.length === 0) return { ok: true, migrated: 0, retained, warnings }
  const written = writeLedgerFile(root, [...parsed.receipts, ...parsed.rawInvalidReceipts], [...parsed.records, ...adopted, ...parsed.rawCorruptRecords])
  if (!written.ok) return written
  return { ok: true, migrated: adopted.length, retained, warnings }
}

// ── grant digest ────────────────────────────────────────────────────────────────────────────────

/** grant 键集 digest:secret 变量名 + env 键 + workspace/cnMirror 布尔 —— 绝不摄入任何值。 */
export function computeGrantDigest(grants: { secrets?: Record<string, string>; env?: Record<string, string>; workspace?: string; cnMirror?: boolean } | undefined): string {
  const shape = {
    secretNames: Object.keys(grants?.secrets ?? {}).sort(),
    envKeys: Object.keys(grants?.env ?? {}).sort(),
    workspace: typeof grants?.workspace === "string" && grants.workspace.length > 0,
    cnMirror: grants?.cnMirror === true,
  }
  return `sha256:${sha256Hex(JSON.stringify(shape))}`
}
