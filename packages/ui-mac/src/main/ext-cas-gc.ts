// REQ-102 A(issue #194)—— CAS mark/sweep GC(parent scope⑥ / 本仓交付④)。
//
// 语义:
//   · **mark 根**(全部 fail-closed:任一根不可读 → 整轮 GC 拒绝,宁多留不误删):
//       ① 各环境根(REQ-098 prod/beta/dev mutable root)的事务 journal(全状态 —— 未完成
//          事务的期望清单在 items[].files[].sha256,committed 有界保留 100);
//       ② 各环境根 ext-store 的 generation 内容重哈希(current + previous + 事务引擎保留的
//          全部代;receipts 指向的就是这些 generation —— 内容 digest 即 CAS 可达性);
//       ③ packaged seed lock(seed target 保留:重装/修复离线可用);
//       ④ 显式 pin 账(ext-cas pins.json)。
//   · **sweep**:只删「<cas>/v1/sha256 下、名字过 digest 严格 pattern、realpath 圈禁在 CAS 根内、
//     未被 mark、且晚于宽限窗(mtime)」的常规文件。未知条目/别名(symlink)一律保留 + loud
//     (uninstall 同款纪律)。**用户数据在路径构造上不可达**——GC 唯一的删除面是 CAS blob 文件。
//   · **与事务引擎互斥**:GC 先持 CAS 级锁(GC 对 GC 串行),再逐环境根尝试持 Bundle 锁
//     (ext-bundle-lock,与 REQ-100 事务同一把)——任一环境有活事务 → 整轮如实跳过(不等待);
//     陈旧锁由既有 stale 恢复机接管(崩溃安全)。sweep 期间不可能有新事务启动。
//   · **崩溃安全**:blob 彼此独立、删除无序 —— 任意中断点后 store 仍自洽;下一轮从头 mark。
//   · **可观测**:dryRun 返回完整 sweep 计划(逐 blob digest/bytes)而零删除;宽限窗与保留
//     计数如实回报。
//
// electron-free、全参数化(envRoots/seedLockPaths/时钟/pid 探活注入),零 mock(仓规)。

import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { confinedExistingPath, sha256FileSync } from "./ext-atomic-fs"
import { tryAcquireBundleLock, type BundleLock } from "./ext-bundle-lock"
import { CAS_SHA256_RE, casPaths, readCasPinsStrict } from "./ext-cas"
import { decodeSeedLock } from "./ext-seed"
import { listGenerations, readTransactionJournal, type TxLog } from "./ext-transaction"
import { environmentMutableRoot } from "./alpha-environment"

/** 宽限窗默认 6 小时:提升进 CAS 但尚未被 journal/generation 引用的新 blob 不被误扫。 */
export const CAS_GC_GRACE_MS_DEFAULT = 6 * 60 * 60_000

const SHARD_RE = /^[0-9a-f]{2}$/

export type CasGcOptions = {
  /** 参与 mark 的环境根(REQ-098 mutable roots);GC 会尝试持有各根的 Bundle 锁(互斥)。 */
  envRoots: string[]
  /** packaged seed lock 路径(seed target 保留);不可解码 → 整轮拒绝(fail closed)。 */
  seedLockPaths?: string[]
  /** true = 只产 sweep 计划,零删除。 */
  dryRun?: boolean
  graceMs?: number
  now?: () => Date
  pidAlive?: (pid: number) => boolean
  lockStaleMs?: number
  log?: TxLog
  /** 测试注入面:每次锁心跳续租(refreshHeld)后回调 —— 用于「长轮 GC 不被 stale 接管」的
   *  时钟推进断言(review #366 Blocker 回归)。生产不传。 */
  onMarkProgress?: () => void
}

export type CasGcReport = {
  ok: boolean
  /** ok=false 时的如实原因(锁被活事务持有 / mark 根不可读)。 */
  reason?: string
  dryRun: boolean
  /** mark 集大小(去重 digest 数)。 */
  marked: number
  /** 店内 blob 总数。 */
  blobsTotal: number
  /** 本轮判定可回收的 blob(dryRun 时即完整计划)。 */
  sweepable: Array<{ sha256: string; bytes: number }>
  /** 实际删除的 blob 路径(dryRun 恒空)。 */
  swept: string[]
  /** 未被引用但落在宽限窗内而保留的 blob 数。 */
  keptByGrace: number
  warnings: string[]
}

/** 一轮 GC 的入参线格(#367:经 workerData 跨线程传递 —— 纯 JSON 形状,worker 侧严格解码)。 */
export type CasGcRoundInput = {
  casBaseRoot: string
  envRoots: string[]
  seedLockPaths: string[]
  graceMs: number
  dryRun: boolean
}

