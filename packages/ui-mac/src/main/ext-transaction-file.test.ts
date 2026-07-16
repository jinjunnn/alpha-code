// REQ-102 #358 —— file action(单文件 journaled 原子替换)进事务引擎:
//  · file(md)+ config(叶)同事务:全提交或全回滚,任意崩溃点后 live 要么全旧要么全新;
//  · 前像区分「缺席」与「零字节」(Codex 裁决 #358 B):恢复缺席态 = unlink,零字节前像 = 写回空文件;
//  · 旁路改写(既非 pre 也非 next)→ fail-closed 保留现状,绝不盲目覆盖;
//  · 崩溃恢复:全翻转 + probe 健康 + receipt 可重放 → 前滚 committed;部分翻转/健康未知 → 回滚。
// 依赖注入(仓规:零 mock.module);全走真盘临时目录。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse } from "jsonc-parser"
import { applyFileImage, prepareFileTx, restoreFileImage } from "./ext-file-tx"
import {
  ExtTxCrashError,
  listTransactionJournals,
  recoverExtensionTransactions,
  runExtensionTransaction,
  type HealthProbe,
  type TxCommitRecord,
  type TxCrashPoint,
  type TxHooks,
  type TxPlan,
} from "./ext-transaction"

let root: string
let cfgTarget: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ext-tx-file-"))
  cfgTarget = join(root, "alpha.jsonc")
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const MD = "---\ndescription: demo agent\n---\nbody"
const MD_PATH = () => join(root, "agents", "demo.md")
const noop = (): void => {}

function planFor(content: string): TxPlan {
  return {
    items: [
      {
        key: "agent--demo",
        action: "file",
        file: { relTarget: "agents/demo.md", next: Buffer.from(content) },
        receipt: { id: "agent:demo", name: "demo" },
      },
      {
        key: "agent--demo--config",
        action: "config",
        config: { target: cfgTarget, edits: [{ keyPath: ["agent", "demo"], value: { description: "demo agent", prompt: "body" } }] },
      },
    ],
  }
}

/** 内容语义探针:staged(pre-switch)/ live(post-switch/recovery)必须等于期望内容。 */
function fileProbe(expected: string): HealthProbe {
  return (input) => {
    if (input.action !== "file") return { healthy: true }
    const p = input.phase === "pre-switch" ? input.stagedFile : input.fileTarget
    try {
      return readFileSync(p!, "utf8") === expected ? { healthy: true } : { healthy: false, reason: "content mismatch" }
    } catch {
      return { healthy: false, reason: "target unreadable" }
    }
  }
}

function hooksFor(opts: { records?: TxCommitRecord[]; crashAt?: TxCrashPoint; probe?: HealthProbe; failReceipt?: boolean } = {}): TxHooks {
  return {
    populate: noop,
    probe: opts.probe ?? fileProbe(MD),
    commitReceipt: (records) => {
      if (opts.failReceipt) throw new Error("ledger unavailable (test)")
      opts.records?.push(...records)
    },
    log: noop,
    ...(opts.crashAt ? { crashAt: opts.crashAt } : {}),
  }
}

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)

const agentLeaf = (): unknown => {
  if (!existsSync(cfgTarget)) return undefined
  const cfg: unknown = parse(readFileSync(cfgTarget, "utf8"))
  const agentMap = isRec(cfg) ? cfg.agent : undefined
  return isRec(agentMap) ? agentMap["demo"] : undefined
}

