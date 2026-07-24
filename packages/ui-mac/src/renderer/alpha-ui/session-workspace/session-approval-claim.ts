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

/**
 * 所有权 = sessionID + 每次 claim 独有的 token,登记为活跃 claim 集(审计第 2 轮 Major:
 * owner 仅存 sessionID 时,同一会话先后 claim A/B,A 的迟到 release 会按字符串命中并清掉
 * B 的持权,造成 watcher 误判无人持权 → 双呈现)。裁决序确定:release 只移除自己的 token,
 * watcher 让位当且仅当该会话仍存在任一活跃 claim —— 重叠挂载按任意顺序建立/释放都不产生
 * 双呈现窗口,同一会话任一时刻恰一个呈现者(有 claim = dock,无 claim = watcher)。
 */
type SessionApprovalClaim = { sessionID: string; token: symbol }

const [claims, setClaims] = createSignal<readonly SessionApprovalClaim[]>([])

/** dock 声明接管 sessionID 的审批呈现;返回释放函数(幂等,仅释放自己这次 claim)。 */
export function claimSessionApprovalDock(sessionID: string): () => void {
  const claim: SessionApprovalClaim = { sessionID, token: Symbol("session-approval-claim") }
  setClaims((current) => [...current, claim])
  return () => setClaims((current) => current.filter((item) => item.token !== claim.token))
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

/** 该会话的审批呈现是否已被 seam dock 接管(响应式;存在任一活跃 claim 即为接管)。 */
export function sessionApprovalDockClaimed(sessionID: string | undefined): boolean {
  return sessionID !== undefined && claims().some((item) => item.sessionID === sessionID)
}

/** 测试隔离用。 */
export function resetSessionApprovalClaim(): void {
  setClaims([])
}
