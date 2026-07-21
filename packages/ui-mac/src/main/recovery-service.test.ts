import { describe, expect, mock, test } from "bun:test"
import { RECOVERY_ACTIONS, RECOVERY_ACTION_RESULT_CODES } from "../shared/recovery"
import { createRecoveryService } from "./recovery-service"

describe("RecoveryService main-owned incident identity", () => {
  test("the exact engine plan is adapted once, returns the same wire object, and applies once", async () => {
    const service = createRecoveryService({ log: () => {}, createID: () => "incident-engine" })
    const plan = { action: "give-up" as const, state: { attempts: 5, lastSpawnAt: 10 } }
    const retry = mock(async () => ({ applied: true as const }))
    const first = service.register({
      source: { kind: "engine", plan },
      effects: { [RECOVERY_ACTIONS.retryEngine]: retry },
      senderID: 11,
    })
    const second = service.register({
      source: { kind: "engine", plan },
      effects: { [RECOVERY_ACTIONS.retryEngine]: retry },
      senderID: 11,
    })

    expect(second).toBe(first)
    expect(await service.submit(first!.incident, RECOVERY_ACTIONS.retryEngine, 11)).toEqual({
      ok: true,
      code: RECOVERY_ACTION_RESULT_CODES.applied,
      action: RECOVERY_ACTIONS.retryEngine,
      applied: true,
    })
    expect(await service.submit(first!.incident, RECOVERY_ACTIONS.retryEngine, 11)).toEqual({
      ok: true,
      code: RECOVERY_ACTION_RESULT_CODES.alreadyApplied,
      action: RECOVERY_ACTIONS.retryEngine,
      applied: false,
    })
    expect(retry).toHaveBeenCalledTimes(1)
  })

  test("one renderer crashID persists once and reuses one failed-save incident across IPC-like retries", async () => {
    const service = createRecoveryService({ log: () => {}, createID: () => "incident-surface" })
    const persist = mock(async () => {
      if (persist.mock.calls.length === 1) throw new Error("/Users/alice/private sk-secret")
    })
    const request = { crashID: "crash-stable-001", surface: "home" as const }
    const [first, second] = await Promise.all([
      service.startSurface(request, 22, persist),
      service.startSurface({ ...request }, 22, persist),
    ])

    expect(second).toBe(first)
    expect(first.plan.actions).toEqual([RECOVERY_ACTIONS.retryFailureSave])
    expect(JSON.stringify(first)).not.toContain("/Users/")
    expect(JSON.stringify(first)).not.toContain("sk-secret")
    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist.mock.calls[0]?.[0]).toEqual({ surface: "home" })
    expect(service.startSurface({ crashID: request.crashID, surface: "session" }, 22, persist)).rejects.toThrow(
      "conflicts with an existing incident",
    )

    const results = await Promise.all([
      service.submit(first.incident, RECOVERY_ACTIONS.retryFailureSave, 22),
      service.submit(first.incident, RECOVERY_ACTIONS.retryFailureSave, 22),
    ])
    expect(results.map((result) => result.code).sort()).toEqual(
      [RECOVERY_ACTION_RESULT_CODES.alreadyApplied, RECOVERY_ACTION_RESULT_CODES.applied].sort(),
    )
    expect(persist).toHaveBeenCalledTimes(2)
  })

  test("unknown sender and malformed action fail closed without running an effect", async () => {
    const service = createRecoveryService({ log: () => {}, createID: () => "incident-denied" })
    const plan = { action: "give-up" as const, state: { attempts: 5, lastSpawnAt: 10 } }
    const retry = mock(async () => ({ applied: true as const }))
    const wire = service.register({
      source: { kind: "engine", plan },
      effects: { [RECOVERY_ACTIONS.retryEngine]: retry },
      senderID: 1,
    })!
    expect(await service.submit(wire.incident, RECOVERY_ACTIONS.retryEngine, 2)).toMatchObject({
      ok: false,
      code: RECOVERY_ACTION_RESULT_CODES.unavailable,
    })
    expect(service.submit(wire.incident, "open-path", 1)).rejects.toThrow("unavailable")
    expect(retry).not.toHaveBeenCalled()
  })
})