/** 一轮 GC 的紧凑摘要(#367 裁决 Q2 修订:不跨线程回传完整 CasGcReport —— extreme 档
 *  sweepable/swept/warnings 可达上万条,structured clone 过重;main 只记计数)。 */
export type CasGcRoundSummary = {
  ok: boolean
  reason?: string
  dryRun: boolean
  marked: number
  blobsTotal: number
  sweepableCount: number
  sweptCount: number
  keptByGrace: number
  warningCount: number
}

export function summarizeCasGcReport(report: CasGcReport): CasGcRoundSummary {
  return {
    ok: report.ok,
    ...(report.reason !== undefined ? { reason: report.reason } : {}),
    dryRun: report.dryRun,
    marked: report.marked,
    blobsTotal: report.blobsTotal,
    sweepableCount: report.sweepable.length,
    sweptCount: report.swept.length,
    keptByGrace: report.keptByGrace,
    warningCount: report.warnings.length,
  }
}

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)

const SUMMARY_KEYS = new Set(["ok", "reason", "dryRun", "marked", "blobsTotal", "sweepableCount", "sweptCount", "keptByGrace", "warningCount"])

/** worker 回传消息的严格解码(fail-closed:形状不符/未知键 = 本轮按异常处理,不猜;
 *  计数字段全部是数组长度或离散计数 → 只收非负安全整数,#385 review r1 F4)。 */
export function decodeCasGcRoundSummary(v: unknown): { ok: true; summary: CasGcRoundSummary } | { ok: false; reason: string } {
  if (!isRec(v)) return { ok: false, reason: "summary must be an object" }
  for (const key of Object.keys(v)) if (!SUMMARY_KEYS.has(key)) return { ok: false, reason: `summary has unknown key "${key}" — refused` }
  if (typeof v.ok !== "boolean") return { ok: false, reason: "summary.ok must be boolean" }
  if (v.reason !== undefined && typeof v.reason !== "string") return { ok: false, reason: "summary.reason must be a string when present" }
  if (typeof v.dryRun !== "boolean") return { ok: false, reason: "summary.dryRun must be boolean" }
  const count = (x: unknown): number | undefined => (typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? x : undefined)
  const marked = count(v.marked)
  const blobsTotal = count(v.blobsTotal)
  const sweepableCount = count(v.sweepableCount)
  const sweptCount = count(v.sweptCount)
  const keptByGrace = count(v.keptByGrace)
  const warningCount = count(v.warningCount)
  if (marked === undefined || blobsTotal === undefined || sweepableCount === undefined || sweptCount === undefined || keptByGrace === undefined || warningCount === undefined)
    return { ok: false, reason: "summary counts must be non-negative safe integers" }
  return {
    ok: true,
    summary: {
      ok: v.ok,
      ...(typeof v.reason === "string" ? { reason: v.reason } : {}),
      dryRun: v.dryRun,
      marked,
      blobsTotal,
      sweepableCount,
      sweptCount,
      keptByGrace,
      warningCount,
    },
  }
}

/** 生产缺省的 mark/互斥环境根集合:dev(= base 根)+ prod + beta(REQ-098 分域)。 */
export function defaultCasGcEnvRoots(baseRoot: string): string[] {
  return [
    environmentMutableRoot("dev", baseRoot),
    environmentMutableRoot("prod", baseRoot),
    environmentMutableRoot("beta", baseRoot),
  ]
}

