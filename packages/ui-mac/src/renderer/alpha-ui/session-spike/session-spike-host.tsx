// REQ-087 spike 容器侧探针(Issue #180;永不默认启用)。
//
// SessionSpikeHost —— 作为 AppInterface children 挂载(与 ComposerTakeover 同通道),在
// session 路由上渲染一条 Alpha 覆盖态计数条,并按路由变化采样:可见 composer 数 /
// #terminal-panel 数 / 命令注册数 —— 验证单挂载与不累积(REQ-087 AC3/AC4 的可取证部分)。
// overlay pointer-events:none,不干扰焦点/滚动,这是"验证 scroll/focus/command 仍工作"的
// 前提。采样挂在 window.__req087Spike;采样口径与判定在 spike-probe-core.ts(含 C4 携带项①
// 的 pending 口径修正)。
//
// 历史:本文件曾同时承载 surface 侧原型(旧 sessionSpikeSurface,Alpha 外框 + 窄导出叶)。
// REQ-088 T2 已将其转正为 session-workspace/alpha-session-workspace.tsx —— C1 窄导出
// (./surface/session)的全仓唯一消费点随之迁移(req087-characterization.test.ts 锚死,
// 本文件不得再出现该导入)。探针本体保留至 T7(spike 清理)统一裁决。

import { createEffect, createSignal, on, onCleanup, Show } from "solid-js"
import { useLocation } from "@solidjs/router"
import { useCommand } from "@opencode-ai/app"
import { parseRoute } from "../../../shared/legacy-route-abi"
import { isSessionSpikeEnabled } from "./spike-flag"
import {
  countSessionScopedCommands,
  formatSample,
  summarizeSamples,
  type SpikeSample,
  type SpikeSummary,
} from "./spike-probe-core"

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
  const composers = [
    ...document.querySelectorAll<HTMLElement>(
      '[data-component="session-prompt-dock"] [data-component="prompt-input-v2"]',
    ),
  ]
  return {
    at: Date.now(),
    pathname,
    sessionID: route?.id,
    composersTotal: composers.length,
    composersVisible: composers.filter((el) => el.offsetParent !== null).length,
    terminalPanels: document.querySelectorAll("#terminal-panel").length,
    promptDocks: document.querySelectorAll('[data-component="session-prompt-dock"]').length,
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
  const summary = () => summarizeSamples(samples())
  const ok = () => {
    const s = summary()
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
                {summary().pendingSamples > 0 ? ` · pend ${summary().pendingSamples}` : ""}
              </div>
            )}
          </Show>
        </div>
      )}
    </Show>
  )
}

// (surface 侧原型已于 REQ-088 T2 转正为 session-workspace/alpha-session-workspace.tsx。)
