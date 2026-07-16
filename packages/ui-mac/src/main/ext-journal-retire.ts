// ext-journal-retire — REQ-100 #375:不可诊断事务 journal 的只读诊断面 + 显式 quarantine/retire。
//
// 语义(2026-07-16 Codex 裁决,#375 评论):
//   · **诊断面纯读零锁**:列出保留态 journal(非终态 .json,含结构畸形)、既有 .corrupt-* 留证、
//     枚举失据根、以及 retire 崩溃窗口残留(prepared receipt);字段带 fingerprint
//     (sha256+bytes)供 retire 复核 —— 防 list→confirm 之间被替换。
//   · **retire = 显式确认后把 journal 文件移入留证目录**(`ext-tx/journal-retired/`,journal/
//     的 sibling —— 全部枚举面只看 journal/ 下 *.json,retired 件对 recovery/gate/终态 GC/
//     CAS mark 天然不可见):持 root Bundle 锁(与事务/恢复/GC 同一把,互斥),锁内先做最后
//     一轮收敛(recoverExtensionTransactionsInHeldLock —— 文件锁非重入,不得调公共恢复入口),
//     复核目标仍在场、fingerprint 一致且非终态才动。**绝不删除任何文件、绝不改账本/用户数据**;
//     live 状态修复仍走既有安装/卸载通道。
//   · **审计两阶段(崩溃一致)**:先原子写 `prepared` receipt(fsync)→ rename(源/目的两目录
//     都 fsync)→ receipt 原子更新为 `retired`。崩溃窗口可判定:下次 retire 操作锁内先调和 ——
//     dest 在场 = 补记 retired;源仍在场 = receipt 记 abandoned(retire 未发生);诊断面把
//     prepared 残留如实列为 retire-incomplete。
//   · **CAS 后果(裁决防呆)**:retire 移除该 journal 提供的 digest mark(仅全局环境根参与
//     生产 GC mark);老于 grace 的孤立 blob 可在下一轮 GC 被删(宽限窗按 blob mtime,不从
//     retiredAt 重起算)—— 调用方必须显式 casMarkRemovalAcknowledged,receipt 记 mark 数量。
//   · staging(`ext-tx/staging/<txId>`)只报告不处置:journal 移走后 recovery 永不再收敛它,
//     属无限期人工证据(可含 0600 敏感 image,见 runbook)。
import { randomBytes, createHash } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fsyncDirSync, writeFileAtomicSync } from "./ext-atomic-fs"
import {
  diagnoseTransactionJournal,
  isTerminalTxState,
  transactionJournalLayout,
  type TxJournalShape,
  type TxRecoveryReport,
} from "./ext-transaction"
import { tryAcquireBundleLock } from "./ext-bundle-lock"
import type { JournalAdminEntry, JournalAdminScope, JournalRetireIntentWire, JournalRetireResult } from "../shared/ext-journal-admin"

const ENTRY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.json$/
const SHA256_RE = /^[0-9a-f]{64}$/
/** retire 目标名 = `<entryId>.retired-<16hex requestId>`(reconcile 圈禁用)。 */
const DEST_NONCE_RE = /\.retired-[0-9a-f]{16}$/
export const RETIRE_NOTE_MAX = 500

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)

export type JournalRootRef = { identity: string; root: string }

export type { JournalAdminEntry } from "../shared/ext-journal-admin"

function firstSeenOf(p: string): { firstSeenAt: string; firstSeenAtSource: "birthtime" | "mtime" } {
  const st = statSync(p)
  // birthtime 在部分文件系统恒 0/epoch —— 如实标源,绝不伪装成「main 首次观察时间」。
  if (st.birthtimeMs > 0 && st.birthtimeMs <= st.mtimeMs + 1)
    return { firstSeenAt: st.birthtime.toISOString(), firstSeenAtSource: "birthtime" }
  return { firstSeenAt: st.mtime.toISOString(), firstSeenAtSource: "mtime" }
}

/** items[].key 的安全提取(畸形结构容忍;去重、有界)。 */
function safeKeysOf(journal: TxJournalShape): string[] {
  const out = new Set<string>()
  if (Array.isArray(journal.items)) {
    for (const item of journal.items) {
      if (out.size >= 32) break
      if (isRec(item) && typeof item.key === "string" && item.key.length <= 256) out.add(item.key)
    }
  }
  return [...out]
}

