// REQ-100 #375 —— 不可诊断 journal 的诊断面 + 显式 retire:
//  · 诊断分类矩阵(retained/结构畸形/已隔离/不可解析/symlink/终态跳过/unreadable-root/体内 txId 不一致);
//  · retire 全链(锁内最后收敛 → fingerprint 复核 → 两阶段 receipt → rename;probe/gate 联动解锁);
//  · 拒绝面(锁忙/指纹漂移/终态/缺席/确认 flag/note 界/entryId 圈禁);
//  · 崩溃窗口调和(prepared+dest → retired;prepared+source → abandoned;list 报 retire-incomplete);
//  · 恢复自守(items 非数组不再炸整轮;shape-ok 可收敛件被收敛后 retire 如实拒);
//  · wire 解码器与 JOURNAL_ADMIN_CHANNELS 构造器行为。
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { tryAcquireBundleLock } from "./ext-bundle-lock"
import {
  decodeJournalListIntent,
  decodeJournalRetireIntent,
  listRetainedJournals,
  retireTransactionJournal,
  type JournalRootRef,
  type RetireJournalRequest,
} from "./ext-journal-retire"
import { makeRecoveryGate } from "./ext-recovery-gate"
import { buildJournalAdminChannels } from "./ext-write-channels"
import {
  probeTransactionJournals,
  recoverExtensionTransactions,
  recoverExtensionTransactionsInHeldLock,
  transactionJournalLayout,
} from "./ext-transaction"

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ext-jretire-"))
})
afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

const DIGEST_A = "a".repeat(64)
const silentLog = (): void => {}

function mkRoot(name: string): JournalRootRef {
  const root = join(base, name)
  mkdirSync(join(root, "ext-tx", "journal"), { recursive: true })
  return { identity: name, root }
}

/** 有效形状、恢复无法收敛(generation 卸载缺 commitUninstall seam → retained for retry)。 */
function retainedUninstallJournal(txId: string): Record<string, unknown> {
  return {
    txId,
    op: "uninstall",
    state: "uninstalling",
    items: [{ key: "skill--demo", genId: "gen-000000-000000", action: "generation", files: [{ sha256: DIGEST_A }] }],
  }
}

function writeJournal(ref: JournalRootRef, name: string, body: unknown): string {
  const p = join(transactionJournalLayout(ref.root).journalDir, name)
  writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body))
  return p
}

function sha256Of(p: string): string {
  return createHash("sha256").update(readFileSync(p)).digest("hex")
}

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)

/** 零断言读 JSON 对象(receipt/outcome 断言用)。 */
function readRec(p: string): Record<string, unknown> {
  const v: unknown = JSON.parse(readFileSync(p, "utf8"))
  if (!isRec(v)) throw new Error(`not a JSON object: ${p}`)
  return v
}

function retireReq(ref: JournalRootRef, entryId: string, over: Partial<RetireJournalRequest> = {}): RetireJournalRequest {
  return {
    entryId,
    txId: entryId.slice(0, -".json".length),
    journalSha256: sha256Of(join(transactionJournalLayout(ref.root).journalDir, entryId)),
    note: "manually verified live config/store/ledger consistent; giving up on this tx",
    liveStateChecked: true,
    casMarkRemovalAcknowledged: true,
    ...over,
  }
}

const retireDeps = { recoverInHeldLock: (root: string) => recoverExtensionTransactionsInHeldLock(root, { log: silentLog }), log: silentLog }

