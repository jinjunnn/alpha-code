// REQ-100 #347 —— 写方事务准入 gate 的行为矩阵(Codex 裁决口径):
//  · 非终态 journal:gate 先恢复收敛,操作在收敛后的终态账本上执行;
//  · 收敛不了(缺 seam / 活锁 / corrupt / journal 目录不可枚举)→ 拒,body 绝不执行;
//  · corrupt journal:本轮拒 + .corrupt-* 留证,下轮(无 corrupt)放行 —— 不因 .json 被移走就判安全;
//  · 进程内 per-root mutex:并发写方串行,不存在「恢复后释放再竞争」窗口;
//  · gatedWriteHandler:root 解析失败原样返回零副作用;拒绝短路 body;成功透传实参与返回值。
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { tryAcquireBundleLock } from "./ext-bundle-lock"
import { gatedWriteHandler, makeRecoveryGate, type RecoveryGate } from "./ext-recovery-gate"
import { probeTransactionJournals, type RecoverOptions } from "./ext-transaction"

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ext-gate-"))
})
afterEach(() => {
  try {
    fs.chmodSync(path.join(root, "ext-tx", "journal"), 0o755)
  } catch {
    /* 不存在/已可写 */
  }
  fs.rmSync(root, { recursive: true, force: true })
})

const journalDir = () => path.join(root, "ext-tx", "journal")

function writeUninstallJournal(txId: string, key = "skill--demo"): void {
  fs.mkdirSync(journalDir(), { recursive: true })
  fs.writeFileSync(
    path.join(journalDir(), `${txId}.json`),
    JSON.stringify({
      v: 1,
      txId,
      op: "uninstall",
      state: "uninstalling",
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
      items: [{ key, genId: "gen-000000-000000", files: [] }],
    }),
  )
}

const fullOpts = (): RecoverOptions => ({
  commitUninstall: () => {},
  uninstallArtifacts: () => {},
})
const gateWith = (opts: () => RecoverOptions): RecoveryGate => makeRecoveryGate(() => opts())

