// REQ-100(issue #192)—— 扩展原子事务单测:崩溃点矩阵(AC1 不变量:任意崩溃点后 live
// generation 要么旧版完整、要么新版完整)、Bundle 原子性(AC2)、更新零残留(AC3)、健康探测
// 回滚 + 隔离收据(AC4)、锁争用(AC5)、卸载所有权守卫(AC6)、有界 GC、环境隔离(REQ-098)。
// 全部真盘临时目录;可注入面(probe/receipt/时钟/pid 探活/故障点)走参数 DI,零 mock.module(仓规)。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { environmentMutableRoot } from "./alpha-environment"
import { bundleLockPath, tryAcquireBundleLock } from "./ext-bundle-lock"
import { capabilityGrantPath, readCapabilityGrant } from "./ext-capability-grants"
import {
  ExtTxCrashError,
  extensionStorePaths,
  gcGenerations,
  gcQuarantine,
  KEEP_GENERATIONS_DEFAULT,
  listGenerations,
  listTransactionJournals,
  readBundleAuthorizationReceipt,
  readCurrentGeneration,
  readQuarantineReceipt,
  recoverExtensionTransactions,
  resolveLiveGenerationDir,
  rollbackToGeneration,
  runExtensionTransaction,
  TX_CRASH_POINTS,
  uninstallExtension,
  type HealthProbe,
  type TxCommitRecord,
  type TxCrashPoint,
  type TxFileSpec,
  type TxHooks,
  type TxPlan,
} from "./ext-transaction"

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ext-tx-"))
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

// ── fixtures & helpers ───────────────────────────────────────────────────────────────────────

const V1 = { "SKILL.md": "v1 skill body", "assets/a.txt": "alpha-1" }
const V2 = { "SKILL.md": "v2 skill body", "assets/b.txt": "beta-2" } // a.txt 在 V2 消失 → AC3 残留检验

const noop = () => {}
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex")

function specsOf(files: Record<string, string>): TxFileSpec[] {
  return Object.entries(files).map(([p, content]) => ({ path: p, sha256: sha(content), size: Buffer.byteLength(content) }))
}

function writeTree(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
}

function planFor(keys: string[], files: Record<string, string>): TxPlan {
  return { items: keys.map((key) => ({ key, files: specsOf(files), manifestDigest: `sha256:${sha(key)}` })) }
}

function hooksFor(files: Record<string, string>, extra: Partial<TxHooks> = {}): TxHooks {
  return { populate: (_item, dir) => writeTree(dir, files), log: noop, ...extra }
}

const healthyProbe: HealthProbe = () => ({ healthy: true })

async function installOk(keys: string[], files: Record<string, string>, extra: Partial<TxHooks> = {}) {
  const result = await runExtensionTransaction(root, planFor(keys, files), hooksFor(files, extra))
  if (!result.ok) throw new Error(`install failed: ${result.reason}`)
  return result
}

function liveContent(r: string, key: string): Record<string, string> | null {
  const dir = resolveLiveGenerationDir(r, key)
  if (!dir) return null
  const out: Record<string, string> = {}
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(rel ? path.join(dir, rel) : dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(childRel)
      else out[childRel] = fs.readFileSync(path.join(dir, childRel), "utf8")
    }
  }
  walk("")
  return out
}

const canon = (o: Record<string, string> | null) =>
  o === null ? null : JSON.stringify(Object.fromEntries(Object.entries(o).sort()))

/** AC1 不变量判定:live = 完整 V1 / 完整 V2 / 未安装;任何其他状态 = 半装态(corrupt)。 */
function versionOf(r: string, key: string): "v1" | "v2" | "none" | "corrupt" {
  const c = canon(liveContent(r, key))
  if (c === null) return "none"
  if (c === canon(V1)) return "v1"
  if (c === canon(V2)) return "v2"
  return "corrupt"
}

// ── happy path ───────────────────────────────────────────────────────────────────────────────

describe("commit path", () => {
  test("single install: staged → verified → materialized → switched → receipt committed", async () => {
    const received: TxCommitRecord[][] = []
    const phases: string[] = []
    const result = await installOk(["skill--demo"], V1, {
      probe: (input) => {
        phases.push(input.phase)
        return { healthy: true }
      },
      commitReceipt: (records) => {
        received.push(records)
      },
    })
    expect(result.committed).toHaveLength(1)
    const record = result.committed[0]!
    expect(record.key).toBe("skill--demo")
    expect(record.generation).toMatch(/^gen-000001-[a-f0-9]{8}$/)
    expect(record.previousGeneration).toBeNull()
    expect(record.manifestDigest).toBe(`sha256:${sha("skill--demo")}`)
    expect(received).toHaveLength(1)
    expect(phases).toEqual(["pre-switch", "post-switch"])
    expect(versionOf(root, "skill--demo")).toBe("v1")
    // 指针文件 = 仓惯例原子换名写的 JSON
    const pointer = JSON.parse(fs.readFileSync(extensionStorePaths(root, "skill--demo").pointer, "utf8"))
    expect(pointer.generation).toBe(record.generation)
    // journal 终态 committed;staging 清理;锁已释放
    expect(listTransactionJournals(root).map((j) => j.state)).toEqual(["committed"])
    expect(fs.existsSync(path.join(root, "ext-tx", "staging", result.txId))).toBe(false)
    expect(fs.existsSync(bundleLockPath(root))).toBe(false)
  })

  test("update creates a NEW generation (never in-place): v1 files vanish, previous retained (AC3)", async () => {
    await installOk(["skill--demo"], V1)
    const gen1 = readCurrentGeneration(root, "skill--demo")!.genId
    const result = await installOk(["skill--demo"], V2)
    expect(versionOf(root, "skill--demo")).toBe("v2") // a.txt 无残留
    expect(result.committed[0]!.previousGeneration).toBe(gen1)
    const gens = listGenerations(root, "skill--demo")
    expect(gens).toHaveLength(2)
    expect(gens.find((g) => g.current)!.genId).not.toBe(gen1)
    expect(gens.some((g) => g.genId === gen1)).toBe(true) // 旧 generation 保留(回滚燃料)
  })

  test("bundle: two items commit together", async () => {
    await installOk(["skill--a", "skill--b"], V1)
    expect(versionOf(root, "skill--a")).toBe("v1")
    expect(versionOf(root, "skill--b")).toBe("v1")
  })
})