describe("listRetainedJournals(#375 诊断分类矩阵)", () => {
  test("retained(结构畸形/state 依赖)、终态跳过、不可解析、已隔离、symlink、体内 txId 不一致", () => {
    const ref = mkRoot("diag")
    const layout = transactionJournalLayout(ref.root)
    writeJournal(ref, "tx-a.json", retainedUninstallJournal("tx-a")) // state 依赖保留
    writeJournal(ref, "tx-b.json", { txId: "tx-b", op: "install", state: "staging", items: {} }) // 结构畸形
    writeJournal(ref, "tx-c.json", { txId: "tx-c", op: "install", state: "committed", items: [] }) // 终态 → 跳过
    writeJournal(ref, "tx-d.json", "{ not json") // 不可解析
    writeJournal(ref, "tx-e.json.corrupt-123", "junk") // 已隔离留证
    writeJournal(ref, "tx-f.json", { txId: "tx-其实是别的", op: "install", state: "staging", items: [] }) // 体内 txId 不一致
    symlinkSync(join(base, "outside.json"), join(layout.journalDir, "tx-g.json"))
    mkdirSync(join(layout.stagingDir, "tx-a"), { recursive: true }) // staging 残留 → stagingPresent

    const { entries } = listRetainedJournals([ref])
    const byId = new Map(entries.map((e) => ["entryId" in e ? e.entryId : e.kind, e]))
    const a = byId.get("tx-a.json")
    if (a?.kind !== "retained") throw new Error("tx-a should be retained")
    expect(a.reasonSource).toBe("state")
    expect(a.keys).toEqual(["skill--demo"])
    expect(a.markDigestCount).toBe(1)
    expect(a.stagingPresent).toBe(true)
    expect(a.journalSha256).toBe(sha256Of(join(layout.journalDir, "tx-a.json")))
    expect(a.bytes).toBeGreaterThan(0)
    expect(["birthtime", "mtime"]).toContain(a.firstSeenAtSource)
    expect(a.path.startsWith("ext-tx/")).toBe(true) // root-relative
    const b = byId.get("tx-b.json")
    if (b?.kind !== "retained") throw new Error("tx-b should be retained")
    expect(b.reasonSource).toBe("structure")
    expect(b.reason).toContain("items is not an array")
    expect(byId.has("tx-c.json")).toBe(false) // 终态不属诊断面
    const d = byId.get("tx-d.json")
    expect(d?.kind).toBe("malformed-entry")
    const e = byId.get("tx-e.json.corrupt-123")
    expect(e?.kind).toBe("already-quarantined")
    const f = byId.get("tx-f.json")
    if (f?.kind !== "retained") throw new Error("tx-f should be retained")
    expect(f.txId).toBe("tx-f")
    expect(f.bodyTxId).toBe("tx-其实是别的")
    const g = byId.get("tx-g.json")
    expect(g?.kind).toBe("malformed-entry")
  })

  test("journal 目录位置被文件占据 → unreadable-root(不静默当空)", () => {
    const root = join(base, "occupied")
    mkdirSync(join(root, "ext-tx"), { recursive: true })
    writeFileSync(join(root, "ext-tx", "journal"), "not a dir")
    const { entries } = listRetainedJournals([{ identity: "occupied", root }])
    expect(entries).toHaveLength(1)
    expect(entries[0]?.kind).toBe("unreadable-root")
  })

  test("journal 目录不存在 = 确无 journal(零条目,非失据)", () => {
    const root = join(base, "empty-root")
    mkdirSync(root, { recursive: true })
    expect(listRetainedJournals([{ identity: "empty", root }]).entries).toHaveLength(0)
  })
})

describe("recovery 自守(#375:畸形 journal 不炸整轮)", () => {
  test("items 非数组的 install journal → retained diagnosis,同轮其它 journal 照常收敛", async () => {
    const ref = mkRoot("selfguard")
    writeJournal(ref, "tx-bad.json", { txId: "tx-bad", op: "install", state: "staging", items: {} })
    writeJournal(ref, "tx-ok.json", { txId: "tx-ok", op: "install", state: "staging", items: [] })
    const rec = await recoverExtensionTransactions(ref.root, { log: silentLog })
    expect(rec.ok).toBe(true)
    const bad = rec.reports.find((r) => r.txId === "tx-bad")
    expect(bad?.action).toBe("none")
    expect(bad?.detail).toContain("items is not an array")
    expect(bad?.detail).toContain("retained for manual diagnosis")
  })
})

