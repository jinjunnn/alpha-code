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
import { gatedWriteHandler, makeRecoveryGate, runVerifiedMutation, type RecoveryGate } from "./ext-recovery-gate"
import { probeTransactionJournals, type RecoverOptions } from "./ext-transaction"
import { assertProjectMcpTransactionRootIdentity, removeProjectMcpConfigInLock } from "./ext-config"
import { removeInstallGrants } from "./ext-install-planner"
import { capabilityGrantPath } from "./ext-capability-grants"
import { findRecordV2, projectScopeIdentity, removeRecordV2, upsertRecordV2 } from "./ext-receipt-v2"

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

function writeUninstallJournal(txId: string, key = "skill--demo", targetRoot = root, action?: "config"): void {
  const targetJournal = path.join(targetRoot, "ext-tx", "journal")
  fs.mkdirSync(targetJournal, { recursive: true })
  fs.writeFileSync(
    path.join(targetJournal, `${txId}.json`),
    JSON.stringify({
      v: 1,
      txId,
      op: "uninstall",
      state: "uninstalling",
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
      items: [{ key, ...(action ? { action } : {}), genId: "gen-000000-000000", files: [] }],
    }),
  )
}

const fullOpts = (): RecoverOptions => ({
  commitUninstall: () => {},
  uninstallArtifacts: () => {},
})
const gateWith = (opts: () => RecoverOptions): RecoveryGate => makeRecoveryGate(() => opts())

