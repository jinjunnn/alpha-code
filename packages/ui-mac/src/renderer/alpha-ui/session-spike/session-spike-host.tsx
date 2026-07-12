// REQ-087 LegacySessionAdapter spike 原型(Issue #180;永不默认启用,清理点见 docs/spikes 报告)。
//
// 两个原型面,共用 spike-flag 实验闸:
//
// 1) SessionSpikeHost —— 容器侧探针(surfaces.session 未注入 = 上游默认叶挂载)。
//    作为 AppInterface children 挂载(与 ComposerTakeover 同通道),在 session 路由上
//    渲染一条 Alpha 覆盖态框架条(会话上下文 + 实时计数),并按路由变化采样:
//    可见 composer 数 / #terminal-panel 数 / 命令注册数 —— 验证单挂载与不累积
//    (REQ-087 AC3/AC4 的可取证部分)。overlay pointer-events:none,不干扰焦点/滚动,
//    这是"验证 scroll/focus/command 仍工作"的前提。采样挂在 window.__req087Spike。
//
// 2) sessionSpikeSurface —— surface 侧原型(需再叠 ALPHA_SURFACE_SESSION=alpha)。
//    经 ADR-027 typed surface seam 注入 session 叶:Alpha 自有外框(header 条)+
//    deep-import 的上游 session 叶。要点:
//    - 叶在 seam 的 createSessionRoute 内挂载,SessionProviders/DirectoryLayout/
//      ServerScopedShell 全部保持上游默认生命周期 —— 外框不消费任何 upstream context
//      (只读路由 ABI),这就是拟议 LegacySessionAdapter 的"窄边界"形态;
//    - deep import 走相对路径(见下方 UPSTREAM_LEAF 注释):spike 实证它 typecheck+bundle
//      均可行,但它绕过 @opencode-ai/app exports map,是"机械可行、尚未合法化"的通道 ——
//      合法化需要 freeze-base 轮换加窄导出(报告 §通道结论);本文件是全仓唯一允许出现
//      该 import 的位置(req087-characterization.test.ts 锚死)。
//    - surface override 与默认叶是 XOR(app.tsx `props.surfaces?.session ?? Session`),
//      结构上不存在双挂载;SurfaceBoundary 兜致命 render 错误 → 记录 + reload 回 legacy。

import { createEffect, createSignal, lazy, on, onCleanup, Show } from "solid-js"
import { useLocation } from "@solidjs/router"
import { useCommand, type MaybePreloadableComponent } from "@opencode-ai/app"
import { parseRoute } from "../../../shared/legacy-route-abi"
import { SurfaceBoundary } from "../surface-boundary"
import { isSessionSpikeEnabled } from "./spike-flag"
import {
  countSessionScopedCommands,
  formatSample,
  summarizeSamples,
  type SpikeSample,
  type SpikeSummary,
} from "./spike-probe-core"

// —— deep-import 通道(REQ-087 关键问题的实证载体)——
// 相对路径解析到 packages/app/src/pages/session.tsx:tsgo -b 经 project reference 通过,
// vite 侧解析为与上游 lazy("@/pages/session") 相同的绝对模块 id(同一 chunk,零重复打包)。
// `@opencode-ai/app/pages/session`(exports map 无此子路径,TS2307)与根导出(无 Session
// 成员,TS2305)均不可用 —— 见报告 §通道结论。
const upstreamLeafImport = () => import("../../../../../app/src/pages/session")
const UpstreamSessionLeaf = lazy(upstreamLeafImport)

const MAX_SAMPLES = 50

declare global {
  interface Window {
    __req087Spike?: {
      samples: () => readonly SpikeSample[]
      summary: () => SpikeSummary
    }
  }
}

const [samples, setSamples] = createSignal<SpikeSample[]>([])

function sessionRouteOf(pathname: string) {
  const r = parseRoute(pathname)
  return r.kind === "session" ? r : undefined
}

function collectSample(pathname: string, commandIds: readonly string[]): SpikeSample {
  const route = sessionRouteOf(pathname)
  const composers = [...document.querySelectorAll<HTMLElement>("[data-component=session-composer]")]
  return {
    at: Date.now(),
    pathname,
    sessionID: route?.id,
    composersTotal: composers.length,
    composersVisible: composers.filter((el) => el.offsetParent !== null).length,
    terminalPanels: document.querySelectorAll("#terminal-panel").length,
    promptDocks: document.querySelectorAll("[data-component=session-prompt-dock]").length,
    commandOptions: commandIds.length,
    sessionScopedCommands: countSessionScopedCommands(commandIds),
  }
}

