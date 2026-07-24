// REQ-125 C7 / Codex 审计第 2/3 轮 Major:审批呈现权的纯语义 ——
// token 所有权(迟到释放不清掉他人)+ 同会话唯一 owner(登记序首个活跃 claim 当选,
// owner 释放按登记序继任)。bindSessionApprovalClaim 的响应式半场与「多 dock 恰一份
// 审批 DOM」在真实 Solid 挂载下验证(session-workspace.cases / PermissionDialog.test)。

import { describe, expect, test } from "bun:test"
import {
  claimSessionApprovalDock,
  resetSessionApprovalClaim,
  sessionApprovalDockClaimed,
} from "./session-approval-claim"

describe("claimSessionApprovalDock 纯语义", () => {
  test("释放幂等且只移除自己的 token;不同会话的 claim 互不干扰", () => {
    resetSessionApprovalClaim()
    const claimA = claimSessionApprovalDock("ses_a")
    expect(sessionApprovalDockClaimed("ses_a")).toBe(true)

    const claimB = claimSessionApprovalDock("ses_b")
    expect(sessionApprovalDockClaimed("ses_a")).toBe(true)
    expect(sessionApprovalDockClaimed("ses_b")).toBe(true)

    claimA.release()
    expect(sessionApprovalDockClaimed("ses_a")).toBe(false)
    expect(sessionApprovalDockClaimed("ses_b")).toBe(true)

    claimB.release()
    expect(sessionApprovalDockClaimed("ses_b")).toBe(false)
    claimB.release()
    expect(sessionApprovalDockClaimed("ses_b")).toBe(false)
    resetSessionApprovalClaim()
  })

  test("同一会话连续 claim:先立者为 owner,迟到释放不清掉后立者,释放后按登记序继任", () => {
    resetSessionApprovalClaim()
    const claimA = claimSessionApprovalDock("ses_same")
    const claimB = claimSessionApprovalDock("ses_same")
    // 唯一 owner:登记序首个活跃 claim 当选(A),后来者非 owner —— 恰一个呈现者。
    expect(claimA.owns()).toBe(true)
    expect(claimB.owns()).toBe(false)
    expect(sessionApprovalDockClaimed("ses_same")).toBe(true)

    // owner 释放 → 按登记序继任(B);会话仍处接管态(watcher 不恢复)。
    claimA.release()
    expect(claimB.owns()).toBe(true)
    expect(sessionApprovalDockClaimed("ses_same")).toBe(true)

    // A 的重复(迟到)释放:token 不匹配 → no-op,B 仍持权。
    claimA.release()
    expect(claimB.owns()).toBe(true)
    expect(sessionApprovalDockClaimed("ses_same")).toBe(true)

    claimB.release()
    expect(claimB.owns()).toBe(false)
    expect(sessionApprovalDockClaimed("ses_same")).toBe(false)
    resetSessionApprovalClaim()
  })

  test("undefined 会话永不判定为已接管", () => {
    resetSessionApprovalClaim()
    claimSessionApprovalDock("ses_a")
    expect(sessionApprovalDockClaimed(undefined)).toBe(false)
    resetSessionApprovalClaim()
  })
})
