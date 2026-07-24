// REQ-125 C7:审批呈现权的进程内协调(零 DOM、零选择器)。
//
// seam 会话页的 composer dock 接管当前会话的审批呈现时在此登记;独立 Permission surface
// (PermissionWatcher)看到当前会话已被 dock 接管则不渲对话框,避免同一请求双 UI。
// dock 卸载 / 崩溃(SurfaceBoundary 收走整页)即释放,watcher 自动恢复兜底 —— 任何时刻
// 都不会出现「无人呈现审批」的放行旁路;不呈现 = 不放行,fail-closed 不因协调而弱化。

import { createSignal } from "solid-js"

const [owner, setOwner] = createSignal<string | undefined>(undefined)

/** dock 声明接管 sessionID 的审批呈现;返回释放函数(幂等,仅释放自己的声明)。 */
export function claimSessionApprovalDock(sessionID: string): () => void {
  setOwner(sessionID)
  return () => setOwner((current) => (current === sessionID ? undefined : current))
}

/** 该会话的审批呈现是否已被 seam dock 接管(响应式)。 */
export function sessionApprovalDockClaimed(sessionID: string | undefined): boolean {
  return sessionID !== undefined && owner() === sessionID
}
