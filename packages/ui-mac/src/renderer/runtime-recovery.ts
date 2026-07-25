import type { SidecarGenerationState } from "../preload/types"
import { shouldApplySidecarState } from "./alpha-ui/model-recovery"
import { markStartupTimeline } from "./startup-timeline"

export const RUNTIME_RECOVERY_EVENT = "alpha:runtime-recovery"
export const SSE_RECONNECTED_EVENT = "alpha:sse-reconnected"

let installed = false
let lastSidecarState: SidecarGenerationState | undefined

function install() {
  if (installed) return
  installed = true
  const bridge = window.api?.sidecarGeneration
  if (!bridge) return
  bridge.subscribe((state) => {
    if (!shouldApplySidecarState(lastSidecarState, state)) return
    lastSidecarState = state
    markStartupTimeline("renderer.sidecar.generation.received", {
      generation: state.generation,
      phase: state.status,
      reason: state.reason,
    })
    window.dispatchEvent(new CustomEvent<SidecarGenerationState>(RUNTIME_RECOVERY_EVENT, { detail: state }))
  })
}

export function hasRuntimeRecoveryBridge() {
  return Boolean(window.api?.sidecarGeneration)
}

// #594 闩死点三:「立即重试」必须覆盖 client 构造层。从 preload 重读 generation 现值并向
// 全部订阅者重新广播,让 use-projects 在 client 已拆毁而现值为 ready 时按现值重建 client。
// R1 Major2:显式自愈允许「重复广播完全相同的状态」(把已恢复的事实再递给停跑的消费链),
// 但不得绕过 generation 单调性与同代终态互斥 —— 迟到的 getState 响应(读到旧 recovering)
// 若无条件覆盖,会把已 ready 的 consumer 再次拆毁,而该代不会有第二个 ready;
// 被污染的 lastSidecarState 还会把回退值回放给之后的新订阅者。
export async function replayRuntimeRecoveryState(): Promise<void> {
  const bridge = window.api?.sidecarGeneration
  if (!bridge) return
  try {
    const state = await bridge.getState()
    const current = lastSidecarState
    const identical =
      current !== undefined &&
      current.generation === state.generation &&
      current.status === state.status &&
      current.reason === state.reason
    if (!identical && !shouldApplySidecarState(current, state)) return
    lastSidecarState = state
    window.dispatchEvent(new CustomEvent<SidecarGenerationState>(RUNTIME_RECOVERY_EVENT, { detail: state }))
  } catch {
    // preload 桥不可达时保持现状;按钮的 fetch 层重试(onRetryCurrent/loadAll)仍在跑。
  }
}

export function subscribeRuntimeRecovery(listener: (state: SidecarGenerationState) => void) {
  install()
  const handle = (event: Event) => listener((event as CustomEvent<SidecarGenerationState>).detail)
  window.addEventListener(RUNTIME_RECOVERY_EVENT, handle)
  const current = lastSidecarState
  if (current) queueMicrotask(() => listener(current))
  return () => window.removeEventListener(RUNTIME_RECOVERY_EVENT, handle)
}

// trigger 只进 timeline 打点(排障溯源:真 SSE 流内重连 vs 自探重建后的本地恢复通知),
// 订阅者语义一致 —— 都是「传输已恢复,停跑的消费链该醒了」。
export function notifySseReconnected(trigger?: string) {
  markStartupTimeline("renderer.sse.reconnected", trigger ? { trigger } : undefined)
  window.dispatchEvent(new Event(SSE_RECONNECTED_EVENT))
}

export function subscribeSseReconnected(listener: () => void) {
  window.addEventListener(SSE_RECONNECTED_EVENT, listener)
  return () => window.removeEventListener(SSE_RECONNECTED_EVENT, listener)
}
