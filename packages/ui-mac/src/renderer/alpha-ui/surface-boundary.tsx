// SurfaceBoundary — ADR-027/REQ-084 surface 级致命错误边界。与 AlphaBoundary(注入件局部降级)
// 不同,surface 是整页所有权:render throw = 该 surface 不可用 → 记录 surface id/version、上报
// main(下次加载据此解析为 legacy —— 对 alpha 与 auto-fallback 态均生效,#334),用户确认 reload
// 后回到同 URL 的 legacy 页面。
// 只接管 render 崩溃;发送、权限、数据一致性错误不经此边界(它们有各自的可见错误态,不得吞)。
import { ErrorBoundary, type JSX } from "solid-js"
import { SURFACE_ABI_VERSION, type SurfaceId } from "../../shared/alpha-surfaces"
import "./alpha-boundary.css"

export function SurfaceBoundary(props: { surface: SurfaceId; children: JSX.Element }) {
  return (
    <ErrorBoundary
      fallback={(error) => {
        const message = String((error as Error)?.message ?? error).slice(0, 500)
        console.error(`[alpha-surface] surface=${props.surface} version=${SURFACE_ABI_VERSION} fatal render error`, error)
        void window.api.surfaces?.reportFailure({ surface: props.surface, error: message }).catch(() => {})
        return (
          <div class="a-ui a-boundary a-boundary--surface" data-alpha-surface-error={props.surface}>
            <span class="a-boundary-name">页面加载失败({props.surface})</span>
            <span class="a-boundary-msg">{message}</span>
            <button
              class="a-boundary-btn"
              onClick={() => {
                // 上报已落盘(下次解析降 legacy,硬 alpha 态同样生效);同 URL reload 切回旧版页面。
                location.reload()
              }}
            >
              重新加载并回退旧版页面
            </button>
          </div>
        )
      }}
    >
      {props.children}
    </ErrorBoundary>
  )
}
