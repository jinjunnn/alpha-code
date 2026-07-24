// REQ-125 C3-term(#550)—— 右栏终端面板的纯模型与引擎通道 seam。
//
// 边界(seam 基线 §② 白名单 / §③ I1):终端仿真与 PTY 数据通道属可复用的非布局内核,
// alpha 只自持外壳(页签条 / 圆角深底输出区外框 / 脚条)。引擎经下方
// `AlphaTerminalEngineChannel` typed seam 进入,本目录零 import 上游模块。
//
// 地面真相:上游引擎 = `packages/app/src/components/terminal.tsx`(ghostty-web WASM +
// PTY WebSocket 数据通道)+ `packages/app/src/context/terminal.tsx`(workspace 级 PTY
// 页签状态,`SessionProviders` 已将其挂在 alpha session 叶之上)。两者经 ADR-027 修订
// (2026-07-24,#554)的窄导出 `./surface/terminal` 进入,唯一消费点 =
// `terminal-engine-adapter.tsx`(静态断言钉死);channel 缺席时面板仍 fail-closed 落空态。
//
// I8:本面板不自持任何会话/工作区异步状态 —— 一切数据都是 channel 访问器的同步派生。
// 但同 workspace 的会话切换不会重挂本子树,同步 accessor 本身证明不了背后的 PTY 状态
// 属于当前会话:channel 投影必须在铸造时盖上 `serverKey+directory+sessionID` 三元身份
// (`identity`),消费侧经 C1 `live.accepts(identity)` 校验;身份不符或校验器缺席一律
// fail-closed 视为 channel 缺席(`acceptedEngineChannel`),旧 channel 无法继续渲染。
import type { Component } from "solid-js"
import type { AlphaSessionIdentity } from "../../session-workspace/session-workspace-core"

/** 一条终端实例(引擎侧 PTY)的页签视图模型。 */
export interface AlphaTerminalInstance {
  id: string
  title: string
  /** 该实例是否有任务在跑(面板页签呼吸点;缺数据 = false,不伪造)。 */
  running: boolean
}

/** 脚条状态明细:运行状态 + 环境 + 尺寸(缺项即不渲染对应段,不伪造)。 */
export interface AlphaTerminalFootStatus {
  running: boolean
  shell?: string
  cols?: number
  rows?: number
}

/**
 * 引擎通道 typed seam —— 面板消费的全部外部能力。
 * 未来适配器把上游 `useTerminal()`(状态)与 `Terminal`(Ghostty 嵌入)收敛成本形状。
 * 适配器在投影时盖 `identity`(I8 三元组);消费侧必须经 `acceptedEngineChannel` 校验。
 */
export interface AlphaTerminalEngineChannel {
  /** 本 channel 投影所属的会话三元身份(serverKey+directory+sessionID),铸造时固定。 */
  identity: AlphaSessionIdentity
  ready(): boolean
  instances(): AlphaTerminalInstance[]
  activeID(): string | undefined
  open(id: string): void
  close(id: string): void
  create(): void
  footStatus(id: string): AlphaTerminalFootStatus
  /** 引擎渲染的输出区内容;alpha 只提供圆角深底外框。 */
  EngineOutput: Component<{ instanceID: string }>
}

/**
 * I8 fail-closed 闸:channel 只有携带被当前 live 上下文接受的三元身份才可被消费。
 * channel 缺席、校验器缺席、身份不符 —— 一律返回 undefined(面板落空态),
 * 同 workspace 切会话后旧 channel 立即失效,直到适配器按新身份重投影。
 */
export function acceptedEngineChannel(
  channel: AlphaTerminalEngineChannel | undefined,
  accepts: ((identity: AlphaSessionIdentity) => boolean) | undefined,
): AlphaTerminalEngineChannel | undefined {
  if (!channel || !accepts) return undefined
  if (!accepts(channel.identity)) return undefined
  return channel
}

/** 激活实例解析:空列表 → undefined;activeID 失效(已关闭)→ 回落首个实例。 */
export function resolveActiveInstance(
  instances: AlphaTerminalInstance[],
  activeID: string | undefined,
): AlphaTerminalInstance | undefined {
  if (instances.length === 0) return undefined
  return instances.find((instance) => instance.id === activeID) ?? instances[0]
}

/** 运行指示三层中的最外层输入:任一实例在跑(右栏 tab 呼吸点数据源)。 */
export function anyTerminalRunning(instances: AlphaTerminalInstance[]): boolean {
  return instances.some((instance) => instance.running)
}

function isPositiveSize(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

/** 脚条尺寸段:`80×24`;任一维缺失或非法 → undefined(整段不渲染)。 */
export function formatTerminalSize(cols: number | undefined, rows: number | undefined): string | undefined {
  if (!isPositiveSize(cols) || !isPositiveSize(rows)) return undefined
  return `${cols}×${rows}`
}
