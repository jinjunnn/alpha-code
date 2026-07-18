// SurfaceBoundary — ADR-027/REQ-084 surface 级致命错误边界。与 AlphaBoundary(注入件局部降级)
// 不同,surface 是整页所有权:render throw = 该 surface 不可用 → 记录 surface id/version、上报
// main 落盘(下次加载据此解析为 legacy —— 对 alpha 与 auto-fallback 态均生效,#334)。
// #334 r1:reload 门控在 main 确认记录已落盘之后 —— 上报是 await 的 IPC 三态(pending/ok/failed),
// 只有 ok 才放行「重新加载」;失败如实呈现并可重试,绝不在没有 legacy 兜底记录时 reload
// (那会回到同一个坏 alpha,crash-loop)。
// 只接管 render 崩溃;发送、权限、数据一致性错误不经此边界(它们有各自的可见错误态,不得吞)。
import { createSignal, ErrorBoundary, type JSX } from "solid-js"
import { SURFACE_ABI_VERSION, type SurfaceId } from "../../shared/alpha-surfaces"
import "./alpha-boundary.css"

export function SurfaceBoundary(props: { surface: SurfaceId; children: JSX.Element }) {
  return (
    <ErrorBoundary
      fallback={(error) => {
        const message = String((error as Error)?.message ?? error).slice(0, 500)
        console.error(`[alpha-surface] surface=${props.surface} version=${SURFACE_ABI_VERSION} fatal render error`, error)
        // 三态门控:pending(记录中,按钮禁用)→ ok(main 确认落盘,放行 reload)/ failed(如实呈现,可重试)。
        const [persisted, setPersisted] = createSignal<"pending" | "ok" | "failed">("pending")
        const report = () => {
          setPersisted("pending")
          const inflight = window.api.surfaces?.reportFailure({ surface: props.surface, error: message })
          if (!inflight) {
            // 上报通道缺失 = 无法确认落盘 —— fail-closed,门控不放行。
            setPersisted("failed")
            return
          }
          inflight.then(() => setPersisted("ok")).catch(() => setPersisted("failed"))
        }
        report()
        return (
          <div class="a-ui a-boundary a-boundary--surface" data-alpha-surface-error={props.surface}>
            <span class="a-boundary-name">页面加载失败({props.surface})</span>
            <span class="a-boundary-msg">{message}</span>
            <button
              class="a-boundary-btn"
              disabled={persisted() === "pending"}
              onClick={() => (persisted() === "ok" ? location.reload() : report())}
            >
              {persisted() === "ok"
                ? "重新加载并回退旧版页面"
                : persisted() === "pending"
                  ? "正在保存错误记录…"
                  : "错误记录保存失败,点击重试"}
            </button>
          </div>
        )
      }}
    >
      {props.children}
    </ErrorBoundary>
  )
}