/** items[].files[].sha256 的去重计数(CAS mark 后果展示;畸形结构容忍)。 */
function markDigestCountOf(journal: TxJournalShape): number {
  const seen = new Set<string>()
  if (Array.isArray(journal.items)) {
    for (const item of journal.items) {
      if (!isRec(item) || !Array.isArray(item.files)) continue
      for (const f of item.files) {
        if (isRec(f) && typeof f.sha256 === "string" && SHA256_RE.test(f.sha256)) seen.add(f.sha256)
      }
    }
  }
  return seen.size
}

/** 只读诊断面(零锁零写):调用方给定根集(全局环境根 main 派生;project 根显式传入)。 */
export function listRetainedJournals(roots: JournalRootRef[]): { entries: JournalAdminEntry[] } {
  const entries: JournalAdminEntry[] = []
  for (const ref of roots) {
    const layout = transactionJournalLayout(ref.root)
    let names: string[]
    try {
      names = readdirSync(layout.journalDir)
    } catch (error) {
      const code = isRec(error) && typeof error.code === "string" ? error.code : undefined
      if (code !== "ENOENT")
        entries.push({ kind: "unreadable-root", rootIdentity: ref.identity, reason: `journal dir cannot be enumerated: ${error instanceof Error ? error.message : String(error)}` })
      // review r1 Minor:journal 目录缺失/不可读时仍扫 journal-retired/ 的 prepared 残留 ——
      // 崩溃证据只落 retired 目录,不能因 journal/ 空/失据就漏报。
      for (const inc of scanIncompleteReceipts(ref)) entries.push(inc)
      continue
    }
    for (const name of names.sort()) {
      const abs = join(layout.journalDir, name)
      const rel = relative(ref.root, abs)
      if (name.includes(".json.corrupt-")) {
        try {
          const st = lstatSync(abs)
          if (!st.isFile()) {
            entries.push({ kind: "malformed-entry", rootIdentity: ref.identity, entryId: name, path: rel, reason: "corrupt-evidence entry is not a regular file" })
            continue
          }
          entries.push({ kind: "already-quarantined", rootIdentity: ref.identity, entryId: name, path: rel, bytes: st.size, ...firstSeenOf(abs) })
        } catch (error) {
          entries.push({ kind: "malformed-entry", rootIdentity: ref.identity, entryId: name, path: rel, reason: `unstattable: ${error instanceof Error ? error.message : String(error)}` })
        }
        continue
      }
      if (!name.endsWith(".json")) continue // 引擎自有临时件等,不属诊断面
      let raw: Buffer
      try {
        const st = lstatSync(abs)
        if (st.isSymbolicLink() || !st.isFile()) {
          entries.push({ kind: "malformed-entry", rootIdentity: ref.identity, entryId: name, path: rel, reason: "not a regular file (symlink is never followed)" })
          continue
        }
        raw = readFileSync(abs)
      } catch (error) {
        entries.push({ kind: "malformed-entry", rootIdentity: ref.identity, entryId: name, path: rel, reason: `unreadable: ${error instanceof Error ? error.message : String(error)}` })
        continue
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw.toString("utf8"))
      } catch {
        entries.push({ kind: "malformed-entry", rootIdentity: ref.identity, entryId: name, path: rel, reason: "unparsable json — recovery quarantines it as .corrupt-* on next run" })
        continue
      }
      if (!isRec(parsed) || typeof parsed.txId !== "string") {
        entries.push({ kind: "malformed-entry", rootIdentity: ref.identity, entryId: name, path: rel, reason: "body txId missing — recovery quarantines it as .corrupt-* on next run" })
        continue
      }
      const state = typeof parsed.state === "string" ? parsed.state : "(missing)"
      if (isTerminalTxState(state)) continue // 终态 = 引擎有界保留自管理,不属保留态诊断
      const diag = diagnoseTransactionJournal(parsed)
      const nameTxId = name.slice(0, -".json".length)
      const op = parsed.op === "uninstall" || parsed.op === "rollback" ? parsed.op : "install"
      entries.push({
        kind: "retained",
        rootIdentity: ref.identity,
        entryId: name,
        path: rel,
        txId: nameTxId,
        ...(parsed.txId !== nameTxId ? { bodyTxId: parsed.txId } : {}),
        op,
        state,
        keys: safeKeysOf(parsed),
        markDigestCount: markDigestCountOf(parsed),
        reason: diag.verdict === "malformed" ? diag.reason : `non-terminal state "${state}" — recovery could not converge (runtime dependency or pending retry; see runbook)`,
        reasonSource: diag.verdict === "malformed" ? "structure" : "state",
        retireEligible: true,
        journalSha256: createHash("sha256").update(raw).digest("hex"),
        bytes: raw.length,
        ...firstSeenOf(abs),
        stagingPresent: existsSync(join(layout.stagingDir, nameTxId)),
      })
    }
    // retire 崩溃窗口残留(prepared receipt)如实可见。
    for (const inc of scanIncompleteReceipts(ref)) entries.push(inc)
  }
  return { entries }
}

