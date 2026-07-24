// REQ-125 C3-term(#550)—— 右栏终端面板的纯模型与引擎通道 seam。
//
// 边界(seam 基线 §② 白名单 / §③ I1):终端仿真与 PTY 数据通道属可复用的非布局内核,
// alpha 只自持外壳(页签条 / 圆角深底输出区外框 / 脚条)。引擎经下方
// `AlphaTerminalEngineChannel` typed seam 进入,本目录零 import 上游模块。
//
// 地面真相(2026-07-24 勘破):上游引擎 = `packages/app/src/components/terminal.tsx`
// (ghostty-web WASM + PTY WebSocket 数据通道)+ `packages/app/src/context/terminal.tsx`
// (workspace 级 PTY 页签状态,`SessionProviders` 已将其挂在 alpha session 叶之上)。
// 两者今日均不在 `@opencode-ai/app` 公开面上 —— exports map 被
// `surface-seam-contract.test.ts` 钉死为仅 `./surface/session`(ADR-027)。接入真实引擎
// 需要一次窄 export(ADR-027 修订 + alpha-frontend.patch),归 owner 决策,不在本票擅动;
// 在此之前 channel 缺席,面板 fail-closed 落空态。
//
// I8:本面板不自持任何会话/工作区异步状态 —— 一切数据都是 channel 访问器的同步派生,
// 工作区身份切换时上游 `TargetSessionPage` 按 `scope+directory` 整树重挂,无 stale 写入面。
import type { Component } from "solid-js"

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
 */
export interface AlphaTerminalEngineChannel {
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