describe("withRecoveredWrite — 准入判据", () => {
  test("root canonical 身份无法复验 → 恢复与 write body 均不执行", async () => {
    let recoveryOptsCalls = 0
    let bodyCalls = 0
    const gate = makeRecoveryGate(
      () => {
        recoveryOptsCalls++
        return {}
      },
      undefined,
      () => {
        throw new Error("identity drift")
      },
    )
    const result = await gate.withRecoveredWrite(root, async () => {
      bodyCalls++
      return { ok: true as const }
    })
    expect(result).toEqual({ ok: false, reason: "root identity cannot be confirmed — operation refused (fail closed)" })
    expect(recoveryOptsCalls).toBe(0)
    expect(bodyCalls).toBe(0)
  })

  test("probe 后第二次 root 复验注入漂移 → write body 零执行", async () => {
    let verifies = 0
    let bodyCalls = 0
    const gate = makeRecoveryGate(
      () => ({}),
      undefined,
      (seenRoot) => {
        expect(seenRoot).toBe(root)
        verifies++
        if (verifies === 2) throw new Error("identity drift after recovery")
      },
    )

    const result = await gate.withRecoveredWrite(root, async () => {
      bodyCalls++
      return { ok: true as const }
    })

    expect(result).toEqual({ ok: false, reason: "root identity cannot be confirmed — operation refused (fail closed)" })
    expect(verifies).toBe(2)
    expect(bodyCalls).toBe(0)
  })

  test("REQ-136 project gate rejects a symlinked ext-tx tree before recovery can follow it", async () => {
    let project = path.join(root, "D")
    fs.mkdirSync(path.join(project, ".alpha"), { recursive: true })
    project = fs.realpathSync(project)
    const projectRoot = path.join(project, ".alpha")
    const outside = path.join(root, "outside-tx")
    fs.mkdirSync(outside, { recursive: true })
    const sentinel = path.join(outside, "sentinel")
    fs.writeFileSync(sentinel, "outside-stays-exact")
    fs.symlinkSync(outside, path.join(projectRoot, "ext-tx"))
    let bodyCalls = 0
    const gate = makeRecoveryGate(
      () => ({}),
      undefined,
      assertProjectMcpTransactionRootIdentity,
    )

    const result = await gate.withRecoveredWrite(projectRoot, async () => {
      bodyCalls++
      return { ok: true as const }
    })
    expect(result).toEqual({ ok: false, reason: "root identity cannot be confirmed — operation refused (fail closed)" })
    expect(bodyCalls).toBe(0)
    expect(fs.readFileSync(sentinel, "utf8")).toBe("outside-stays-exact")
  })

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

  test("REQ-136 crash-replayed project MCP uninstall is idempotent and cannot touch global", async () => {
    let project = path.join(root, "D")
    const globalRoot = path.join(root, "global")
    fs.mkdirSync(path.join(project, ".alpha"), { recursive: true })
    project = fs.realpathSync(project)
    const projectRoot = path.join(project, ".alpha")
    fs.mkdirSync(globalRoot, { recursive: true })
    const projectConfig = path.join(projectRoot, "alpha.jsonc")
    const globalConfig = path.join(globalRoot, "alpha.jsonc")
    fs.writeFileSync(projectConfig, JSON.stringify({ mcp: { demo: { type: "local", command: ["npx", "project"] } } }, null, 2))
    fs.writeFileSync(globalConfig, JSON.stringify({ mcp: { demo: { type: "local", command: ["npx", "global"] } } }, null, 4) + "\n")
    const globalBefore = fs.readFileSync(globalConfig, "utf8")
    const identity = projectScopeIdentity(project)
    if (!identity.ok) throw new Error(identity.reason)
    expect(
      upsertRecordV2(projectRoot, {
        id: "mcp:demo",
        name: "demo",
        kind: "mcp",
        environment: "prod",
        scope: identity.scope,
        desiredState: "enabled",
        origin: "catalog",
        configKey: "mcp.demo",
        installedAt: "2026-08-18T00:00:00.000Z",
      }).ok,
    ).toBe(true)
    const grant = capabilityGrantPath(projectRoot, "mcp--demo")
    fs.mkdirSync(path.dirname(grant), { recursive: true })
    fs.writeFileSync(grant, '{"v":1}\n')
    writeUninstallJournal("tx-project-mcp", "mcp--demo", projectRoot, "config")

    let commits = 0
    let bodyCalls = 0
    const gate = makeRecoveryGate(
      (seenRoot) => ({
        uninstallArtifacts: (key) => {
          expect(seenRoot).toBe(projectRoot)
          const removed = removeProjectMcpConfigInLock(seenRoot, key.slice("mcp--".length))
          if (!removed.ok) throw new Error(removed.reason)
          const grants = removeInstallGrants(seenRoot, [key])
          if (!grants.ok) throw new Error(grants.reason)
        },
        commitUninstall: () => {
          commits++
          if (commits === 1) throw new Error("simulated crash before ledger commit")
          const removed = removeRecordV2(seenRoot, "mcp", "demo")
          if (!removed.ok) throw new Error(removed.reason)
        },
      }),
      undefined,
      (seenRoot) => {
        expect(seenRoot).toBe(projectRoot)
      },
    )

    const first = await gate.withRecoveredWrite(projectRoot, async () => {
      bodyCalls++
      return { ok: true as const }
    })
    expect(first.ok).toBe(false)
    expect(bodyCalls).toBe(0)
    expect(fs.existsSync(grant)).toBe(false)
    expect(JSON.parse(fs.readFileSync(projectConfig, "utf8")).mcp?.demo).toBeUndefined()
    expect(findRecordV2(projectRoot, "mcp", "demo")).not.toBeNull()
    expect(fs.readFileSync(globalConfig, "utf8")).toBe(globalBefore)
    expect(probeTransactionJournals(projectRoot).entries[0]?.state).toBe("uninstalling")

    const second = await gate.withRecoveredWrite(projectRoot, async () => {
      bodyCalls++
      return { ok: true as const }
    })
    expect(second).toEqual({ ok: true })
    expect(bodyCalls).toBe(1)
    expect(commits).toBe(2)
    expect(findRecordV2(projectRoot, "mcp", "demo")).toBeNull()
    expect(probeTransactionJournals(projectRoot).entries[0]?.state).toBe("uninstalled")
    expect(fs.readFileSync(globalConfig, "utf8")).toBe(globalBefore)
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
    if (r.ok) throw new Error("expected refusal")
    expect(r.reason).toContain("non-terminal transaction journal remains")
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
      if (r.ok) throw new Error("expected refusal")
      expect(r.reason).toContain("recovery incomplete")
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
    if (first.ok) throw new Error("expected refusal")
    expect(first.reason).toContain("corrupt transaction journal quarantined")
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
      if (r.ok) throw new Error("expected refusal")
      expect(r.reason.length).toBeGreaterThan(0)
    } finally {
      fs.chmodSync(journalDir(), 0o755)
    }
  })

  test("journal 位置被普通文件占据(ENOTDIR)→ 拒且 op 零调用(review #376 Blocker 回归)", async () => {
    fs.mkdirSync(path.join(root, "ext-tx"), { recursive: true })
    fs.writeFileSync(path.join(root, "ext-tx", "journal"), "i am a file, not a directory")
    const gate = gateWith(fullOpts)
    let ran = false
    const r = await gate.withRecoveredWrite(root, async () => {
      ran = true
      return { ok: true as const }
    })
    expect(ran).toBe(false)
    if (r.ok) throw new Error("expected refusal")
    expect(r.reason).toContain("cannot be enumerated")
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

describe("runVerifiedMutation — startup migration 紧前复验", () => {
  test("recovery 前已验、migration 前第二验漂移 → migration 零执行", () => {
    let verifies = 0
    let migrations = 0
    const verify = (seenRoot: string) => {
      expect(seenRoot).toBe(root)
      verifies++
      if (verifies === 2) throw new Error("root drifted during recovery")
    }

    verify(root)
    expect(() =>
      runVerifiedMutation(root, verify, () => {
        migrations++
      }),
    ).toThrow("root drifted during recovery")
    expect(verifies).toBe(2)
    expect(migrations).toBe(0)
  })
})