type RetireReceipt = Record<string, unknown>

function readReceipt(p: string): RetireReceipt | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(p, "utf8"))
    return isRec(parsed) ? parsed : null
  } catch {
    return null
  }
}

function scanIncompleteReceipts(ref: JournalRootRef): JournalAdminEntry[] {
  const layout = transactionJournalLayout(ref.root)
  let names: string[]
  try {
    names = readdirSync(layout.retiredDir).filter((n) => n.endsWith(".receipt.json"))
  } catch {
    return []
  }
  const out: JournalAdminEntry[] = []
  for (const name of names.sort()) {
    const receipt = readReceipt(join(layout.retiredDir, name))
    if (!receipt || receipt.status !== "prepared") continue
    const entryId = typeof receipt.entryId === "string" ? receipt.entryId : "(unknown)"
    const txId = typeof receipt.txId === "string" ? receipt.txId : "(unknown)"
    const destName = typeof receipt.destinationName === "string" ? receipt.destinationName : ""
    out.push({
      kind: "retire-incomplete",
      rootIdentity: ref.identity,
      receiptPath: relative(ref.root, join(layout.retiredDir, name)),
      entryId,
      txId,
      destinationPresent: destName !== "" && existsSync(join(layout.retiredDir, destName)),
    })
  }
  return out
}

export type RetireJournalRequest = {
  entryId: string
  /** 展示/审计字段;定位以 entryId + journalSha256 为准(裁决 Q3)。 */
  txId: string
  journalSha256: string
  note: string
  liveStateChecked: boolean
  casMarkRemovalAcknowledged: boolean
}

/** review r2 Minor:main 与 preload 共用 shared 真源(不再本地重复定义,防漂移)。 */
export type RetireJournalResult = JournalRetireResult

export type RetireDeps = {
  /** 锁内最后收敛(裁决 Q1:文件锁非重入,必须用 InHeldLock 核心,不得调公共恢复入口)。
   *  onProgress = 每张 journal 后续租持有锁(review r1 Major:长恢复不被 15min stale 接管)。 */
  recoverInHeldLock: (root: string, onProgress: () => void) => Promise<{ ok: boolean; reason?: string; reports: TxRecoveryReport[] }>
  now?: () => Date
  log?: (event: string, detail: Record<string, unknown>) => void
  pidAlive?: (pid: number) => boolean
  lockStaleMs?: number
}

/** 请求核验(IPC 解码后仍在此复核 —— 通道层零信任)。 */
export function validateRetireRequest(req: RetireJournalRequest): { ok: true } | { ok: false; reason: string } {
  if (!ENTRY_ID_RE.test(req.entryId) || req.entryId.includes(".corrupt-"))
    return { ok: false, reason: `invalid entryId "${req.entryId}"` }
  if (!SHA256_RE.test(req.journalSha256)) return { ok: false, reason: "journalSha256 must be 64 hex chars" }
  if (typeof req.txId !== "string" || req.txId.length === 0 || req.txId.length > 256) return { ok: false, reason: "invalid txId" }
  const note = req.note.trim()
  if (note.length === 0 || note.length > RETIRE_NOTE_MAX) return { ok: false, reason: `note must be 1..${RETIRE_NOTE_MAX} chars (non-empty after trim)` }
  if (!req.liveStateChecked) return { ok: false, reason: "liveStateChecked must be explicitly true (confirm live config/store/ledger were inspected)" }
  if (!req.casMarkRemovalAcknowledged)
    return { ok: false, reason: "casMarkRemovalAcknowledged must be explicitly true (retire removes this journal's CAS marks; orphan blobs older than grace become sweepable next GC round)" }
  return { ok: true }
}