/** 容器侧探针 + 覆盖态框架条。flag 关闭 ⇒ 恒 null(挂载零成本,不订阅任何状态)。 */
export function SessionSpikeHost() {
  if (!isSessionSpikeEnabled()) return null
  return <SessionSpikeHostInner />
}

function SessionSpikeHostInner() {
  const loc = useLocation()
  const command = useCommand()

  const takeSample = () => {
    const sample = collectSample(loc.pathname, command.options.map((o) => o.id))
    console.log(formatSample(sample))
    setSamples((prev) => [...prev, sample].slice(-MAX_SAMPLES))
  }

  window.__req087Spike = {
    samples: () => samples(),
    summary: () => summarizeSamples(samples()),
  }
  onCleanup(() => {
    delete window.__req087Spike
  })

  // 每次路由变化采样两次:立即(切换瞬间)+ 650ms 后(lazy 叶/终端面板挂载完成)。
  createEffect(
    on(
      () => loc.pathname,
      () => {
        takeSample()
        const timer = window.setTimeout(takeSample, 650)
        onCleanup(() => window.clearTimeout(timer))
      },
    ),
  )

  const route = () => sessionRouteOf(loc.pathname)
  const latest = () => samples()[samples().length - 1]
  const ok = () => {
    const s = summarizeSamples(samples())
    return s.singleMountViolations === 0 && !s.commandAccumulation && !s.terminalPanelAccumulation
  }

  return (
    <Show when={route()}>
      {(r) => (
        <div
          data-alpha-session-spike-overlay
          style={{
            position: "fixed",
            right: "10px",
            bottom: "10px",
            "z-index": "9999",
            "pointer-events": "none",
            "user-select": "none",
            font: "500 10px/1.5 ui-monospace, monospace",
            padding: "4px 8px",
            "border-radius": "6px",
            background: "color-mix(in srgb, #f6821f 12%, rgba(20,20,20,0.85))",
            color: "#ffd9b3",
            border: "1px solid rgba(246,130,31,0.5)",
          }}
        >
          <div>
            REQ-087 SPIKE · {r().directory.split("/").filter(Boolean).pop() ?? r().directory} ·{" "}
            {r().id ? r().id!.slice(-8) : "new"}
          </div>
          <Show when={latest()}>
            {(s) => (
              <div>
                composer {s().composersVisible}/{s().composersTotal} · terminal {s().terminalPanels} · cmd{" "}
                {s().commandOptions}({s().sessionScopedCommands}) · {ok() ? "OK" : "VIOLATION"}
              </div>
            )}
          </Show>
        </div>
      )}
    </Show>
  )
}

/** surface 侧原型内部的 Alpha 自有 header 条(零 upstream context,只读路由 ABI)。 */
function SpikeFrameHeader() {
  const loc = useLocation()
  const route = () => sessionRouteOf(loc.pathname)
  return (
    <div
      data-alpha-session-spike-frame-header
      style={{
        display: "flex",
        "align-items": "center",
        gap: "8px",
        height: "26px",
        padding: "0 10px",
        "flex-shrink": "0",
        font: "600 11px/1 ui-monospace, monospace",
        background: "color-mix(in srgb, #f6821f 18%, var(--background-stronger, #1c1c1c))",
        color: "var(--text-strong, #eee)",
        "border-bottom": "1px solid rgba(246,130,31,0.45)",
      }}
    >
      <span>ALPHA FRAME(REQ-087 原型)</span>
      <span style={{ opacity: "0.7", "font-weight": "400" }}>
        {route()?.directory ?? "?"} · {route()?.id ?? "new session"}
      </span>
    </div>
  )
}

/**
 * surface 侧原型工厂:双闸(本 flag + 主进程 ALPHA_SURFACE_SESSION=alpha)全开才返回组件,
 * 否则返回 undefined ⇒ surfaces.session 维持未注入,seam 走上游默认叶(严格零变化)。
 */
export function sessionSpikeSurface(): MaybePreloadableComponent | undefined {
  if (!isSessionSpikeEnabled()) return undefined
  const Comp: MaybePreloadableComponent = () => (
    <SurfaceBoundary surface="session">
      <div
        data-alpha-session-spike-frame
        style={{ display: "flex", "flex-direction": "column", height: "100%", "min-height": "0" }}
      >
        <SpikeFrameHeader />
        <div style={{ flex: "1", "min-height": "0" }}>
          <UpstreamSessionLeaf />
        </div>
      </div>
    </SurfaceBoundary>
  )
  // 与 seam 的 preload 契约对齐(app.tsx `preload: () => Leaf.preload?.()`)。
  Comp.preload = () => {
    void upstreamLeafImport()
  }
  return Comp
}
