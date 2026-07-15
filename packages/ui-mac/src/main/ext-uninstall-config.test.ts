// REQ-100 #346 —— config 卸载事务与恢复的崩溃注入矩阵(Codex 裁决的测试面):
//  · action=config:journal 先行、锁内 removeArtifacts(config→secrets)→ commitLedger → 终态;
//  · 任一步失败 = journal 保持 uninstalling(绝不谎报),恢复经 uninstallArtifacts seam 幂等前滚;
//  · 缺 seam / 未知 action / 畸形 items = 保持非终态(修掉「缺 seam 假终态」双 bug:
//    recoverUninstall 缺 commitUninstall、recoverRollback 缺 commitReceipt 此前都会标终态);
//  · 恢复 seam 在恢复锁内运行 —— 锁内再取 bundle 锁必 busy(seam 只准用 in-lock 原语)。
// 真盘 fixture:artifact = 临时“配置文件”,真实 fs 删除/真实 EACCES 注入(非 void mock)。
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { tryAcquireBundleLock } from "./ext-bundle-lock"
import {
  probeTransactionJournals,
  recoverExtensionTransactions,
  uninstallExtensionTransaction,
  type TxJournal,
} from "./ext-transaction"

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ext-uncfg-"))
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const journalDir = () => path.join(root, "ext-tx", "journal")
const journalStates = () => probeTransactionJournals(root).entries.map((j) => `${j.op}:${j.state}`)

function writeRawJournal(j: Partial<TxJournal> & { txId: string }): void {
  fs.mkdirSync(journalDir(), { recursive: true })
  const body: TxJournal = {
    v: 1,
    txId: j.txId,
    op: j.op ?? "uninstall",
    state: j.state ?? "uninstalling",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    items: j.items ?? [{ key: "mcp--demo", action: "config", genId: "gen-000000-000000", files: [] }],
    ...(j.reason ? { reason: j.reason } : {}),
  }
  fs.writeFileSync(path.join(journalDir(), `${j.txId}.json`), JSON.stringify(body))
}