/**
 * 显式 retire:持 root Bundle 锁 → 调和 prepared 残留 → 锁内最后收敛 → fingerprint/终态复核 →
 * 两阶段审计(prepared receipt → rename → retired receipt)。绝不删除任何文件。
 */
export async function retireTransactionJournal(ref: JournalRootRef, req: RetireJournalRequest, deps: RetireDeps): Promise<RetireJournalResult> {
  const valid = validateRetireRequest(req)
  if (!valid.ok) return { ok: false, reason: valid.reason }
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? ((event, detail) => console.error(`[ext-journal-retire] ${event} ${JSON.stringify(detail)}`))
  const layout = transactionJournalLayout(ref.root)
  const acquired = tryAcquireBundleLock(ref.root, {
    txId: `tx-jretire-${randomBytes(4).toString("hex")}`,
    now,
    log: (event, detail) => log(event, detail),
    pidAlive: deps.pidAlive,
    staleMs: deps.lockStaleMs,
  })
  if (!acquired.ok) return { ok: false, reason: `journal retire refused: ${acquired.reason} (transaction/recovery/GC in flight — retry later)` }
  const refresh = (): void => acquired.lock.refresh()
  try {
    // journal-retired/ 目录项本身持久化(review r1 Blocker B2:新建后须 fsync 其父 ext-tx/,
    // 否则掉电后 receipt 目录项可能随目录消失,形成「已移动而无 prepared 审计」窗口)。
    mkdirSync(layout.retiredDir, { recursive: true })
    fsyncDirSync(dirname(layout.retiredDir))
    reconcilePreparedReceipts(ref, layout.retiredDir, layout.journalDir, now, log)
    refresh() // review r3 Major:reconcile 后续租(reconcile 可能遍历多张残留 receipt)

    // 锁内最后收敛:能被自动恢复的绝不 retire(每张 journal 后续租锁)。
    const recoveryAttemptedAt = now().toISOString()
    const rec = await deps.recoverInHeldLock(ref.root, refresh)
    const ours = rec.reports.find((r) => `${r.txId}.json` === req.entryId)
    const recoveryOutcome = rec.ok
      ? (ours ? `report: ${ours.action}/${ours.state} — ${ours.detail}` : `ok (${rec.reports.length} report(s), none for this entry)`)
      : `recovery incomplete: ${rec.reason ?? "unknown"}`

    const source = join(layout.journalDir, req.entryId)
    let st: ReturnType<typeof lstatSync>
    try {
      st = lstatSync(source)
    } catch {
      return { ok: false, reason: `journal "${req.entryId}" is no longer present — recovery converged or quarantined it this round (${recoveryOutcome}); re-run diagnosis` }
    }
    if (st.isSymbolicLink() || !st.isFile()) return { ok: false, reason: `journal "${req.entryId}" is not a regular file — refusing (inspect manually)` }
    const raw = readFileSync(source)
    const sha = createHash("sha256").update(raw).digest("hex")
    if (sha !== req.journalSha256)
      return { ok: false, reason: `journal "${req.entryId}" changed since diagnosis (fingerprint mismatch) — re-run diagnosis and confirm again` }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw.toString("utf8"))
    } catch {
      return { ok: false, reason: `journal "${req.entryId}" is unparsable — recovery quarantines it as .corrupt-* (retry the operation instead of retiring)` }
    }
    if (!isRec(parsed)) return { ok: false, reason: `journal "${req.entryId}" body is not an object — recovery quarantines it as .corrupt-*` }
    const state = typeof parsed.state === "string" ? parsed.state : "(missing)"
    if (isTerminalTxState(state)) return { ok: false, reason: `journal "${req.entryId}" is terminal (${state}) — nothing to retire` }
    const diag = diagnoseTransactionJournal(parsed)
    const nameTxId = req.entryId.slice(0, -".json".length)
    const bodyTxId = typeof parsed.txId === "string" ? parsed.txId : undefined
    const first = firstSeenOf(source)
    const stagingPresent = existsSync(join(layout.stagingDir, nameTxId))
    const markDigestCount = markDigestCountOf(parsed)

    const requestId = randomBytes(8).toString("hex")
    const destinationName = `${req.entryId}.retired-${requestId}`
    const destination = join(layout.retiredDir, destinationName)
    const receiptName = `retire-${requestId}.receipt.json`
    const receiptPath = join(layout.retiredDir, receiptName)
    if (existsSync(destination) || existsSync(receiptPath))
      return { ok: false, reason: "requestId collision on retire evidence — retry" }

    const receipt: Record<string, unknown> = {
      v: 1,
      action: "retire",
      status: "prepared",
      requestId,
      rootIdentity: ref.identity,
      entryId: req.entryId,
      txId: nameTxId,
      ...(bodyTxId !== undefined && bodyTxId !== nameTxId ? { bodyTxId } : {}),
      op: parsed.op === "uninstall" || parsed.op === "rollback" ? parsed.op : "install",
      state,
      keys: safeKeysOf(parsed),
      diagnosticReason: diag.verdict === "malformed" ? diag.reason : `non-terminal state "${state}" — recovery could not converge`,
      sourcePath: relative(ref.root, source),
      destinationPath: relative(ref.root, destination),
      destinationName,
      sourceSha256: sha,
      sourceBytes: raw.length,
      firstSeenAt: first.firstSeenAt,
      firstSeenAtSource: first.firstSeenAtSource,
      recoveryAttemptedAt,
      recoveryOutcome,
      requestedAt: now().toISOString(),
      note: req.note.trim(),
      liveStateChecked: true,
      casMarkRemovalAcknowledged: true,
      stagingPresent,
      markDigestCount,
    }
    refresh() // rename 前续租(复核到落盘之间锁不失效)
    // 两阶段(裁决 Q2 + review r1 Blocker B2/B3):
    //   1. prepared receipt 原子写(writeFileAtomicSync 已 fsync 内容 + retiredDir);
    //   2. rename source → dest;
    //   3. **先 fsync 目标目录(dest 新增持久),再 fsync 源目录(source 删除持久)** —— 顺序
    //      反了会在两次 fsync 间掉电时 source 删除已落盘而 dest 新增未落盘 = 两边皆无(数据丢失);
    //   4. rename 后按实物复核 dest sha256(M1:read→rename 之间外部替换 = drift,如实记 receipt);
    //   5. receipt 原子更新为 retired。
    writeFileAtomicSync(receiptPath, JSON.stringify(receipt, null, 2))
    renameSync(source, destination)
    fsyncDirSync(layout.retiredDir)
    fsyncDirSync(layout.journalDir)
    const destSha = createHash("sha256").update(readFileSync(destination)).digest("hex")
    const drift = destSha !== sha
    if (drift) log("journal-retire-drift", { rootIdentity: ref.identity, entryId: req.entryId, expected: sha, actual: destSha })
    writeFileAtomicSync(
      receiptPath,
      JSON.stringify({ ...receipt, status: "retired", retiredAt: now().toISOString(), ...(drift ? { fingerprintDriftAtRename: true, retiredSha256: destSha } : {}) }, null, 2),
    )
    fsyncDirSync(layout.retiredDir)
    log("journal-retired", { rootIdentity: ref.identity, entryId: req.entryId, txId: nameTxId, requestId, markDigestCount, stagingPresent, drift })
    return { ok: true, entryId: req.entryId, txId: nameTxId, movedTo: relative(ref.root, destination), receiptPath: relative(ref.root, receiptPath), markDigestCount, stagingPresent, recoveryOutcome }
  } finally {
    acquired.lock.release()
  }
}

