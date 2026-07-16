// REQ-102 #358 —— file action(单文件 journaled 原子替换)进事务引擎:
//  · file(md)+ config(叶)同事务:全提交或全回滚,任意崩溃点后 live 要么全旧要么全新;
//  · 前像区分「缺席」与「零字节」(Codex 裁决 #358 B):恢复缺席态 = unlink,零字节前像 = 写回空文件;
//  · 旁路改写(既非 pre 也非 next)→ fail-closed 保留现状,绝不盲目覆盖;
//  · 崩溃恢复:全翻转 + probe 健康 + receipt 可重放 → 前滚 committed;部分翻转/健康未知 → 回滚。
// 依赖注入(仓规:零 mock.module);全走真盘临时目录。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, existsSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse } from "jsonc-parser"
import { agentFileProbe, recoveryReceiptInputs } from "./ext-agent-install"
import { seedPluginFileProbe } from "./ext-install-planner"
import { applyFileImage, prepareFileTx, restoreFileImage } from "./ext-file-tx"
import { findRecordV2, upsertRecordsV2 } from "./ext-receipt-v2"
import { skillGenerationProbe } from "./ext-skill-generations"
import {
  ExtTxCrashError,
  listTransactionJournals,
  recoverExtensionTransactions,
  recoveryClean,
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

  test("crash after-switched + live md tampered → 保留非终态(旁路改写不终态化,review Blocker 3)", async () => {
    await expect(runExtensionTransaction(root, planFor(MD), hooksFor({ crashAt: "after-switched" }))).rejects.toThrow(ExtTxCrashError)
    writeFileSync(MD_PATH(), "tampered by bypass") // 旁路改写:既非 pre 也非 next
    const rec = await recoverExtensionTransactions(root, { probe: fileProbe(MD), commitReceipt: noop, pidAlive: () => false, log: noop })
    expect(rec.ok).toBe(true)
    // file restore 被旁路改写挡住 → 不宣称 rolled-back,journal 保持非终态供人工处置。
    expect(rec.reports[0].action).toBe("none")
    expect(recoveryClean(rec)).toBe(false)
    expect(readFileSync(MD_PATH(), "utf8")).toBe("tampered by bypass") // 绝不盲目覆盖旁路内容
    expect(agentLeaf()).toBeUndefined() // config 已幂等回滚(下轮 noop)
    const j = listTransactionJournals(root)[0]
    expect(j.state).toBe("switched") // 非终态保留 → 写方 gate 继续阻断
  })

  test("恢复期 staging 丢失 = 失据 → 保留非终态,零改动(review Blocker 3)", async () => {
    await expect(runExtensionTransaction(root, planFor(MD), hooksFor({ crashAt: "mid-switch" }))).rejects.toThrow(ExtTxCrashError)
    expect(readFileSync(MD_PATH(), "utf8")).toBe(MD) // file 已翻转,config 未翻转
    rmSync(join(root, "ext-tx", "staging"), { recursive: true, force: true })
    const rec = await recoverExtensionTransactions(root, { probe: fileProbe(MD), commitReceipt: noop, pidAlive: () => false, log: noop })
    expect(rec.ok).toBe(true)
    expect(rec.reports[0].action).toBe("none")
    expect(recoveryClean(rec)).toBe(false)
    expect(readFileSync(MD_PATH(), "utf8")).toBe(MD) // 失据时零改动(不盲回滚)
    const j = listTransactionJournals(root)[0]
    expect(j.state).toBe("switching")
  })

  test("父目录 symlink 逃逸在写盘前被圈禁拒绝(review Blocker 2)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "ext-tx-outside-"))
    try {
      symlinkSync(outside, join(root, "agents"))
      const r = await runExtensionTransaction(root, planFor(MD), hooksFor())
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.reason).toContain("confinement")
      expect(existsSync(join(outside, "demo.md"))).toBe(false) // root 外零写入
      expect(agentLeaf()).toBeUndefined()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test("恢复前滚同样过圈禁:agents 目录被换 symlink → 保留非终态,绝不落账(review r2 Blocker)", async () => {
    await expect(runExtensionTransaction(root, planFor(MD), hooksFor({ crashAt: "after-switched" }))).rejects.toThrow(ExtTxCrashError)
    // 崩溃后把真实 agents 目录换成指向 root 外的 symlink,外部文件内容恰与 nextDigest 一致 ——
    // 若前滚不重验圈禁,会为逃逸 root 的文件 probe + 落账并解除 recovery gate。
    const outside = mkdtempSync(join(tmpdir(), "ext-tx-outside-"))
    try {
      writeFileSync(join(outside, "demo.md"), MD)
      rmSync(join(root, "agents"), { recursive: true, force: true })
      symlinkSync(outside, join(root, "agents"))
      const records: TxCommitRecord[] = []
      const rec = await recoverExtensionTransactions(root, {
        probe: fileProbe(MD),
        commitReceipt: (recs) => records.push(...recs),
        pidAlive: () => false,
        log: noop,
      })
      expect(rec.ok).toBe(true)
      expect(rec.reports[0].action).toBe("none")
      expect(records).toHaveLength(0) // 零落账
      const j = listTransactionJournals(root)[0]
      expect(j.state).toBe("switched") // 非终态保留 → gate 继续阻断
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test("在线回滚遇 file 旁路改写 → 保留非终态、不删 staging 证据(review r2 Blocker)", async () => {
    // post-switch 探针先旁路改写 live md 再判不健康 → 触发在线 rollbackAll 的 file diverged 分支。
    const sabotage: HealthProbe = (input) => {
      if (input.action !== "file" || input.phase !== "post-switch") return { healthy: true }
      writeFileSync(input.fileTarget!, "bypass while switched")
      return { healthy: false, reason: "sabotaged (test)" }
    }
    const r = await runExtensionTransaction(root, planFor(MD), hooksFor({ probe: sabotage }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain("retained non-terminal")
    expect(readFileSync(MD_PATH(), "utf8")).toBe("bypass while switched") // 绝不盲目覆盖旁路内容
    expect(agentLeaf()).toBeUndefined() // config 已幂等回旧
    const j = listTransactionJournals(root)[0]
    expect(j.state).toBe("switched") // 不终态化(终态化会解除写方 gate 阻断)
    expect(readdirSync(join(root, "ext-tx", "staging")).length).toBeGreaterThan(0) // 证据保留
  })

  test("圈禁在 apply 前紧邻重验:pre-switch 后父目录被换 symlink → 零树外写入,保留非终态(review r3 Blocker)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "ext-tx-outside-"))
    try {
      // pre-switch 探针窗口内(staging/materialize 之后、switch 之前)把 agents 换成树外 symlink。
      const swapProbe: HealthProbe = (input) => {
        if (input.action === "file" && input.phase === "pre-switch") {
          rmSync(join(root, "agents"), { recursive: true, force: true })
          symlinkSync(outside, join(root, "agents"))
        }
        return { healthy: true }
      }
      const r = await runExtensionTransaction(root, planFor(MD), hooksFor({ probe: swapProbe }))
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.reason).toContain("confinement")
      expect(r.reason).toContain("retained non-terminal") // restore 侧重验同样拦下 → 保留非终态
      expect(readdirSync(outside)).toEqual([]) // 树外零写入(tmp 文件也没有)
      expect(agentLeaf()).toBeUndefined()
      const j = listTransactionJournals(root)[0]
      expect(j.state).toBe("switching")
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test("生产恢复接线语义:composed probe + 过滤 receipt 前滚(review Blocker 1)", async () => {
    const iso = new Date().toISOString()
    const receipt = {
      id: "agent:demo",
      name: "demo",
      kind: "agent",
      environment: "prod",
      scope: { kind: "global" },
      desiredState: "enabled",
      origin: "catalog",
      installedAt: iso,
      configKey: "agent.demo",
      files: [MD_PATH()],
    }
    const plan: TxPlan = {
      items: [
        { key: "agent--demo", action: "file", file: { relTarget: "agents/demo.md", next: Buffer.from(MD) }, receipt },
        {
          key: "agent--demo--config",
          action: "config",
          config: { target: cfgTarget, edits: [{ keyPath: ["agent", "demo"], value: { description: "demo agent", prompt: "body" } }] },
        },
      ],
    }
    await expect(runExtensionTransaction(root, plan, hooksFor({ crashAt: "after-switched" }))).rejects.toThrow(ExtTxCrashError)
    // 生产 recoveryOpts 同构:skillGenerationProbe + agentFileProbe 组合、recoveryReceiptInputs 过滤。
    const fileP = agentFileProbe(root)
    const rec = await recoverExtensionTransactions(root, {
      probe: async (input) => {
        const gen = await skillGenerationProbe(input)
        if (!gen.healthy) return gen
        return fileP(input)
      },
      commitReceipt: (recs) => {
        const written = upsertRecordsV2(root, recoveryReceiptInputs(recs))
        if (!written.ok) throw new Error(written.reason)
      },
      pidAlive: () => false,
      log: noop,
    })
    expect(rec.ok).toBe(true)
    expect(rec.reports[0].action).toBe("resumed-committed") // config 副 item 不再让重放失败
    expect(readFileSync(MD_PATH(), "utf8")).toBe(MD)
    expect(agentLeaf()).toEqual({ description: "demo agent", prompt: "body" })
    const record = findRecordV2(root, "agent", "demo")
    expect(record).not.toBeNull()
    expect(record!.configKey).toBe("agent.demo")
  })

  test("requireAbsent:锁内前像在场即结构化拒(#359 r3 —— 未策展不认领的执行层断言)", async () => {
    mkdirSync(join(root, "agents"), { recursive: true })
    writeFileSync(MD_PATH(), "bypass-planted content")
    const r = await runExtensionTransaction(
      root,
      { items: [{ key: "agent--demo", action: "file", file: { relTarget: "agents/demo.md", next: Buffer.from(MD), requireAbsent: true } }] },
      hooksFor(),
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.stage).toBe("staging")
    expect(r.reason).toContain("must be absent")
    expect(readFileSync(MD_PATH(), "utf8")).toBe("bypass-planted content") // 零覆盖
  })

  test("requireAbsent 在 switch 前紧邻重断言:prepare→apply 窗口内旁路植入 → 拒且保留非终态(#359 r4)", async () => {
    // pre-switch 探针窗口(prepare 之后、switch 之前)植入计划内目标文件。
    const plantProbe: HealthProbe = (input) => {
      if (input.action === "file" && input.phase === "pre-switch") {
        mkdirSync(join(root, "agents"), { recursive: true })
        writeFileSync(MD_PATH(), "planted in the async window")
      }
      return { healthy: true }
    }
    const r = await runExtensionTransaction(
      root,
      { items: [{ key: "agent--demo", action: "file", file: { relTarget: "agents/demo.md", next: Buffer.from(MD), requireAbsent: true } }] },
      { populate: noop, probe: plantProbe, commitReceipt: noop, log: noop },
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain("appeared before switch")
    expect(r.reason).toContain("retained non-terminal") // 植入内容 diverged → 保留非终态留证
    expect(readFileSync(MD_PATH(), "utf8")).toBe("planted in the async window") // 零覆盖
    const j = listTransactionJournals(root)[0]
    expect(j.state).toBe("switching")
  })

  test("同 digest 植入(在线):未 applied 的 requireAbsent 目标绝不 unlink,保留非终态留证(#359 r5)", async () => {
    // 窗口内植入的内容**恰等于** nextDigest —— 只看 digest 会把它误认本事务输出而在回滚时 unlink。
    const plantSame: HealthProbe = (input) => {
      if (input.action === "file" && input.phase === "pre-switch") {
        mkdirSync(join(root, "agents"), { recursive: true })
        writeFileSync(MD_PATH(), MD)
      }
      return { healthy: true }
    }
    const r = await runExtensionTransaction(
      root,
      { items: [{ key: "agent--demo", action: "file", file: { relTarget: "agents/demo.md", next: Buffer.from(MD), requireAbsent: true } }] },
      { populate: noop, probe: plantSame, commitReceipt: noop, log: noop },
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain("retained non-terminal")
    expect(readFileSync(MD_PATH(), "utf8")).toBe(MD) // 植入文件原样保留(不是我们的输出,不 unlink)
    expect(listTransactionJournals(root)[0].state).toBe("switching")
  })

  test("同 digest 植入(崩溃恢复):未 applied → 不前滚落账、不 unlink,保留非终态(#359 r5)", async () => {
    // 崩溃在 switching journal 落盘后、任何 apply 之前;随后旁路植入同 digest 内容。
    await expect(
      runExtensionTransaction(
        root,
        { items: [{ key: "agent--demo", action: "file", file: { relTarget: "agents/demo.md", next: Buffer.from(MD), requireAbsent: true }, receipt: { id: "agent:demo" } }] },
        { populate: noop, probe: fileProbe(MD), commitReceipt: noop, log: noop, crashAt: "after-switching-journal" },
      ),
    ).rejects.toThrow(ExtTxCrashError)
    mkdirSync(join(root, "agents"), { recursive: true })
    writeFileSync(MD_PATH(), MD) // 同 digest 植入
    const records: TxCommitRecord[] = []
    const rec = await recoverExtensionTransactions(root, {
      probe: fileProbe(MD),
      commitReceipt: (recs) => records.push(...recs),
      pidAlive: () => false,
      log: noop,
    })
    expect(rec.ok).toBe(true)
    expect(rec.reports[0].action).toBe("none") // 未 applied → 不判翻转 → 不前滚
    expect(records).toHaveLength(0) // 零落账(绝不认领外部字节)
    expect(readFileSync(MD_PATH(), "utf8")).toBe(MD) // 植入文件原样保留
    expect(listTransactionJournals(root)[0].state).toBe("switching")
  })

  test("legacy #358 journal(无 requireAbsent/applied)按发布时语义前滚,不误回滚(#359 r6 兼容)", async () => {
    // 用新引擎制造 after-switched 崩溃,再从盘上剥掉新字段 = 忠实模拟升级前遗留的在途 journal。
    await expect(runExtensionTransaction(root, planFor(MD), hooksFor({ crashAt: "after-switched" }))).rejects.toThrow(ExtTxCrashError)
    const jDir = join(root, "ext-tx", "journal")
    const jName = readdirSync(jDir).find((n) => n.endsWith(".json"))
    if (!jName) throw new Error("journal missing")
    const jFile = join(jDir, jName)
    const legacy: unknown = parse(readFileSync(jFile, "utf8"))
    if (!isRec(legacy) || !Array.isArray(legacy.items)) throw new Error("journal shape")
    for (const it of legacy.items) {
      if (isRec(it) && isRec(it.file)) {
        delete it.file.requireAbsent
        delete it.file.applied
      }
    }
    writeFileSync(jFile, JSON.stringify(legacy))
    const records: TxCommitRecord[] = []
    const rec = await recoverExtensionTransactions(root, {
      probe: fileProbe(MD),
      commitReceipt: (recs) => records.push(...recs),
      pidAlive: () => false,
      log: noop,
    })
    expect(rec.ok).toBe(true)
    expect(rec.reports[0].action).toBe("resumed-committed") // already-switched 的遗留事务前滚,绝不误回滚
    expect(readFileSync(MD_PATH(), "utf8")).toBe(MD)
    expect(agentLeaf()).toEqual({ description: "demo agent", prompt: "body" })
    expect(records.length).toBeGreaterThan(0) // receipt 重放发生
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

describe("plugin seed 形状的崩溃恢复(REQ-102 #359:载荷 file items + config 单事务)", () => {
  const PJS = "export const Demo = async () => ({})"
  const LIB = "export const u = 1"
  const pluginPlan = (): TxPlan => {
    const iso = new Date().toISOString()
    const dir = join(root, "plugins", "demo@abcdef0123456789")
    return {
      items: [
        { key: "plugin--demo--f0", action: "file", file: { relTarget: "plugins/demo@abcdef0123456789/plugin.js", next: Buffer.from(PJS) } },
        { key: "plugin--demo--f1", action: "file", file: { relTarget: "plugins/demo@abcdef0123456789/lib/util.js", next: Buffer.from(LIB) } },
        {
          key: "plugin--demo",
          action: "config",
          config: { target: cfgTarget, edits: [{ keyPath: ["plugin"], value: [join(dir, "plugin.js")] }] },
          receipt: {
            id: "plugin:demo",
            name: "demo",
            kind: "plugin",
            environment: "prod",
            scope: { kind: "global" },
            desiredState: "enabled",
            origin: "catalog",
            installedAt: iso,
            configKey: `plugin-path:${join(dir, "plugin.js")}`,
            files: [dir],
          },
        },
      ],
    }
  }
  const routerProbe = (): HealthProbe => {
    const agentProbe = agentFileProbe(root)
    const pluginProbe = seedPluginFileProbe()
    return async (input) => {
      const gen = await skillGenerationProbe(input)
      if (!gen.healthy) return gen
      if (input.action !== "file") return { healthy: true }
      return input.key.startsWith("agent--") ? agentProbe(input) : pluginProbe(input)
    }
  }

  test("crash after-switched → 生产路由探针验载荷 digest 后前滚,receipt 过滤重放落单条账", async () => {
    await expect(
      runExtensionTransaction(root, pluginPlan(), { populate: noop, probe: seedPluginFileProbe(), commitReceipt: noop, log: noop, crashAt: "after-switched" }),
    ).rejects.toThrow(ExtTxCrashError)
    const rec = await recoverExtensionTransactions(root, {
      probe: routerProbe(),
      commitReceipt: (recs) => {
        const written = upsertRecordsV2(root, recoveryReceiptInputs(recs))
        if (!written.ok) throw new Error(written.reason)
      },
      pidAlive: () => false,
      log: noop,
    })
    expect(rec.ok).toBe(true)
    expect(rec.reports[0].action).toBe("resumed-committed")
    const dir = join(root, "plugins", "demo@abcdef0123456789")
    expect(readFileSync(join(dir, "plugin.js"), "utf8")).toBe(PJS)
    expect(readFileSync(join(dir, "lib", "util.js"), "utf8")).toBe(LIB)
    expect(findRecordV2(root, "plugin", "demo")).not.toBeNull()
  })

  test("crash after-switched + 载荷被篡改 → digest 判未翻转 → 回滚(文件恢复缺席、config 回旧)", async () => {
    await expect(
      runExtensionTransaction(root, pluginPlan(), { populate: noop, probe: seedPluginFileProbe(), commitReceipt: noop, log: noop, crashAt: "after-switched" }),
    ).rejects.toThrow(ExtTxCrashError)
    const dir = join(root, "plugins", "demo@abcdef0123456789")
    writeFileSync(join(dir, "lib", "util.js"), "tampered payload")
    const rec = await recoverExtensionTransactions(root, { probe: routerProbe(), commitReceipt: noop, pidAlive: () => false, log: noop })
    expect(rec.ok).toBe(true)
    // 篡改文件 digest ≠ next → 部分翻转 → 回滚;被篡改文件 diverged fail-closed 保留非终态。
    expect(rec.reports[0].action).toBe("none")
    expect(findRecordV2(root, "plugin", "demo")).toBeNull() // 绝不为篡改载荷落账
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
