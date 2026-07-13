// REQ-100(issue #192)T1 —— Bundle 锁:每个环境根(REQ-098 env-scoped mutable root)同一时刻
// 只允许一个扩展事务(AC5:并发安装/卸载由跨进程锁串行化,不损坏 receipt 或配置)。
//
// 机制:
//   · 锁文件 `<root>/ext-tx/tx.lock`,`wx` 独占创建 = 本地文件系统上的原子互斥原语;
//     文件体记录持有者(pid/hostname/txId/心跳),供陈旧判定与诊断;
//   · 陈旧恢复(loud):同机 pid 已死,或心跳超过 staleMs —— 陈旧锁**改名移入**
//     `<root>/ext-tx/stale-locks/`(证据保留,绝不静默 unlink 别人的锁),记录注入日志,
//     然后重试独占创建;rename 本身原子,两个进程同时抢陈旧锁只有一个能改名成功;
//   · 非阻塞 tryAcquire:忙 → 如实返回持有者,由调用方决定排队/报错(引擎层不隐式等待);
//   · electron-free + 时钟/pid 探活可注入(单测确定性,不碰 mock.module —— 仓规:DI 面)。

import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { writeFileAtomicSync } from "./ext-atomic-fs"

export const BUNDLE_LOCK_STALE_MS_DEFAULT = 15 * 60_000

export type LockHolder = {
  v: 1
  pid: number
  hostname: string
  txId: string
  acquiredAt: string
  heartbeatAt: string
}

export type StaleLockInfo = {
  /** 解析出的持有者;锁文件不可解析时为 null(同样按陈旧处理,loud)。 */
  holder: LockHolder | null
  movedTo: string
  reason: string
}

export type BundleLock = {
  file: string
  holder: LockHolder
  /** 心跳续期(长事务在阶段转换处调用;非持有者态下拒绝改写)。 */
  refresh(): void
  /** 幂等释放:仍是本持有者才 unlink;否则 loud 不动(绝不删别人的锁)。 */
  release(): void
}

export type AcquireLockOptions = {
  txId: string
  staleMs?: number
  now?: () => Date
  /** pid 探活注入(默认 process.kill(pid, 0));仅对同 hostname 的持有者使用。 */
  pidAlive?: (pid: number) => boolean
  log?: (event: string, detail: Record<string, unknown>) => void
}

export type AcquireLockResult =
  | { ok: true; lock: BundleLock; recoveredStale?: StaleLockInfo }
  | { ok: false; reason: string; holder?: LockHolder }

const TX_DIR = "ext-tx"
const LOCK_FILE = "tx.lock"
const STALE_DIR = "stale-locks"

