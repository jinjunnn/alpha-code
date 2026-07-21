// REQ-090 Recovery wire contract. This module contains renderer-safe values only and is shared
// across main, preload, and renderer bundles. Incident ownership stays process-local in main.

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

export type RecoveryPlanView = {
  code: RecoveryCode
  category: "database-corrupt" | "database-too-new" | "engine-stopped" | "surface-crashed"
  actions: readonly RecoveryAction[]
  retryable: boolean
}

export type RecoveryActionResult =
  | { ok: true; code: "RECOVERY_ACTION_APPLIED"; action: RecoveryAction; applied: true }
  | { ok: true; code: "RECOVERY_ACTION_ALREADY_APPLIED"; action: RecoveryAction; applied: false }
  | {
      ok: false
      code:
        | "RECOVERY_ACTION_FAILED"
        | "RECOVERY_ACTION_UNAVAILABLE"
        | "RECOVERY_ACTION_BUSY"
        | "RECOVERY_ACTION_CONFLICT"
      action: RecoveryAction
      retryable: boolean
    }

/** Opaque handle only; it never contains a source id, path, error, or recovery-plan identity. */
export type RecoveryIncidentWire = {
  incident: string
  plan: RecoveryPlanView
}

export function isRecoveryAction(value: unknown): value is RecoveryAction {
  return typeof value === "string" && Object.values(RECOVERY_ACTIONS).includes(value as RecoveryAction)
}
