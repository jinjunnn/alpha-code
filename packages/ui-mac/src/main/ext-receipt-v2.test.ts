// REQ-099(issue #191 / ADR-028 §4/§5)—— InstallRecordV2 与双格式账本单测:严格 record 解码、
// generation/previousDigest 链、v1 双视图同步(回滚不丢安装,AC#6)、v1 写路径 carry-through、
// scope identity fail-closed(项目移动 / 符号链接 / Unicode 路径 / 损坏 record,AC#4)、显式迁移。
// 全部真盘临时目录;纯模块直测,零 mock.module(仓规)。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { addReceipt, removeReceipt } from "./alpha-installs"
import type { InstallReceipt } from "../preload/types"
import { sha256Hex } from "./ext-manifest-v2"
import {
  computeGrantDigest,
  decodeRecordV2,
  findRecordV2,
  lookupForUninstall,
  migrateV1Ledger,
  probeLedgerForWrite,
  projectScopeIdentity,
  readLedgerV2,
  removeRecordV2,
  setDesiredStateV2,
  toV1Receipt,
  upsertRecordV2,
  upsertRecordsV2,
  verifyProjectScope,
  RECORD_SCHEMA_VERSION,
  type InstallRecordV2,
  type UpsertInput,
} from "./ext-receipt-v2"

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ext-receipt-v2-"))
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const DIGEST_A = `sha256:${"a".repeat(64)}`
const DIGEST_B = `sha256:${"b".repeat(64)}`
const ledgerFile = (r: string = root) => path.join(r, "installs.json")
const readRaw = (r: string = root) => JSON.parse(fs.readFileSync(ledgerFile(r), "utf8")) as { v: number; receipts: InstallReceipt[]; records: unknown[] }

function upsertInput(overrides: Partial<UpsertInput> = {}): UpsertInput {
  return {
    id: "mcp:markitdown",
    name: "markitdown",
    kind: "mcp",
    environment: "prod",
    scope: { kind: "global" },
    version: "1.0.0",
    manifestDigest: DIGEST_A,
    desiredState: "enabled",
    origin: "catalog",
    configKey: "mcp.markitdown",
    installedAt: new Date("2026-07-13T08:00:00Z").toISOString(),
    ...overrides,
  }
}

function v1Receipt(overrides: Partial<InstallReceipt> = {}): InstallReceipt {
  return {
    id: "mcp:markitdown",
    name: "markitdown",
    type: "mcp",
    scope: "global",
    installedAt: new Date("2026-07-01T00:00:00Z").toISOString(),
    origin: "catalog",
    configKey: "mcp.markitdown",
    ...overrides,
  }
}

describe("decodeRecordV2 — strict, fail closed", () => {
  const valid = (): unknown => {
    const w = upsertRecordV2(root, upsertInput())
    if (!w.ok) throw new Error("fixture write failed")
    return JSON.parse(JSON.stringify(w.record))
  }

  test("valid record round-trips", () => {
    const decoded = decodeRecordV2(valid())
    expect(decoded.ok).toBe(true)
  })

  test("unknown key / unknown schemaVersion refused loudly", () => {
    const rogue = { ...(valid() as Record<string, unknown>), extraField: 1 }
    const decoded = decodeRecordV2(rogue)
    expect(decoded.ok).toBe(false)
    if (!decoded.ok) expect(decoded.errors.some((e) => e.includes('unknown key "extraField"'))).toBe(true)
    const wrongVersion = { ...(valid() as Record<string, unknown>), schemaVersion: 3 }
    expect(decodeRecordV2(wrongVersion).ok).toBe(false)
  })

  test("scope strictness: unknown scope key / relative projectPath / bad hash refused", () => {
    const base = valid() as Record<string, unknown>
    expect(decodeRecordV2({ ...base, scope: { kind: "global", extra: 1 } }).ok).toBe(false)
    expect(decodeRecordV2({ ...base, scope: { kind: "project", projectPath: "relative/x", projectPathHash: "a".repeat(64) } }).ok).toBe(false)
    expect(decodeRecordV2({ ...base, scope: { kind: "project", projectPath: "/abs/x", projectPathHash: "nothex" } }).ok).toBe(false)
    expect(decodeRecordV2({ ...base, scope: { kind: "user" } }).ok).toBe(false)
  })

  test("digest formats / generation / enums / timestamps validated", () => {
    const base = valid() as Record<string, unknown>
    expect(decodeRecordV2({ ...base, manifestDigest: "md5:zz" }).ok).toBe(false)
    expect(decodeRecordV2({ ...base, generation: 0 }).ok).toBe(false)
    expect(decodeRecordV2({ ...base, desiredState: "paused" }).ok).toBe(false)
    expect(decodeRecordV2({ ...base, environment: "staging" }).ok).toBe(false)
    expect(decodeRecordV2({ ...base, origin: "wormhole" }).ok).toBe(false)
    expect(decodeRecordV2({ ...base, installedAt: "not-a-date" }).ok).toBe(false)
    expect(decodeRecordV2({ ...base, transaction: { id: "t", state: "exploded" } }).ok).toBe(false)
    expect(decodeRecordV2({ ...base, transaction: { id: "t", state: "committed", extra: 1 } }).ok).toBe(false)
    expect(decodeRecordV2({ ...base, files: ["relative/path.md"] }).ok).toBe(false)
  })
})

