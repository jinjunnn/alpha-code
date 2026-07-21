// SurfaceBoundary — Alpha-only fatal surface recovery. A crash is admitted once with a stable
// renderer crashID; main turns it into one process-local incident and returns only the safe #434 DTO.
// The failed region never reloads or swaps to a legacy surface.
import { ErrorBoundary, type JSX } from "solid-js"
import type { SurfaceId } from "../../shared/alpha-surfaces"
import { admitSurfaceRecovery } from "./RuntimeRecoveryHost"
import "./alpha-boundary.css"

export function SurfaceBoundary(props: { surface: SurfaceId; children: JSX.Element }) {
  return (
    <ErrorBoundary
      fallback={() => {
        admitSurfaceRecovery(
          window.api.surfaces.reportFailure({ crashID: globalThis.crypto.randomUUID(), surface: props.surface }),
        )
        return (
          <div class="a-ui a-boundary a-boundary--surface" data-alpha-surface-error="isolated" role="status">
            <span class="a-boundary-name">页面已停止运行</span>
            <span class="a-boundary-msg">请在 Recovery 面板中选择安全操作。</span>
          </div>
        )
      }}
    >
      {props.children}
    </ErrorBoundary>
  )
}