// ── 计划校验与路径守卫 ───────────────────────────────────────────────────────────────────────

describe("plan validation (path guards)", () => {
  const bad = async (plan: TxPlan) => {
    const result = await runExtensionTransaction(root, plan, hooksFor(V1))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.stage).toBe("validate")
    return result.reason
  }

  test("traversal / absolute / duplicate paths and keys, bad digests, bad txId all refused pre-flight", async () => {
    expect(await bad({ items: [{ key: "k", files: [{ path: "../evil", sha256: sha("x") }] }] })).toContain("unsafe")
    expect(await bad({ items: [{ key: "k", files: [{ path: "/abs", sha256: sha("x") }] }] })).toContain("unsafe")
    expect(await bad({ items: [{ key: "bad/key", files: [{ path: "a", sha256: sha("x") }] }] })).toContain("key")
    expect(
      await bad({ items: [{ key: "k", files: [{ path: "a", sha256: sha("x") }, { path: "a", sha256: sha("y") }] }] }),
    ).toContain("duplicate")
    expect(await bad({ items: [{ key: "k", files: [{ path: "a", sha256: "beef" }] }] })).toContain("sha256")
    expect(await bad({ items: [{ key: "k", files: [] }] })).toContain("no expected files")
    expect(await bad({ items: [] })).toContain("no items")
    expect(await bad({ txId: "evil/../../x", items: [{ key: "k", files: [{ path: "a", sha256: sha("x") }] }] })).toContain(
      "txId",
    )
    // 拒绝发生在任何写盘之前
    expect(fs.existsSync(path.join(root, "ext-tx"))).toBe(false)
    expect(fs.existsSync(path.join(root, "ext-store"))).toBe(false)
  })
})

// ── staging 校验 ─────────────────────────────────────────────────────────────────────────────

describe("staging verification", () => {
  test("hash mismatch → aborted, live untouched", async () => {
    await installOk(["skill--demo"], V1)
    const plan = planFor(["skill--demo"], V2)
    plan.items[0]!.files[0]!.sha256 = sha("tampered")
    const result = await runExtensionTransaction(root, plan, hooksFor(V2))
    if (result.ok) throw new Error("expected failure")
    expect(result.stage).toBe("verify")
    expect(result.reason).toContain("sha256 mismatch")
    expect(versionOf(root, "skill--demo")).toBe("v1")
    expect(listGenerations(root, "skill--demo")).toHaveLength(1)
    expect(listTransactionJournals(root).at(-1)!.state).toBe("aborted")
  })

  test("unexpected extra file → aborted (structure must match receipt exactly)", async () => {
    const result = await runExtensionTransaction(root, planFor(["skill--demo"], V1), {
      populate: (_item, dir) => {
        writeTree(dir, V1)
        fs.writeFileSync(path.join(dir, "smuggled.bin"), "x")
      },
      log: noop,
    })
    if (result.ok) throw new Error("expected failure")
    expect(result.reason).toContain("unexpected file")
    expect(versionOf(root, "skill--demo")).toBe("none")
  })

  test("missing expected file → aborted", async () => {
    const result = await runExtensionTransaction(root, planFor(["skill--demo"], V1), {
      populate: (_item, dir) => writeTree(dir, { "SKILL.md": V1["SKILL.md"] }),
      log: noop,
    })
    if (result.ok) throw new Error("expected failure")
    expect(result.reason).toContain("missing expected file")
  })

  test("symlink in staging → refused", async () => {
    const result = await runExtensionTransaction(root, planFor(["skill--demo"], V1), {
      populate: (_item, dir) => {
        writeTree(dir, V1)
        fs.rmSync(path.join(dir, "assets", "a.txt"))
        fs.symlinkSync("/etc/hosts", path.join(dir, "assets", "a.txt"))
      },
      log: noop,
    })
    if (result.ok) throw new Error("expected failure")
    expect(result.reason).toContain("symlink")
  })

  test("populate failure → aborted at staging, nothing applied", async () => {
    const result = await runExtensionTransaction(root, planFor(["skill--demo"], V1), {
      populate: () => {
        throw new Error("download interrupted")
      },
      log: noop,
    })
    if (result.ok) throw new Error("expected failure")
    expect(result.stage).toBe("staging")
    expect(result.reason).toContain("download interrupted")
    expect(versionOf(root, "skill--demo")).toBe("none")
  })
})

