import type { SidecarGenerationState } from "../../preload/types"
import { nextEngineRetryDelay } from "./model-picker-logic"

export type RecoveryLoadState = "loading" | "recovering" | "failed"

export function shouldApplySidecarState(
  previous: SidecarGenerationState | undefined,
  next: SidecarGenerationState,
): boolean {
  if (!previous) return true
  if (next.generation < previous.generation) return false
  if (next.generation > previous.generation) return true
  if (next.status === previous.status) return false
  // 同代内只允许 recovering → 终态(ready/failed)。终态恰好一次(#577):failed 之后
  // 同代不得再变 ready(引擎迟到恢复走 consumer 自探或新 generation),ready 也不回退。
  return previous.status === "recovering" && (next.status === "ready" || next.status === "failed")
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

// #594 闩死点二:引擎模型列表拉取的无上限封顶退避循环(单测覆盖)。旧实现是 20×1s 预算,
// 耗尽后 setModelChainState("recovering") 直接 return、不再安排任何定时器 —— 三个唤醒源
//(generation-ready / SSE 重连 / account-recovered)在 #577 一类 producer 事故下全死,
// 模型链永久闩死。改为与 picker 同构的 nextEngineRetryDelay(1s/2s/4s/8s 封顶)退避,
// 直到成功或本链被 supersede/卸载;唤醒信号仍可提前打断等待。
export async function loadEngineModelsWithRetry<T>(opts: {
  /** 已在途的首次拉取(composer 提前发出 model.list)。 */
  initial: Promise<T>
  /** 安排下一次拉取。 */
  read: () => Promise<T>
  /** 退避等待(createRetryWakeup.wait):唤醒信号可提前打断。 */
  wait: (delayMs: number) => Promise<"elapsed" | "cancelled">
  /** 成功后清掉排队中的唤醒残留(createRetryWakeup.clear)。 */
  clearWake: () => void
  /** 本链是否已被 supersede/卸载 —— 唯一的循环退出条件(除成功外)。 */
  isStale: () => boolean
  onAttemptFailed: () => void
  onRetryTick?: (tick: { attempt: number; delayMs: number; wait: "elapsed" | "cancelled" }) => void
  delayFor?: (attempt: number) => number
}): Promise<{ status: "loaded"; data: T } | { status: "stale" }> {
  const delayFor = opts.delayFor ?? nextEngineRetryDelay
  let listing = opts.initial
  for (let attempt = 0; !opts.isStale(); attempt++) {
    try {
      const data = await listing
      if (opts.isStale()) return { status: "stale" }
      opts.clearWake()
      return { status: "loaded", data }
    } catch {
      if (opts.isStale()) return { status: "stale" }
      opts.onAttemptFailed()
    }
    const delayMs = delayFor(attempt)
    const wait = await opts.wait(delayMs)
    if (opts.isStale()) return { status: "stale" }
    opts.onRetryTick?.({ attempt: attempt + 2, delayMs, wait })
    listing = opts.read()
  }
  return { status: "stale" }
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
