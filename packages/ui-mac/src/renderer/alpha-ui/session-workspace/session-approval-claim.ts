// REQ-125 C7:审批呈现权的进程内协调(零 DOM、零选择器)。
//
// seam 会话页的 composer dock 接管当前会话的审批呈现时在此登记;独立 Permission surface
// (PermissionWatcher)看到当前会话已被 dock 接管则不渲对话框,避免同一请求双 UI。
//
// 时序纪律(Codex 审计 2026-07-24 Major:消除「两边都不呈现」的确定性窗口):
// 呈现权移交**先立后破** —— dock 只在自身 feed 就绪(list 成功、可真实呈现)时才持有
// claim;list 在途或失败期间不夺权,watcher 凭自己的通道继续兜底。claim 与释放经
// bindSessionApprovalClaim 的响应式 effect 原子成对(claim 后立即登记 onCleanup,中间
// 无可抛语句),dock 卸载 / 降级 / 失去就绪即同步释放 —— 任何时刻,能呈现的一侧呈现;
// 不呈现 = 不放行,fail-closed 不因协调而弱化。

import { createEffect, createSignal, onCleanup } from "solid-js"

const [owner, setOwner] = createSignal<string | undefined>(undefined)

/** dock 声明接管 sessionID 的审批呈现;返回释放函数(幂等,仅释放自己的声明)。 */
export function claimSessionApprovalDock(sessionID: string): () => void {
  setOwner(sessionID)
  return () => setOwner((current) => (current === sessionID ? undefined : current))
}

/**
 * 响应式 claim 绑定:仅当 `sessionID` 存在且 `ready()` 为 true 时持有呈现权;
 * ready 翻转 / 会话切换 / owner 树销毁均同步释放。必须在响应式 owner 内调用。
 */
export function bindSessionApprovalClaim(input: { sessionID: () => string | undefined; ready: () => boolean }): void {
  createEffect(() => {
    const sessionID = input.sessionID()
    if (!sessionID || !input.ready()) return
    const release = claimSessionApprovalDock(sessionID)
    onCleanup(release)
  })
}

/** 该会话的审批呈现是否已被 seam dock 接管(响应式)。 */
export function sessionApprovalDockClaimed(sessionID: string | undefined): boolean {
  return sessionID !== undefined && owner() === sessionID
}

/** 测试隔离用。 */
export function resetSessionApprovalClaim(): void {
  setOwner(undefined)
}
