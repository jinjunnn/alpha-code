// REQ-100 —— Bundle 锁单测:互斥、争用、陈旧恢复(死 pid / 心跳超时 / 不可读)全走真盘;
// pid 探活与时钟按仓规走参数注入(不碰 mock.module)。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { bundleLockPath, tryAcquireBundleLock, type LockHolder } from "./ext-bundle-lock"

let root: string
const logs: Array<{ event: string; detail: Record<string, unknown> }> = []
const log = (event: string, detail: Record<string, unknown>) => logs.push({ event, detail })

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ext-lock-"))
  logs.length = 0
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const readHolder = (): LockHolder => JSON.parse(fs.readFileSync(bundleLockPath(root), "utf8"))

describe("tryAcquireBundleLock", () => {
  test("acquires and records the holder", () => {
    const r = tryAcquireBundleLock(root, { txId: "tx-a-00000001", log })
    if (!r.ok) throw new Error(r.reason)
    const holder = readHolder()
    expect(holder.pid).toBe(process.pid)
    expect(holder.txId).toBe("tx-a-00000001")
    r.lock.release()
    expect(fs.existsSync(bundleLockPath(root))).toBe(false)
  })

  test("second acquire while held → busy with holder info (mutual exclusion)", () => {
    const first = tryAcquireBundleLock(root, { txId: "tx-a-00000001", log })
    if (!first.ok) throw new Error(first.reason)
    const second = tryAcquireBundleLock(root, { txId: "tx-b-00000002", log })
    expect(second.ok).toBe(false)
    if (second.ok) throw new Error("unreachable")
    expect(second.reason).toContain("held by pid")
    expect(second.holder?.txId).toBe("tx-a-00000001")
    first.lock.release()
    const third = tryAcquireBundleLock(root, { txId: "tx-b-00000002", log })
    expect(third.ok).toBe(true)
    if (third.ok) third.lock.release()
  })

  test("dead-pid stale lock is recovered loudly with evidence preserved", () => {
    const first = tryAcquireBundleLock(root, { txId: "tx-dead-00000001", log })
    if (!first.ok) throw new Error(first.reason)
    // 模拟持有进程死亡:锁文件在,pid 探活返回 false
    const r = tryAcquireBundleLock(root, { txId: "tx-b-00000002", log, pidAlive: () => false })
    if (!r.ok) throw new Error(r.reason)
    expect(r.recoveredStale?.reason).toContain("not alive")
    expect(r.recoveredStale?.holder?.txId).toBe("tx-dead-00000001")
    expect(fs.existsSync(r.recoveredStale!.movedTo)).toBe(true) // 证据保留在 stale-locks/
    expect(logs.some((l) => l.event === "stale-lock-recovered")).toBe(true)
    r.lock.release()
  })

  test("heartbeat-timeout stale lock is recovered (injected clock)", () => {
    const t0 = new Date("2026-07-12T10:00:00Z")
    const first = tryAcquireBundleLock(root, { txId: "tx-old-00000001", log, now: () => t0 })
    if (!first.ok) throw new Error(first.reason)
    const later = new Date(t0.getTime() + 16 * 60_000)
    const r = tryAcquireBundleLock(root, { txId: "tx-b-00000002", log, now: () => later, pidAlive: () => true })
    if (!r.ok) throw new Error(r.reason)
    expect(r.recoveredStale?.reason).toContain("stale")
    r.lock.release()
  })

  test("live holder within ttl is NOT stolen even from another host", () => {
    const foreign: LockHolder = {
      v: 1,
      pid: 999999,
      hostname: "other-host",
      txId: "tx-x-00000009",
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    }
    fs.mkdirSync(path.dirname(bundleLockPath(root)), { recursive: true })
    fs.writeFileSync(bundleLockPath(root), JSON.stringify(foreign))
    const r = tryAcquireBundleLock(root, { txId: "tx-b-00000002", log, pidAlive: () => false })
    expect(r.ok).toBe(false) // 异机持有者不做 pid 判定,只認 ttl —— 心跳新鲜则不抢
  })

  test("unreadable lock file counts as stale (loud takeover)", () => {
    fs.mkdirSync(path.dirname(bundleLockPath(root)), { recursive: true })
    fs.writeFileSync(bundleLockPath(root), "{ not json")
    const r = tryAcquireBundleLock(root, { txId: "tx-b-00000002", log })
    if (!r.ok) throw new Error(r.reason)
    expect(r.recoveredStale?.reason).toContain("unreadable")
    expect(r.recoveredStale?.holder).toBeNull()
    r.lock.release()
  })

  test("refresh advances heartbeat; refused once the file belongs to someone else", () => {
    const t0 = new Date("2026-07-12T10:00:00Z")
    let t = t0
    const r = tryAcquireBundleLock(root, { txId: "tx-a-00000001", log, now: () => t })
    if (!r.ok) throw new Error(r.reason)
    t = new Date(t0.getTime() + 60_000)
    r.lock.refresh()
    expect(readHolder().heartbeatAt).toBe(t.toISOString())
    // 锁文件被他人顶替(如陈旧接管竞态)→ refresh/release 拒绝碰别人的锁
    const other: LockHolder = { ...readHolder(), pid: process.pid + 1, txId: "tx-z-00000099" }
    fs.writeFileSync(bundleLockPath(root), JSON.stringify(other))
    r.lock.refresh()
    r.lock.release()
    expect(JSON.parse(fs.readFileSync(bundleLockPath(root), "utf8")).txId).toBe("tx-z-00000099")
    expect(logs.some((l) => l.event === "release-refused-not-owner")).toBe(true)
  })

  test("release is idempotent", () => {
    const r = tryAcquireBundleLock(root, { txId: "tx-a-00000001", log })
    if (!r.ok) throw new Error(r.reason)
    r.lock.release()
    r.lock.release()
    expect(fs.existsSync(bundleLockPath(root))).toBe(false)
  })

  test("relative root is refused", () => {
    const r = tryAcquireBundleLock("not-absolute", { txId: "tx-a-00000001", log })
    expect(r.ok).toBe(false)
  })
})