describe("dual-format ledger — generation chain & v1 view lockstep (AC#6)", () => {
  test("fresh install writes v:2 with BOTH views; generation 1", () => {
    const w = upsertRecordV2(root, upsertInput())
    expect(w.ok).toBe(true)
    if (!w.ok) return
    expect(w.record.generation).toBe(1)
    const raw = readRaw()
    expect(raw.v).toBe(2)
    expect(raw.receipts).toHaveLength(1)
    expect(raw.records).toHaveLength(1)
    expect(raw.receipts[0]!.name).toBe("markitdown")
    expect(raw.receipts[0]!.type).toBe("mcp")
  })

  test("upsert same (kind,name) bumps generation and chains previousDigest", () => {
    upsertRecordV2(root, upsertInput())
    const w2 = upsertRecordV2(root, upsertInput({ manifestDigest: DIGEST_B, version: "1.1.0" }))
    expect(w2.ok).toBe(true)
    if (!w2.ok) return
    expect(w2.record.generation).toBe(2)
    expect(w2.record.previousDigest).toBe(DIGEST_A)
    const { records } = readLedgerV2(root)
    expect(records).toHaveLength(1)
    expect(records[0]!.version).toBe("1.1.0")
  })

  test("v1-only predecessor counts as generation 1 → new record is generation 2", () => {
    addReceipt(root, v1Receipt())
    const w = upsertRecordV2(root, upsertInput())
    expect(w.ok).toBe(true)
    if (!w.ok) return
    expect(w.record.generation).toBe(2)
    // v1 视图被替换为 v2 派生视图,不重复
    const raw = readRaw()
    expect(raw.receipts).toHaveLength(1)
  })

  test("v1 write path (alpha-installs) carries records[] through — v1 ops never erase v2 truth", () => {
    upsertRecordV2(root, upsertInput())
    // 旧代码路径写 v1 receipt(另一个 key)
    addReceipt(root, v1Receipt({ id: "user:legacy", name: "legacy", type: "skill", configKey: undefined, origin: "created" }))
    let raw = readRaw()
    expect(raw.records).toHaveLength(1) // v2 真相仍在
    expect(raw.receipts).toHaveLength(2)
    // v1 remove 同样不抹 v2
    removeReceipt(root, "skill", "legacy")
    raw = readRaw()
    expect(raw.records).toHaveLength(1)
    expect(raw.receipts).toHaveLength(1)
  })

  test("readLedgerV2 exposes v1-only receipts separately (read-only compat)", () => {
    addReceipt(root, v1Receipt({ id: "user:old", name: "oldie", type: "skill", configKey: undefined }))
    upsertRecordV2(root, upsertInput())
    const view = readLedgerV2(root)
    expect(view.records).toHaveLength(1)
    expect(view.v1Only).toHaveLength(1)
    expect(view.v1Only[0]!.name).toBe("oldie")
  })

  test("corrupt v2 record is excluded with a warning — never operable (fail closed)", () => {
    upsertRecordV2(root, upsertInput())
    const raw = readRaw()
    ;(raw.records[0] as Record<string, unknown>).generation = -5
    fs.writeFileSync(ledgerFile(), JSON.stringify(raw))
    const view = readLedgerV2(root)
    expect(view.records).toHaveLength(0)
    expect(view.warnings.some((w) => w.includes("fail closed"))).toBe(true)
    expect(findRecordV2(root, "mcp", "markitdown")).toBeNull()
  })

  test("corrupt FILE: read warns; write quarantines (loud self-heal, never silent clobber)", () => {
    fs.writeFileSync(ledgerFile(), "{ not json")
    const view = readLedgerV2(root)
    expect(view.records).toHaveLength(0)
    expect(view.warnings.some((w) => w.includes("unreadable"))).toBe(true)
    const w = upsertRecordV2(root, upsertInput())
    expect(w.ok).toBe(true)
    if (!w.ok) return
    expect(w.warnings.some((x) => x.includes("quarantined"))).toBe(true)
    expect(fs.readdirSync(root).some((f) => f.startsWith("installs.json.corrupt-"))).toBe(true)
  })

  test("removeRecordV2 removes BOTH views and is idempotent", () => {
    upsertRecordV2(root, upsertInput())
    const removed = removeRecordV2(root, "mcp", "markitdown")
    expect(removed.ok && removed.removed?.name === "markitdown").toBe(true)
    const raw = readRaw()
    expect(raw.receipts).toHaveLength(0)
    expect(raw.records).toHaveLength(0)
    const again = removeRecordV2(root, "mcp", "markitdown")
    expect(again.ok).toBe(true)
    if (again.ok) expect(again.removed).toBeNull()
  })

  test("setDesiredStateV2 flips and persists; no v2 record → fail closed", () => {
    upsertRecordV2(root, upsertInput())
    expect(setDesiredStateV2(root, "mcp", "markitdown", "disabled").ok).toBe(true)
    expect(findRecordV2(root, "mcp", "markitdown")?.desiredState).toBe("disabled")
    const missing = setDesiredStateV2(root, "skill", "ghost", "disabled")
    expect(missing.ok).toBe(false)
  })

  test("upsert refuses to write a record that fails its own strict decode", () => {
    const w = upsertRecordV2(root, upsertInput({ name: "bad name!" }))
    expect(w.ok).toBe(false)
    expect(fs.existsSync(ledgerFile())).toBe(false)
  })

  test("toV1Receipt preserves v1 semantics (rollback-readable view)", () => {
    const w = upsertRecordV2(root, upsertInput({ files: ["/abs/a.md"] }))
    if (!w.ok) throw new Error("fixture")
    const receipt = toV1Receipt(w.record)
    expect(receipt).toEqual({
      id: "mcp:markitdown",
      name: "markitdown",
      type: "mcp",
      scope: "global",
      version: "1.0.0",
      installedAt: w.record.installedAt,
      origin: "catalog",
      files: ["/abs/a.md"],
      configKey: "mcp.markitdown",
    })
  })
})

