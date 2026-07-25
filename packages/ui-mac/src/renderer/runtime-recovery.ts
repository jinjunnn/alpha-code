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
// 显式自愈请求不做 shouldApplySidecarState 去重 —— 现值本身就是主进程的当前事实;
// consumer 各自的 ready/failed 分支语义不变(failed 仍不会被当成 ready 盲连)。
export async function replayRuntimeRecoveryState(): Promise<void> {
  const bridge = window.api?.sidecarGeneration
  if (!bridge) return
  try {
    const state = await bridge.getState()
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

export function notifySseReconnected() {
  markStartupTimeline("renderer.sse.reconnected")
  window.dispatchEvent(new Event(SSE_RECONNECTED_EVENT))
}

export function subscribeSseReconnected(listener: () => void) {
  window.addEventListener(SSE_RECONNECTED_EVENT, listener)
  return () => window.removeEventListener(SSE_RECONNECTED_EVENT, listener)
}
