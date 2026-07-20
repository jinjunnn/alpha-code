import type { PreflightPlan } from "./db-safety"
import type { SelfHealPlan } from "./sidecar-self-heal"

export const RECOVERY_CODES = {
  databaseCorrupt: "RECOVERY_DATABASE_CORRUPT",
  databaseTooNew: "RECOVERY_DATABASE_TOO_NEW",
  engineStopped: "RECOVERY_ENGINE_STOPPED",
  surfaceCrashed: "RECOVERY_SURFACE_CRASHED",
} as const

export type RecoveryCode = (typeof RECOVERY_CODES)[keyof typeof RECOVERY_CODES]

export const RECOVERY_ACTIONS = {
  restoreLatestBackup: "restore-latest-backup",
  exitApp: "exit-app",
  continueStartup: "continue-startup",
  backupAndContinue: "backup-and-continue",
  retryEngine: "retry-engine",
  retryFailureSave: "retry-failure-save",
} as const

export type RecoveryAction = (typeof RECOVERY_ACTIONS)[keyof typeof RECOVERY_ACTIONS]

export const RECOVERY_ACTION_RESULT_CODES = {
  applied: "RECOVERY_ACTION_APPLIED",
  alreadyApplied: "RECOVERY_ACTION_ALREADY_APPLIED",
  failed: "RECOVERY_ACTION_FAILED",
  unavailable: "RECOVERY_ACTION_UNAVAILABLE",
  busy: "RECOVERY_ACTION_BUSY",
  conflict: "RECOVERY_ACTION_CONFLICT",
} as const

export type RecoveryPlan = {
  code: RecoveryCode
  category: "database-corrupt" | "database-too-new" | "engine-stopped" | "surface-crashed"
  actions: readonly RecoveryAction[]
  retryable: boolean
}

export type RecoverySource =
  | { kind: "database"; plan: PreflightPlan; backupAvailable: boolean }
  | { kind: "engine"; plan: SelfHealPlan; error?: unknown }
  | { kind: "surface"; failureRecord: "pending" | "saved" | "failed"; error?: unknown }

export type RecoveryLogger = (event: "recovery-plan" | "recovery-action-failed", detail: Record<string, unknown>) => void

/**
 * Converts existing recovery decisions into the renderer-safe contract. Source details are sent only
 * to the injected local logger; the returned object contains no paths, exceptions, stacks, secrets,
 * migration ids, backup names, or surface ids.
 */
export function adaptRecoveryPlan(source: RecoverySource, log: RecoveryLogger): RecoveryPlan | null {
  if (source.kind === "database") {
    if (source.plan.kind === "corrupt") {
      const result: RecoveryPlan = {
        code: RECOVERY_CODES.databaseCorrupt,
        category: "database-corrupt",
        actions: source.backupAvailable
          ? [RECOVERY_ACTIONS.restoreLatestBackup, RECOVERY_ACTIONS.exitApp, RECOVERY_ACTIONS.continueStartup]
          : [RECOVERY_ACTIONS.exitApp, RECOVERY_ACTIONS.continueStartup],
        retryable: false,
      }
      log("recovery-plan", { code: result.code, source: source.plan })
      return result
    }
    if (source.plan.kind !== "db-ahead") return null
    const result: RecoveryPlan = {
      code: RECOVERY_CODES.databaseTooNew,
      category: "database-too-new",
      actions: [RECOVERY_ACTIONS.exitApp, RECOVERY_ACTIONS.backupAndContinue, RECOVERY_ACTIONS.continueStartup],
      retryable: false,
    }
    log("recovery-plan", { code: result.code, source: source.plan })
    return result
  }

  if (source.kind === "engine") {
    if (source.plan.action !== "give-up") return null
    const result: RecoveryPlan = {
      code: RECOVERY_CODES.engineStopped,
      category: "engine-stopped",
      actions: [RECOVERY_ACTIONS.retryEngine],
      retryable: true,
    }
    log("recovery-plan", { code: result.code, source: source.plan, error: source.error })
    return result
  }

  const canRetrySave = source.failureRecord === "failed"
  const result: RecoveryPlan = {
    code: RECOVERY_CODES.surfaceCrashed,
    category: "surface-crashed",
    actions: canRetrySave ? [RECOVERY_ACTIONS.retryFailureSave] : [],
    retryable: canRetrySave,
  }
  log("recovery-plan", { code: result.code, failureRecord: source.failureRecord, error: source.error })
  return result
}