describe("file action in runExtensionTransaction (REQ-102 #358)", () => {
  test("commits file + config atomically with typed commit records", async () => {
    const records: TxCommitRecord[] = []
    const r = await runExtensionTransaction(root, planFor(MD), hooksFor({ records }))
    expect(r.ok).toBe(true)
    expect(readFileSync(MD_PATH(), "utf8")).toBe(MD)
    expect(agentLeaf()).toEqual({ description: "demo agent", prompt: "body" })
    const fileRec = records.find((rec) => rec.action === "file")!
    expect(fileRec.key).toBe("agent--demo")
    expect(fileRec.fileTarget).toBe(MD_PATH())
    expect(fileRec.receipt).toEqual({ id: "agent:demo", name: "demo" })
    for (const j of listTransactionJournals(root)) expect(j.state).toBe("committed")
    // per-tx staging 残留清理(根目录本身可留空壳)。
    expect(readdirSync(join(root, "ext-tx", "staging"))).toEqual([])
  })

  test("receipt failure rolls back both: fresh target restored to ABSENT, config leaf restored", async () => {
    const r = await runExtensionTransaction(root, planFor(MD), hooksFor({ failReceipt: true }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.stage).toBe("receipt-commit")
    expect(existsSync(MD_PATH())).toBe(false) // preAbsent → unlink(不是留一个空文件)
    expect(agentLeaf()).toBeUndefined()
    for (const j of listTransactionJournals(root)) expect(j.state).toBe("rolled-back")
  })

  test("zero-byte preimage is restored as a zero-byte FILE (absent ≠ empty, Codex 裁决 B)", async () => {
    mkdirSync(join(root, "agents"), { recursive: true })
    writeFileSync(MD_PATH(), "") // 存在但零字节
    const r = await runExtensionTransaction(root, planFor(MD), hooksFor({ failReceipt: true }))
    expect(r.ok).toBe(false)
    expect(existsSync(MD_PATH())).toBe(true)
    expect(statSync(MD_PATH()).size).toBe(0)
  })

  test("pre-switch probe failure aborts with zero live changes", async () => {
    const r = await runExtensionTransaction(root, planFor(MD), hooksFor({ probe: fileProbe("something else") }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.stage).toBe("pre-switch-probe")
    expect(existsSync(MD_PATH())).toBe(false)
    expect(agentLeaf()).toBeUndefined()
    for (const j of listTransactionJournals(root)) expect(j.state).toBe("aborted")
  })

  test("crash mid-switch (file flipped, config not) → recovery restores bundle atomicity", async () => {
    await expect(runExtensionTransaction(root, planFor(MD), hooksFor({ crashAt: "mid-switch" }))).rejects.toThrow(ExtTxCrashError)
    expect(readFileSync(MD_PATH(), "utf8")).toBe(MD) // 崩溃时 file 已翻转
    const rec = await recoverExtensionTransactions(root, { probe: fileProbe(MD), commitReceipt: noop, pidAlive: () => false, log: noop })
    expect(rec.ok).toBe(true)
    expect(rec.reports[0].action).toBe("rolled-back")
    expect(existsSync(MD_PATH())).toBe(false) // 部分翻转 = 原子性破缺 → 回滚到全旧
    expect(agentLeaf()).toBeUndefined()
  })

  test("crash after-switched → recovery forward-commits (probe healthy, receipt replayed)", async () => {
    await expect(runExtensionTransaction(root, planFor(MD), hooksFor({ crashAt: "after-switched" }))).rejects.toThrow(ExtTxCrashError)
    const records: TxCommitRecord[] = []
    const rec = await recoverExtensionTransactions(root, {
      probe: fileProbe(MD),
      commitReceipt: (recs) => records.push(...recs),
      pidAlive: () => false,
      log: noop,
    })
    expect(rec.ok).toBe(true)
    expect(rec.reports[0].action).toBe("resumed-committed")
    expect(readFileSync(MD_PATH(), "utf8")).toBe(MD)
    expect(agentLeaf()).toEqual({ description: "demo agent", prompt: "body" })
    expect(records.find((r) => r.action === "file")?.fileTarget).toBe(MD_PATH())
    for (const j of listTransactionJournals(root)) expect(j.state).toBe("committed")
  })

  test("crash after-switched + live md tampered → recovery probe fails → rollback; tampered file kept (fail closed)", async () => {
    await expect(runExtensionTransaction(root, planFor(MD), hooksFor({ crashAt: "after-switched" }))).rejects.toThrow(ExtTxCrashError)
    writeFileSync(MD_PATH(), "tampered by bypass") // 旁路改写:既非 pre 也非 next
    const rec = await recoverExtensionTransactions(root, { probe: fileProbe(MD), commitReceipt: noop, pidAlive: () => false, log: noop })
    expect(rec.ok).toBe(true)
    expect(rec.reports[0].action).toBe("rolled-back")
    expect(readFileSync(MD_PATH(), "utf8")).toBe("tampered by bypass") // 绝不盲目覆盖旁路内容
    expect(agentLeaf()).toBeUndefined() // config 正常回滚
  })

  test("validatePlan refuses missing payload / unsafe relTarget / empty content / duplicate targets", async () => {
    const missing = await runExtensionTransaction(root, { items: [{ key: "a", action: "file" }] }, hooksFor())
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.reason).toContain("missing file payload")

    const escape = await runExtensionTransaction(
      root,
      { items: [{ key: "a", action: "file", file: { relTarget: "../evil.md", next: Buffer.from("x") } }] },
      hooksFor(),
    )
    expect(escape.ok).toBe(false)
    if (!escape.ok) expect(escape.reason).toContain("unsafe relTarget")

    const empty = await runExtensionTransaction(
      root,
      { items: [{ key: "a", action: "file", file: { relTarget: "agents/a.md", next: Buffer.alloc(0) } }] },
      hooksFor(),
    )
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.reason).toContain("non-empty Buffer")

    const dup = await runExtensionTransaction(
      root,
      {
        items: [
          { key: "a", action: "file", file: { relTarget: "agents/a.md", next: Buffer.from("x") } },
          { key: "b", action: "file", file: { relTarget: "agents/a.md", next: Buffer.from("y") } },
        ],
      },
      hooksFor(),
    )
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.reason).toContain("duplicate file target")
  })
})

describe("ext-file-tx image semantics (REQ-102 #358)", () => {
  test("refuses a symlink / non-regular target at prepare (fail closed before any write)", () => {
    mkdirSync(join(root, "agents", "demo.md"), { recursive: true }) // 目录占位 = 非常规文件
    const prep = prepareFileTx(MD_PATH(), Buffer.from(MD))
    expect(prep.ok).toBe(false)
    if (!prep.ok) expect(prep.reason).toContain("not a regular file")
  })

  test("restore is a noop when the switch never applied, and refuses divergence", () => {
    const prep = prepareFileTx(MD_PATH(), Buffer.from(MD))
    expect(prep.ok).toBe(true)
    if (!prep.ok) return
    // switch 未应用(目标仍缺席)→ noop。
    expect(restoreFileImage(prep.image)).toEqual({ ok: true, action: "noop" })
    // 应用后正常恢复缺席态。
    applyFileImage(prep.image)
    expect(readFileSync(MD_PATH(), "utf8")).toBe(MD)
    expect(restoreFileImage(prep.image)).toEqual({ ok: true, action: "restored" })
    expect(existsSync(MD_PATH())).toBe(false)
    // 旁路改写 → 拒绝覆盖。
    applyFileImage(prep.image)
    writeFileSync(MD_PATH(), "bypass")
    const diverged = restoreFileImage(prep.image)
    expect(diverged.ok).toBe(false)
    if (!diverged.ok) expect(diverged.reason).toContain("diverged")
    expect(readFileSync(MD_PATH(), "utf8")).toBe("bypass")
  })
})
