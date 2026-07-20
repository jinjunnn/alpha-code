import { describe, expect, test } from "bun:test"
import {
  RECOVERY_ACTIONS,
  adaptRecoveryPlan,
  createRecoveryActionAdapter,
  type RecoveryActionResult,
  type RecoveryLogger,
} from "./recovery-adapter"

const silent: RecoveryLogger = () => {}

describe("adaptRecoveryPlan — four real recovery partitions", () => {
  test("database corrupt exposes restore only when a real backup exists", () => {
    expect(
      adaptRecoveryPlan({ kind: "database", plan: { kind: "corrupt", detail: "bad db" }, backupAvailable: true }, silent),
    ).toEqual({
      code: "RECOVERY_DATABASE_CORRUPT",
      category: "database-corrupt",
      actions: ["restore-latest-backup", "exit-app", "continue-startup"],
      retryable: false,
    })
    expect(
      adaptRecoveryPlan({ kind: "database", plan: { kind: "corrupt", detail: "bad db" }, backupAvailable: false }, silent),
    ).toEqual({
      code: "RECOVERY_DATABASE_CORRUPT",
      category: "database-corrupt",
      actions: ["exit-app", "continue-startup"],
      retryable: false,
    })
  })

  test("database too new exposes the three existing boot actions", () => {
    expect(
      adaptRecoveryPlan(
        { kind: "database", plan: { kind: "db-ahead", unknown: ["future"], latest: "future" }, backupAvailable: false },
        silent,
      ),
    ).toEqual({
      code: "RECOVERY_DATABASE_TOO_NEW",
      category: "database-too-new",
      actions: ["exit-app", "backup-and-continue", "continue-startup"],
      retryable: false,
    })
  })

  test("sidecar give-up maps to engine retry; an active self-heal is not a recovery state", () => {
    expect(adaptRecoveryPlan({ kind: "engine", plan: { action: "give-up", state: { attempts: 5, lastSpawnAt: 10 } } }, silent)).toEqual({
      code: "RECOVERY_ENGINE_STOPPED",
      category: "engine-stopped",
      actions: ["retry-engine"],
      retryable: true,
    })
    expect(
      adaptRecoveryPlan(
        { kind: "engine", plan: { action: "heal", delayMs: 1000, state: { attempts: 1, lastSpawnAt: 10 } } },
        silent,
      ),
    ).toBeNull()
  })

  test("surface crash only exposes retry while its failure record save has failed", () => {
    expect(adaptRecoveryPlan({ kind: "surface", failureRecord: "failed" }, silent)).toEqual({
      code: "RECOVERY_SURFACE_CRASHED",
      category: "surface-crashed",
      actions: ["retry-failure-save"],
      retryable: true,
    })
    expect(adaptRecoveryPlan({ kind: "surface", failureRecord: "pending" }, silent)?.actions).toEqual([])
    expect(adaptRecoveryPlan({ kind: "surface", failureRecord: "saved" }, silent)).toEqual({
      code: "RECOVERY_SURFACE_CRASHED",
      category: "surface-crashed",
      actions: [],
      retryable: false,
    })
  })

  test("non-failure database plans do not invent a recovery state", () => {
    expect(adaptRecoveryPlan({ kind: "database", plan: { kind: "proceed" }, backupAvailable: false }, silent)).toBeNull()
    expect(
      adaptRecoveryPlan(
        { kind: "database", plan: { kind: "migrate-ahead", pending: ["migration"] }, backupAvailable: false },
        silent,
      ),
    ).toBeNull()
    expect(
      adaptRecoveryPlan({ kind: "database", plan: { kind: "skip", reason: "read failed" }, backupAvailable: false }, silent),
    ).toBeNull()
  })

  test("renderer and logger values exclude path, home name, secret, exception text, stack, and source identifiers", () => {
    const poison = "Error: token=sk-secret at /Users/alice/private/config.json\n    at save (/home/alice/app.ts:1:1)"
    const logs: unknown[] = []
    const log: RecoveryLogger = (event, detail) => logs.push({ event, detail })
    const values = [
      adaptRecoveryPlan({ kind: "database", plan: { kind: "corrupt", detail: poison }, backupAvailable: true }, log),
      adaptRecoveryPlan(
        { kind: "database", plan: { kind: "db-ahead", unknown: [poison], latest: poison }, backupAvailable: false },
        log,
      ),
      adaptRecoveryPlan(
        { kind: "engine", plan: { action: "give-up", state: { attempts: 5, lastSpawnAt: 10 } }, error: new Error(poison) },
        log,
      ),
      adaptRecoveryPlan({ kind: "surface", failureRecord: "failed", error: new Error(poison) }, log),
    ]
    const rendered = JSON.stringify({ values, logs })
    for (const forbidden of ["/Users/", "/home/", "alice", "sk-secret", "config.json", "Error:", "at save", "future"]) {
      expect(rendered).not.toContain(forbidden)
    }
    expect(logs).toEqual([
      { event: "recovery-plan", detail: { code: "RECOVERY_DATABASE_CORRUPT", status: "available" } },
      { event: "recovery-plan", detail: { code: "RECOVERY_DATABASE_TOO_NEW", status: "available" } },
      { event: "recovery-plan", detail: { code: "RECOVERY_ENGINE_STOPPED", status: "available" } },
      { event: "recovery-plan", detail: { code: "RECOVERY_SURFACE_CRASHED", status: "available" } },
    ])
    expect(Object.keys(values[0] ?? {}).sort()).toEqual(["actions", "category", "code", "retryable"])
  })

  test("a throwing logger cannot escape adaptRecoveryPlan or change its safe DTO", () => {
    const poison = "Error: token=sk-secret at /Users/alice/private/config.json\n    at adapt (/home/alice/app.ts:1:1)"
    const result = adaptRecoveryPlan(
      { kind: "database", plan: { kind: "corrupt", detail: poison }, backupAvailable: false },
      () => {
        throw new Error(poison)
      },
    )

    expect(result).toEqual({
      code: "RECOVERY_DATABASE_CORRUPT",
      category: "database-corrupt",
      actions: ["exit-app", "continue-startup"],
      retryable: false,
    })
    expect(JSON.stringify(result)).not.toContain("sk-secret")
  })

  test("a rejecting logger cannot escape adaptRecoveryPlan or change its safe DTO", async () => {
    const poison = "Error: token=sk-secret at /Users/alice/private/config.json\n    at adapt (/home/alice/app.ts:1:1)"
    const result = adaptRecoveryPlan(
      { kind: "database", plan: { kind: "corrupt", detail: poison }, backupAvailable: false },
      () => Promise.reject(new Error(poison)),
    )
    await Promise.resolve()

    expect(result).toEqual({
      code: "RECOVERY_DATABASE_CORRUPT",
      category: "database-corrupt",
      actions: ["exit-app", "continue-startup"],
      retryable: false,
    })
    expect(JSON.stringify(result)).not.toContain("sk-secret")
  })
})

