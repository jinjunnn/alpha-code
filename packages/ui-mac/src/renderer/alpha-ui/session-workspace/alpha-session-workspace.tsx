// AlphaSessionWorkspace — REQ-088 T2(Issue #181):session surface 的正式 Alpha 外框。
// REQ-087 spike 的 surface 侧原型(session-spike-host.tsx 旧 sessionSpikeSurface)在此转正;
// 容器侧探针仍留在 session-spike/(T7 统一清理)。
//
// 结构与纪律(变更任何一条先回 spike 报告 §6 / T6 审计 §3 重评):
//   - 叶经 C1 合法窄导出(app 包 exports 的 ./surface/session 子路径,ADR-027 修订、
//     frontend-freeze-base-3)进入。本文件是全仓唯一消费点(req087-characterization.test.ts 锚死)。
//   - 叶在 seam 的 createSessionRoute 内挂载:SessionProviders/DirectoryLayout/ServerScopedShell
//     全部保持上游默认生命周期,外框零 upstream context(只读版本化路由 ABI)。
//   - surface override 与默认叶 XOR(app.tsx `props.surfaces?.session ?? Session`),结构上不存在
//     双挂载;SurfaceBoundary 兜致命 render 错误 → 记录 + reload 回 legacy(C4 已真机实证,不改)。
//   - 双闸:主进程 env-override `ALPHA_SURFACE_SESSION=alpha` + localStorage 闸(spike-flag),
//     任一闸关 ⇒ 工厂返回 undefined = seam 走上游默认叶,零变化。发布态本期保持 legacy(T5 才升级)。
//   - 宿主红线(T6 审计 §3;alpha-session-workspace.test.ts 钉死):
//       R1 活叶包裹保持普通流(flex:1 + min-height:0,不隐藏、不脱流)——takeover 的
//          offsetParent 可见性口径依赖于此;
//       R2 chrome 一律 data-alpha-* 命名空间 + a-swk-* 类,绝不与上游锚点同名;
//       R7 三个 takeover 仍是 AppInterface children,绝不移进本外框;
//       Stage C-1 前本外框**不自渲染 AlphaComposer**(那要求与 takeover gate 同 PR,见审计 §4.1)。
//   - 跨 server 最小安全解(C4 S5 携带项②):alpha 侧栏恒 pin 本地 sidecar,active server 为他机时
//     点其会话必然叶 throw ——CrossServerGuard 有界识别该错误族并给出引导(回首页 / 重新加载),
//     不再落 surface 致命 fallback(避免污染崩溃记录 —— 该记录对一切 alpha 生效态降 legacy,#334);
//     识别不到的错误原样 rethrow,
//     SurfaceBoundary 语义不变。
//   - preloadSessionLeaf(C4 携带项③):alpha 侧栏 hover/点击时预热叶 lazy chunk,消 C4 实测的
//     冷入场(0ms 采样 panel=0);窄导出与上游 lazy 解析到同一模块 id,legacy 模式同样受益。

import { createMemo, ErrorBoundary, lazy, Show, type JSX } from "solid-js"
import { useLocation, useNavigate } from "@solidjs/router"
import type { MaybePreloadableComponent } from "@opencode-ai/app"
import { hrefFor, parseRoute } from "../../../shared/legacy-route-abi"
import { SurfaceBoundary } from "../surface-boundary"
import { isSessionSpikeEnabled } from "../session-spike/spike-flag"
import { isCrossServerSessionError, workspaceContextOf } from "./session-workspace-core"
import "./session-workspace.css"

// —— 合法窄通道(REQ-088 C1):全仓唯一消费点。vite 解析到与上游 lazy("@/pages/session")
// 相同的绝对模块 id(同一 chunk,零重复打包)。
const upstreamLeafImport = () => import("@opencode-ai/app/surface/session")
const UpstreamSessionLeaf = lazy(upstreamLeafImport)

/** 预热 session 叶 lazy chunk(幂等;C4 携带项③,alpha 侧栏 hover/导航前调用)。 */
export function preloadSessionLeaf(): void {
  void upstreamLeafImport()
}

/** 正式 chrome:header/上下文条。零 upstream context —— 只读路由 ABI 的解析结果。 */
function WorkspaceChrome() {
  const loc = useLocation()
  const context = createMemo(() => workspaceContextOf(parseRoute(loc.pathname)))
  return (
    <header class="a-ui a-swk-chrome" data-alpha-session-workspace-chrome>
      <span class="a-swk-dot" aria-hidden="true" />
      <Show when={context()} fallback={<span class="a-swk-project">会话</span>}>
        {(ctx) => (
          <>
            <span class="a-swk-project">{ctx().project}</span>
            <span class="a-swk-sep" aria-hidden="true">
              /
            </span>
            <span class="a-swk-session">{ctx().sessionShort ?? "新会话"}</span>
          </>
        )}
      </Show>
      <span class="a-swk-spacer" aria-hidden="true" />
      <span class="a-swk-badge" data-alpha-session-workspace-badge>
        Alpha
      </span>
    </header>
  )
}

/**
 * 跨 server 会话缺失的有界引导(C4 S5 最小安全解)。只接住 isCrossServerSessionError 识别的
 * 错误族;其余在 fallback 渲染期同步 rethrow —— Solid 会把它交给上一层边界(SurfaceBoundary),
 * 致命链路(记录 → fallback → reload 回 legacy)保持 C4 实证语义。
 */
function CrossServerGuard(props: { children: JSX.Element }) {
  const navigate = useNavigate()
  return (
    <ErrorBoundary
      fallback={(error) => {
        if (!isCrossServerSessionError(error)) throw error
        console.warn("[alpha-workspace] cross-server session click intercepted", error)
        return (
          <div class="a-ui a-swk-guard" data-alpha-session-workspace-guard>
            <div class="a-swk-guard-card" role="alert">
              <div class="a-swk-guard-title">此会话不属于当前连接的服务器</div>
              <div class="a-swk-guard-desc">
                Alpha 侧栏固定显示本地引擎的会话;当前窗口已切换到其他服务器,无法在这里打开它。
                重新加载可回到本地引擎,或先返回首页。
              </div>
              <div class="a-swk-guard-actions">
                <button type="button" class="a-swk-btn a-swk-btn--primary" onClick={() => location.reload()}>
                  重新加载(回到本地引擎)
                </button>
                <button type="button" class="a-swk-btn" onClick={() => navigate(hrefFor.home())}>
                  返回首页
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
 * surface 工厂:双闸(localStorage 闸 + 主进程 ALPHA_SURFACE_SESSION=alpha,后者由调用方的
 * resolved.session.mode === "alpha" 前置保证)全开才返回组件,否则 undefined ⇒ surfaces.session
 * 维持未注入,seam 走上游默认叶(严格零变化)。localStorage 闸沿用 spike-flag(键
 * ALPHA_SESSION_SPIKE)——T5 发布态阶梯前不改口径,T7 统一裁决其去留。
 */
export function alphaSessionWorkspaceSurface(): MaybePreloadableComponent | undefined {
  if (!isSessionSpikeEnabled()) return undefined
  const Comp: MaybePreloadableComponent = () => <AlphaSessionWorkspace />
  // 与 seam 的 preload 契约对齐(app.tsx `preload: () => Leaf.preload?.()`)。
  Comp.preload = preloadSessionLeaf
  return Comp
}