describe("scope identity — fail closed (AC#4)", () => {
  test("identity = realpath + sha256(NFC); symlinked dir resolves to the same identity", () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), "proj-real-"))
    const link = path.join(root, "proj-link")
    fs.symlinkSync(real, link)
    try {
      const a = projectScopeIdentity(real)
      const b = projectScopeIdentity(link)
      expect(a.ok && b.ok).toBe(true)
      if (!a.ok || !b.ok) return
      expect(b.scope.projectPathHash).toBe(a.scope.projectPathHash)
      expect(a.scope.projectPathHash).toBe(sha256Hex(a.scope.projectPath.normalize("NFC")))
    } finally {
      fs.rmSync(real, { recursive: true, force: true })
    }
  })

  test("unreachable / relative / non-directory project dir refused", () => {
    expect(projectScopeIdentity(path.join(root, "no-such-dir")).ok).toBe(false)
    expect(projectScopeIdentity("relative/dir").ok).toBe(false)
    const file = path.join(root, "a-file")
    fs.writeFileSync(file, "x")
    expect(projectScopeIdentity(file).ok).toBe(false)
  })

  test("Unicode project path: identity stable across the same dir", () => {
    const uni = path.join(root, "项目-héllo")
    fs.mkdirSync(uni)
    const a = projectScopeIdentity(uni)
    const b = projectScopeIdentity(uni)
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) expect(a.scope.projectPathHash).toBe(b.scope.projectPathHash)
  })

  test("moved/renamed project → verifyProjectScope REFUSES, never falls back to global", () => {
    const projA = path.join(root, "proj-a")
    fs.mkdirSync(projA)
    const identity = projectScopeIdentity(projA)
    if (!identity.ok) throw new Error("fixture")
    const record: InstallRecordV2 = {
      schemaVersion: RECORD_SCHEMA_VERSION,
      id: "skill:demo",
      name: "demo",
      kind: "skill",
      environment: "prod",
      scope: identity.scope,
      desiredState: "enabled",
      generation: 1,
      origin: "catalog",
      installedAt: new Date().toISOString(),
    }
    expect(verifyProjectScope(record, projA).ok).toBe(true)
    const projB = path.join(root, "proj-b")
    fs.renameSync(projA, projB)
    const moved = verifyProjectScope(record, projB)
    expect(moved.ok).toBe(false)
    if (!moved.ok) expect(moved.reason).toContain("NOT falling back to global")
    const gone = verifyProjectScope(record, projA)
    expect(gone.ok).toBe(false)
    if (!gone.ok) expect(gone.reason).toContain("fail closed")
  })

  test("global record is not project-verifiable", () => {
    const w = upsertRecordV2(root, upsertInput())
    if (!w.ok) throw new Error("fixture")
    expect(verifyProjectScope(w.record, root).ok).toBe(false)
  })
})

