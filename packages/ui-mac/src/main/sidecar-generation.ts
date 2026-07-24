import type { SidecarGenerationState } from "../preload/types"
export type { SidecarGenerationState } from "../preload/types"

export function createSidecarGenerationState(initial: SidecarGenerationState = {
  status: "recovering",
  generation: 0,
  reason: "boot",
}) {
  let current = initial
  return {
    get: () => current,
    update(next: SidecarGenerationState) {
      current = next
      return current
    },
  }
}