// ── Bundle 原子性(AC2) ─────────────────────────────────────────────────────────────────────

describe("bundle atomicity (AC2)", () => {
  test("second child fails during populate → BOTH keys keep the old generation", async () => {
    await installOk(["skill--a", "skill--b"], V1)
    const result = await runExtensionTransaction(root, planFor(["skill--a", "skill--b"], V2), {
      populate: (item, dir) => {
        if (item.key === "skill--b") throw new Error("child b failed")
        writeTree(dir, V2)
      },
      log: noop,
    })
    if (result.ok) throw new Error("expected failure")
    expect(versionOf(root, "skill--a")).toBe("v1")
    expect(versionOf(root, "skill--b")).toBe("v1")
    expect(listGenerations(root, "skill--a")).toHaveLength(1)
  })

  test("second child fails health probe pre-switch → both keys unchanged, failed gens quarantined", async () => {
    await installOk(["skill--a", "skill--b"], V1)
    const result = await runExtensionTransaction(
      root,
      planFor(["skill--a", "skill--b"], V2),
      hooksFor(V2, {
        probe: (input) =>
          input.key === "skill--b" && input.phase === "pre-switch"
            ? { healthy: false, reason: "mcp handshake timeout" }
            : { healthy: true },
      }),
    )
    if (result.ok) throw new Error("expected failure")
    expect(result.stage).toBe("pre-switch-probe")
    expect(versionOf(root, "skill--a")).toBe("v1")
    expect(versionOf(root, "skill--b")).toBe("v1")
    const receipt = readQuarantineReceipt(root, result.txId!)
    expect(receipt?.from).toBe("pre-switch-probe")
    expect(receipt?.reason).toContain("mcp handshake timeout")
  })
})

// ── 健康探测 + 回滚 / 隔离(AC4) ────────────────────────────────────────────────────────────

describe("health probe rollback & quarantine", () => {
  test("post-switch probe failure → automatic rollback to previous generation + receipted quarantine", async () => {
    await installOk(["skill--demo"], V1)
    const gen1 = readCurrentGeneration(root, "skill--demo")!.genId
    const result = await runExtensionTransaction(
      root,
      planFor(["skill--demo"], V2),
      hooksFor(V2, {
        probe: (input) => (input.phase === "post-switch" ? { healthy: false, reason: "plugin crashed on load" } : { healthy: true }),
      }),
    )
    if (result.ok) throw new Error("expected failure")
    expect(result.stage).toBe("post-switch-probe")
    expect(versionOf(root, "skill--demo")).toBe("v1")
    expect(readCurrentGeneration(root, "skill--demo")!.genId).toBe(gen1)
    expect(result.quarantined!.length).toBe(1)
    expect(fs.existsSync(result.quarantined![0]!)).toBe(true)
    const receipt = readQuarantineReceipt(root, result.txId!)
    expect(receipt?.from).toBe("post-switch-rollback")
    expect(receipt?.reason).toContain("plugin crashed on load")
    expect(listTransactionJournals(root).at(-1)!.state).toBe("rolled-back")
    // 失败 generation 不再出现在 generations 下(隔离 ≠ 残留)
    expect(listGenerations(root, "skill--demo")).toHaveLength(1)
  })

  test("post-switch probe failure on FRESH install → pointer cleared (not installed), quarantined", async () => {
    const result = await runExtensionTransaction(
      root,
      planFor(["skill--demo"], V1),
      hooksFor(V1, {
        probe: (input) => (input.phase === "post-switch" ? { healthy: false, reason: "boom" } : { healthy: true }),
      }),
    )
    if (result.ok) throw new Error("expected failure")
    expect(versionOf(root, "skill--demo")).toBe("none")
  })

  test("probe throwing counts as unhealthy (fail closed)", async () => {
    await installOk(["skill--demo"], V1)
    const result = await runExtensionTransaction(
      root,
      planFor(["skill--demo"], V2),
      hooksFor(V2, {
        probe: (input) => {
          if (input.phase === "post-switch") throw new Error("probe transport died")
          return { healthy: true }
        },
      }),
    )
    if (result.ok) throw new Error("expected failure")
    expect(versionOf(root, "skill--demo")).toBe("v1")
  })
})

// ── receipt commit 接缝(REQ-099) ───────────────────────────────────────────────────────────

describe("receipt commit seam", () => {
  test("commitReceipt failure → rollback (live never diverges from committed receipts)", async () => {
    await installOk(["skill--demo"], V1)
    const result = await runExtensionTransaction(
      root,
      planFor(["skill--demo"], V2),
      hooksFor(V2, {
        commitReceipt: () => {
          throw new Error("ledger write failed")
        },
      }),
    )
    if (result.ok) throw new Error("expected failure")
    expect(result.stage).toBe("receipt-commit")
    expect(versionOf(root, "skill--demo")).toBe("v1")
    expect(listTransactionJournals(root).at(-1)!.state).toBe("rolled-back")
  })
})

// ── 崩溃点矩阵(AC1:任意点注入故障,无半装态;恢复收敛;重试幂等) ───────────────────────────

