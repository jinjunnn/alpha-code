// REQ-099 #356:project 账本 adoption —— 裁决测试矩阵:纯文本项目收编、已决策项目同样收编
// (触发面在 trust-check 早退之前,源文本合同)、prod 先采 beta 可读且幂等不重写 environment、
// scope 不符 retained、损坏信封零改动、busy 串行且 transient 可重试、无存量零写副作用。
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { addReceipt } from "./alpha-installs"
import { tryAcquireBundleLock } from "./ext-bundle-lock"
import { adoptProjectLedger } from "./ext-project-adopt"
import { makeRecoveryGate } from "./ext-recovery-gate"
import { findRecordV2, readLedgerV2 } from "./ext-receipt-v2"
import type { InstallReceipt } from "../preload/types"

let tmp: string
let projectDir: string
const alphaDir = () => join(projectDir, ".code-puppy")
const gate = () => makeRecoveryGate(() => ({}))

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ext-adopt-"))
  projectDir = join(tmp, "proj")
  mkdirSync(projectDir, { recursive: true })
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const v1 = (name: string, scope: InstallReceipt["scope"] = "project"): InstallReceipt => ({
  id: `skill:${name}`,
  name,
  type: "skill",
  scope,
  installedAt: new Date().toISOString(),
  origin: "catalog",
})

describe("adoptProjectLedger (REQ-099 #356)", () => {
  test("纯文本项目(无 executable)v1 存量收编:realpath+hash 身份绑定,environment 如实固化", async () => {
    mkdirSync(alphaDir(), { recursive: true })
    addReceipt(alphaDir(), v1("notes"))
    const r = await adoptProjectLedger(projectDir, { environment: "prod", gate: gate() })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.migrated).toBe(1)
    const rec = findRecordV2(alphaDir(), "skill", "notes")
    expect(rec).not.toBeNull()
    expect(rec!.environment).toBe("prod")
    expect(rec!.scope.kind).toBe("project")
    if (rec!.scope.kind !== "project") throw new Error("unreachable")
    expect(rec!.scope.projectPath).toBe(realpathSync.native(projectDir))
    expect(rec!.scope.projectPathHash).toMatch(/^[0-9a-f]{64}$/)
  })

  test("跨 channel 共享语义(裁决 A+C):prod 先采 → beta 触发幂等、不重写 environment、记录照常可读", async () => {
    mkdirSync(alphaDir(), { recursive: true })
    addReceipt(alphaDir(), v1("notes"))
    const first = await adoptProjectLedger(projectDir, { environment: "prod", gate: gate() })
    expect(first.ok).toBe(true)
    const again = await adoptProjectLedger(projectDir, { environment: "beta", gate: gate() })
    expect(again.ok).toBe(true)
    if (!again.ok) throw new Error("unreachable")
    expect(again.migrated).toBe(0) // 幂等:已有 v2 record 的 key 不重迁
    const rec = findRecordV2(alphaDir(), "skill", "notes")
    expect(rec!.environment).toBe("prod") // 归因字段不被后到 channel 重写
    // C 不变量:读方按 ledger/key/scope 操作,不按 environment 过滤 —— beta 视角照常可见。
    expect(readLedgerV2(alphaDir()).records.some((x) => x.name === "notes")).toBe(true)
  })

  test("scope 不符的 v1 receipt retained(不误采全局遗物);符号链接路径与真实路径同一身份", async () => {
    mkdirSync(alphaDir(), { recursive: true })
    addReceipt(alphaDir(), v1("notes"))
    addReceipt(alphaDir(), v1("stray", "global"))
    const linked = join(tmp, "proj-link")
    symlinkSync(projectDir, linked)
    const r = await adoptProjectLedger(linked, { environment: "prod", gate: gate() })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.migrated).toBe(1)
    expect(r.retained).toBe(1)
    // 经 realpath 收编 → 用真实路径再触发 = 幂等(无双根)。
    const again = await adoptProjectLedger(projectDir, { environment: "prod", gate: gate() })
    expect(again.ok && again.migrated === 0).toBe(true)
    expect(findRecordV2(alphaDir(), "skill", "stray")).toBeNull()
  })

  test("损坏信封 → ok:false(final)且账本零改动", async () => {
    mkdirSync(alphaDir(), { recursive: true })
    writeFileSync(join(alphaDir(), "installs.json"), "{ not json !!!")
    const before = readFileSync(join(alphaDir(), "installs.json"))
    const r = await adoptProjectLedger(projectDir, { environment: "prod", gate: gate() })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.transient).toBe(false)
    expect(readFileSync(join(alphaDir(), "installs.json")).equals(before)).toBe(true)
  })

  test("busy(project bundle 锁被持有)→ transient 拒绝零改动;释放后重试成功", async () => {
    mkdirSync(alphaDir(), { recursive: true })
    addReceipt(alphaDir(), v1("notes"))
    const before = readFileSync(join(alphaDir(), "installs.json"))
    const held = tryAcquireBundleLock(alphaDir(), { txId: "tx-in-flight" })
    expect(held.ok).toBe(true)
    if (!held.ok) return
    try {
      const r = await adoptProjectLedger(projectDir, { environment: "prod", gate: gate() })
      expect(r.ok).toBe(false)
      if (r.ok) throw new Error("unreachable")
      expect(r.transient).toBe(true)
      expect(readFileSync(join(alphaDir(), "installs.json")).equals(before)).toBe(true)
    } finally {
      held.lock.release()
    }
    const retry = await adoptProjectLedger(projectDir, { environment: "prod", gate: gate() })
    expect(retry.ok && retry.migrated === 1).toBe(true)
  })

  test("无 .code-puppy 存量 → 零写副作用(不为纯净项目制造 .code-puppy/lock/journal)", async () => {
    const r = await adoptProjectLedger(projectDir, { environment: "prod", gate: gate() })
    expect(r.ok && r.migrated === 0).toBe(true)
    expect(existsSync(alphaDir())).toBe(false)
  })

  test("身份 fail-closed:相对路径拒绝(final,不重试)", async () => {
    const r = await adoptProjectLedger("not/absolute", { environment: "prod", gate: gate() })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.transient).toBe(false)
  })
})

