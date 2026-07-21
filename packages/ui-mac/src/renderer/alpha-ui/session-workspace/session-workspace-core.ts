// REQ-088 T2 — AlphaSessionWorkspace 纯逻辑核(bun:test 可测;DOM/渲染在 alpha-session-workspace.tsx)。
//
// 两块职责:
//   1. workspaceContextOf —— chrome 上下文条的展示模型,输入只有版本化路由 ABI 的解析结果
//      (LegacyRoute),不消费任何 upstream context(REQ-087 spike 报告 §6 的窄 API 纪律)。
//   2. isCrossServerSessionError —— C4 S5 发现的跨 server 会话点击崩溃(alpha 侧栏恒 pin 本地
//      sidecar,active server 为他机时上游叶 render throw「Session not found: <id>」,引擎侧
//      control-plane 的错误文案)的**有界识别**。识别到 = 用户态引导(不是 surface 缺陷,不应
//      污染 surface 崩溃诊断记录);识别不到 = 原样 rethrow 给 SurfaceBoundary 并进入
//      Alpha Recovery。文案漂移的降级方向是安全的:识别失败只是进入 fail-closed 恢复面。

import type { LegacyRoute } from "../../../shared/legacy-route-abi"
import { projectLabel } from "../../sidebar/route"

export interface WorkspaceContext {
  directory: string
  /** 目录 basename(与 alpha 侧栏的项目标签同一口径)。 */
  project: string
  sessionId?: string
  /** 会话 id 尾 8 位(chrome 展示;C4 取证用的同一缩写口径)。 */
  sessionShort?: string
}

/** session 路由 → chrome 展示模型;其余路由(workspace 不该挂载的位置)返回 undefined。 */
export function workspaceContextOf(route: LegacyRoute): WorkspaceContext | undefined {
  if (route.kind !== "session") return undefined
  return {
    directory: route.directory,
    project: projectLabel(route.directory),
    sessionId: route.id,
    sessionShort: route.id ? route.id.slice(-8) : undefined,
  }
}

/**
 * 跨 server 会话缺失错误的有界识别(引擎 control-plane 文案:`Session not found: <id>`)。
 * 只认这一族;任何其他错误(含文案未来漂移)都返回 false ⇒ 调用方 rethrow 回 SurfaceBoundary。
 */
export function isCrossServerSessionError(error: unknown): boolean {
  if (error == null) return false
  const message = typeof error === "string" ? error : String((error as { message?: unknown }).message ?? "")
  return /session not found/i.test(message)
}
