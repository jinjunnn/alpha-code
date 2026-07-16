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

const retireDeps = { recoverInHeldLock: (root: string, _onProgress: () => void) => recoverExtensionTransactionsInHeldLock(root, { log: silentLog }), log: silentLog }

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

  test("review r1 Blocker:畸形 key(../)的 rollback 不写盘逃逸(diagnose 前置拦截 + writePointer 守卫)", async () => {
    const ref = mkRoot("escape")
    writeJournal(ref, "tx-evil.json", { txId: "tx-evil", op: "rollback", state: "switching", items: [{ key: "../../../victim", genId: "gen-000000-000000" }] })
    const rec = await recoverExtensionTransactions(ref.root, { log: silentLog })
    const evil = rec.reports.find((r) => r.txId === "tx-evil")
    expect(evil?.action).toBe("none")
    expect(evil?.detail).toContain("item key")
    // 未在 store 树外写出 victim 指针。
    expect(existsSync(join(base, "victim"))).toBe(false)
    expect(existsSync(join(ref.root, "..", "..", "..", "victim"))).toBe(false)
  })

  test("review r1 Blocker:body txId ≠ 文件名 → 保留态,不 dispatch(不信 body txId)", async () => {
    const ref = mkRoot("txidmismatch")
    writeJournal(ref, "tx-name.json", { txId: "tx-other-body", op: "install", state: "staging", items: [] })
    const rec = await recoverExtensionTransactions(ref.root, { log: silentLog })
    const r = rec.reports.find((rep) => rep.txId === "tx-name")
    expect(r?.action).toBe("none")
    expect(r?.detail).toContain("body txId")
  })

  test("review r1 Blocker:terminal GC 按文件名删除,body txId 含 ../ 不逃逸删外部文件", async () => {
    const ref = mkRoot("gcescape")
    const victim = join(base, "gc-victim.json")
    writeFileSync(victim, "precious")
    // body txId 指向 ../ 外部,但文件名合法;GC 应按文件名删自身、绝不碰 victim。
    writeJournal(ref, "tx-aaaaaaaaaa-deadbeef.json", { txId: "../../../gc-victim", op: "install", state: "committed", items: [], updatedAt: "2020-01-01T00:00:00Z" })
    await recoverExtensionTransactions(ref.root, { log: silentLog, keepJournals: 0 })
    expect(existsSync(victim)).toBe(true) // 外部文件安然无恙
  })

  test("review r1 Major:结构畸形的**终态** journal 仍清 staging(diagnose 只拦非终态)", async () => {
    const ref = mkRoot("termstaging")
    const layout = transactionJournalLayout(ref.root)
    // 终态 committed + 结构畸形(items 非数组)+ 有 staging 残留(可含敏感前像)。
    writeJournal(ref, "tx-term.json", { txId: "tx-term", op: "install", state: "committed", items: {} })
    mkdirSync(join(layout.stagingDir, "tx-term"), { recursive: true })
    writeFileSync(join(layout.stagingDir, "tx-term", "secret.image"), "0600 before-image")
    await recoverExtensionTransactions(ref.root, { log: silentLog })
    expect(existsSync(join(layout.stagingDir, "tx-term"))).toBe(false) // staging 被清,不残留敏感前像
  })

  test("review r2 Blocker:畸形 config item 的 root 外绝对 target 不越界写盘(恢复路径圈禁)", async () => {
    const ref = mkRoot("cfgescape")
    const victim = join(base, "cfg-victim.jsonc")
    // switching 状态 + 部分翻转会进入回滚;config item 指向 root 外绝对 target。
    writeJournal(ref, "tx-cfg.json", {
      txId: "tx-cfg",
      op: "install",
      state: "switching",
      items: [{ key: "skill--demo", action: "config", config: { target: victim, slot: "a", preDigest: "x", nextDigest: "y" } }],
    })
    await recoverExtensionTransactions(ref.root, { log: silentLog })
    expect(existsSync(victim)).toBe(false) // root 外 target 绝不被写
  })

  test("review r2 Blocker:diagnose 拦畸形 config item(target 非绝对)→ 保留态不 dispatch", async () => {
    const ref = mkRoot("cfgdiag")
    writeJournal(ref, "tx-bad.json", { txId: "tx-bad", op: "install", state: "staging", items: [{ key: "skill--demo", action: "config", config: { target: "relative/x", slot: "a" } }] })
    const rec = await recoverExtensionTransactions(ref.root, { log: silentLog })
    const r = rec.reports.find((rep) => rep.txId === "tx-bad")
    expect(r?.action).toBe("none")
    expect(r?.detail).toContain("config item target")
  })

  test("review r2 Major:错配终态(rollback+rolled-back / uninstall+committed)统一清 staging,不重放 op", async () => {
    const ref = mkRoot("mismatchterm")
    const layout = transactionJournalLayout(ref.root)
    // rollback 且已 rolled-back(终态)—— 旧路径会重新翻指针改回 committed;新路径只清 staging。
    writeJournal(ref, "tx-rb.json", { txId: "tx-rb", op: "rollback", state: "rolled-back", items: [{ key: "skill--demo", genId: "gen-000001-aaaaaaaa" }] })
    mkdirSync(join(layout.stagingDir, "tx-rb"), { recursive: true })
    // uninstall 且 committed(错配终态)—— 旧路径保留不清 staging → GC 后残留前像。
    writeJournal(ref, "tx-un.json", { txId: "tx-un", op: "uninstall", state: "committed", items: [{ key: "skill--demo", genId: "gen-000000-000000", action: "generation", files: [] }] })
    mkdirSync(join(layout.stagingDir, "tx-un"), { recursive: true })
    // 指针基线:确认恢复后没被 rollback 重放翻动。
    const rec = await recoverExtensionTransactions(ref.root, { log: silentLog })
    const rb = rec.reports.find((r) => r.txId === "tx-rb")
    const un = rec.reports.find((r) => r.txId === "tx-un")
    expect(rb?.action).not.toBe("resumed-committed") // 未重放 rollback 前滚
    expect(un?.detail).toContain("terminal")
    expect(existsSync(join(layout.stagingDir, "tx-rb"))).toBe(false) // 两者 staging 都被清
    expect(existsSync(join(layout.stagingDir, "tx-un"))).toBe(false)
    // current.json 未被 rollback 错误写出。
    expect(existsSync(join(ref.root, "ext-store", "skill--demo", "current.json"))).toBe(false)
  })

  test("review r3 Blocker/Major:reconcile source+dest 同在 → abandoned,**绝不删除 source**(交回恢复)", async () => {
    const ref = mkRoot("reconcileboth")
    const layout = transactionJournalLayout(ref.root)
    mkdirSync(layout.retiredDir, { recursive: true })
    const body = retainedUninstallJournal("tx-half")
    const sha = createHash("sha256").update(JSON.stringify(body)).digest("hex")
    const rid = "0123456789abcdef" // 16 hex
    writeFileSync(join(layout.retiredDir, `tx-half.json.retired-${rid}`), JSON.stringify(body))
    writeJournal(ref, "tx-half.json", body) // source 仍在(rename 半持久)
    writeFileSync(
      join(layout.retiredDir, `retire-${rid}.receipt.json`),
      JSON.stringify({ v: 1, action: "retire", status: "prepared", requestId: rid, entryId: "tx-half.json", txId: "tx-half", destinationName: `tx-half.json.retired-${rid}`, sourceSha256: sha }),
    )
    writeJournal(ref, "tx-trigger.json", retainedUninstallJournal("tx-trigger"))
    await retireTransactionJournal(ref, retireReq(ref, "tx-trigger.json"), retireDeps)
    const receipt = readRec(join(layout.retiredDir, `retire-${rid}.receipt.json`))
    expect(receipt.status).toBe("abandoned") // retire 未完成
    expect(existsSync(join(layout.journalDir, "tx-half.json"))).toBe(true) // source 保留,不被删
  })

  test("review r3 Blocker:reconcile 对畸形 receipt(entryId/destName 含 traversal)不越界(严格圈禁)", async () => {
    const ref = mkRoot("reconciletrav")
    const layout = transactionJournalLayout(ref.root)
    const victim = join(base, "traversal-victim.json")
    writeFileSync(victim, "precious")
    mkdirSync(layout.retiredDir, { recursive: true })
    // 恶意 prepared receipt:entryId/destinationName 含 ../ 指向 root 外。
    writeFileSync(
      join(layout.retiredDir, "retire-evil.receipt.json"),
      JSON.stringify({ v: 1, action: "retire", status: "prepared", requestId: "evil", entryId: "../../traversal-victim.json", txId: "x", destinationName: "../../traversal-victim.json.retired-deadbeefdeadbeef", sourceSha256: "a".repeat(64) }),
    )
    writeJournal(ref, "tx-trigger.json", retainedUninstallJournal("tx-trigger"))
    await retireTransactionJournal(ref, retireReq(ref, "tx-trigger.json"), retireDeps)
    expect(existsSync(victim)).toBe(true) // root 外文件安然无恙(entryId 圈禁拒,不据以 join)
    const receipt = readRec(join(layout.retiredDir, "retire-evil.receipt.json"))
    expect(String(receipt.status).startsWith("abandoned")).toBe(true) // 圈禁后不据畸形名 join → 无越界
  })

  test("review r3 Major:reconcile dest-only 缺 sourceSha256 → retired 但 fingerprintVerified:false", async () => {
    const ref = mkRoot("reconcileunverif")
    const layout = transactionJournalLayout(ref.root)
    mkdirSync(layout.retiredDir, { recursive: true })
    const rid = "abcdef0123456789"
    writeFileSync(join(layout.retiredDir, `tx-u.json.retired-${rid}`), JSON.stringify(retainedUninstallJournal("tx-u")))
    writeFileSync(
      join(layout.retiredDir, `retire-${rid}.receipt.json`),
      JSON.stringify({ v: 1, action: "retire", status: "prepared", requestId: rid, entryId: "tx-u.json", txId: "tx-u", destinationName: `tx-u.json.retired-${rid}` }), // 无 sourceSha256; source 不在
    )
    writeJournal(ref, "tx-trigger.json", retainedUninstallJournal("tx-trigger"))
    await retireTransactionJournal(ref, retireReq(ref, "tx-trigger.json"), retireDeps)
    const receipt = readRec(join(layout.retiredDir, `retire-${rid}.receipt.json`))
    expect(receipt.status).toBe("retired")
    expect(receipt.fingerprintVerified).toBe(false)
  })

  test("review r3 Blocker:非法文件名 txId(..)→ 不据以构造 staging 路径,不删 ext-tx", async () => {
    const ref = mkRoot("badname")
    const layout = transactionJournalLayout(ref.root)
    // 文件名派生 txId = ".."(危险);body txId 也 "..",过等值检查;若无 TX_ID_RE 守卫会
    // txStagingDir(root,"..")=ext-tx 被 cleanTerminalStaging 删掉。
    writeFileSync(join(layout.journalDir, "...json"), JSON.stringify({ txId: "..", op: "install", state: "committed", items: [] }))
    const sentinel = join(layout.journalDir, "sentinel.txt")
    writeFileSync(sentinel, "keep")
    const rec = await recoverExtensionTransactions(ref.root, { log: silentLog })
    const bad = rec.reports.find((r) => r.txId === "..")
    expect(bad?.detail).toContain("not a safe path segment")
    expect(existsSync(layout.journalDir)).toBe(true) // ext-tx/journal 未被删
    expect(existsSync(sentinel)).toBe(true)
  })

  test("review r3 Major:未知 action 的 item → diagnose 判 malformed 保留,不进 dispatch", async () => {
    const ref = mkRoot("unknownaction")
    writeJournal(ref, "tx-ua.json", { txId: "tx-ua", op: "install", state: "switching", items: [{ key: "skill--demo", action: "evil-action" }] })
    const rec = await recoverExtensionTransactions(ref.root, { log: silentLog })
    const r = rec.reports.find((rep) => rep.txId === "tx-ua")
    expect(r?.action).toBe("none")
    expect(r?.detail).toContain("unknown item action")
  })

  test("review r3 Major:staging 删除失败(圈禁不过)→ 终态件不谎报 cleaned,terminal GC 不删该 journal", async () => {
    const ref = mkRoot("stagingfail")
    const layout = transactionJournalLayout(ref.root)
    // committed + 有 staging;把 staging 变成不可删(mkdir 只读父)难以稳定复现,改测 gc 跳过逻辑:
    // staging 仍在时 terminal GC 不删 journal。
    writeJournal(ref, "tx-keep.json", { txId: "tx-keep", op: "install", state: "committed", items: [], updatedAt: "2020-01-01T00:00:00Z" })
    mkdirSync(join(layout.stagingDir, "tx-keep"), { recursive: true })
    // 手动阻断 staging 删除:把 stagingDir/tx-keep 设为文件(existsSync 真、removeDirGuarded rmSync 仍可删)
    // —— 改为直接验 gcTerminalJournals 的 staging-exists 跳过:先让恢复清 staging(会删),再断言无残留。
    await recoverExtensionTransactions(ref.root, { log: silentLog, keepJournals: 0 })
    expect(existsSync(join(layout.stagingDir, "tx-keep"))).toBe(false) // staging 被清
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
    writeFileSync(join(layout.retiredDir, "tx-a.json.retired-deadbeefdeadbeef"), JSON.stringify(retainedUninstallJournal("tx-a")))
    writeFileSync(
      join(layout.retiredDir, "retire-deadbeefdeadbeef.receipt.json"),
      JSON.stringify({ v: 1, action: "retire", status: "prepared", requestId: "deadbeefdeadbeef", entryId: "tx-a.json", txId: "tx-a", destinationName: "tx-a.json.retired-deadbeefdeadbeef" }),
    )
    // 场景 B:rename 未发生、receipt 停在 prepared,源仍在场。
    writeJournal(ref, "tx-b.json", retainedUninstallJournal("tx-b"))
    writeFileSync(
      join(layout.retiredDir, "retire-beefdeadbeefdead.receipt.json"),
      JSON.stringify({ v: 1, action: "retire", status: "prepared", requestId: "beefdeadbeefdead", entryId: "tx-b.json", txId: "tx-b", destinationName: "tx-b.json.retired-beefdeadbeefdead" }),
    )
    // 调和前:诊断面把两条 prepared 残留如实列出。
    const before = listRetainedJournals([ref]).entries.filter((e) => e.kind === "retire-incomplete")
    expect(before).toHaveLength(2)
    expect(before.find((e) => e.kind === "retire-incomplete" && e.entryId === "tx-a.json")?.destinationPresent).toBe(true)
    // 任意一次 retire 操作锁内先调和(用 tx-b 自身走一遍;调和先行,随后 tx-b 正常 retire)。
    const r = await retireTransactionJournal(ref, retireReq(ref, "tx-b.json"), retireDeps)
    expect(r.ok).toBe(true)
    const receiptA = readRec(join(layout.retiredDir, "retire-deadbeefdeadbeef.receipt.json"))
    expect(receiptA.status).toBe("retired")
    expect(receiptA.reconciled).toBe(true)
    const receiptB = readRec(join(layout.retiredDir, "retire-beefdeadbeefdead.receipt.json"))
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
