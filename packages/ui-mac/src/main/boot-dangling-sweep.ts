// REQ-053 AC2 boot dangling sweep — extracted so OPENCODE_TEST_ONBOARDING can still
// skip REQ-059/065/104 reconcile without skipping this call (`#1031`).
import { sweepEngineConfigDanglingUnlocked, type DanglingSweepOutcome } from "./engine-config-dangling"

export type BootDanglingSweepLog = {
  error: (message: string, extra?: unknown) => void
}

export type BootDanglingSweepResult = {
  outcome: DanglingSweepOutcome
  enforcementGap: string[]
}

export function runBootDanglingSweep(options: {
  userDataPath: string
  engineDataPath: string
  homeDir?: string
  log?: BootDanglingSweepLog
}): BootDanglingSweepResult {
  try {
    const outcome = sweepEngineConfigDanglingUnlocked({
      phase: "boot",
      userDataPath: options.userDataPath,
      engineDataPath: options.engineDataPath,
      homeDir: options.homeDir,
    })
    if (outcome.enforcementGap.length > 0) {
      options.log?.error("[req053-dangling-sweep] boot enforcement gap — blocking sidecar", {
        gap: outcome.enforcementGap,
      })
    }
    return { outcome, enforcementGap: [...outcome.enforcementGap] }
  } catch (error) {
    const gap = `dangling sweep crashed: ${error instanceof Error ? error.message : String(error)}`
    options.log?.error("[req053-dangling-sweep] boot sweep crashed — blocking sidecar (fail closed)", error)
    return {
      outcome: { changedFiles: [], stripped: [], warnings: [], enforcementGap: [] },
      enforcementGap: [gap],
    }
  }
}