const EXPECT_AFTER_RECOVERY: Record<TxCrashPoint, "v1" | "v2"> = {
  "after-lock": "v1",
  "after-authorize": "v1",
  "after-journal": "v1",
  "mid-populate": "v1",
  "after-populate": "v1",
  "after-staged": "v1",
  "mid-materialize": "v1",
  "after-materialized": "v1",
  "after-pre-probe": "v1",
  "after-switching-journal": "v1", // 意图已记录但零翻转 → 回滚
  "mid-switch": "v1", // Bundle 半翻转 → 恢复回滚还原原子性
  "after-switched": "v2", // 全翻转 + 恢复探测健康 + receipt 幂等重放 → 前滚
  "after-post-probe": "v2",
  "after-receipt-commit": "v2",
  "before-gc": "v2", // journal 已 committed → 终态,仅清理
}

describe("crash-point matrix (AC1)", () => {
  for (const point of TX_CRASH_POINTS) {
    test(`kill at ${point}: live stays complete; recovery converges to ${EXPECT_AFTER_RECOVERY[point]}; retry idempotent`, async () => {
      const keys = ["skill--k1", "skill--k2"]
      await installOk(keys, V1)
      const crashed = runExtensionTransaction(
        root,
        planFor(keys, V2),
        hooksFor(V2, { crashAt: point, probe: healthyProbe, commitReceipt: noop }),
      )
      await expect(crashed).rejects.toThrow(ExtTxCrashError)

      // ① 崩溃后、恢复前:每个扩展的 live 内容完整(旧版全量或新版全量,绝无混合)
      for (const key of keys) expect(["v1", "v2"]).toContain(versionOf(root, key))

      // ② 恢复(pid 判死接管崩溃残留锁;注入健康探测 + 幂等 receipt 重放)
      const recovered = await recoverExtensionTransactions(root, {
        probe: healthyProbe,
        commitReceipt: noop,
        pidAlive: () => false,
        log: noop,
      })
      expect(recovered.ok).toBe(true)

      // ③ 恢复后:不变量仍成立、Bundle 两 key 版本一致、且为该崩溃点的预期版本
      for (const key of keys) expect(versionOf(root, key)).toBe(EXPECT_AFTER_RECOVERY[point])
      // ④ journal 全部终态(无悬挂事务)
      for (const j of listTransactionJournals(root)) {
        expect(["committed", "rolled-back", "aborted"]).toContain(j.state)
      }
      // ⑤ 幂等重试:同一计划重跑成功,live = v2
      const retry = await runExtensionTransaction(root, planFor(keys, V2), hooksFor(V2))
      expect(retry.ok).toBe(true)
      for (const key of keys) expect(versionOf(root, key)).toBe("v2")
    })
  }

  test("recovery WITHOUT probe/receipt seam rolls back post-switch crashes (health unknown = unhealthy)", async () => {
    const keys = ["skill--k1"]
    await installOk(keys, V1)
    const crashed = runExtensionTransaction(root, planFor(keys, V2), hooksFor(V2, { crashAt: "after-switched" }))
    await expect(crashed).rejects.toThrow(ExtTxCrashError)
    const recovered = await recoverExtensionTransactions(root, { pidAlive: () => false, log: noop })
    expect(recovered.ok).toBe(true)
    expect(recovered.reports.at(-1)!.action).toBe("rolled-back")
    expect(versionOf(root, "skill--k1")).toBe("v1")
    // 隔离收据可溯源(from=crash-recovery)
    const txId = recovered.reports.at(-1)!.txId
    expect(readQuarantineReceipt(root, txId)?.from).toBe("crash-recovery")
  })

  test("recovery is idempotent (second run is a no-op)", async () => {
    const keys = ["skill--k1"]
    await installOk(keys, V1)
    await expect(
      runExtensionTransaction(root, planFor(keys, V2), hooksFor(V2, { crashAt: "after-staged" })),
    ).rejects.toThrow(ExtTxCrashError)
    const first = await recoverExtensionTransactions(root, { pidAlive: () => false, log: noop })
    expect(first.reports.some((r) => r.action === "aborted")).toBe(true)
    const second = await recoverExtensionTransactions(root, { pidAlive: () => false, log: noop })
    expect(second.ok).toBe(true)
    expect(second.reports.every((r) => r.action === "none" || r.action === "cleaned")).toBe(true)
    expect(versionOf(root, "skill--k1")).toBe("v1")
  })
})

// ── 锁争用(AC5) ────────────────────────────────────────────────────────────────────────────

describe("lock contention (AC5)", () => {
  test("transaction refuses to start while another holds the environment lock", async () => {
    const held = tryAcquireBundleLock(root, { txId: "tx-live-00000001", log: noop })
    if (!held.ok) throw new Error(held.reason)
    const result = await runExtensionTransaction(root, planFor(["skill--demo"], V1), hooksFor(V1))
    if (result.ok) throw new Error("expected lock refusal")
    expect(result.stage).toBe("lock")
    expect(result.reason).toContain("held by pid")
    held.lock.release()
  })

  test("recovery reports skipped (not silent) when a live transaction holds the lock", async () => {
    const held = tryAcquireBundleLock(root, { txId: "tx-live-00000001", log: noop })
    if (!held.ok) throw new Error(held.reason)
    fs.mkdirSync(path.join(root, "ext-tx", "journal"), { recursive: true })
    const recovered = await recoverExtensionTransactions(root, { log: noop })
    expect(recovered.ok).toBe(false)
    expect(recovered.reason).toContain("recovery skipped")
    held.lock.release()
  })

  test("crash leaves the lock behind; next transaction takes it over loudly via stale recovery", async () => {
    await expect(
      runExtensionTransaction(root, planFor(["skill--demo"], V1), hooksFor(V1, { crashAt: "after-journal" })),
    ).rejects.toThrow(ExtTxCrashError)
    expect(fs.existsSync(bundleLockPath(root))).toBe(true) // 崩溃不释放锁(真实进程死亡语义)
    await recoverExtensionTransactions(root, { pidAlive: () => false, log: noop })
    const retry = await runExtensionTransaction(root, planFor(["skill--demo"], V1), hooksFor(V1))
    expect(retry.ok).toBe(true)
  })
})