describe("v1 → v2 explicit migration (AC#6)", () => {
  test("migrates v1-only receipts: generation 1, migratedFrom, digests honestly absent; idempotent", () => {
    addReceipt(root, v1Receipt())
    addReceipt(root, v1Receipt({ id: "user:mine", name: "mine", type: "skill", origin: "created", configKey: undefined }))
    const r = migrateV1Ledger(root, "prod")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.migrated).toBe(2)
    const { records, v1Only } = readLedgerV2(root)
    expect(records).toHaveLength(2)
    expect(v1Only).toHaveLength(0)
    for (const rec of records) {
      expect(rec.generation).toBe(1)
      expect(rec.migratedFrom).toBe("v1")
      expect(rec.manifestDigest).toBeUndefined()
    }
    // 不丢 v1 receipt(回滚安全)
    expect(readRaw().receipts).toHaveLength(2)
    const again = migrateV1Ledger(root, "prod")
    expect(again.ok).toBe(true)
    if (again.ok) expect(again.migrated).toBe(0)
  })

  test("project ledger binds identity to the CURRENT project dir", () => {
    const proj = path.join(root, "proj")
    const alphaDir = path.join(proj, ".alpha")
    fs.mkdirSync(alphaDir, { recursive: true })
    addReceipt(alphaDir, v1Receipt({ scope: "project", type: "skill", name: "psk", id: "skill:psk", configKey: undefined }))
    const r = migrateV1Ledger(alphaDir, "prod", proj)
    expect(r.ok).toBe(true)
    const rec = findRecordV2(alphaDir, "skill", "psk")
    expect(rec?.scope.kind).toBe("project")
    if (rec?.scope.kind === "project") expect(rec.scope.projectPath).toBe(fs.realpathSync(proj))
  })

  test("corrupt ledger refuses migration (no guessing)", () => {
    fs.writeFileSync(ledgerFile(), "not json at all")
    const r = migrateV1Ledger(root, "prod")
    expect(r.ok).toBe(false)
  })

  // ── #309 adoption 规则(Codex 裁决)────────────────────────────────────────────────────────────

  test("adoption:非 catalog 怪 id 规范化为 user:<name>;receipts 原样(降级视图不变)", () => {
    addReceipt(root, v1Receipt({ id: "weird-legacy-id", name: "mytool", type: "plugin", origin: "created", configKey: "plugin:mytool" }))
    const before = JSON.parse(JSON.stringify(readRaw().receipts))
    const r = migrateV1Ledger(root, "prod")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.migrated).toBe(1)
    expect(findRecordV2(root, "plugin", "mytool")?.id).toBe("user:mytool") // v2 身份规范化
    expect(readRaw().receipts).toEqual(before) // v1 视图逐字不变(旧 id 仍可被 v1 reader 读到)
  })

  test("adoption 拒绝面:catalog 缺 kind 前缀 / command+catalog / 超长字段 → retained + 可定位 warning,文件仅在有 adopted 时才写", () => {
    addReceipt(root, v1Receipt({ id: "legacy-weird", name: "svc", type: "mcp", origin: "catalog", configKey: "mcp.svc" })) // catalog 身份不可重建
    addReceipt(root, v1Receipt({ id: "command:x", name: "x", type: "command", origin: "catalog", configKey: undefined })) // command 禁 catalog
    addReceipt(root, v1Receipt({ id: "user:big", name: "big", type: "skill", origin: "created", configKey: "k".repeat(600) })) // v2 字段上限
    const bytesBefore = fs.readFileSync(ledgerFile(), "utf8")
    const r = migrateV1Ledger(root, "prod")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.migrated).toBe(0)
    expect(r.retained).toBe(3)
    expect(r.warnings.some((w) => w.includes("mcp:svc") && w.includes(ledgerFile()))).toBe(true) // 可定位
    expect(fs.readFileSync(ledgerFile(), "utf8")).toBe(bytesBefore) // adopted=0 → 零写盘
  })

  test("scope 与账本物理域不符 → retained(不再降级成 global);同键重复 receipt → 全部 retained", () => {
    addReceipt(root, v1Receipt({ id: "user:psk", name: "psk", type: "skill", scope: "project", origin: "created", configKey: undefined }))
    const raw = readRaw()
    raw.receipts.push({ ...raw.receipts[0]!, id: "user:psk" }) // 手工造同键重复(addReceipt 会去重)
    raw.receipts.push({ ...raw.receipts[0]!, id: "user:psk2" })
    fs.writeFileSync(ledgerFile(), JSON.stringify(raw))
    const r = migrateV1Ledger(root, "prod")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.migrated).toBe(0)
    expect(r.retained).toBe(3)
    expect(r.warnings.some((w) => w.includes("duplicate"))).toBe(true)
  })

  test("#357 Blocker 回归锁:未来版本/未知顶层键/非数组集合 → 拒迁移,原文件字节零改动", () => {
    const cases = [
      { v: 3, receipts: [] }, // 未来版本
      { v: 1, receipts: [], futureKey: {} }, // 未知顶层键
      { v: 1, receipts: {} }, // receipts 非数组(parseLedger 会静默当空 → 重写即丢数据)
      { v: 2, receipts: [], records: "oops" }, // records 非数组
    ]
    for (const c of cases) {
      fs.writeFileSync(ledgerFile(), JSON.stringify(c))
      const bytes = fs.readFileSync(ledgerFile(), "utf8")
      const r = migrateV1Ledger(root, "prod")
      expect(r.ok).toBe(false)
      // r22:未来版本/非数组集合改由 parseLedger 信封闸先拒(文案不同,语义同为拒 + 零改动)。
      if (!r.ok) expect(r.reason).toContain("refusing")
      expect(fs.readFileSync(ledgerFile(), "utf8")).toBe(bytes)
    }
    // v:1 纯 receipts 信封(v1 writer 真实形状)照常可迁
    fs.writeFileSync(ledgerFile(), JSON.stringify({ v: 1, receipts: [v1Receipt()] }))
    const ok = migrateV1Ledger(root, "prod")
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.migrated).toBe(1)
  })

  test("parser 有排除项(非法 receipt)→ 整次拒绝,原文件字节零改动", () => {
    addReceipt(root, v1Receipt())
    const raw = readRaw()
    ;(raw.receipts as unknown[]).push({ id: "no-name" }) // 非法条目(parser 会排除并 warning)
    fs.writeFileSync(ledgerFile(), JSON.stringify(raw))
    const bytesBefore = fs.readFileSync(ledgerFile(), "utf8")
    const r = migrateV1Ledger(root, "prod")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("excluded/corrupt")
    expect(fs.readFileSync(ledgerFile(), "utf8")).toBe(bytesBefore)
  })

  test("幂等二跑:migrated=0 且文件内容不变;migrated record 可 lookup/set-state(消费面无 migratedFrom 分支)", () => {
    addReceipt(root, v1Receipt())
    expect(migrateV1Ledger(root, "prod").ok).toBe(true)
    const bytes = fs.readFileSync(ledgerFile(), "utf8")
    const again = migrateV1Ledger(root, "prod")
    expect(again.ok).toBe(true)
    if (again.ok) expect(again.migrated).toBe(0)
    expect(fs.readFileSync(ledgerFile(), "utf8")).toBe(bytes)
    const found = lookupForUninstall(root, "mcp", "markitdown")
    expect(found.status).toBe("valid") // migrated record 走正常 v2 操作面
    expect(setDesiredStateV2(root, "mcp", "markitdown", "disabled").ok).toBe(true)
  })
})