export type RecoveryActionEffectResult =
  | { applied: true }
  | { applied: false; retryable: boolean; error?: unknown }

export type RecoveryActionResult =
  | { ok: true; code: "RECOVERY_ACTION_APPLIED"; action: RecoveryAction; applied: true }
  | { ok: true; code: "RECOVERY_ACTION_ALREADY_APPLIED"; action: RecoveryAction; applied: false }
  | {
      ok: false
      code: "RECOVERY_ACTION_FAILED" | "RECOVERY_ACTION_UNAVAILABLE" | "RECOVERY_ACTION_BUSY" | "RECOVERY_ACTION_CONFLICT"
      action: RecoveryAction
      retryable: boolean
    }

export type RecoveryActionEffects = Partial<
  Record<RecoveryAction, () => RecoveryActionEffectResult | Promise<RecoveryActionEffectResult>>
>

/** One instance owns one failure incident. Create a new instance only after observing a new incident. */
export function createRecoveryActionAdapter(plan: RecoveryPlan, effects: RecoveryActionEffects, log: RecoveryLogger) {
  const terminalFailures = new Map<RecoveryAction, RecoveryActionResult>()
  let appliedAction: RecoveryAction | undefined
  let inflight: { action: RecoveryAction; result: Promise<RecoveryActionResult> } | undefined

  return {
    plan,
    submit(action: RecoveryAction): Promise<RecoveryActionResult> {
      if (!plan.actions.includes(action) || !effects[action]) {
        return Promise.resolve({ ok: false, code: RECOVERY_ACTION_RESULT_CODES.unavailable, action, retryable: false })
      }
      if (appliedAction === action) {
        return Promise.resolve({ ok: true, code: RECOVERY_ACTION_RESULT_CODES.alreadyApplied, action, applied: false })
      }
      if (appliedAction) {
        return Promise.resolve({ ok: false, code: RECOVERY_ACTION_RESULT_CODES.conflict, action, retryable: false })
      }
      if (inflight?.action === action) {
        return inflight.result.then((result) =>
          result.ok
            ? { ok: true, code: RECOVERY_ACTION_RESULT_CODES.alreadyApplied, action, applied: false }
            : result,
        )
      }
      if (inflight) return Promise.resolve({ ok: false, code: RECOVERY_ACTION_RESULT_CODES.busy, action, retryable: true })
      const terminal = terminalFailures.get(action)
      if (terminal) return Promise.resolve(terminal)

      const effect = effects[action]!
      const result = Promise.resolve()
        .then(effect)
        .then((outcome): RecoveryActionResult => {
          if (outcome.applied) {
            appliedAction = action
            return { ok: true, code: RECOVERY_ACTION_RESULT_CODES.applied, action, applied: true }
          }
          const failure: RecoveryActionResult = {
            ok: false,
            code: RECOVERY_ACTION_RESULT_CODES.failed,
            action,
            retryable: plan.retryable && outcome.retryable,
          }
          log("recovery-action-failed", { recoveryCode: plan.code, action, error: outcome.error })
          if (!failure.retryable) terminalFailures.set(action, failure)
          return failure
        })
        .catch((error): RecoveryActionResult => {
          const failure: RecoveryActionResult = {
            ok: false,
            code: RECOVERY_ACTION_RESULT_CODES.failed,
            action,
            retryable: false,
          }
          log("recovery-action-failed", { recoveryCode: plan.code, action, error })
          terminalFailures.set(action, failure)
          return failure
        })
        .finally(() => {
          inflight = undefined
        })
      inflight = { action, result }
      return result
    },
  }
}