/** 崩溃窗口调和(锁内):prepared receipt + dest 在场 = 补记 retired;源仍在场 = 记 abandoned
 *  (retire 未发生,fingerprint 已失效,须重新诊断确认);二者皆无 = 记 abandoned(如实)。 */
function reconcilePreparedReceipts(ref: JournalRootRef, retiredDir: string, journalDirAbs: string, now: () => Date, log: (event: string, detail: Record<string, unknown>) => void): void {
  let names: string[]
  try {
    names = readdirSync(retiredDir).filter((n) => n.endsWith(".receipt.json"))
  } catch {
    return
  }
  for (const name of names.sort()) {
    const p = join(retiredDir, name)
    const receipt = readReceipt(p)
    if (!receipt || receipt.status !== "prepared") continue
    // review r3 Blocker:destinationName/entryId 是 receipt 字段(可能畸形/含 ..),join 前
    // 必须严格圈禁 —— 否则 traversal 段会让 destPath/sourcePath 指向目录外,曾经的 unlink 分支
    // 据此删除越界文件。名字必须是引擎自产形态(entryId = <txId>.json;destName = entryId.retired-<hex>)。
    const entryId = typeof receipt.entryId === "string" && ENTRY_ID_RE.test(receipt.entryId) && !receipt.entryId.includes(".corrupt-") ? receipt.entryId : ""
    const destName = typeof receipt.destinationName === "string" ? receipt.destinationName : ""
    const destNameOk = entryId !== "" && destName === `${entryId}.retired-${typeof receipt.requestId === "string" ? receipt.requestId : ""}` && DEST_NONCE_RE.test(destName)
    const expectedSha = typeof receipt.sourceSha256 === "string" && SHA256_RE.test(receipt.sourceSha256) ? receipt.sourceSha256 : undefined
    const destExists = destNameOk && existsSync(join(retiredDir, destName))
    const sourceExists = entryId !== "" && existsSync(join(journalDirAbs, entryId))
    // review r3 Blocker/Major:reconcile **绝不删除任何文件**(此前的「补完 rename」unlink 分支
    // 是越界删除面 + 会删掉被恢复改写过的 source)。三态如实标记,retire 未完成的一律 abandoned:
    //   · dest 在场 ∧ source 不在场 = rename 已完成 → retired(按 dest 实物复核指纹,不成立标
    //     fingerprintVerified:false 不谎称);
    //   · **dest 与 source 同在**(rename 半持久)= retire 未完成 → abandoned(source 仍是活
    //     journal,交回正常恢复;operator 重新诊断后可再 retire,dest 孤儿无害不被任何枚举面看见);
    //   · 仅 source / 皆无 = abandoned。
    if (destExists && !sourceExists) {
      let actualSha: string | undefined
      try {
        actualSha = createHash("sha256").update(readFileSync(join(retiredDir, destName))).digest("hex")
      } catch {
        actualSha = undefined
      }
      const verified = expectedSha !== undefined && actualSha !== undefined
      const drift = verified && actualSha !== expectedSha
      writeFileAtomicSync(
        p,
        JSON.stringify(
          { ...receipt, status: "retired", retiredAt: now().toISOString(), reconciled: true, fingerprintVerified: verified, ...(drift ? { fingerprintDriftAtReconcile: true } : {}), ...(actualSha !== undefined ? { retiredSha256: actualSha } : {}) },
          null,
          2,
        ),
      )
      log("journal-retire-reconciled", { receipt: name, outcome: "retired", verified, drift })
    } else if (destExists && sourceExists) {
      writeFileAtomicSync(p, JSON.stringify({ ...receipt, status: "abandoned", abandonedAt: now().toISOString(), note2: "rename not durably completed (source still live) — journal returned to normal recovery; re-diagnose to retire again" }, null, 2))
      log("journal-retire-reconciled", { receipt: name, outcome: "abandoned-incomplete" })
    } else if (sourceExists) {
      writeFileAtomicSync(p, JSON.stringify({ ...receipt, status: "abandoned", abandonedAt: now().toISOString() }, null, 2))
      log("journal-retire-reconciled", { receipt: name, outcome: "abandoned" })
    } else {
      writeFileAtomicSync(p, JSON.stringify({ ...receipt, status: "abandoned", abandonedAt: now().toISOString(), note2: "neither source nor destination present at reconcile time" }, null, 2))
      log("journal-retire-reconciled", { receipt: name, outcome: "abandoned-missing" })
    }
  }
}

