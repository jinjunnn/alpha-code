// REQ-159 `#1322`(AC1)—— renderer 侧「沙箱装上了没有」的**唯一**读取点。
//
// 信号来源是引擎自报,不是 renderer 自己猜平台:main 只在「fence 计划进了 start 命令 + sidecar 在 apply 之后
// 发了 ready」两个事实都成立时,才给 generation 终态挂上 `fence: "applied"`(server.ts 返回值 →
// settleBootHealth / armRespawnGenerationTerminal → publishSidecarGeneration → preload `sidecar-generation`)。
// 这里只订阅那条既有通道(runtime-recovery 的 subscribeRuntimeRecovery,已过 generation 单调闸),
// 把它投影成两个同步访问器。
//
// fail-closed:没有状态 / 引擎不在线 / 字段缺席 ⇒ false —— 没有围栏就不说有(设计 §3.1 出现条件)。
// 一个 renderer 里只有一份;呈现层经 props 拿到访问器(终端面板刻意不 import 本模块 —— 它的 I1 棘轮
// 禁 window.api,而本模块的订阅最终落在 preload 桥上)。

import { createSignal } from "solid-js"
import type { SidecarGenerationState } from "../../preload/types"
import { hasRuntimeRecoveryBridge, subscribeRuntimeRecovery } from "../runtime-recovery"

const [state, setState] = createSignal<SidecarGenerationState | undefined>(undefined)
let installed = false

function install() {
  if (installed) return
  installed = true
  // 纯 bun 单测没有 window;桥缺席(旧 preload / 非 Electron 宿主)同样按「没有围栏」处理。
  if (typeof window === "undefined" || !hasRuntimeRecoveryBridge()) return
  subscribeRuntimeRecovery((next) => setState(next))
}

/** 引擎在线的两种终态。failed / recovering 没有引擎,也就没有围栏可言。 */
export function engineOnline(next: SidecarGenerationState | undefined): boolean {
  return next !== undefined && (next.status === "ready" || next.status === "injection-failed")
}

/** 纯投影(单测用同一条规则):在线 **且** 引擎自报装上了围栏。 */
export function sandboxAppliedFrom(next: SidecarGenerationState | undefined): boolean {
  return engineOnline(next) && next?.fence === "applied"
}

/** 呈现层访问器:这一代引擎装上了围栏。 */
export function sandboxApplied(): boolean {
  install()
  return sandboxAppliedFrom(state())
}

/**
 * 在线引擎的代号;不在线 = undefined。工作区写探针的答案按它分代缓存 —— 可写集在每次 fork 时
 * 重新从 store 取并集,换代之后同一目录的答案可能不同(打开过的目录下一代就在集合里)。
 */
export function sandboxGeneration(): number | undefined {
  install()
  const current = state()
  return engineOnline(current) ? current!.generation : undefined
}

/** 测试用:直接灌一条 generation 状态(绕过 preload 桥),并阻止真订阅。 */
export function setSandboxStateForTests(next: SidecarGenerationState | undefined) {
  installed = true
  setState(next)
}
