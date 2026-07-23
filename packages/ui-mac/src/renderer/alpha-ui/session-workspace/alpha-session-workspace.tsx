// AlphaSessionWorkspace — REQ-088 T2(Issue #181):session surface 的正式 Alpha 外框。
// REQ-087 spike 的 surface 侧原型(旧 sessionSpikeSurface)在此转正;未挂载的探针目录
// session-spike/ 已随 T7(#502)删除,反回归断言见本文件 test 的 not.toContain 守卫。
//
// 结构与纪律(变更任何一条先回 spike 报告 §6 / T6 审计 §3 重评):
//   - 叶经 C1 合法窄导出(app 包 exports 的 ./surface/session 子路径,ADR-027 修订、
//     frontend-freeze-base-3)进入。本文件是全仓唯一消费点(req087-characterization.test.ts 锚死)。
//   - 叶在 seam 的 createSessionRoute 内挂载:SessionProviders/DirectoryLayout/ServerScopedShell
//     全部保持上游默认生命周期,外框零 upstream context(只读版本化路由 ABI)。
//   - surface override 与默认叶 XOR(app.tsx `props.surfaces?.session ?? Session`),结构上不存在
//     双挂载;SurfaceBoundary 兜致命 render 错误 → 留在 Alpha 区域并进入 Recovery。
//   - 单一挂载条件:调用方仅在 resolved.session.mode === "alpha" 时注入本工厂返回的组件;
//     legacy 解析结果不注入,由 seam 走上游默认叶。
//   - 宿主红线(T6 审计 §3;alpha-session-workspace.test.ts 钉死):
//       R1 活叶包裹保持普通流(flex:1 + min-height:0,不隐藏、不脱流)——takeover 的
//          offsetParent 可见性口径依赖于此;
//       R2 chrome 一律 data-alpha-* 命名空间 + a-swk-* 类,绝不与上游锚点同名;
//       R7 三个 takeover 仍是 AppInterface children,绝不移进本外框;
//       Stage C-1 前本外框**不自渲染 AlphaComposer**(那要求与 takeover gate 同 PR,见审计 §4.1)。
//   - 跨 server 最小安全解(C4 S5 携带项②):alpha 侧栏恒 pin 本地 sidecar,active server 为他机时
//     点其会话必然叶 throw ——CrossServerGuard 有界识别该错误族并给出返回首页引导,
//     不再落 surface 致命 fallback(避免把可识别的跨 server 状态误记为 surface crash);
//     识别不到的错误原样 rethrow,
//     SurfaceBoundary 语义不变。
//   - preloadSessionLeaf(C4 携带项③):alpha 侧栏 hover/点击时预热叶 lazy chunk,消 C4 实测的
//     冷入场(0ms 采样 panel=0);窄导出与上游 lazy 解析到同一模块 id,legacy 模式同样受益。

import { createMemo, ErrorBoundary, lazy, Show, type JSX } from "solid-js"
import { useLocation, useNavigate } from "@solidjs/router"
import type { MaybePreloadableComponent } from "@opencode-ai/app"
import { hrefFor, parseRoute } from "../../../shared/route-manifest"
import { SurfaceBoundary } from "../surface-boundary"
import { isCrossServerSessionError, workspaceContextOf } from "./session-workspace-core"
import { t } from "../../i18n"
import "./session-workspace.css"

// —— 合法窄通道(REQ-088 C1):全仓唯一消费点。vite 解析到与上游 lazy("@/pages/session")
// 相同的绝对模块 id(同一 chunk,零重复打包)。
const upstreamLeafImport = () => import("@opencode-ai/app/surface/session")
const UpstreamSessionLeaf = lazy(upstreamLeafImport)

/** 预热 session 叶 lazy chunk(幂等;C4 携带项③,alpha 侧栏 hover/导航前调用)。 */
export function preloadSessionLeaf(): void {
  void upstreamLeafImport()
}

/** 正式 chrome:header/上下文条。零 upstream context —— 只读 route manifest 的解析结果。 */
function WorkspaceChrome() {
  const loc = useLocation()
  const context = createMemo(() => workspaceContextOf(parseRoute(loc.pathname)))
  return (
    <header class="a-ui a-swk-chrome" data-alpha-session-workspace-chrome>
      <span class="a-swk-dot" aria-hidden="true" />
      <Show when={context()} fallback={<span class="a-swk-project">{t("alpha.session.session")}</span>}>
        {(ctx) => (
          <>
            <span class="a-swk-project">{ctx().project}</span>
            <span class="a-swk-sep" aria-hidden="true">
              /
            </span>
            <span class="a-swk-session">{ctx().sessionShort ?? t("alpha.newSession.title")}</span>
          </>
        )}
      </Show>
      <span class="a-swk-spacer" aria-hidden="true" />
      <span class="a-swk-badge" data-alpha-session-workspace-badge>
        {t("alpha.brand.short")}
      </span>
    </header>
  )
}

/**
 * 跨 server 会话缺失的有界引导(C4 S5 最小安全解)。只接住 isCrossServerSessionError 识别的
 * 错误族;其余在 fallback 渲染期同步 rethrow —— Solid 会把它交给上一层边界(SurfaceBoundary),
 * 其余错误交给外层 SurfaceBoundary，并进入 Alpha Recovery；不会切换 legacy surface。
 */
function CrossServerGuard(props: { children: JSX.Element }) {
  const navigate = useNavigate()
  return (
    <ErrorBoundary
      fallback={(error) => {
        if (!isCrossServerSessionError(error)) throw error
        console.warn("ALPHA_CROSS_SERVER_SESSION_BLOCKED")
        return (
          <div class="a-ui a-swk-guard" data-alpha-session-workspace-guard>
            <div class="a-swk-guard-card" role="alert">
              <div class="a-swk-guard-title">{t("alpha.session.crossServerTitle")}</div>
              <div class="a-swk-guard-desc">
                {t("alpha.session.crossServerDetail")}
              </div>
              <div class="a-swk-guard-actions">
                <button
                  type="button"
                  class="a-swk-btn a-swk-btn--primary"
                  onClick={() => navigate(hrefFor.home())}
                >
                  {t("alpha.session.backHome")}
                </button>
              </div>
            </div>
          </div>
        )
      }}
    >
      {props.children}
    </ErrorBoundary>
  )
}

/**
 * 正式外框。注意:外层与叶包裹**不挂** .a-ui —— alpha 排版(字体/颜色)不得级联进上游叶,
 * legacy 视觉 parity 优先;.a-ui 只作用于 chrome 与引导卡。
 */
export function AlphaSessionWorkspace() {
  return (
    <SurfaceBoundary surface="session">
      <div class="a-swk-root" data-alpha-session-workspace>
        <WorkspaceChrome />
        <div class="a-swk-leaf" data-alpha-session-workspace-leaf>
          <CrossServerGuard>
            <UpstreamSessionLeaf />
          </CrossServerGuard>
        </div>
      </div>
    </SurfaceBoundary>
  )
}

/**
 * surface 工厂无条件返回 Alpha 组件。唯一挂载条件由调用方的
 * resolved.session.mode === "alpha" 保证；legacy 解析结果保持上游默认叶。
 */
export function alphaSessionWorkspaceSurface(): MaybePreloadableComponent {
  const Comp: MaybePreloadableComponent = () => <AlphaSessionWorkspace />
  // 与 seam 的 preload 契约对齐(app.tsx `preload: () => Leaf.preload?.()`)。
  Comp.preload = preloadSessionLeaf
  return Comp
}
