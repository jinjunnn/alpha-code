// REQ-125 C4(integration audit Major-2)—— 终端「任一实例在跑」的跨组件投影。
//
// 生产状态通路:TerminalRailPanel(唯一知道 accepted channel instances 的组件)把
// anyTerminalRunning 发布到本模块级信号;shell 的 rr-tabs 终端呼吸点消费之——
// 无论面板由 shell 内建兜底渲染,还是未来 lane 经 panels.terminal 注入(两者都是
// 同一 TerminalRailPanel 组件),链路都接通。railMeta.terminalRunning 仍是显式
// 覆盖通道(workspace 侧一旦有更权威的状态源,以它为准)。
//
// I8:面板的 instances 已经过 acceptedEngineChannel 身份闸(会话切换 → 空列表 →
// 发布 false);面板卸载时复位 false,信号永不携带过期会话的运行态。
import { createSignal } from "solid-js"

const [anyRunning, setAnyRunning] = createSignal(false)

/** Shell 消费面:任一终端实例在跑(缺面板/缺 channel = false,fail-closed)。 */
export function terminalRailAnyRunning(): boolean {
  return anyRunning()
}

/** 仅供 TerminalRailPanel(及测试)发布;其余代码只读。 */
export function publishTerminalAnyRunning(value: boolean): void {
  setAnyRunning(value)
}