describe("retireTransactionJournal(#375 全链与拒绝面)", () => {
  test("happy path:两阶段 receipt + rename;probe/恢复 gate 联动解锁;原字节保留", async () => {
    const ref = mkRoot("happy")
    const layout = transactionJournalLayout(ref.root)
    const src = writeJournal(ref, "tx-r.json", retainedUninstallJournal("tx-r"))
    const originalBytes = readFileSync(src)
    mkdirSync(join(layout.stagingDir, "tx-r"), { recursive: true })

    // retire 前:gate 拒(非终态在场)。
    const gate = makeRecoveryGate(() => ({ log: silentLog }))
    const refused = await gate.withRecoveredWrite(ref.root, async () => "ran")
    expect(refused).not.toBe("ran")

    const r = await retireTransactionJournal(ref, retireReq(ref, "tx-r.json"), retireDeps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.markDigestCount).toBe(1)
    expect(r.stagingPresent).toBe(true)
    expect(r.recoveryOutcome).toContain("retained")
    // journal 已移出、原字节保留、receipt 终态 retired。
    expect(existsSync(src)).toBe(false)
    const moved = join(ref.root, r.movedTo)
    expect(readFileSync(moved).equals(originalBytes)).toBe(true)
    const receipt = readRec(join(ref.root, r.receiptPath))
    expect(receipt.status).toBe("retired")
    expect(receipt.sourceSha256).toBe(sha256Of(moved))
    expect(receipt.note).toBeTruthy()
    expect(receipt.liveStateChecked).toBe(true)
    expect(receipt.casMarkRemovalAcknowledged).toBe(true)
    expect(receipt.stagingPresent).toBe(true)
    expect(typeof receipt.retiredAt).toBe("string")
    // 枚举面不再看见:probe 全终态(空),gate 放行。
    expect(probeTransactionJournals(ref.root).entries).toHaveLength(0)
    const admitted = await gate.withRecoveredWrite(ref.root, async () => "ran")
    expect(admitted).toBe("ran")
    // staging 残留只报告不处置。
    expect(existsSync(join(layout.stagingDir, "tx-r"))).toBe(true)
  })

  test("锁忙(事务/GC/恢复在途)→ 如实拒绝", async () => {
    const ref = mkRoot("busy")
    writeJournal(ref, "tx-x.json", retainedUninstallJournal("tx-x"))
    const req = retireReq(ref, "tx-x.json")
    const held = tryAcquireBundleLock(ref.root, { txId: "tx-holder", log: silentLog })
    if (!held.ok) throw new Error("test lock acquire failed")
    try {
      const r = await retireTransactionJournal(ref, req, retireDeps)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain("retry later")
    } finally {
      held.lock.release()
    }
  })

  test("fingerprint 漂移 / 终态 / 缺席 / 确认 flag / note / entryId 圈禁 → 逐项拒", async () => {
    const ref = mkRoot("refuse")
    writeJournal(ref, "tx-y.json", retainedUninstallJournal("tx-y"))
    const good = retireReq(ref, "tx-y.json")
    // fingerprint 漂移
    const drift = await retireTransactionJournal(ref, { ...good, journalSha256: "b".repeat(64) }, retireDeps)
    expect(drift.ok).toBe(false)
    if (!drift.ok) expect(drift.reason).toContain("fingerprint mismatch")
    // 可被恢复收敛的 journal(staging → aborted 终态)→ 拒「terminal」
    writeJournal(ref, "tx-conv.json", { txId: "tx-conv", op: "install", state: "staging", items: [] })
    const conv = await retireTransactionJournal(ref, retireReq(ref, "tx-conv.json"), retireDeps)
    expect(conv.ok).toBe(false)
    if (!conv.ok) expect(conv.reason).toContain("fingerprint mismatch") // 收敛改写了 journal → 指纹先失配(如实:须重新诊断)
    // 缺席
    const absent = await retireTransactionJournal(ref, { ...good, entryId: "tx-none.json", journalSha256: "c".repeat(64) }, retireDeps)
    expect(absent.ok).toBe(false)
    if (!absent.ok) expect(absent.reason).toContain("no longer present")
    // 确认 flag / note / entryId
    for (const bad of [
      { ...good, liveStateChecked: false },
      { ...good, casMarkRemovalAcknowledged: false },
      { ...good, note: "   " },
      { ...good, note: "x".repeat(501) },
      { ...good, entryId: "../escape.json" },
      { ...good, entryId: "tx-e.json.corrupt-1" },
    ]) {
      const r = await retireTransactionJournal(ref, bad, retireDeps)
      expect(r.ok).toBe(false)
    }
  })

  test("恢复能收敛的 journal:锁内最后收敛后按新事实拒(绝不 retire 可自愈件)", async () => {
    const ref = mkRoot("converge")
    writeJournal(ref, "tx-s.json", { txId: "tx-s", op: "install", state: "staging", items: [] })
    const req = retireReq(ref, "tx-s.json") // 指纹取自收敛前
    const r = await retireTransactionJournal(ref, req, retireDeps)
    expect(r.ok).toBe(false) // staging → recovery 置 aborted(journal 被改写)→ 指纹失配拒
    // 收敛后 journal 已终态:即便拿新指纹重试也拒 terminal。
    const retry = await retireTransactionJournal(ref, retireReq(ref, "tx-s.json"), retireDeps)
    expect(retry.ok).toBe(false)
    if (!retry.ok) expect(retry.reason).toContain("terminal")
  })

  test("崩溃窗口调和:prepared+dest → 补记 retired;prepared+source → abandoned;list 报 retire-incomplete", async () => {
    const ref = mkRoot("crash")
    const layout = transactionJournalLayout(ref.root)
    mkdirSync(layout.retiredDir, { recursive: true })
    // 场景 A:rename 已发生、receipt 停在 prepared。
    writeFileSync(join(layout.retiredDir, "tx-a.json.retired-deadbeef"), JSON.stringify(retainedUninstallJournal("tx-a")))
    writeFileSync(
      join(layout.retiredDir, "retire-deadbeef.receipt.json"),
      JSON.stringify({ v: 1, action: "retire", status: "prepared", requestId: "deadbeef", entryId: "tx-a.json", txId: "tx-a", destinationName: "tx-a.json.retired-deadbeef" }),
    )
    // 场景 B:rename 未发生、receipt 停在 prepared,源仍在场。
    writeJournal(ref, "tx-b.json", retainedUninstallJournal("tx-b"))
    writeFileSync(
      join(layout.retiredDir, "retire-beefdead.receipt.json"),
      JSON.stringify({ v: 1, action: "retire", status: "prepared", requestId: "beefdead", entryId: "tx-b.json", txId: "tx-b", destinationName: "tx-b.json.retired-beefdead" }),
    )
    // 调和前:诊断面把两条 prepared 残留如实列出。
    const before = listRetainedJournals([ref]).entries.filter((e) => e.kind === "retire-incomplete")
    expect(before).toHaveLength(2)
    expect(before.find((e) => e.kind === "retire-incomplete" && e.entryId === "tx-a.json")?.destinationPresent).toBe(true)
    // 任意一次 retire 操作锁内先调和(用 tx-b 自身走一遍;调和先行,随后 tx-b 正常 retire)。
    const r = await retireTransactionJournal(ref, retireReq(ref, "tx-b.json"), retireDeps)
    expect(r.ok).toBe(true)
    const receiptA = readRec(join(layout.retiredDir, "retire-deadbeef.receipt.json"))
    expect(receiptA.status).toBe("retired")
    expect(receiptA.reconciled).toBe(true)
    const receiptB = readRec(join(layout.retiredDir, "retire-beefdead.receipt.json"))
    expect(receiptB.status).toBe("abandoned") // tx-b 的旧 prepared 在调和时源仍在场 → abandoned;随后的新 retire 有自己的新 receipt
    const receipts = readdirSync(layout.retiredDir).filter((n) => n.endsWith(".receipt.json"))
    expect(receipts.length).toBe(3) // 两张调和件 + tx-b 新 retire 件
  })
})