describe("withRecoveredWrite — 准入判据", () => {
  test("非终态 journal → 先收敛再执行 op(op 看到的是全终态账本)", async () => {
    writeUninstallJournal("tx-open-1")
    const gate = gateWith(fullOpts)
    let sawTerminal = false
    const r = await gate.withRecoveredWrite(root, async () => {
      const probe = probeTransactionJournals(root)
      sawTerminal = probe.entries.every((j) => j.terminal)
      return { ok: true as const }
    })
    expect(r).toEqual({ ok: true })
    expect(sawTerminal).toBe(true)
  })

  test("收敛不了(缺 seam,journal 保持非终态)→ 拒且 op 不执行", async () => {
    writeUninstallJournal("tx-open-2")
    const gate = gateWith(() => ({})) // 无 commitUninstall seam → 保持 uninstalling
    let ran = false
    const r = await gate.withRecoveredWrite(root, async () => {
      ran = true
      return { ok: true as const }
    })
    expect(ran).toBe(false)
    expect((r as { ok: false; reason: string }).reason).toContain("non-terminal transaction journal remains")
  })

  test("活锁(bundle 锁被活 pid 持有)→ 拒且 op 不执行(不抢活锁)", async () => {
    const held = tryAcquireBundleLock(root, { txId: "tx-live" })
    expect(held.ok).toBe(true)
    if (!held.ok) return
    let ran = false
    try {
      const r = await gateWith(fullOpts).withRecoveredWrite(root, async () => {
        ran = true
        return { ok: true as const }
      })
      expect(ran).toBe(false)
      expect((r as { ok: false; reason: string }).reason).toContain("recovery incomplete")
    } finally {
      held.lock.release()
    }
  })

  test("corrupt journal → 本轮拒(留 .corrupt-* 证据),重试放行", async () => {
    fs.mkdirSync(journalDir(), { recursive: true })
    fs.writeFileSync(path.join(journalDir(), "tx-corrupt.json"), "{not json")
    const gate = gateWith(fullOpts)
    let ran = false
    const first = await gate.withRecoveredWrite(root, async () => {
      ran = true
      return { ok: true as const }
    })
    expect(ran).toBe(false)
    expect((first as { ok: false; reason: string }).reason).toContain("corrupt transaction journal quarantined")
    // 证据保留(.corrupt-* 文件),原 .json 已移走
    const entries = fs.readdirSync(journalDir())
    expect(entries.some((n) => n.includes(".corrupt-"))).toBe(true)
    expect(entries.some((n) => n === "tx-corrupt.json")).toBe(false)
    // 下轮:无 corrupt → 放行
    const second = await gate.withRecoveredWrite(root, async () => ({ ok: true as const }))
    expect(second).toEqual({ ok: true })
  })

  test("journal 目录不可枚举 → 拒(fail closed)", async () => {
    writeUninstallJournal("tx-open-3")
    const gate = gateWith(fullOpts)
    fs.chmodSync(journalDir(), 0o000)
    let ran = false
    try {
      const r = await gate.withRecoveredWrite(root, async () => {
        ran = true
        return { ok: true as const }
      })
      expect(ran).toBe(false)
      expect((r as { ok: false; reason: string }).reason.length).toBeGreaterThan(0)
    } finally {
      fs.chmodSync(journalDir(), 0o755)
    }
  })

  test("进程内 mutex:同根并发写方严格串行(恢复→探测→操作同链,无窗口)", async () => {
    const gate = gateWith(fullOpts)
    const order: string[] = []
    const slow = gate.withRecoveredWrite(root, async () => {
      order.push("a-start")
      await new Promise((r) => setTimeout(r, 40))
      order.push("a-end")
      return "a"
    })
    const fast = gate.withRecoveredWrite(root, async () => {
      order.push("b-start")
      return "b"
    })
    const [ra, rb] = await Promise.all([slow, fast])
    expect(ra).toBe("a")
    expect(rb).toBe("b")
    expect(order).toEqual(["a-start", "a-end", "b-start"])
  })

  test("op 抛错不毒化 mutex 链(下一个写方照常执行)", async () => {
    const gate = gateWith(fullOpts)
    await expect(
      gate.withRecoveredWrite(root, async () => {
        throw new Error("op exploded")
      }),
    ).rejects.toThrow("op exploded")
    const next = await gate.withRecoveredWrite(root, async () => ({ ok: true as const }))
    expect(next).toEqual({ ok: true })
  })
})

describe("gatedWriteHandler — 结构性接入(假 registrar 行为断言)", () => {
  test("root 解析失败 → 原样返回,gate 与 body 都不执行", async () => {
    let gateCalls = 0
    const spyGate: RecoveryGate = {
      withRecoveredWrite: async (_root, op) => {
        gateCalls++
        return op()
      },
    }
    let bodyCalls = 0
    const h = gatedWriteHandler(
      spyGate,
      (v: unknown) => (typeof v === "string" ? { ok: true as const, root } : { ok: false as const, reason: "bad intent" }),
      async (_v: unknown) => {
        bodyCalls++
        return { ok: true as const }
      },
    )
    expect(await h(42)).toEqual({ ok: false, reason: "bad intent" })
    expect(gateCalls).toBe(0)
    expect(bodyCalls).toBe(0)
  })

  test("gate 拒绝 → body 短路;放行 → body 收到原实参、root 传对", async () => {
    const seenRoots: string[] = []
    let admit = false
    const spyGate: RecoveryGate = {
      withRecoveredWrite: async (r, op) => {
        seenRoots.push(r)
        if (!admit) return { ok: false as const, reason: "gate says no" }
        return op()
      },
    }
    const seenArgs: unknown[] = []
    const h = gatedWriteHandler(
      spyGate,
      (..._a: unknown[]) => ({ ok: true as const, root: "/resolved/root" }),
      async (a: unknown, b: unknown) => {
        seenArgs.push(a, b)
        return "done"
      },
    )
    expect(await h("x", 7)).toEqual({ ok: false, reason: "gate says no" })
    expect(seenArgs).toEqual([])
    admit = true
    expect(await h("x", 7)).toBe("done")
    expect(seenArgs).toEqual(["x", 7])
    expect(seenRoots).toEqual(["/resolved/root", "/resolved/root"])
  })
})