describe("upsertRecordsV2 — 批量单写(REQ-100 #311)", () => {
  test("多条 record 一次落盘;各自 generation 独立", () => {
    const w = upsertRecordsV2(root, [
      upsertInput({ id: "skill:a", name: "a", kind: "skill", configKey: undefined }),
      upsertInput({ id: "mcp:b", name: "b", kind: "mcp", configKey: "mcp.b" }),
    ])
    expect(w.ok).toBe(true)
    if (!w.ok) return
    expect(w.records).toHaveLength(2)
    const { records } = readLedgerV2(root)
    expect(records.map((r) => r.name).sort()).toEqual(["a", "b"])
  })

  test("任一 record 非法 → 整批拒绝,不留半套", () => {
    const w = upsertRecordsV2(root, [
      upsertInput({ id: "skill:ok", name: "ok", kind: "skill", configKey: undefined }),
      upsertInput({ name: "" }), // 非法 name
    ])
    expect(w.ok).toBe(false)
    expect(readLedgerV2(root).records).toHaveLength(0) // 半套都不落
  })

  test("同 key 更新走递增 generation", () => {
    upsertRecordsV2(root, [upsertInput({ manifestDigest: DIGEST_A })])
    const w = upsertRecordsV2(root, [upsertInput({ manifestDigest: DIGEST_B, version: "1.1.0" })])
    expect(w.ok).toBe(true)
    if (w.ok) expect(w.records[0]!.generation).toBe(2)
  })
})

