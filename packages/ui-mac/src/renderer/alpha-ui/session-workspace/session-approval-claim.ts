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
 * 所有权 = sessionID + 每次 claim 独有的 token,登记为**有序**活跃 claim 集(审计第 2/3 轮
 * Major):
 * - release 只移除自己的 token —— 同一会话先后 claim A/B 时,A 的迟到 release 不清掉 B;
 * - watcher 让位当且仅当该会话仍存在任一活跃 claim;
 * - **多 dock 并存时选出唯一 owner**:同一会话按登记序首个活跃 claim 为 owner,后来者
 *   非 owner(不渲染审批卡);owner 释放时按登记序继任 —— 任一时刻同一会话恰一个呈现者
 *   (owner dock;无 claim 时 = watcher),裁决序确定。
 */
type SessionApprovalClaim = { sessionID: string; token: symbol }

const [claims, setClaims] = createSignal<readonly SessionApprovalClaim[]>([])

export type SessionApprovalClaimHandle = {
  /** 本次 claim 当前是否为该会话的呈现 owner(登记序首个活跃 claim;响应式)。 */
  owns: () => boolean
  /** 释放本次 claim(幂等,仅移除自己的 token)。 */
  release: () => void
}

/** dock 声明接管 sessionID 的审批呈现;返回句柄(owner 判定 + 释放)。 */
export function claimSessionApprovalDock(sessionID: string): SessionApprovalClaimHandle {
  const claim: SessionApprovalClaim = { sessionID, token: Symbol("session-approval-claim") }
  setClaims((current) => [...current, claim])
  return {
    owns: () => claims().find((item) => item.sessionID === sessionID)?.token === claim.token,
    release: () => setClaims((current) => current.filter((item) => item.token !== claim.token)),
  }
}

/**
 * 响应式 claim 绑定:仅当 `sessionID` 存在且 `ready()` 为 true 时持有 claim;
 * ready 翻转 / 会话切换 / owner 树销毁均同步释放。返回「本绑定当前是否为呈现 owner」
 * 的响应式判定,dock 据此决定是否渲染审批卡。必须在响应式 owner 内调用。
 */
export function bindSessionApprovalClaim(input: {
  sessionID: () => string | undefined
  ready: () => boolean
}): () => boolean {
  const [handle, setHandle] = createSignal<SessionApprovalClaimHandle | undefined>(undefined)
  createEffect(() => {
    const sessionID = input.sessionID()
    if (!sessionID || !input.ready()) {
      setHandle(undefined)
      return
    }
    const claim = claimSessionApprovalDock(sessionID)
    setHandle(claim)
    onCleanup(() => {
      claim.release()
      setHandle(undefined)
    })
  })
  return () => handle()?.owns() ?? false
}

/** 该会话的审批呈现是否已被 seam dock 接管(响应式;存在任一活跃 claim 即为接管)。 */
export function sessionApprovalDockClaimed(sessionID: string | undefined): boolean {
  return sessionID !== undefined && claims().some((item) => item.sessionID === sessionID)
}

/** 测试隔离用。 */
export function resetSessionApprovalClaim(): void {
  setClaims([])
}