/** 递归收集目录内全部常规文件的 sha256(symlink 不跟、warning 记账)。 */
function markDirContents(dir: string, marked: Set<string>, warnings: string[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    warnings.push(`mark: unreadable dir ${dir}: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      warnings.push(`mark: symlink skipped (never followed): ${abs}`)
      continue
    }
    if (entry.isDirectory()) markDirContents(abs, marked, warnings)
    else if (entry.isFile()) {
      try {
        marked.add(sha256FileSync(abs))
      } catch (error) {
        warnings.push(`mark: unreadable file ${abs}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}

/** journal 目录逐文件读取;**不可解析的 journal = mark 根不可信 → 抛错整轮拒绝**(fail closed)。 */
function markJournals(envRoot: string, marked: Set<string>): void {
  const dir = path.join(envRoot, "ext-tx", "journal")
  let names: string[]
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"))
  } catch (error) {
    // 仅「目录不存在」= 无事务史;权限/IO 等其它错误 = mark 根不可信 → fail closed。
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw new Error(`journal dir unreadable ${dir} — refusing to GC (fail closed): ${error instanceof Error ? error.message : String(error)}`)
  }
  for (const name of names) {
    if (name.includes(".corrupt-")) continue // 恢复机移开留证的坏 journal,不构成 mark 根
    const journal = readTransactionJournal(envRoot, name.slice(0, -".json".length))
    if (!journal) throw new Error(`unreadable transaction journal ${path.join(dir, name)} — refusing to GC (fail closed)`)
    for (const item of journal.items) for (const f of item.files) marked.add(f.sha256)
  }
}

/** ext-store 全部 key 的全部 generation 内容重哈希(receipts/current/previous 可达性)。 */
function markGenerations(envRoot: string, marked: Set<string>, warnings: string[], onKeyDone?: () => void): void {
  const storeRoot = path.join(envRoot, "ext-store")
  let keys: fs.Dirent[]
  try {
    keys = fs.readdirSync(storeRoot, { withFileTypes: true })
  } catch (error) {
    // 仅「目录不存在」= 无安装;权限/IO 等其它错误 = 可达 generation 不可枚举 → fail closed。
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw new Error(`ext-store unreadable ${storeRoot} — refusing to GC (fail closed): ${error instanceof Error ? error.message : String(error)}`)
  }
  for (const key of keys) {
    if (!key.isDirectory()) continue
    // 布局所有权在 ext-transaction;listGenerations 是权威枚举面(非法 key/非 generation 目录自滤)。
    for (const gen of listGenerations(envRoot, key.name)) markDirContents(gen.dir, marked, warnings)
    // 每 key 全量重哈希后续租锁心跳(单 key 大 store 也无 15 分钟上界,review #366 Blocker)。
    onKeyDone?.()
  }
}

function markSeedLock(seedLockPath: string, marked: Set<string>): void {
  let text: string
  try {
    text = fs.readFileSync(seedLockPath, "utf8")
  } catch (error) {
    throw new Error(`seed lock unreadable ${seedLockPath}: ${error instanceof Error ? error.message : String(error)} — refusing to GC (fail closed)`)
  }
  const decoded = decodeSeedLock(text)
  if (!decoded.ok) throw new Error(`seed lock invalid ${seedLockPath}: ${decoded.error} — refusing to GC (fail closed)`)
  for (const asset of decoded.lock.assets) for (const f of asset.files) marked.add(f.sha256)
}

/**
 * mark/sweep 主入口。锁不可得 / mark 根不可信 → `{ ok: false, reason }`(零删除)。
 * 成功时 swept/sweepable/keptByGrace 如实回报(dryRun = 只算不删)。
 */
export function collectCasGarbage(baseRoot: string, opts: CasGcOptions): CasGcReport {
  const warnings: string[] = []
  const log = opts.log ?? ((event, detail) => console.error(`[ext-cas-gc] ${event} ${JSON.stringify(detail)}`))
  const now = opts.now ?? (() => new Date())
  const dryRun = opts.dryRun ?? false
  const graceMs = Math.max(0, opts.graceMs ?? CAS_GC_GRACE_MS_DEFAULT)
  const report = (partial: Partial<CasGcReport> & { ok: boolean }): CasGcReport => ({
    dryRun,
    marked: 0,
    blobsTotal: 0,
    sweepable: [],
    swept: [],
    keptByGrace: 0,
    warnings,
    ...partial,
  })
  if (!path.isAbsolute(baseRoot)) return report({ ok: false, reason: `baseRoot must be absolute: ${baseRoot}` })
  const { root: casRoot, blobsDir } = casPaths(baseRoot)
  // 注:empty-store 快返放在锁 + mark 根校验**之后**(review #366:seed/pins 等强制 mark 根损坏
  // 必须在空店时同样整轮 fail-closed 暴露,不得静默 ok)。

  // ── 互斥:CAS 级锁(GC 对 GC)+ 全部环境根 Bundle 锁(GC 对事务引擎)。任一活占用 → 跳过。
  const held: BundleLock[] = []
  const releaseAll = () => {
    for (const lock of held.reverse()) lock.release()
    held.length = 0
  }
  const lockOpts = { now, log, pidAlive: opts.pidAlive, staleMs: opts.lockStaleMs }
  const gcTxId = () => `tx-casgc-${crypto.randomBytes(4).toString("hex")}`
  const casLock = tryAcquireBundleLock(casRoot, { txId: gcTxId(), ...lockOpts })
  if (!casLock.ok) return report({ ok: false, reason: `CAS lock busy: ${casLock.reason}` })
  held.push(casLock.lock)
  for (const envRoot of opts.envRoots) {
    if (!path.isAbsolute(envRoot)) {
      releaseAll()
      return report({ ok: false, reason: `env root must be absolute: ${envRoot}` })
    }
    const acquired = tryAcquireBundleLock(envRoot, { txId: gcTxId(), ...lockOpts })
    if (!acquired.ok) {
      releaseAll()
      return report({ ok: false, reason: `transaction in flight at ${envRoot}: ${acquired.reason} — GC skipped (mutual exclusion)` })
    }
    held.push(acquired.lock)
  }

  // 锁续租(review #366 Blocker):mark 的 generation 全量重哈希与 sweep 没有 15 分钟上界,
  // 不续租则心跳超 staleMs 后锁会被其它进程按 stale 接管(rename 留证)→ GC↔GC / GC↔事务并行,
  // 互斥保证被破坏。整轮期间按进度定期刷新全部持有锁的心跳。
  const refreshHeld = (): void => {
    for (const lock of held) lock.refresh()
    opts.onMarkProgress?.()
  }

  try {
    // ── mark ────────────────────────────────────────────────────────────────────────────────
    const marked = new Set<string>()
    try {
      for (const envRoot of opts.envRoots) {
        markJournals(envRoot, marked)
        refreshHeld()
        markGenerations(envRoot, marked, warnings, refreshHeld)
      }
      for (const seedLockPath of opts.seedLockPaths ?? []) {
        markSeedLock(seedLockPath, marked)
        refreshHeld()
      }
      // pin 账是 mark 根之一:损坏(存在但不可读/JSON/结构非法)必须 fail-closed,绝不当空集
      // 继续 sweep —— 否则受保护 blob 会被误删(REQ-102 #333)。仅「无 pin 文件」= 合法空集。
      const pinsRead = readCasPinsStrict(baseRoot)
      if (pinsRead.status === "invalid")
        throw new Error(`corrupt pins ledger — refusing to GC (fail closed): ${pinsRead.reason}`)
      for (const digest of Object.keys(pinsRead.pins)) marked.add(digest)
    } catch (error) {
      return report({ ok: false, reason: error instanceof Error ? error.message : String(error) })
    }

    // ── sweep ───────────────────────────────────────────────────────────────────────────────
    if (!fs.existsSync(blobsDir)) {
      log("cas-gc", { dryRun, marked: marked.size, blobsTotal: 0, sweepable: 0, swept: 0, keptByGrace: 0, reason: "empty store" })
      return report({ ok: true, marked: marked.size, reason: "empty store" })
    }
    const sweepable: Array<{ sha256: string; bytes: number }> = []
    const swept: string[] = []
    let blobsTotal = 0
    let keptByGrace = 0
    let sinceRefresh = 0
    const cutoffMs = now().getTime() - graceMs
    let shards: fs.Dirent[]
    try {
      shards = fs.readdirSync(blobsDir, { withFileTypes: true })
    } catch (error) {
      return report({ ok: false, reason: `blobs dir unreadable: ${error instanceof Error ? error.message : String(error)}` })
    }
    for (const shard of shards) {
      const shardAbs = path.join(blobsDir, shard.name)
      if (shard.isSymbolicLink() || !shard.isDirectory() || !SHARD_RE.test(shard.name)) {
        warnings.push(`sweep kept unknown entry (not blob-owned): ${shardAbs}`)
        continue
      }
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(shardAbs, { withFileTypes: true })
      } catch (error) {
        warnings.push(`sweep: unreadable shard ${shardAbs}: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      for (const entry of entries) {
        // 续租节流:每 64 个条目刷新一次全部持有锁的心跳(sweep 无时长上界)。
        if (++sinceRefresh >= 64) {
          sinceRefresh = 0
          refreshHeld()
        }
        const abs = path.join(shardAbs, entry.name)
        // 严格 blob 命名双守卫:64hex + 分片一致;symlink/目录/异名一律保留 + loud。
        if (entry.isSymbolicLink() || !entry.isFile() || !CAS_SHA256_RE.test(entry.name) || !entry.name.startsWith(shard.name)) {
          warnings.push(`sweep kept unknown entry (not blob-owned): ${abs}`)
          continue
        }
        blobsTotal++
        if (marked.has(entry.name)) continue
        let st: fs.Stats
        try {
          st = fs.lstatSync(abs)
        } catch {
          continue // 并发消失 = 已无事可删
        }
        if (st.mtimeMs > cutoffMs) {
          keptByGrace++
          continue
        }
        sweepable.push({ sha256: entry.name, bytes: st.size })
        if (dryRun) continue
        if (!confinedExistingPath(casRoot, abs)) {
          warnings.push(`sweep refused (path guard): ${abs}`)
          continue
        }
        try {
          fs.rmSync(abs)
          swept.push(abs)
        } catch (error) {
          warnings.push(`sweep failed for ${abs}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      // 空分片目录顺手收敛(只在真删模式;失败无害)。
      if (!dryRun) {
        try {
          fs.rmdirSync(shardAbs)
        } catch {
          /* non-empty → retained */
        }
      }
    }
    log("cas-gc", { dryRun, marked: marked.size, blobsTotal, sweepable: sweepable.length, swept: swept.length, keptByGrace })
    return report({ ok: true, marked: marked.size, blobsTotal, sweepable, swept, keptByGrace })
  } finally {
    releaseAll()
  }
}