describe("recovery gate 准入(review #380 minor:journal 在场的真实行为)", () => {
  test("项目根有损坏/未终态 journal → gate 拒绝,adoption transient 且账本零改动", async () => {
    mkdirSync(alphaDir(), { recursive: true })
    addReceipt(alphaDir(), v1("notes"))
    const before = readFileSync(join(alphaDir(), "installs.json"))
    // 伪造一个不可解析 journal(recoverExtensionTransactions 会隔离并报告 corrupt → 准入拒绝)。
    mkdirSync(join(alphaDir(), "ext-tx", "journal"), { recursive: true })
    writeFileSync(join(alphaDir(), "ext-tx", "journal", "tx-broken.json"), "{ not json")
    const r = await adoptProjectLedger(projectDir, { environment: "prod", gate: gate() })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.transient).toBe(true) // gate refusal = transient,下次打开重试
    expect(readFileSync(join(alphaDir(), "installs.json")).equals(before)).toBe(true)
    // 隔离处置后(本次 gate 已把损坏件移交隔离),重试应可通过 —— 与生产 recoveryOpts 的
    // seam 无关面:adoption 事务只涉账本迁移,不触发 #346 uninstall seam。
    const retry = await adoptProjectLedger(projectDir, { environment: "prod", gate: gate() })
    expect(retry.ok && retry.migrated === 1).toBe(true)
  })
})

describe("#356 wiring:触发面在 trust-check 两个早退之前(源文本合同)", () => {
  // 分类与「这处锚守不住什么」登记在 ./source-text-anchors.ts(`#968` 第 ⑤ 层机械校验)。
  test("ANCHOR (not a gate): adoption 调用位置先于「无 executable 早退」与「已有决策早退」", () => {
    const src = readFileSync(join(import.meta.dir, "ext-ipc.ts"), "utf8")
    const trustStart = src.indexOf('ipcMain.handle("ext-trust-check"')
    const trustEnd = src.indexOf('ipcMain.handle("ext-external-check"', trustStart)
    expect(trustStart).toBeGreaterThan(0)
    expect(trustEnd).toBeGreaterThan(trustStart)
    const trust = src.slice(trustStart, trustEnd)
    const posAdopt = trust.indexOf("adoptProjectLedger(directory")
    const posNoExec = trust.indexOf("exec.mcp.length === 0 && exec.plugins.length === 0")
    const posDecision = trust.indexOf("hasExtensionsDecision(prefs)")
    expect(posAdopt).toBeGreaterThan(0)
    expect(posNoExec).toBeGreaterThan(0)
    expect(posDecision).toBeGreaterThan(0)
    expect(posAdopt).toBeLessThan(posNoExec)
    expect(posAdopt).toBeLessThan(posDecision)
  })
})