describe("uninstallExtensionTransaction — action=config", () => {
  test("happy path:artifacts 在锁内删(锁内重取必 busy)→ commitLedger → 终态 uninstalled", async () => {
    const cfgFile = path.join(root, "fake-config.json")
    fs.writeFileSync(cfgFile, "{}")
    const order: string[] = []
    const r = await uninstallExtensionTransaction(root, "mcp--demo", {
      action: "config",
      removeArtifacts: () => {
        // 锁契约证明:此刻 bundle 锁被本事务持有 → 重取必 busy
        const reacquire = tryAcquireBundleLock(root, { txId: "tx-intruder" })
        expect(reacquire.ok).toBe(false)
        fs.rmSync(cfgFile) // 真实 fs artifact 删除
        order.push("artifacts")
      },
      commitLedger: () => {
        order.push("ledger")
      },
    })
    expect(r.ok).toBe(true)
    expect(order).toEqual(["artifacts", "ledger"]) // config→ledger 秩序
    expect(fs.existsSync(cfgFile)).toBe(false)
    expect(journalStates()).toEqual(["uninstall:uninstalled"])
  })

  test("action=config 缺 removeArtifacts → 写 journal 前拒绝(零副作用)", async () => {
    const r = await uninstallExtensionTransaction(root, "mcp--demo", { action: "config" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("removeArtifacts")
    expect(fs.existsSync(journalDir())).toBe(false) // journal 目录都没建
  })

  test("artifacts 真实 I/O 失败(EACCES)→ journal 保持 uninstalling;修复后恢复前滚收敛", async () => {
    const guard = path.join(root, "protected")
    const secretFile = path.join(guard, "secret.bin")
    fs.mkdirSync(guard, { recursive: true })
    fs.writeFileSync(secretFile, "s3cret")
    fs.chmodSync(guard, 0o555) // 目录只读 → 删除子文件必 EACCES
    const r = await uninstallExtensionTransaction(root, "mcp--demo", {
      action: "config",
      removeArtifacts: () => {
        fs.rmSync(secretFile) // 真实 EACCES,不是 mock throw
      },
      commitLedger: () => {},
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("artifact removal failed")
    expect(journalStates()).toEqual(["uninstall:uninstalling"]) // 非终态保留

    // 修复环境(chmod 回来)→ 恢复经 seam 幂等前滚:artifacts 删净 + 去账 + 终态
    fs.chmodSync(guard, 0o755)
    let ledgerRemoved = 0
    const rec = await recoverExtensionTransactions(root, {
      uninstallArtifacts: (key) => {
        expect(key).toBe("mcp--demo")
        fs.rmSync(secretFile, { force: true }) // 幂等
      },
      commitUninstall: () => {
        ledgerRemoved++
      },
    })
    expect(rec.ok).toBe(true)
    expect(ledgerRemoved).toBe(1)
    expect(fs.existsSync(secretFile)).toBe(false)
    expect(journalStates()).toEqual(["uninstall:uninstalled"])

    // 再跑一遍恢复:已终态,零动作(幂等)
    const again = await recoverExtensionTransactions(root, {
      uninstallArtifacts: () => {
        throw new Error("must not be called on terminal journal")
      },
      commitUninstall: () => {
        throw new Error("must not be called on terminal journal")
      },
    })
    expect(again.ok).toBe(true)
  })

  test("commitLedger 失败 → artifacts 已净除、journal 非终态;恢复补删账收敛", async () => {
    const cfgFile = path.join(root, "fake-config.json")
    fs.writeFileSync(cfgFile, "{}")
    const r = await uninstallExtensionTransaction(root, "mcp--demo", {
      action: "config",
      removeArtifacts: () => fs.rmSync(cfgFile),
      commitLedger: () => {
        throw new Error("ledger write EIO")
      },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("ledger")
    expect(fs.existsSync(cfgFile)).toBe(false)
    expect(journalStates()).toEqual(["uninstall:uninstalling"])
    const rec = await recoverExtensionTransactions(root, {
      uninstallArtifacts: () => {
        /* 幂等 no-op:artifact 已不在 */
      },
      commitUninstall: () => {},
    })
    expect(rec.ok).toBe(true)
    expect(journalStates()).toEqual(["uninstall:uninstalled"])
  })
})

describe("recoverUninstall / recoverRollback — 缺 seam 与畸形 journal 绝不假终态", () => {
  test("config journal 缺 uninstallArtifacts seam → 保持非终态", async () => {
    writeRawJournal({ txId: "tx-cfg-1" })
    const rec = await recoverExtensionTransactions(root, { commitUninstall: () => {} })
    expect(rec.ok).toBe(true)
    expect(rec.reports[0]!.detail).toContain("missing uninstallArtifacts seam")
    expect(journalStates()).toEqual(["uninstall:uninstalling"])
  })

  test("generation journal 缺 commitUninstall seam → 保持非终态(此前假终态,回归锁)", async () => {
    writeRawJournal({ txId: "tx-gen-1", items: [{ key: "skill--demo", genId: "gen-000000-000000", files: [] }] })
    const rec = await recoverExtensionTransactions(root, {})
    expect(rec.ok).toBe(true)
    expect(rec.reports[0]!.detail).toContain("missing commitUninstall seam")
    expect(journalStates()).toEqual(["uninstall:uninstalling"])
  })

  test("未知 action / 空 items / 多 items → 保持非终态待人工诊断", async () => {
    writeRawJournal({ txId: "tx-bad-1", items: [{ key: "x--y", action: "receipt" as never, genId: "gen-000000-000000", files: [] }] })
    writeRawJournal({ txId: "tx-bad-2", items: [] })
    writeRawJournal({
      txId: "tx-bad-3",
      items: [
        { key: "a--b", genId: "gen-000000-000000", files: [] },
        { key: "c--d", genId: "gen-000000-000000", files: [] },
      ],
    })
    const rec = await recoverExtensionTransactions(root, { uninstallArtifacts: () => {}, commitUninstall: () => {} })
    expect(rec.ok).toBe(true)
    expect(journalStates().sort()).toEqual(["uninstall:uninstalling", "uninstall:uninstalling", "uninstall:uninstalling"])
  })

  test("恢复 seam 在恢复锁内运行:seam 内重取 bundle 锁必 busy", async () => {
    writeRawJournal({ txId: "tx-cfg-2" })
    let checked = false
    const rec = await recoverExtensionTransactions(root, {
      uninstallArtifacts: () => {
        const reacquire = tryAcquireBundleLock(root, { txId: "tx-intruder-2" })
        expect(reacquire.ok).toBe(false)
        checked = true
      },
      commitUninstall: () => {},
    })
    expect(rec.ok).toBe(true)
    expect(checked).toBe(true)
    expect(journalStates()).toEqual(["uninstall:uninstalled"])
  })

  test("rollback journal:receipt 在而 commitReceipt seam 缺 → 保持非终态(此前假终态,回归锁)", async () => {
    writeRawJournal({
      txId: "tx-rb-1",
      op: "rollback",
      state: "switching",
      items: [{ key: "skill--demo", genId: "gen-000001-abcdef12", files: [], receipt: { any: "template" } } as never],
    })
    const rec = await recoverExtensionTransactions(root, {})
    expect(rec.ok).toBe(true)
    expect(rec.reports[0]!.detail).toContain("missing commitReceipt seam")
    const rb = probeTransactionJournals(root).entries.find((j) => j.txId === "tx-rb-1")
    expect(rb!.state).not.toBe("committed")
  })
})

describe("generation 卸载 owned-path 删除失败 → journal 保留(#346 相邻缺口加固)", () => {
  test("generation 目录不可删(真实 EACCES)→ 非终态;修复后前滚收敛", async () => {
    const genDir = path.join(root, "ext-store", "skill--demo", "generations", "gen-000001-abcdef12")
    fs.mkdirSync(genDir, { recursive: true })
    fs.writeFileSync(path.join(genDir, "SKILL.md"), "x")
    fs.chmodSync(genDir, 0o555) // 目录内容不可删
    const r = await uninstallExtensionTransaction(root, "skill--demo", { commitLedger: () => {} })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("store removal incomplete")
    expect(journalStates()).toEqual(["uninstall:uninstalling"])
    fs.chmodSync(genDir, 0o755)
    const rec = await recoverExtensionTransactions(root, { commitUninstall: () => {} })
    expect(rec.ok).toBe(true)
    expect(journalStates()).toEqual(["uninstall:uninstalled"])
    expect(fs.existsSync(path.join(root, "ext-store", "skill--demo"))).toBe(false)
  })
})