describe("#378 r17 Blocker —— 损坏记录原文保全 + 同 key/unattributable 拒写", () => {
  const R17_TX = { id: "tx-r17-replay", state: "committed" as const }
  const seedWithCorrupt = (extraRecord: unknown) => {
    upsertRecordV2(root, upsertInput({ transaction: R17_TX }))
    const valid = readLedgerV2(root).records[0]
    if (!valid) throw new Error("fixture: valid record missing")
    fs.writeFileSync(ledgerFile(), JSON.stringify({ v: 2, receipts: [], records: [valid, extraRecord] }))
  }

  test("可归属损坏记录:无关 key 写/删照常且原文保全;同 key 写与删一律拒", () => {
    seedWithCorrupt({ kind: "plugin", name: "px", generation: -5 })
    const w = upsertRecordsV2(root, [upsertInput({ id: "skill:a", name: "a", kind: "skill", configKey: undefined })])
    expect(w.ok).toBe(true) // 无关 key 不被整账砖死(O4 教训)
    expect(fs.readFileSync(ledgerFile(), "utf8")).toMatch(/"generation":\s*-5/) // 证据没被重建蒸发
    const same = upsertRecordV2(root, upsertInput({ id: "plugin:px", name: "px", kind: "plugin", configKey: "plugin:px@1" }))
    expect(same.ok).toBe(false)
    if (!same.ok) expect(same.reason).toContain("corrupt v2 record for this key")
    const rmSame = removeRecordV2(root, "plugin", "px")
    expect(rmSame.ok).toBe(false)
    const rmOther = removeRecordV2(root, "skill", "a")
    expect(rmOther.ok).toBe(true)
    expect(fs.readFileSync(ledgerFile(), "utf8")).toMatch(/"generation":\s*-5/) // 删除路径同样保全
  })

  test("unattributable 损坏:任何 fresh 写拒;纯重放批零写盘照常(恢复不被卡)", () => {
    seedWithCorrupt({ garbage: true })
    const fresh = upsertRecordsV2(root, [upsertInput({ id: "skill:c", name: "c", kind: "skill", configKey: undefined })])
    expect(fresh.ok).toBe(false)
    if (!fresh.ok) expect(fresh.reason).toContain("unattributable")
    const replay = upsertRecordsV2(root, [upsertInput({ transaction: R17_TX })])
    expect(replay.ok).toBe(true) // 同 tx 完全一致 = 纯重放,零写盘
    expect(fs.readFileSync(ledgerFile(), "utf8")).toContain("garbage") // 原文未动
  })

  test("r22:信封收口 —— 未来版本一切写拒零触碰;records 非数组按损坏处理(quarantine 保字节,不静默折叠成空)", () => {
    fs.writeFileSync(ledgerFile(), JSON.stringify({ v: 3, receipts: [], records: [{ future: true }] }))
    const futureBytes = fs.readFileSync(ledgerFile(), "utf8")
    expect(probeLedgerForWrite(root).ok).toBe(false)
    const w = upsertRecordV2(root, upsertInput())
    expect(w.ok).toBe(false)
    if (!w.ok) expect(w.reason).toContain("newer than this build")
    expect(removeRecordV2(root, "mcp", "markitdown").ok).toBe(false)
    expect(fs.readFileSync(ledgerFile(), "utf8")).toBe(futureBytes) // 未来数据零触碰
    fs.writeFileSync(ledgerFile(), JSON.stringify({ v: 2, receipts: [], records: { ownership: "evidence" } }))
    expect(probeLedgerForWrite(root).ok).toBe(false) // 提交面拒(quarantine 不是提交路径)
    const w2 = upsertRecordsV2(root, [upsertInput()]) // 直接写面:损坏文件语义 = 隔离保字节 + 响亮警告
    expect(w2.ok).toBe(true)
    if (w2.ok) expect(w2.warnings.join(" ")).toContain("quarantined")
    const quarantined = fs.readdirSync(root).filter((f) => f.startsWith("installs.json.corrupt-"))
    expect(quarantined.length).toBeGreaterThanOrEqual(1)
    expect(fs.readFileSync(path.join(root, quarantined[quarantined.length - 1] ?? ""), "utf8")).toContain("ownership") // 证据字节保全
  })

  test("r19:账本读失败(EACCES)≠ 空账 —— 写/删/翻转/卸载查询一律拒,不 no-op 谎报;恢复后照常", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return
    upsertRecordV2(root, upsertInput())
    fs.chmodSync(ledgerFile(), 0o000)
    try {
      expect(removeRecordV2(root, "mcp", "markitdown").ok).toBe(false) // r19 前:no-op「成功」
      expect(upsertRecordV2(root, upsertInput({ id: "skill:x", name: "x", kind: "skill", configKey: undefined })).ok).toBe(false)
      expect(setDesiredStateV2(root, "mcp", "markitdown", "disabled").ok).toBe(false)
      expect(lookupForUninstall(root, "mcp", "markitdown").status).toBe("ledger-corrupt")
    } finally {
      fs.chmodSync(ledgerFile(), 0o644)
    }
    const rm = removeRecordV2(root, "mcp", "markitdown")
    expect(rm.ok).toBe(true)
    if (rm.ok) expect(rm.removed?.name).toBe("markitdown")
  })

  test("r18:字节级 evidence 侧写(同损坏集只落一份);setDesiredStateV2 同款损坏闸", () => {
    seedWithCorrupt({ kind: "plugin", name: "px", generation: -5 })
    const before = fs.readFileSync(ledgerFile(), "utf8")
    readLedgerV2(root) // 首次观测触发侧写
    const listEvidence = () => fs.readdirSync(root).filter((f) => f.startsWith("installs.json.evidence-"))
    const evid = listEvidence()
    expect(evid).toHaveLength(1)
    const first = evid[0]
    if (!first) throw new Error("fixture")
    expect(fs.readFileSync(path.join(root, first), "utf8")).toBe(before) // 原文件字节(重复键/词法取证不丢)
    upsertRecordsV2(root, [upsertInput({ id: "skill:a", name: "a", kind: "skill", configKey: undefined })])
    readLedgerV2(root)
    expect(listEvidence()).toHaveLength(1) // 损坏集未变 → 不增殖
    const sds = setDesiredStateV2(root, "plugin", "px", "disabled")
    expect(sds.ok).toBe(false)
    if (!sds.ok) expect(sds.reason).toContain("corrupt v2 record for this key")
  })
})