// ── 有界 GC ──────────────────────────────────────────────────────────────────────────────────

describe("generation GC (bounded, guarded)", () => {
  test(`keeps ${KEEP_GENERATIONS_DEFAULT} generations by default (current + two rollback targets, AC4)`, async () => {
    for (const body of ["r1", "r2", "r3", "r4", "r5"]) {
      await installOk(["skill--demo"], { "SKILL.md": body })
    }
    const gens = listGenerations(root, "skill--demo")
    expect(gens).toHaveLength(KEEP_GENERATIONS_DEFAULT)
    expect(gens.find((g) => g.current)).toBeDefined()
    expect(liveContent(root, "skill--demo")).toEqual({ "SKILL.md": "r5" })
  })

  test("keepGenerations override", async () => {
    for (const body of ["r1", "r2", "r3"]) {
      await installOk(["skill--demo"], { "SKILL.md": body }, { keepGenerations: 2 })
    }
    expect(listGenerations(root, "skill--demo")).toHaveLength(2)
  })

  test("fail closed: unreadable pointer → GC deletes nothing", async () => {
    await installOk(["skill--demo"], V1)
    await installOk(["skill--demo"], V2)
    fs.writeFileSync(extensionStorePaths(root, "skill--demo").pointer, "{ corrupt")
    const gc = gcGenerations(root, "skill--demo", { keep: 1 })
    expect(gc.deleted).toEqual([])
    expect(gc.warnings.join()).toContain("fail closed")
    expect(listGenerations(root, "skill--demo")).toHaveLength(2)
  })

  test("quarantine GC is bounded", () => {
    const qRoot = path.join(root, "ext-tx", "quarantine")
    for (let i = 0; i < 5; i++) fs.mkdirSync(path.join(qRoot, `tx-q${i}-0000000${i}`), { recursive: true })
    const gc = gcQuarantine(root, { keep: 3 })
    expect(gc.deleted).toHaveLength(2)
    expect(fs.readdirSync(qRoot)).toHaveLength(3)
  })
})

// ── 离线回滚(AC4) ──────────────────────────────────────────────────────────────────────────

describe("offline rollback (AC4)", () => {
  test("user can roll back across retained healthy generations", async () => {
    await installOk(["skill--demo"], V1)
    const gen1 = readCurrentGeneration(root, "skill--demo")!.genId
    await installOk(["skill--demo"], V2)
    await installOk(["skill--demo"], { "SKILL.md": "v3" })
    // 默认保留 3 代 → gen1 仍在盘上,可离线回滚两代
    const rolled = rollbackToGeneration(root, "skill--demo", gen1, { log: noop })
    expect(rolled.ok).toBe(true)
    expect(versionOf(root, "skill--demo")).toBe("v1")
  })

  test("rollback to a generation not on disk is refused", async () => {
    await installOk(["skill--demo"], V1)
    const r = rollbackToGeneration(root, "skill--demo", "gen-000099-deadbeef", { log: noop })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("not on disk")
  })

  test("rollback serializes on the bundle lock", async () => {
    await installOk(["skill--demo"], V1)
    const held = tryAcquireBundleLock(root, { txId: "tx-live-00000001", log: noop })
    if (!held.ok) throw new Error(held.reason)
    const gen1 = readCurrentGeneration(root, "skill--demo")!.genId
    const r = rollbackToGeneration(root, "skill--demo", gen1, { log: noop })
    expect(r.ok).toBe(false)
    held.lock.release()
  })
})

// ── 卸载所有权守卫(AC6) ────────────────────────────────────────────────────────────────────

describe("uninstall (AC6: only transaction/generation-owned paths)", () => {
  test("removes pointer + generations, keeps user-authored strays loudly", async () => {
    await installOk(["skill--demo"], V1)
    await installOk(["skill--demo"], V2)
    const { store, generations } = extensionStorePaths(root, "skill--demo")
    fs.writeFileSync(path.join(generations, "user-notes.txt"), "hand-written") // 非 generation 命名 → 不属我们
    const result = uninstallExtension(root, "skill--demo", { log: noop })
    if (!result.ok) throw new Error(result.reason)
    expect(resolveLiveGenerationDir(root, "skill--demo")).toBeNull()
    expect(listGenerations(root, "skill--demo")).toHaveLength(0)
    expect(fs.existsSync(path.join(generations, "user-notes.txt"))).toBe(true) // 用户文件保留
    expect(result.warnings.join()).toContain("kept unknown entry")
    expect(fs.existsSync(store)).toBe(true) // 含未知内容的目录保留
  })

  test("clean uninstall removes the whole store dir; unknown key is idempotent success", async () => {
    await installOk(["skill--demo"], V1)
    const result = uninstallExtension(root, "skill--demo", { log: noop })
    if (!result.ok) throw new Error(result.reason)
    expect(fs.existsSync(extensionStorePaths(root, "skill--demo").store)).toBe(false)
    const again = uninstallExtension(root, "skill--demo", { log: noop })
    expect(again.ok).toBe(true)
  })
})