// ── wire 解码(#375 裁决 Q4:renderer 无任意 root 通道;scope = main 派生 env selector 或
//    projectDir 严格解析;flags 必须字面 true;未知键拒)────────────────────────────────────────

type JournalRetireIntent = JournalRetireIntentWire

const LIST_KEYS = new Set(["projectDir"])

export function decodeJournalListIntent(v: unknown): { ok: true; projectDir?: string } | { ok: false; reason: string } {
  if (v === undefined || v === null) return { ok: true }
  if (!isRec(v)) return { ok: false, reason: "list intent must be an object" }
  for (const key of Object.keys(v)) if (!LIST_KEYS.has(key)) return { ok: false, reason: `list intent has unknown key "${key}" — refused` }
  if (v.projectDir === undefined) return { ok: true }
  if (typeof v.projectDir !== "string" || v.projectDir.length === 0) return { ok: false, reason: "projectDir must be a non-empty string" }
  return { ok: true, projectDir: v.projectDir }
}

const RETIRE_KEYS = new Set(["scope", "entryId", "txId", "journalSha256", "note", "liveStateChecked", "casMarkRemovalAcknowledged"])
const SCOPE_KEYS_GLOBAL = new Set(["kind", "environment"])
const SCOPE_KEYS_PROJECT = new Set(["kind", "projectDir"])

