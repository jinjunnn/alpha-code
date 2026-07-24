// REQ-125 #554 —— 终端引擎 channel 适配器:I1 白名单通道的唯一引擎 import 点。
//
// 上游引擎经 ADR-027 修订(2026-07-24)的窄导出 `@opencode-ai/app/surface/terminal` 进入:
// `useTerminal` = workspace 级 PTY 页签状态(上游 SessionProviders 的 TerminalProvider 已
// 包住 alpha session 叶,可直接消费),`Terminal` = Ghostty 嵌入(WASM 仿真 + PTY WebSocket
// 数据通道)。本文件只做粘合,不重实现引擎:铸 channel(I8 三元身份盖章,纯投影在
// terminal-engine-adapter-core)+ 引擎输出组件(持久化回写、连接后 trim、连接失败一次性
// clone 恢复 —— 语义对齐上游 terminal-panel 的既有粘合)。
import { Terminal, useTerminal, type LocalPTY } from "@opencode-ai/app/surface/terminal"
import { createEffect, createMemo, createSignal, Show, type Accessor, type Component } from "solid-js"
import { t } from "../../../i18n"
import type { AlphaSessionLiveSnapshot } from "../../session-workspace/session-workspace-core"
import {
  mintTerminalEngineChannel,
  sameIdentityProjection,
  type TerminalEngineHandle,
} from "./terminal-engine-adapter-core"
import type { AlphaTerminalEngineChannel } from "./terminal-rail-core"

type TerminalEngine = ReturnType<typeof useTerminal>

/**
 * 引擎缺席(TerminalProvider 不在祖先链)= channel 缺席:面板 fail-closed 落空态,
 * 不把结构性缺口升级成 Recovery 崩溃 —— 空态本就是 channel 缺席的合同形态(#550)。
 */
function resolveTerminalEngine(): TerminalEngine | undefined {
  try {
    return useTerminal()
  } catch {
    return undefined
  }
}

/** clone 恢复的一次性标记 key(对齐上游 terminal-panel 的 terminalRecoveryKey)。 */
const recoveryKey = (pty: LocalPTY) => String(pty.titleNumber || pty.title || pty.id)

/**
 * 引擎输出组件:上游 Terminal 直挂进 alpha 输出区外框。粘合与上游 terminal-panel 同语义:
 * 连接成功 → 清恢复标记 + trim 持久缓冲;卸载 → 回写缓冲/尺寸/滚动;连接失败 → 按
 * recovery key 一次性 clone(换新 PTY 保留页签),防止 clone 循环。
 */
function createEngineOutput(engine: TerminalEngine): Component<{ instanceID: string }> {
  const recovered = new Set<string>()
  return (props) => {
    const ops = engine.bind()
    const pty = createMemo(() => engine.all().find((item) => item.id === props.instanceID))
    // keep-alive × autoFocus 一次性(审计第 4 轮 Major-2):上游 Terminal 只在首挂消费
    // autoFocus;shell 的 keep-alive 隐藏重显不重挂,重显时的聚焦请求会滞留不被消费。
    // 挂载中收到本实例的聚焦请求 → 焦点代次 +1,keyed 重挂一次,让请求经原生 autoFocus
    // 路径真实被消费(scrollback/尺寸/滚动由 onCleanup 回写 + 持久缓冲恢复,粘合已有)。
    // 首挂自带的请求走首挂 autoFocus,不额外重挂;他实例请求(id 不匹配)不触发。
    const [focusEpoch, setFocusEpoch] = createSignal(1)
    let liveSinceFirstRun = false
    createEffect(() => {
      const requested = engine.focusRequested(props.instanceID)
      if (!liveSinceFirstRun) {
        liveSinceFirstRun = true
        return
      }
      if (requested) setFocusEpoch((epoch) => epoch + 1)
    })
    return (
      <Show when={pty()}>
        {(current) => (
          <Show when={focusEpoch()} keyed>
            {(_epoch) => (
              <Terminal
                pty={current()}
                autoFocus={engine.focusRequested(props.instanceID)}
                onAutoFocus={() => engine.consumeFocus(props.instanceID)}
                onConnect={() => {
                  recovered.delete(recoveryKey(current()))
                  ops.trim(props.instanceID)
                }}
                onCleanup={(next) => ops.update(next)}
                onConnectError={() => {
                  const key = recoveryKey(current())
                  if (recovered.has(key)) return
                  recovered.add(key)
                  void ops.clone(props.instanceID)
                }}
              />
            )}
          </Show>
        )}
      </Show>
    )
  }
}

/**
 * 真引擎 channel:绑定当前会话三元身份(I8,铸造时盖章;消费侧经 live.accepts 把闸)。
 * 只有身份真实变更才重铸 —— equals 走三元组比较,快照级抖动(标题/running)不重挂引擎输出;
 * 会话切换即重铸,旧投影身份不再被接受,面板立即回空态直至新投影就绪。
 */
export function useAlphaTerminalEngineChannel(
  current: Accessor<AlphaSessionLiveSnapshot | undefined>,
): Accessor<AlphaTerminalEngineChannel | undefined> {
  const engine: TerminalEngineHandle | undefined = (() => {
    const resolved = resolveTerminalEngine()
    if (!resolved) return undefined
    return { surface: resolved, EngineOutput: createEngineOutput(resolved) }
  })()
  const identity = createMemo(() => current()?.identity, undefined, { equals: sameIdentityProjection })
  return createMemo(() =>
    mintTerminalEngineChannel({
      engine,
      identity: identity(),
      labels: {
        numbered: (number) => t("alpha.terminal.titleNumbered", { number }),
        untitled: t("alpha.session.terminal"),
      },
    }),
  )
}