describe("computeGrantDigest — 键集 digest,绝不摄入值", () => {
  test("value-independent; key-set sensitive", () => {
    const a = computeGrantDigest({ secrets: { API_KEY: "topsecret-1" } })
    const b = computeGrantDigest({ secrets: { API_KEY: "completely-different" } })
    expect(a).toBe(b)
    const c = computeGrantDigest({ secrets: { OTHER_KEY: "x" } })
    expect(c).not.toBe(a)
    expect(computeGrantDigest(undefined)).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(computeGrantDigest({ workspace: "/w" })).not.toBe(computeGrantDigest(undefined))
  })
})

// ── #352(Codex 裁决必改 4):transaction exact-replay 幂等 ──────────────────────────────────────
describe("upsert transaction exact-replay idempotency (REQ-099 #352)", () => {
  const input = (over: Partial<Parameters<typeof upsertRecordV2>[1]> = {}) => ({
    id: "plugin:np",
    name: "np",
    kind: "plugin" as const,
    environment: "prod" as const,
    scope: { kind: "global" as const },
    version: "2.3.4",
    desiredState: "enabled" as const,
    origin: "catalog" as const,
    configKey: "plugin:@alpha/np@2.3.4",
    transaction: { id: "tx-replay-1", state: "committed" as const },
    installedAt: "2026-07-16T00:00:00.000Z",
    ...over,
  })
  test("同 txId + 全部事实一致 → 原记录原样返回,不递增 generation/previous 链", () => {
    const first = upsertRecordV2(root, input())
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.record.generation).toBe(1)
    const replay = upsertRecordV2(root, input())
    expect(replay.ok).toBe(true)
    if (!replay.ok) return
    expect(replay.record.generation).toBe(1) // 幂等:恢复期重放 commitReceipt 不产生新代
    expect(replay.record).toEqual(first.record)
  })
  test("同 txId 但事实冲突 = id 重用 → 显式拒绝(exact replay only);批量同语义", () => {
    expect(upsertRecordV2(root, input()).ok).toBe(true)
    const conflict = upsertRecordV2(root, input({ version: "9.9.9" }))
    expect(conflict.ok).toBe(false)
    if (!conflict.ok) expect(conflict.reason).toContain("conflicting facts")
    const batchReplay = upsertRecordsV2(root, [input()])
    expect(batchReplay.ok).toBe(true)
    if (batchReplay.ok) expect(batchReplay.records[0]!.generation).toBe(1)
    const batchConflict = upsertRecordsV2(root, [input({ version: "9.9.9" })])
    expect(batchConflict.ok).toBe(false)
  })
  test("不同 txId = 正常更新 → generation 递增 + previousDigest 链", () => {
    expect(upsertRecordV2(root, input({ manifestDigest: `sha256:${"a".repeat(64)}` })).ok).toBe(true)
    const next = upsertRecordV2(root, input({ transaction: { id: "tx-replay-2", state: "committed" as const }, version: "2.4.0", manifestDigest: `sha256:${"b".repeat(64)}` }))
    expect(next.ok).toBe(true)
    if (!next.ok) return
    expect(next.record.generation).toBe(2)
    expect(next.record.previousDigest).toBe(`sha256:${"a".repeat(64)}`)
  })
})