describe("wire 解码器(#375 裁决 Q4)", () => {
  test("list intent:空/合法/未知键/非法 projectDir", () => {
    expect(decodeJournalListIntent(undefined).ok).toBe(true)
    expect(decodeJournalListIntent({}).ok).toBe(true)
    expect(decodeJournalListIntent({ projectDir: "/p" }).ok).toBe(true)
    expect(decodeJournalListIntent({ extra: 1 }).ok).toBe(false)
    expect(decodeJournalListIntent({ projectDir: "" }).ok).toBe(false)
  })

  test("retire intent:scope 严格、flag 字面 true、note 界、指纹形状、未知键拒", () => {
    const good = {
      scope: { kind: "global", environment: "prod" },
      entryId: "tx-1.json",
      txId: "tx-1",
      journalSha256: "a".repeat(64),
      note: "checked",
      liveStateChecked: true,
      casMarkRemovalAcknowledged: true,
    }
    expect(decodeJournalRetireIntent(good).ok).toBe(true)
    for (const bad of [
      { ...good, scope: { kind: "global", environment: "staging" } },
      { ...good, scope: { kind: "global", environment: "prod", extra: 1 } },
      { ...good, scope: { kind: "project", projectDir: "" } },
      { ...good, scope: { kind: "other" } },
      { ...good, entryId: "../x.json" },
      { ...good, journalSha256: "short" },
      { ...good, note: "" },
      { ...good, liveStateChecked: 1 },
      { ...good, casMarkRemovalAcknowledged: "yes" },
      { ...good, extra: true },
    ]) {
      expect(decodeJournalRetireIntent(bad).ok).toBe(false)
    }
  })
})

