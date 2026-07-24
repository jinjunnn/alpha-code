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