export function decodeJournalRetireIntent(v: unknown): { ok: true; intent: JournalRetireIntent } | { ok: false; reason: string } {
  if (!isRec(v)) return { ok: false, reason: "retire intent must be an object" }
  for (const key of Object.keys(v)) if (!RETIRE_KEYS.has(key)) return { ok: false, reason: `retire intent has unknown key "${key}" — refused` }
  const rawScope = v.scope
  if (!isRec(rawScope)) return { ok: false, reason: "retire intent scope is required" }
  let scope: JournalAdminScope
  if (rawScope.kind === "global") {
    for (const key of Object.keys(rawScope)) if (!SCOPE_KEYS_GLOBAL.has(key)) return { ok: false, reason: `scope has unknown key "${key}" — refused` }
    if (rawScope.environment !== "dev" && rawScope.environment !== "prod" && rawScope.environment !== "beta")
      return { ok: false, reason: 'scope.environment must be "dev" | "prod" | "beta"' }
    scope = { kind: "global", environment: rawScope.environment }
  } else if (rawScope.kind === "project") {
    for (const key of Object.keys(rawScope)) if (!SCOPE_KEYS_PROJECT.has(key)) return { ok: false, reason: `scope has unknown key "${key}" — refused` }
    if (typeof rawScope.projectDir !== "string" || rawScope.projectDir.length === 0)
      return { ok: false, reason: "scope.projectDir must be a non-empty string" }
    scope = { kind: "project", projectDir: rawScope.projectDir }
  } else {
    return { ok: false, reason: 'scope.kind must be "global" | "project"' }
  }
  if (typeof v.entryId !== "string" || !ENTRY_ID_RE.test(v.entryId) || v.entryId.includes(".corrupt-"))
    return { ok: false, reason: "invalid entryId" }
  if (typeof v.txId !== "string" || v.txId.length === 0 || v.txId.length > 256) return { ok: false, reason: "invalid txId" }
  if (typeof v.journalSha256 !== "string" || !SHA256_RE.test(v.journalSha256)) return { ok: false, reason: "journalSha256 must be 64 hex chars" }
  if (typeof v.note !== "string" || v.note.trim().length === 0 || v.note.length > RETIRE_NOTE_MAX)
    return { ok: false, reason: `note must be 1..${RETIRE_NOTE_MAX} chars (non-empty after trim)` }
  if (v.liveStateChecked !== true) return { ok: false, reason: "liveStateChecked must be explicitly true" }
  if (v.casMarkRemovalAcknowledged !== true) return { ok: false, reason: "casMarkRemovalAcknowledged must be explicitly true" }
  return {
    ok: true,
    intent: {
      scope,
      entryId: v.entryId,
      txId: v.txId,
      journalSha256: v.journalSha256,
      note: v.note,
      liveStateChecked: true,
      casMarkRemovalAcknowledged: true,
    },
  }
}