function createRetryPlan(log: RecoveryLogger = silent) {
  const plan = adaptRecoveryPlan(
    { kind: "engine", plan: { action: "give-up", state: { attempts: 5, lastSpawnAt: 10 } } },
    log,
  )
  if (!plan) throw new Error("Expected engine recovery plan")
  return plan
}

function createDatabaseTooNewPlan(log: RecoveryLogger = silent) {
  const plan = adaptRecoveryPlan(
    { kind: "database", plan: { kind: "db-ahead", unknown: ["future"], latest: "future" }, backupAvailable: false },
    log,
  )
  if (!plan) throw new Error("Expected database recovery plan")
  return plan
}

describe("createRecoveryActionAdapter — idempotent submission", () => {
  test("sequential duplicate applies once and reports the second call as not newly applied", async () => {
    let calls = 0
    const adapter = createRecoveryActionAdapter(
      createRetryPlan(),
      {
        [RECOVERY_ACTIONS.retryEngine]: () => {
          calls++
          return { applied: true }
        },
      },
      silent,
    )

    expect(await adapter.submit(RECOVERY_ACTIONS.retryEngine)).toEqual({
      ok: true,
      code: "RECOVERY_ACTION_APPLIED",
      action: "retry-engine",
      applied: true,
    })
    expect(await adapter.submit(RECOVERY_ACTIONS.retryEngine)).toEqual({
      ok: true,
      code: "RECOVERY_ACTION_ALREADY_APPLIED",
      action: "retry-engine",
      applied: false,
    })
    expect(calls).toBe(1)
  })

  test("concurrent duplicate coalesces one effect and preserves applied truth", async () => {
    let calls = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const adapter = createRecoveryActionAdapter(
      createRetryPlan(),
      {
        [RECOVERY_ACTIONS.retryEngine]: async () => {
          calls++
          await gate
          return { applied: true }
        },
      },
      silent,
    )
    const first = adapter.submit(RECOVERY_ACTIONS.retryEngine)
    const duplicate = adapter.submit(RECOVERY_ACTIONS.retryEngine)
    release!()

    expect(await first).toMatchObject({ code: "RECOVERY_ACTION_APPLIED", applied: true })
    expect(await duplicate).toMatchObject({ code: "RECOVERY_ACTION_ALREADY_APPLIED", applied: false })
    expect(calls).toBe(1)
  })

  test("two adapters for one incident coalesce concurrent submissions into one effect", async () => {
    let calls = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const plan = createRetryPlan()
    const effects = {
      [RECOVERY_ACTIONS.retryEngine]: async () => {
        calls++
        await gate
        return { applied: true } as const
      },
    }
    const firstAdapter = createRecoveryActionAdapter(plan, effects, silent)
    const rebuiltAdapter = createRecoveryActionAdapter(plan, effects, silent)

    const first = firstAdapter.submit(RECOVERY_ACTIONS.retryEngine)
    const duplicate = rebuiltAdapter.submit(RECOVERY_ACTIONS.retryEngine)
    release!()

    expect(await first).toMatchObject({ code: "RECOVERY_ACTION_APPLIED", applied: true })
    expect(await duplicate).toMatchObject({ code: "RECOVERY_ACTION_ALREADY_APPLIED", applied: false })
    expect(calls).toBe(1)
  })

  test("adapting one source plan twice memoizes its DTO and coalesces adapters", async () => {
    let calls = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const sourcePlan = { action: "give-up", state: { attempts: 5, lastSpawnAt: 10 } } as const
    const firstPlan = adaptRecoveryPlan({ kind: "engine", plan: sourcePlan }, silent)!
    const secondPlan = adaptRecoveryPlan({ kind: "engine", plan: sourcePlan }, silent)!
    const effects = {
      [RECOVERY_ACTIONS.retryEngine]: async () => {
        calls++
        await gate
        return { applied: true } as const
      },
    }
    const firstAdapter = createRecoveryActionAdapter(firstPlan, effects, silent)
    const secondAdapter = createRecoveryActionAdapter(secondPlan, effects, silent)

    expect(secondPlan).toBe(firstPlan)
    const first = firstAdapter.submit(RECOVERY_ACTIONS.retryEngine)
    const duplicate = secondAdapter.submit(RECOVERY_ACTIONS.retryEngine)
    release!()

    expect(await first).toMatchObject({ code: "RECOVERY_ACTION_APPLIED", applied: true })
    expect(await duplicate).toMatchObject({ code: "RECOVERY_ACTION_ALREADY_APPLIED", applied: false })
    expect(calls).toBe(1)
  })

  test("a cloned renderer DTO is rejected because it is not the main-process incident owner", () => {
    const plan = createRetryPlan()

    expect(() =>
      createRecoveryActionAdapter(
        structuredClone(plan),
        { [RECOVERY_ACTIONS.retryEngine]: () => ({ applied: true }) },
        silent,
      ),
    ).toThrow("Recovery action adapters require an owned recovery incident")
  })

  test("an effect must explicitly confirm application; failed effects can retry only when truthful", async () => {
    let calls = 0
    const logged: Record<string, unknown>[] = []
    const adapter = createRecoveryActionAdapter(
      createRetryPlan(),
      {
        [RECOVERY_ACTIONS.retryEngine]: () =>
          ++calls === 1 ? { applied: false, retryable: true, error: new Error("/Users/alice sk-secret") } : { applied: true },
      },
      (_event, detail) => logged.push(detail),
    )

    expect(await adapter.submit(RECOVERY_ACTIONS.retryEngine)).toEqual({
      ok: false,
      code: "RECOVERY_ACTION_FAILED",
      action: "retry-engine",
      retryable: true,
    })
    expect(await adapter.submit(RECOVERY_ACTIONS.retryEngine)).toMatchObject({ code: "RECOVERY_ACTION_APPLIED", applied: true })
    expect(calls).toBe(2)
    const rendered = JSON.stringify(logged)
    for (const forbidden of ["/Users/", "alice", "sk-secret", "Error:", "at "]) expect(rendered).not.toContain(forbidden)
    expect(logged).toEqual([
      {
        code: "RECOVERY_ENGINE_STOPPED",
        action: "retry-engine",
        status: "failed",
        reason: "effect-not-applied",
      },
    ])
  })

  test("non-retryable failure is cached and never repeats its side effect", async () => {
    let calls = 0
    const plan = adaptRecoveryPlan(
      { kind: "database", plan: { kind: "corrupt", detail: "bad db" }, backupAvailable: true },
      silent,
    )!
    const adapter = createRecoveryActionAdapter(
      plan,
      {
        [RECOVERY_ACTIONS.restoreLatestBackup]: () => {
          calls++
          return { applied: false, retryable: true, error: "failed" }
        },
      },
      silent,
    )

    const first = await adapter.submit(RECOVERY_ACTIONS.restoreLatestBackup)
    const second = await adapter.submit(RECOVERY_ACTIONS.restoreLatestBackup)
    expect(first).toEqual(second)
    expect(first).toMatchObject({ ok: false, code: "RECOVERY_ACTION_FAILED", retryable: false })
    expect(calls).toBe(1)
  })

  test("an explicit not-applied result remains action-scoped because its side-effect boundary is known", async () => {
    let backupCalls = 0
    let continueCalls = 0
    const adapter = createRecoveryActionAdapter(
      createDatabaseTooNewPlan(),
      {
        [RECOVERY_ACTIONS.backupAndContinue]: () => {
          backupCalls++
          return { applied: false, retryable: false }
        },
        [RECOVERY_ACTIONS.continueStartup]: () => {
          continueCalls++
          return { applied: true }
        },
      },
      silent,
    )

    expect(await adapter.submit(RECOVERY_ACTIONS.backupAndContinue)).toMatchObject({
      code: "RECOVERY_ACTION_FAILED",
      retryable: false,
    })
    expect(await adapter.submit(RECOVERY_ACTIONS.continueStartup)).toMatchObject({
      code: "RECOVERY_ACTION_APPLIED",
      applied: true,
    })
    expect({ backupCalls, continueCalls }).toEqual({ backupCalls: 1, continueCalls: 1 })
  })

  test("an unknown effect boundary terminates the incident and blocks every different action", async () => {
    let backupCalls = 0
    let continueCalls = 0
    const adapter = createRecoveryActionAdapter(
      createDatabaseTooNewPlan(),
      {
        [RECOVERY_ACTIONS.backupAndContinue]: () => {
          backupCalls++
          throw new Error("partial side effect token=sk-secret /Users/alice/private")
        },
        [RECOVERY_ACTIONS.continueStartup]: () => {
          continueCalls++
          return { applied: true }
        },
      },
      silent,
    )

    const failed = await adapter.submit(RECOVERY_ACTIONS.backupAndContinue)
    expect(failed).toEqual({
      ok: false,
      code: "RECOVERY_ACTION_FAILED",
      action: "backup-and-continue",
      retryable: false,
    })
    const blocked = await adapter.submit(RECOVERY_ACTIONS.continueStartup)
    expect(blocked).toEqual({
      ok: false,
      code: "RECOVERY_ACTION_CONFLICT",
      action: "continue-startup",
      retryable: false,
    })
    expect(await adapter.submit(RECOVERY_ACTIONS.continueStartup)).toEqual(blocked)
    expect(await adapter.submit(RECOVERY_ACTIONS.backupAndContinue)).toEqual(failed)
    expect({ backupCalls, continueCalls }).toEqual({ backupCalls: 1, continueCalls: 0 })
  })

  test("unavailable and conflicting actions produce no side effect", async () => {
    let calls = 0
    const plan = createDatabaseTooNewPlan()
    const adapter = createRecoveryActionAdapter(
      plan,
      {
        [RECOVERY_ACTIONS.exitApp]: () => {
          calls++
          return { applied: true }
        },
        [RECOVERY_ACTIONS.continueStartup]: () => {
          calls++
          return { applied: true }
        },
      },
      silent,
    )

    expect(await adapter.submit(RECOVERY_ACTIONS.retryEngine)).toMatchObject({ code: "RECOVERY_ACTION_UNAVAILABLE" })
    expect(await adapter.submit(RECOVERY_ACTIONS.exitApp)).toMatchObject({ code: "RECOVERY_ACTION_APPLIED", applied: true })
    expect(await adapter.submit(RECOVERY_ACTIONS.continueStartup)).toEqual({
      ok: false,
      code: "RECOVERY_ACTION_CONFLICT",
      action: "continue-startup",
      retryable: false,
    })
    expect(calls).toBe(1)
  })

  test("a throwing action logger cannot expose the effect exception or change the safe failure DTO", async () => {
    const poison = "Error: token=sk-secret /Users/alice/private\n    at retry (/home/alice/app.ts:1:1)"
    const adapter = createRecoveryActionAdapter(
      createRetryPlan(),
      { [RECOVERY_ACTIONS.retryEngine]: () => Promise.reject(new Error(poison)) },
      () => {
        throw new Error(poison)
      },
    )
    const result: RecoveryActionResult = await adapter.submit(RECOVERY_ACTIONS.retryEngine)
    const rendered = JSON.stringify(result)
    for (const forbidden of ["/Users/", "/home/", "alice", "sk-secret", "Error:", "at retry"]) {
      expect(rendered).not.toContain(forbidden)
    }
    expect(result).toEqual({
      ok: false,
      code: "RECOVERY_ACTION_FAILED",
      action: "retry-engine",
      retryable: false,
    })
    expect(Object.keys(result).sort()).toEqual(["action", "code", "ok", "retryable"])
  })
})
