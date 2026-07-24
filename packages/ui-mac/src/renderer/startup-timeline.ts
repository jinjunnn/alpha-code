import type {
  RendererStartupMarkName,
  StartupTimelineExtra,
} from "../preload/types"

export type RendererStartupTimelineBridge = {
  mark: (name: RendererStartupMarkName, rendererNow: number, extra?: StartupTimelineExtra) => void
}

export function createRendererStartupTimeline(
  bridge: () => RendererStartupTimelineBridge | undefined,
  now: () => number = () => performance.now(),
) {
  return (name: RendererStartupMarkName, extra?: StartupTimelineExtra) => {
    try {
      const target = bridge()
      if (!target) return
      target.mark(name, now(), extra)
    } catch {
      // Observation must remain a safe no-op when the preload bridge is absent or unavailable.
    }
  }
}

export const markStartupTimeline = createRendererStartupTimeline(() => window.api?.startupTimeline)
