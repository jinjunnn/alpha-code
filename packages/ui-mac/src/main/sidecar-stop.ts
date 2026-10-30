// #858 —— main 与 sidecar 之间「怎么停」的唯一形状。
//
// main 用 `SIDECAR_STOP_COMMAND` 写,sidecar 用 `parseSidecarStopCommand` 读、用 `stopSidecarListener` 执行。
// 两侧共用一份,免得形状在两个包里各写一遍然后漂移。
//
// 停止一律排空(引擎 listener 的 `stop()` 不传强关参数,活动连接自然收口)。#858 曾为 token-only 换血加过
// 「强关活动连接」一档;REQ-236 `#1562` 起令牌续期热应用凭据文件、不再重启引擎,那一档没有任何生产者,随之删除。

export type SidecarStopCommand = { type: "stop" }

/** 引擎 listener 里本模块用得到的那一面(`Server.listen()` 的返回值满足它)。 */
export type StoppableListener = { stop(close?: boolean): void | Promise<void> }

export const SIDECAR_STOP_COMMAND: SidecarStopCommand = { type: "stop" }

/** 只认 `type: "stop"`;其余字段一律忽略(不存在任何会改变停止语义的附加字段)。 */
export function parseSidecarStopCommand(value: unknown): SidecarStopCommand | undefined {
  if (!value || typeof value !== "object") return
  if ((value as { type?: unknown }).type !== "stop") return
  return SIDECAR_STOP_COMMAND
}

/** sidecar 侧的执行:排空(不传参,与 #858 之前的既有调用逐字节相同)。 */
export async function stopSidecarListener(listener: StoppableListener | undefined) {
  if (!listener) return
  await listener.stop()
}
