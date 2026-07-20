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

declare const recoveryIncident: unique symbol

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
  readonly [recoveryIncident]: true
}

export type RecoverySource =
  | { kind: "database"; plan: PreflightPlan; backupAvailable: boolean }
  | { kind: "engine"; plan: SelfHealPlan; error?: unknown }
  | { kind: "surface"; failureRecord: "pending" | "saved" | "failed"; error?: unknown }

export type RecoveryLogDetail =
  | { code: RecoveryCode; status: "available" }
  | {
      code: RecoveryCode
      action: RecoveryAction
      status: "failed"
      reason: "effect-not-applied" | "effect-boundary-unknown"
    }

export type RecoveryLogger = (
  event: "recovery-plan" | "recovery-action-failed",
  detail: RecoveryLogDetail,
) => void | Promise<void>

/**
 * Converts existing recovery decisions into the renderer-safe contract. Neither the returned object
 * nor injected logger receives paths, exceptions, stacks, secrets, migration ids, backup names, or
 * surface ids.
 */
export function adaptRecoveryPlan(source: RecoverySource, log: RecoveryLogger): RecoveryPlan | null {
  const incidentSource = source.kind === "surface" ? source : source.plan
  const existing = recoveryIncidents.get(incidentSource)
  if (existing) return existing.plan

  if (source.kind === "database") {
    if (source.plan.kind === "corrupt") {
      const result = registerRecoveryIncident(incidentSource, {
        code: RECOVERY_CODES.databaseCorrupt,
        category: "database-corrupt",
        actions: source.backupAvailable
          ? [RECOVERY_ACTIONS.restoreLatestBackup, RECOVERY_ACTIONS.exitApp, RECOVERY_ACTIONS.continueStartup]
          : [RECOVERY_ACTIONS.exitApp, RECOVERY_ACTIONS.continueStartup],
        retryable: false,
      })
      logRecovery(log, "recovery-plan", { code: result.code, status: "available" })
      return result
    }
    if (source.plan.kind !== "db-ahead") return null
    const result = registerRecoveryIncident(incidentSource, {
      code: RECOVERY_CODES.databaseTooNew,
      category: "database-too-new",
      actions: [RECOVERY_ACTIONS.exitApp, RECOVERY_ACTIONS.backupAndContinue, RECOVERY_ACTIONS.continueStartup],
      retryable: false,
    })
    logRecovery(log, "recovery-plan", { code: result.code, status: "available" })
    return result
  }

  if (source.kind === "engine") {
    if (source.plan.action !== "give-up") return null
    const result = registerRecoveryIncident(incidentSource, {
      code: RECOVERY_CODES.engineStopped,
      category: "engine-stopped",
      actions: [RECOVERY_ACTIONS.retryEngine],
      retryable: true,
    })
    logRecovery(log, "recovery-plan", { code: result.code, status: "available" })
    return result
  }

  const canRetrySave = source.failureRecord === "failed"
  const result = registerRecoveryIncident(incidentSource, {
    code: RECOVERY_CODES.surfaceCrashed,
    category: "surface-crashed",
    actions: canRetrySave ? [RECOVERY_ACTIONS.retryFailureSave] : [],
    retryable: canRetrySave,
  })
  logRecovery(log, "recovery-plan", { code: result.code, status: "available" })
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

type RecoveryIncidentState = {
  terminalFailures: Map<RecoveryAction, RecoveryActionResult>
  appliedAction?: RecoveryAction
  unknownBoundaryAction?: RecoveryAction
  inflight?: { action: RecoveryAction; result: Promise<RecoveryActionResult> }
}

const recoveryIncidents = new WeakMap<object, { plan: RecoveryPlan; state: RecoveryIncidentState }>()
const recoverySources = new WeakMap<RecoveryPlan, object>()

/** Adapter instances for DTOs memoized from the same source plan share one process-local incident state. */
export function createRecoveryActionAdapter(plan: RecoveryPlan, effects: RecoveryActionEffects, log: RecoveryLogger) {
  const incidentSource = recoverySources.get(plan)
  const state = incidentSource ? recoveryIncidents.get(incidentSource)?.state : undefined
  if (!state) throw new Error("Recovery action adapters require an owned recovery incident")

  return {
    plan,
    submit(action: RecoveryAction): Promise<RecoveryActionResult> {
      if (state.unknownBoundaryAction) {
        if (state.unknownBoundaryAction === action) return Promise.resolve(state.terminalFailures.get(action)!)
        return Promise.resolve({ ok: false, code: RECOVERY_ACTION_RESULT_CODES.conflict, action, retryable: false })
      }
      if (!plan.actions.includes(action) || !effects[action]) {
        return Promise.resolve({ ok: false, code: RECOVERY_ACTION_RESULT_CODES.unavailable, action, retryable: false })
      }
      if (state.appliedAction === action) {
        return Promise.resolve({ ok: true, code: RECOVERY_ACTION_RESULT_CODES.alreadyApplied, action, applied: false })
      }
      if (state.appliedAction) {
        return Promise.resolve({ ok: false, code: RECOVERY_ACTION_RESULT_CODES.conflict, action, retryable: false })
      }
      if (state.inflight?.action === action) {
        return state.inflight.result.then((result) =>
          result.ok
            ? { ok: true, code: RECOVERY_ACTION_RESULT_CODES.alreadyApplied, action, applied: false }
            : result,
        )
      }
      if (state.inflight) return Promise.resolve({ ok: false, code: RECOVERY_ACTION_RESULT_CODES.busy, action, retryable: true })
      const terminal = state.terminalFailures.get(action)
      if (terminal) return Promise.resolve(terminal)

      const effect = effects[action]!
      const result = Promise.resolve()
        .then(effect)
        .then((outcome): RecoveryActionResult => {
          if (outcome.applied) {
            state.appliedAction = action
            return { ok: true, code: RECOVERY_ACTION_RESULT_CODES.applied, action, applied: true }
          }
          const failure: RecoveryActionResult = {
            ok: false,
            code: RECOVERY_ACTION_RESULT_CODES.failed,
            action,
            retryable: plan.retryable && outcome.retryable,
          }
          logRecovery(log, "recovery-action-failed", {
            code: plan.code,
            action,
            status: "failed",
            reason: "effect-not-applied",
          })
          if (!failure.retryable) state.terminalFailures.set(action, failure)
          return failure
        })
        .catch((): RecoveryActionResult => {
          const failure: RecoveryActionResult = {
            ok: false,
            code: RECOVERY_ACTION_RESULT_CODES.failed,
            action,
            retryable: false,
          }
          logRecovery(log, "recovery-action-failed", {
            code: plan.code,
            action,
            status: "failed",
            reason: "effect-boundary-unknown",
          })
          state.terminalFailures.set(action, failure)
          state.unknownBoundaryAction = action
          return failure
        })
        .finally(() => {
          state.inflight = undefined
        })
      state.inflight = { action, result }
      return result
    },
  }
}

function registerRecoveryIncident(source: object, plan: Omit<RecoveryPlan, typeof recoveryIncident>) {
  const result = plan as RecoveryPlan
  recoveryIncidents.set(source, { plan: result, state: { terminalFailures: new Map() } })
  recoverySources.set(result, source)
  return result
}

function logRecovery(
  log: RecoveryLogger,
  event: "recovery-plan" | "recovery-action-failed",
  detail: RecoveryLogDetail,
) {
  try {
    const pending = log(event, detail)
    if (pending) void pending.catch(() => {})
  } catch {}
}
