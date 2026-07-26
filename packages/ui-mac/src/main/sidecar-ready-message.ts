// #613(R1 Blocker 2):sidecar → main 的 ready IPC 消息构造,从 sidecar.ts start() 抽出的
// 最小单元。sidecar.ts 无法被 bun import(首个 import 即 node:module registerHooks,顶层
// getParentPort() 必抛),而纯源码文本锚已被实证绕过 —— 把转发表达式变异成
// `injectionFailure: injection.error && undefined` 时四条文本锚全绿、IPC 却丢失失败字段。
// 「失败字段真的在 ready 消息上」只能由真执行的运行时闸门守住(sidecar-ready-message.test.ts),
// 所以这段逻辑必须住在 bun 可 import 的模块里。抽取范围以「闸门能真执行」为限,只此一个函数;
// sidecar.ts 侧的接线锚(唯一通路 + 捕获值整体入参)见 alpha-config-injection.test.ts。
import type { AlphaConfigInjectionFailure, AlphaConfigInjectionResult } from "./alpha-config-injection"

export type SidecarReadyMessage = { type: "ready"; injectionFailure?: AlphaConfigInjectionFailure }

/** 注入失败必须整体随 ready 上车(rev2c ③″2-6:成功=结果可用);成功路径不得携带该字段。 */
export function buildReadyMessage(injection: AlphaConfigInjectionResult): SidecarReadyMessage {
  if (injection.ok) return { type: "ready" }
  return { type: "ready", injectionFailure: injection.error }
}