export function bundleLockPath(root: string): string {
  return path.join(root, TX_DIR, LOCK_FILE)
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM = 进程存在但无权限发信号 → 视为存活(fail closed:宁可判活也不抢活锁)
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function defaultLog(event: string, detail: Record<string, unknown>): void {
  console.error(`[ext-bundle-lock] ${event} ${JSON.stringify(detail)}`)
}

function parseHolder(text: string): LockHolder | null {
  try {
    const parsed = JSON.parse(text) as LockHolder
    if (!parsed || typeof parsed !== "object") return null
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return null
    if (typeof parsed.hostname !== "string" || typeof parsed.txId !== "string") return null
    if (typeof parsed.acquiredAt !== "string" || typeof parsed.heartbeatAt !== "string") return null
    return parsed
  } catch {
    return null
  }
}

/** 陈旧判定:不可解析 / 同机死 pid / 心跳超时。返回 null = 不陈旧(真持有中)。 */
function staleReason(
  holder: LockHolder | null,
  opts: { staleMs: number; now: () => Date; pidAlive: (pid: number) => boolean },
): string | null {
  if (!holder) return "lock file unreadable"
  if (holder.hostname === os.hostname() && !opts.pidAlive(holder.pid)) return `holder pid ${holder.pid} not alive`
  const beat = Date.parse(holder.heartbeatAt || holder.acquiredAt)
  if (Number.isNaN(beat)) return "lock heartbeat unreadable"
  const age = opts.now().getTime() - beat
  if (age > opts.staleMs) return `lock heartbeat stale (${age}ms > ${opts.staleMs}ms)`
  return null
}

/**
 * 非阻塞获取环境级 Bundle 锁。忙 → { ok:false, holder };陈旧 → 移走(loud)后接管,
 * recoveredStale 携带证据路径。
 */
export function tryAcquireBundleLock(root: string, opts: AcquireLockOptions): AcquireLockResult {
  if (!path.isAbsolute(root)) return { ok: false, reason: `lock root must be absolute: ${root}` }
  const staleMs = opts.staleMs ?? BUNDLE_LOCK_STALE_MS_DEFAULT
  const now = opts.now ?? (() => new Date())
  const pidAlive = opts.pidAlive ?? defaultPidAlive
  const log = opts.log ?? defaultLog
  const file = bundleLockPath(root)
  let recoveredStale: StaleLockInfo | undefined

  for (let attempt = 0; attempt < 3; attempt++) {
    const holder: LockHolder = {
      v: 1,
      pid: process.pid,
      hostname: os.hostname(),
      txId: opts.txId,
      acquiredAt: now().toISOString(),
      heartbeatAt: now().toISOString(),
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(holder, null, 2) + "\n", { flag: "wx" })
      return { ok: true, lock: makeLock(file, holder, { now, log }), recoveredStale }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        return { ok: false, reason: error instanceof Error ? error.message : "failed to create lock" }
      }
    }
    // 已有锁:读持有者 → 判陈旧
    let text: string
    try {
      text = fs.readFileSync(file, "utf8")
    } catch {
      continue // 读的瞬间被释放了 → 直接重试创建
    }
    const existing = parseHolder(text)
    const stale = staleReason(existing, { staleMs, now, pidAlive })
    if (!stale) {
      return {
        ok: false,
        reason: `bundle lock held by pid ${existing!.pid} (tx ${existing!.txId})`,
        holder: existing!,
      }
    }
    // 陈旧接管(loud):改名移入 stale-locks/ 保证据;rename 原子,竞争者只有一个成功
    const movedTo = path.join(
      path.dirname(file),
      STALE_DIR,
      `tx.lock.stale-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
    )
    try {
      fs.mkdirSync(path.dirname(movedTo), { recursive: true })
      fs.renameSync(file, movedTo)
    } catch {
      continue // 别的进程先接管/释放了 → 重试创建
    }
    recoveredStale = { holder: existing, movedTo, reason: stale }
    log("stale-lock-recovered", { root, movedTo, reason: stale, holder: existing ?? "unreadable" })
  }
  return { ok: false, reason: "bundle lock contention: could not acquire after stale recovery attempts" }
}

function makeLock(
  file: string,
  initial: LockHolder,
  deps: { now: () => Date; log: (event: string, detail: Record<string, unknown>) => void },
): BundleLock {
  let holder = initial
  let released = false
  const ownsFile = (): boolean => {
    try {
      const current = parseHolder(fs.readFileSync(file, "utf8"))
      return !!current && current.pid === holder.pid && current.txId === holder.txId
    } catch {
      return false
    }
  }
  return {
    file,
    get holder() {
      return holder
    },
    refresh() {
      if (released) return
      if (!ownsFile()) {
        deps.log("refresh-refused-not-owner", { file, txId: holder.txId })
        return
      }
      holder = { ...holder, heartbeatAt: deps.now().toISOString() }
      writeFileAtomicSync(file, JSON.stringify(holder, null, 2) + "\n")
    },
    release() {
      if (released) return
      released = true
      if (!ownsFile()) {
        deps.log("release-refused-not-owner", { file, txId: holder.txId })
        return
      }
      try {
        fs.unlinkSync(file)
      } catch {
        /* already gone = released */
      }
    },
  }
}