describe("JOURNAL_ADMIN_CHANNELS 构造器(#375 裁决 Q4:renderer 无任意 root 通道)", () => {
  const globalRoots = (): JournalRootRef[] => [
    { identity: "dev", root: "/g/dev" },
    { identity: "prod", root: "/g/prod" },
    { identity: "beta", root: "/g/beta" },
  ]

  test("list:global 三根恒聚合;projectDir 解析失败原样返回不静默降级", () => {
    const seen: JournalRootRef[][] = []
    const admin = buildJournalAdminChannels({
      globalRoots,
      projectRoot: (dir) => (dir === "/ok" ? { ok: true, root: "/ok/.alpha" } : { ok: false, reason: "fail closed" }),
      list: (roots) => {
        seen.push(roots)
        return { entries: [] }
      },
      retire: () => Promise.resolve({ ok: false, reason: "unused" }),
    })
    admin.retainedList(undefined)
    expect(seen[0]?.map((r) => r.identity)).toEqual(["dev", "prod", "beta"])
    admin.retainedList({ projectDir: "/ok" })
    expect(seen[1]?.map((r) => r.identity)).toEqual(["dev", "prod", "beta", "project:/ok"])
    const refused = admin.retainedList({ projectDir: "/bad" })
    expect(refused).toEqual({ ok: false, reason: "fail closed" })
    expect(seen).toHaveLength(2) // 解析失败零副作用
  })

  test("retire:scope 路由到 main 派生根;project 解析 fail-closed;seam 收到解码后的请求", async () => {
    const calls: Array<{ ref: JournalRootRef; req: RetireJournalRequest }> = []
    const admin = buildJournalAdminChannels({
      globalRoots,
      projectRoot: (dir) => (dir === "/ok" ? { ok: true, root: "/ok/.alpha" } : { ok: false, reason: "fail closed" }),
      list: () => ({ entries: [] }),
      retire: (ref, req) => {
        calls.push({ ref, req })
        return Promise.resolve({ ok: true })
      },
    })
    const intent = {
      scope: { kind: "prod" }, // 非法
      entryId: "tx-1.json",
      txId: "tx-1",
      journalSha256: "a".repeat(64),
      note: "n",
      liveStateChecked: true,
      casMarkRemovalAcknowledged: true,
    }
    const bad = await admin.retire(intent)
    expect(isRec(bad) && bad.ok).toBe(false)
    await admin.retire({ ...intent, scope: { kind: "global", environment: "beta" } })
    expect(calls[0]?.ref).toEqual({ identity: "beta", root: "/g/beta" })
    expect(calls[0]?.req.entryId).toBe("tx-1.json")
    const proj = await admin.retire({ ...intent, scope: { kind: "project", projectDir: "/bad" } })
    expect(isRec(proj) ? proj.reason : undefined).toBe("fail closed")
    expect(calls).toHaveLength(1)
  })
})
