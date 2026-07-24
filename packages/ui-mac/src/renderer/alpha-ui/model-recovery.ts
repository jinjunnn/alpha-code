import type { SidecarGenerationState } from "../../preload/types"

export type RecoveryLoadState = "loading" | "recovering" | "failed"

export function shouldApplySidecarState(
  previous: SidecarGenerationState | undefined,
  next: SidecarGenerationState,
): boolean {
  if (!previous) return true
  if (next.generation < previous.generation) return false
  if (next.generation > previous.generation) return true
  if (next.status === previous.status) return false
  return previous.status === "recovering" && next.status === "ready"
}

export function accountResultState(result: unknown): "ready" | "recovering" | "failed" {
  if (!result || typeof result !== "object" || !("error" in result)) return "ready"
  const error = String(result.error)
  if (
    error === "network" ||
    error === "unauthorized" ||
    error === "not-authenticated" ||
    /^http-(408|425|429|5\d\d)$/.test(error)
  )
    return "recovering"
  return "failed"
}

export function createRetryWakeup(deps: {
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
  onCancel?: (reason: string, outcome: "queued" | "cancelled") => void
} = {}) {
  const setTimer = deps.setTimer ?? setTimeout
  const clearTimer = deps.clearTimer ?? clearTimeout
  let timer: ReturnType<typeof setTimeout> | undefined
  let wakeReason: string | undefined
  let resolveWait: ((value: "elapsed" | "cancelled") => void) | undefined
  let disposed = false
  let cancellationQueued = false

  return {
    wait(delayMs: number): Promise<"elapsed" | "cancelled"> {
      if (disposed) return Promise.resolve("cancelled")
      if (wakeReason) {
        wakeReason = undefined
        return Promise.resolve("cancelled")
      }
      return new Promise((resolve) => {
        resolveWait = resolve
        timer = setTimer(() => {
          timer = undefined
          resolveWait = undefined
          resolve("elapsed")
        }, delayMs)
      })
    },
    wake(reason: string) {
      if (cancellationQueued) return
      if (wakeReason) return
      wakeReason = reason
      if (!timer || !resolveWait) {
        deps.onCancel?.(reason, "queued")
        return
      }
      clearTimer(timer)
      timer = undefined
      const resolve = resolveWait
      resolveWait = undefined
      wakeReason = undefined
      cancellationQueued = true
      queueMicrotask(() => {
        cancellationQueued = false
      })
      deps.onCancel?.(reason, "cancelled")
      resolve("cancelled")
    },
    clear() {
      wakeReason = undefined
    },
    dispose() {
      disposed = true
      if (timer) clearTimer(timer)
      timer = undefined
      resolveWait?.("cancelled")
      resolveWait = undefined
      wakeReason = undefined
    },
  }
}
