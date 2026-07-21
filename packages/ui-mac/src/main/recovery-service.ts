import { randomUUID } from "node:crypto"
import type { SurfaceId } from "../shared/alpha-surfaces"
import {
  RECOVERY_ACTIONS,
  RECOVERY_ACTION_RESULT_CODES,
  isRecoveryAction,
  type RecoveryAction,
  type RecoveryActionResult,
  type RecoveryIncidentWire,
} from "../shared/recovery"
import {
  adaptRecoveryPlan,
  createRecoveryActionAdapter,
  type RecoveryActionEffects,
  type RecoveryLogger,
  type RecoverySource,
} from "./recovery-adapter"

type RegisteredIncident = {
  adapter: ReturnType<typeof createRecoveryActionAdapter>
  allowedSenders: Set<number>
  onApplied: Set<(action: RecoveryAction) => void>
  wire: RecoveryIncidentWire
}

export type SurfaceRecoveryRequest = {
  crashID: string
  surface: SurfaceId
}

/**
 * Owns every process-local recovery incident. Renderer handles are opaque; only this registry keeps
 * the exact source plan and adapted plan objects that #434 needs for effect-once semantics.
 */
export function createRecoveryService(options: { log: RecoveryLogger; createID?: () => string }) {
  const incidents = new Map<string, RegisteredIncident>()
  const sources = new WeakMap<object, RegisteredIncident>()
  const surfaceStarts = new Map<number, Map<string, { surface: SurfaceId; started: Promise<RecoveryIncidentWire> }>>()

  const register = (input: {
    source: RecoverySource
    effects: RecoveryActionEffects
    senderID: number
    onApplied?: (action: RecoveryAction) => void
  }) => {
    const source = input.source.kind === "surface" ? input.source : input.source.plan
    const existing = sources.get(source)
    if (existing) {
      existing.allowedSenders.add(input.senderID)
      if (input.onApplied) existing.onApplied.add(input.onApplied)
      return existing.wire
    }

    const plan = adaptRecoveryPlan(input.source, options.log)
    if (!plan) return null
    const incident = (options.createID ?? randomUUID)()
    const entry: RegisteredIncident = {
      adapter: createRecoveryActionAdapter(plan, input.effects, options.log),
      allowedSenders: new Set([input.senderID]),
      onApplied: new Set(input.onApplied ? [input.onApplied] : []),
      wire: { incident, plan },
    }
    incidents.set(incident, entry)
    sources.set(source, entry)
    return entry.wire
  }

  return {
    register,
    allow(incident: string, senderID: number) {
      const entry = incidents.get(incident)
      if (!entry) throw new Error("Recovery incident is unavailable")
      entry.allowedSenders.add(senderID)
    },
    async submit(incident: string, action: unknown, senderID: number): Promise<RecoveryActionResult> {
      if (!isRecoveryAction(action)) throw new Error("Recovery action is unavailable")
      const entry = incidents.get(incident)
      if (!entry || !entry.allowedSenders.has(senderID)) {
        return { ok: false, code: RECOVERY_ACTION_RESULT_CODES.unavailable, action, retryable: false }
      }
      const result = await entry.adapter.submit(action)
      if (result.ok && result.applied) entry.onApplied.forEach((notify) => notify(action))
      return result
    },
    startSurface(
      request: SurfaceRecoveryRequest,
      senderID: number,
      persist: (payload: { surface: SurfaceId }) => void | Promise<void>,
    ) {
      if (
        !request ||
        !/^[A-Za-z0-9_-]{8,128}$/.test(request.crashID) ||
        !["home", "newSession", "session"].includes(request.surface)
      ) {
        return Promise.reject(new Error("Recovery crash identity is invalid"))
      }
      const starts = surfaceStarts.get(senderID) ?? new Map()
      surfaceStarts.set(senderID, starts)
      const existing = starts.get(request.crashID)
      if (existing && existing.surface !== request.surface) {
        return Promise.reject(new Error("Recovery crash identity conflicts with an existing incident"))
      }
      if (existing) return existing.started

      const started = Promise.resolve()
        .then(() => persist({ surface: request.surface }))
        .then(
          () => ({ kind: "surface", failureRecord: "saved" }) as const,
          () => ({ kind: "surface", failureRecord: "failed" }) as const,
        )
        .then((source) => {
          const wire = register({
            source,
            senderID,
            effects: {
              [RECOVERY_ACTIONS.retryFailureSave]: async () => {
                try {
                  await persist({ surface: request.surface })
                  return { applied: true }
                } catch {
                  return { applied: false, retryable: true }
                }
              },
            },
          })
          if (!wire) throw new Error("Recovery incident is unavailable")
          return wire
        })
      starts.set(request.crashID, { surface: request.surface, started })
      return started
    },
  }
}

export type RecoveryService = ReturnType<typeof createRecoveryService>