// ── #395 Codex r7 B4:更新在写点(锁内 prev)决定 desiredState,不用计划期传入值 ──────────────────
describe("#395 r7 B4 desiredState 写点优先", () => {
  test("更新(prev 存在):计划期传入 enabled,但 prev 已 disabled → 沿用 prev,禁用不复活", () => {
    const first = upsertRecordV2(root, upsertInput({ desiredState: "enabled" }))
    expect(first.ok).toBe(true)
    // 模拟用户中途 disable(set-state 通道)。
    expect(setDesiredStateV2(root, "mcp", "markitdown", "disabled").ok).toBe(true)
    // 更新事务用计划期(锁外)算的旧 enabled 提交 —— 必须被锁内 prev(disabled)覆盖。
    const upd = upsertRecordV2(root, upsertInput({ desiredState: "enabled", manifestDigest: DIGEST_B }))
    expect(upd.ok).toBe(true)
    if (upd.ok) expect(upd.record.desiredState).toBe("disabled")
  })

  test("fresh(无 prev):用传入 desiredState(分类器值)", () => {
    const w = upsertRecordV2(root, upsertInput({ desiredState: "disabled" }))
    expect(w.ok).toBe(true)
    if (w.ok) expect(w.record.desiredState).toBe("disabled")
  })

  test("批量 upsert 同样在写点沿用 prev(更新不复活禁用)", () => {
    upsertRecordV2(root, upsertInput({ desiredState: "enabled" }))
    expect(setDesiredStateV2(root, "mcp", "markitdown", "disabled").ok).toBe(true)
    const batch = upsertRecordsV2(root, [upsertInput({ desiredState: "enabled", manifestDigest: DIGEST_B })])
    expect(batch.ok).toBe(true)
    if (batch.ok) expect(batch.records[0].desiredState).toBe("disabled")
  })
})
