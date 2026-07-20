import { describe, expect, test } from "bun:test"
import {
  RECOVERY_ACTIONS,
  adaptRecoveryPlan,
  createRecoveryActionAdapter,
  type RecoveryActionResult,
  type RecoveryLogger,
  type RecoveryPlan,
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

  test("renderer-safe values exclude path, home name, secret, exception text, stack, and source identifiers", () => {
    const poison = "Error: token=sk-secret at /Users/alice/private/config.json\n    at save (/home/alice/app.ts:1:1)"
    const logs: Record<string, unknown>[] = []
    const log: RecoveryLogger = (_event, detail) => logs.push(detail)
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
    const rendered = JSON.stringify(values)
    for (const forbidden of ["/Users/", "/home/", "alice", "sk-secret", "config.json", "Error:", "at save", "future"]) {
      expect(rendered).not.toContain(forbidden)
    }
    expect(JSON.stringify(logs)).toContain("sk-secret")
    expect(Object.keys(values[0] ?? {}).sort()).toEqual(["actions", "category", "code", "retryable"])
  })
})

const retryPlan: RecoveryPlan = {
  code: "RECOVERY_ENGINE_STOPPED",
  category: "engine-stopped",
  actions: [RECOVERY_ACTIONS.retryEngine],
  retryable: true,
}

describe("createRecoveryActionAdapter — idempotent submission", () => {
  test("sequential duplicate applies once and reports the second call as not newly applied", async () => {
    let calls = 0
    const adapter = createRecoveryActionAdapter(
      retryPlan,
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
      retryPlan,
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

  test("an effect must explicitly confirm application; failed effects can retry only when truthful", async () => {
    let calls = 0
    const logged: Record<string, unknown>[] = []
    const adapter = createRecoveryActionAdapter(
      retryPlan,
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
    expect((logged[0]?.error as Error).message).toContain("sk-secret")
  })

  test("non-retryable failure is cached and never repeats its side effect", async () => {
    let calls = 0
    const plan: RecoveryPlan = {
      code: "RECOVERY_DATABASE_CORRUPT",
      category: "database-corrupt",
      actions: [RECOVERY_ACTIONS.restoreLatestBackup],
      retryable: false,
    }
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

  test("unavailable and conflicting actions produce no side effect", async () => {
    let calls = 0
    const plan: RecoveryPlan = {
      code: "RECOVERY_DATABASE_TOO_NEW",
      category: "database-too-new",
      actions: [RECOVERY_ACTIONS.exitApp, RECOVERY_ACTIONS.continueStartup],
      retryable: false,
    }
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

  test("unknown thrown exceptions are redacted and fail closed as non-retryable", async () => {
    const adapter = createRecoveryActionAdapter(
      retryPlan,
      { [RECOVERY_ACTIONS.retryEngine]: () => Promise.reject(new Error("token=sk-secret /Users/alice/private")) },
      silent,
    )
    const result: RecoveryActionResult = await adapter.submit(RECOVERY_ACTIONS.retryEngine)
    expect(JSON.stringify(result)).not.toContain("sk-secret")
    expect(JSON.stringify(result)).not.toContain("/Users/")
    expect(result).toMatchObject({ ok: false, code: "RECOVERY_ACTION_FAILED", retryable: false })
    expect(Object.keys(result).sort()).toEqual(["action", "code", "ok", "retryable"])
  })
})