// ── 环境隔离(REQ-098) ──────────────────────────────────────────────────────────────────────

describe("environment isolation (REQ-098 roots)", () => {
  test("a transaction in the prod root never touches the beta root (or the shared base)", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "ext-tx-env-"))
    try {
      const prodRoot = environmentMutableRoot("prod", base)
      const betaRoot = environmentMutableRoot("beta", base)
      fs.mkdirSync(betaRoot, { recursive: true })
      const result = await runExtensionTransaction(prodRoot, planFor(["skill--demo"], V1), hooksFor(V1))
      expect(result.ok).toBe(true)
      expect(versionOf(prodRoot, "skill--demo")).toBe("v1")
      // beta 域与 base(dev 单根)零接触
      expect(fs.readdirSync(betaRoot)).toEqual([])
      expect(fs.existsSync(path.join(base, "ext-store"))).toBe(false)
      expect(fs.existsSync(path.join(base, "ext-tx"))).toBe(false)
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })
})

// ── capability 授权闸口(REQ-100 AC3:权限扩张必须重确认,静默继承无通道) ─────────────────────

describe("capability authorization gate", () => {
  const CAPS_V1 = ["prompt:context"]
  const CAPS_V2 = ["prompt:context", "process:spawn"]

  function planWithCaps(keys: string[], files: Record<string, string>, caps: string[], confirmed?: string[]): TxPlan {
    return {
      items: keys.map((key) => ({ key, files: specsOf(files), capabilities: caps })),
      ...(confirmed ? { authorization: { confirmed: Object.fromEntries(keys.map((k) => [k, confirmed])) } } : {}),
    }
  }

  test("fresh install with capabilities demands explicit authorization (initial grant)", async () => {
    const refused = await runExtensionTransaction(root, planWithCaps(["skill--demo"], V1, CAPS_V1), hooksFor(V1))
    if (refused.ok) throw new Error("expected authorize refusal")
    expect(refused.stage).toBe("authorize")
    expect(refused.reason).toContain("silent inheritance refused")
    expect(refused.authorization?.[0]?.previous).toBeNull()
    expect(refused.authorization?.[0]?.added).toEqual(CAPS_V1)
    // 零写盘:无 journal、无 store、锁已释放
    expect(versionOf(root, "skill--demo")).toBe("none")
    expect(listTransactionJournals(root)).toEqual([])
    expect(fs.existsSync(path.join(root, "ext-store"))).toBe(false)
    expect(fs.existsSync(bundleLockPath(root))).toBe(false)

    const confirmed = await runExtensionTransaction(root, planWithCaps(["skill--demo"], V1, CAPS_V1, CAPS_V1), hooksFor(V1))
    expect(confirmed.ok).toBe(true)
    expect(versionOf(root, "skill--demo")).toBe("v1")
    expect(readCapabilityGrant(root, "skill--demo")?.capabilities).toEqual(CAPS_V1)
  })

  test("upgrade with unchanged capabilities proceeds without re-confirmation", async () => {
    await runExtensionTransaction(root, planWithCaps(["skill--demo"], V1, CAPS_V1, CAPS_V1), hooksFor(V1))
    const upgrade = await runExtensionTransaction(root, planWithCaps(["skill--demo"], V2, CAPS_V1), hooksFor(V2))
    expect(upgrade.ok).toBe(true)
    expect(versionOf(root, "skill--demo")).toBe("v2")
  })

  test("capability expansion without confirmation is refused; old version keeps running (AC3)", async () => {
    await runExtensionTransaction(root, planWithCaps(["skill--demo"], V1, CAPS_V1, CAPS_V1), hooksFor(V1))
    const refused = await runExtensionTransaction(root, planWithCaps(["skill--demo"], V2, CAPS_V2), hooksFor(V2))
    if (refused.ok) throw new Error("expected authorize refusal")
    expect(refused.stage).toBe("authorize")
    expect(refused.authorization?.[0]?.added).toEqual(["process:spawn"])
    expect(versionOf(root, "skill--demo")).toBe("v1") // 旧版原样健康
    expect(listGenerations(root, "skill--demo")).toHaveLength(1)
    expect(readCapabilityGrant(root, "skill--demo")?.capabilities).toEqual(CAPS_V1) // 授权账未被污染
  })

  test("stale/partial confirmation that does not cover the full new set is refused (TOCTOU guard)", async () => {
    await runExtensionTransaction(root, planWithCaps(["skill--demo"], V1, CAPS_V1, CAPS_V1), hooksFor(V1))
    // 确认的是旧集合(缺 process:spawn)→ 不覆盖请求集 → 拒绝
    const refused = await runExtensionTransaction(root, planWithCaps(["skill--demo"], V2, CAPS_V2, CAPS_V1), hooksFor(V2))
    if (refused.ok) throw new Error("expected authorize refusal")
    expect(refused.stage).toBe("authorize")
    expect(versionOf(root, "skill--demo")).toBe("v1")
  })

  test("expansion with covering confirmation commits and updates the grant ledger", async () => {
    await runExtensionTransaction(root, planWithCaps(["skill--demo"], V1, CAPS_V1, CAPS_V1), hooksFor(V1))
    const upgraded = await runExtensionTransaction(root, planWithCaps(["skill--demo"], V2, CAPS_V2, CAPS_V2), hooksFor(V2))
    expect(upgraded.ok).toBe(true)
    if (!upgraded.ok) throw new Error("unreachable")
    expect(versionOf(root, "skill--demo")).toBe("v2")
    expect(readCapabilityGrant(root, "skill--demo")?.capabilities).toEqual([...CAPS_V2].sort())
    const receipt = readBundleAuthorizationReceipt(root, upgraded.txId)
    expect(receipt?.items[0]?.added).toEqual(["process:spawn"])
    expect(receipt?.items[0]?.requiresConfirmation).toBe(true)
  })

  test("capability shrink needs no confirmation and shrinks the grant at commit", async () => {
    await runExtensionTransaction(root, planWithCaps(["skill--demo"], V1, CAPS_V2, CAPS_V2), hooksFor(V1))
    const shrunk = await runExtensionTransaction(root, planWithCaps(["skill--demo"], V2, CAPS_V1), hooksFor(V2))
    expect(shrunk.ok).toBe(true)
    if (!shrunk.ok) throw new Error("unreachable")
    expect(readCapabilityGrant(root, "skill--demo")?.capabilities).toEqual(CAPS_V1)
    expect(readBundleAuthorizationReceipt(root, shrunk.txId)?.items[0]?.removed).toEqual(["process:spawn"])
  })

  test("failed upgrade (post-switch probe) rolls back WITHOUT touching the grant ledger", async () => {
    await runExtensionTransaction(root, planWithCaps(["skill--demo"], V1, CAPS_V1, CAPS_V1), hooksFor(V1))
    const failed = await runExtensionTransaction(
      root,
      planWithCaps(["skill--demo"], V2, CAPS_V2, CAPS_V2),
      hooksFor(V2, {
        probe: (input) => (input.phase === "post-switch" ? { healthy: false, reason: "crashed" } : { healthy: true }),
      }),
    )
    expect(failed.ok).toBe(false)
    expect(versionOf(root, "skill--demo")).toBe("v1")
    // 授权账仍是旧集合 → 重试升级依旧要求确认(失败不产生任何隐式授权)
    expect(readCapabilityGrant(root, "skill--demo")?.capabilities).toEqual(CAPS_V1)
    const retry = await runExtensionTransaction(root, planWithCaps(["skill--demo"], V2, CAPS_V2), hooksFor(V2))
    if (retry.ok) throw new Error("expected authorize refusal on retry")
    expect(retry.stage).toBe("authorize")
  })

  test("corrupt grant ledger fails closed: even unchanged capabilities demand re-confirmation", async () => {
    await runExtensionTransaction(root, planWithCaps(["skill--demo"], V1, CAPS_V1, CAPS_V1), hooksFor(V1))
    fs.writeFileSync(capabilityGrantPath(root, "skill--demo"), "{ corrupt")
    const refused = await runExtensionTransaction(root, planWithCaps(["skill--demo"], V2, CAPS_V1), hooksFor(V2))
    if (refused.ok) throw new Error("expected authorize refusal")
    expect(refused.stage).toBe("authorize")
    expect(refused.authorization?.[0]?.previous).toBeNull()
    const confirmed = await runExtensionTransaction(root, planWithCaps(["skill--demo"], V2, CAPS_V1, CAPS_V1), hooksFor(V2))
    expect(confirmed.ok).toBe(true)
  })

  test("bundle: one decision covers all items; any unconfirmed expanding item blocks the whole bundle (AC2)", async () => {
    const keys = ["skill--a", "skill--b"]
    const init = await runExtensionTransaction(root, planWithCaps(keys, V1, CAPS_V1, CAPS_V1), hooksFor(V1))
    expect(init.ok).toBe(true)
    // 只有 b 扩张,但确认缺失 → 整单拒绝,两个 key 都保持 v1
    const plan: TxPlan = {
      items: [
        { key: "skill--a", files: specsOf(V2), capabilities: CAPS_V1 },
        { key: "skill--b", files: specsOf(V2), capabilities: CAPS_V2 },
      ],
    }
    const refused = await runExtensionTransaction(root, plan, hooksFor(V2))
    if (refused.ok) throw new Error("expected authorize refusal")
    expect(versionOf(root, "skill--a")).toBe("v1")
    expect(versionOf(root, "skill--b")).toBe("v1")
    // 单次确认(只需覆盖扩张的 b)→ 一次 commit
    const ok = await runExtensionTransaction(
      root,
      { ...plan, authorization: { confirmed: { "skill--b": CAPS_V2 } } },
      hooksFor(V2),
    )
    expect(ok.ok).toBe(true)
    expect(versionOf(root, "skill--a")).toBe("v2")
    expect(versionOf(root, "skill--b")).toBe("v2")
  })

  test("skipped optional children are visible in the authorization receipt (AC2)", async () => {
    const plan: TxPlan = {
      items: [{ key: "skill--main", files: specsOf(V1), capabilities: [] }],
      skippedOptional: [{ key: "mcp--optional-helper", reason: "platform win32 unsupported" }],
    }
    const result = await runExtensionTransaction(root, plan, hooksFor(V1))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    const receipt = readBundleAuthorizationReceipt(root, result.txId)
    expect(receipt?.skippedOptional).toEqual([{ key: "mcp--optional-helper", reason: "platform win32 unsupported" }])
  })

  test("crash after switch during capability upgrade: recovery commits AND persists the new grant", async () => {
    await runExtensionTransaction(root, planWithCaps(["skill--demo"], V1, CAPS_V1, CAPS_V1), hooksFor(V1))
    await expect(
      runExtensionTransaction(
        root,
        planWithCaps(["skill--demo"], V2, CAPS_V2, CAPS_V2),
        hooksFor(V2, { crashAt: "after-switched", probe: healthyProbe, commitReceipt: noop }),
      ),
    ).rejects.toThrow(ExtTxCrashError)
    const recovered = await recoverExtensionTransactions(root, {
      probe: healthyProbe,
      commitReceipt: noop,
      pidAlive: () => false,
      log: noop,
    })
    expect(recovered.ok).toBe(true)
    expect(recovered.reports.some((r) => r.action === "resumed-committed")).toBe(true)
    expect(versionOf(root, "skill--demo")).toBe("v2")
    expect(readCapabilityGrant(root, "skill--demo")?.capabilities).toEqual([...CAPS_V2].sort())
  })

  test("uninstall removes the grant ledger (transaction-owned path)", async () => {
    await runExtensionTransaction(root, planWithCaps(["skill--demo"], V1, CAPS_V1, CAPS_V1), hooksFor(V1))
    const result = uninstallExtension(root, "skill--demo", { log: noop })
    if (!result.ok) throw new Error(result.reason)
    expect(result.removed.some((p) => p.endsWith("grants.json"))).toBe(true)
    expect(readCapabilityGrant(root, "skill--demo")).toBeNull()
    expect(fs.existsSync(extensionStorePaths(root, "skill--demo").store)).toBe(false)
  })

  test("plan validation refuses malformed capabilities / authorization / skippedOptional", async () => {
    const bad = async (plan: TxPlan) => {
      const result = await runExtensionTransaction(root, plan, hooksFor(V1))
      if (result.ok) throw new Error("expected validate refusal")
      expect(result.stage).toBe("validate")
      return result.reason
    }
    const files = specsOf(V1)
    expect(await bad({ items: [{ key: "k", files, capabilities: ["bad cap"] }] })).toContain("unsafe capability")
    expect(await bad({ items: [{ key: "k", files, capabilities: ["a", "a"] }] })).toContain("duplicate capability")
    expect(
      await bad({ items: [{ key: "k", files }], authorization: { confirmed: { ghost: ["a"] } } }),
    ).toContain("unknown item")
    expect(
      await bad({ items: [{ key: "k", files }], skippedOptional: [{ key: "k" }] }),
    ).toContain("collides")
    expect(
      await bad({ items: [{ key: "k", files }], skippedOptional: [{ key: "../evil" }] }),
    ).toContain("invalid key")
  })
})

