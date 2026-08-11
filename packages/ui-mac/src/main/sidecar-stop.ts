// #858 —— main 与 sidecar 之间「怎么停」的唯一形状。
//
// 缺陷不在某一行逻辑,在**协议少一个字段**:
//   · 「这次只是 token-only 换血」这个事实只有 main 知道(index.ts 的 respawn reason);
//   · 而「要不要主动关掉活动连接」的开关只有 sidecar 按得到 —— 它是引擎 listener 的
//     `stop(close?: boolean)`(packages/opencode/src/server/server.ts:186-197:`close` 为真时
//     跑 `forceClose` = http.closeAll + websockets.closeAll,即 `server.closeAllConnections()`;
//     不传则只关 scope,活动连接自然排空)。
// 两端都有一半信息,而线上的 `{ type: "stop" }` 一个字段都不带 ⇒ sidecar 恒走排空,
// 旧 sidecar 在有活动连接时把 main 的整个停止预算吃满,新 token 的 sidecar 干等。
//
// 所以本模块不是"工具函数",它是**这条线的合同**:main 用 `buildSidecarStopCommand` 写,
// sidecar 用 `parseSidecarStopCommand` 读、用 `stopSidecarListener` 执行。两侧共用一份,
// 免得形状在两个包里各写一遍然后漂移。
//
// 边界(这是本票唯一收紧的东西):**只有** token-only 换血请求强关。结构性 respawn 与应用
// 退出照旧排空 —— 那两条路径上「等干净」本身就是安全语义,不在本票范围内放宽。

/**
 * main 侧的停止原因。
 * - `token-rotation`:token-only 换血 —— 引擎形态不变,只是换一份凭据,旧连接注定要断,
 *   如实中断即可(renderer 的中断/草稿保留语义不变)。
 * - `graceful`:结构性 respawn 与应用退出 —— 保留既有排空语义。
 */
export type SidecarStopMode = "graceful" | "token-rotation"

/**
 * 线上形状。缺省 = 排空(= 今天的行为,逐字节不变);`closeActiveConnections` 只由
 * token-only 换血置真。刻意用可选字段而不是 `mode: string`:老形状 `{ type: "stop" }`
 * 就是新形状的合法取值,不存在"没读懂就当强关"的方向。
 */
export type SidecarStopCommand = { type: "stop"; closeActiveConnections?: true }

/** 引擎 listener 里本模块用得到的那一面(`Server.listen()` 的返回值满足它)。 */
export type StoppableListener = { stop(close?: boolean): void | Promise<void> }

export function buildSidecarStopCommand(mode: SidecarStopMode): SidecarStopCommand {
  return mode === "token-rotation" ? { type: "stop", closeActiveConnections: true } : { type: "stop" }
}

/**
 * fail-closed:只有**显式 `true`** 才强关。任何别的取值(缺省 / `"1"` / `1` / `"true"` / `false`)
 * 一律回落到排空 —— 强关是收紧后的窄路径,拿不准时要退到既有安全语义那一侧,不是反过来。
 */
export function parseSidecarStopCommand(value: unknown): SidecarStopCommand | undefined {
  if (!value || typeof value !== "object") return
  const command = value as { type?: unknown; closeActiveConnections?: unknown }
  if (command.type !== "stop") return
  return command.closeActiveConnections === true ? { type: "stop", closeActiveConnections: true } : { type: "stop" }
}

/**
 * sidecar 侧的执行。排空那一支刻意**不传参**(而不是传 `false`)—— 让既有路径的调用与本票
 * 之前逐字节相同,免得"等价所以随便"日后变成一次真实的语义漂移。
 */
export async function stopSidecarListener(listener: StoppableListener | undefined, command: SidecarStopCommand) {
  if (!listener) return
  if (command.closeActiveConnections) await listener.stop(true)
  else await listener.stop()
}