// ── 恢复杂项 ─────────────────────────────────────────────────────────────────────────────────

describe("recovery misc", () => {
  test("no ext-tx dir → recovery is a cheap no-op", async () => {
    const r = await recoverExtensionTransactions(root, { log: noop })
    expect(r.ok).toBe(true)
    expect(r.reports).toEqual([])
  })

  test("corrupt journal is moved aside loudly, never silently deleted", async () => {
    const dir = path.join(root, "ext-tx", "journal")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "tx-bad-00000000.json"), "{ nope")
    const r = await recoverExtensionTransactions(root, { log: noop })
    expect(r.ok).toBe(true)
    expect(r.reports[0]!.action).toBe("cleaned")
    expect(fs.readdirSync(dir).some((n) => n.includes(".corrupt-"))).toBe(true)
  })
})

// ── REQ-099 #309(Codex review #357 major):recoveryClean —— ok:true ≠ 干净 ─────────────────────

describe("recoveryClean — 迁移等敏感动作的收敛判定", () => {
  const rep = (state: string, action: string) => ({ txId: "t", state, action, detail: "" }) as import("./ext-transaction").TxRecoveryReport
  test("ok:false / aborted / rolled-back / 非终态待重试 → 不干净;前滚完成与良性终态 → 干净", async () => {
    const { recoveryClean } = await import("./ext-transaction")
    expect(recoveryClean({ ok: false, reports: [] })).toBe(false)
    expect(recoveryClean({ ok: true, reports: [rep("aborted", "aborted")] })).toBe(false)
    expect(recoveryClean({ ok: true, reports: [rep("rolled-back", "rolled-back")] })).toBe(false)
    expect(recoveryClean({ ok: true, reports: [rep("uninstalling", "none")] })).toBe(false) // retained for retry
    expect(recoveryClean({ ok: true, reports: [] })).toBe(true)
    expect(recoveryClean({ ok: true, reports: [rep("committed", "resumed-committed")] })).toBe(true)
    expect(recoveryClean({ ok: true, reports: [rep("uninstalled", "none"), rep("committed", "cleaned")] })).toBe(true)
  })
})
