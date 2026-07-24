// REQ-125 C7 / Codex 审计 Major:审批呈现权协调的纯语义(claim/release)。
// bindSessionApprovalClaim 的响应式「先立后破」行为在真实 Solid 挂载下验证
// (test-component/session-workspace.cases.ts —— 本进程的 solid-js 是 server 构建,
// createEffect 不执行,故响应式半场不在此文件伪造)。

import { describe, expect, test } from "bun:test"
import {
  claimSessionApprovalDock,
  resetSessionApprovalClaim,
  sessionApprovalDockClaimed,
} from "./session-approval-claim"

describe("claimSessionApprovalDock 纯语义", () => {
  test("释放幂等且只移除自己的 token;不同会话的 claim 互不干扰", () => {
    resetSessionApprovalClaim()
    const releaseA = claimSessionApprovalDock("ses_a")
    expect(sessionApprovalDockClaimed("ses_a")).toBe(true)

    const releaseB = claimSessionApprovalDock("ses_b")
    expect(sessionApprovalDockClaimed("ses_a")).toBe(true)
    expect(sessionApprovalDockClaimed("ses_b")).toBe(true)

    releaseA()
    expect(sessionApprovalDockClaimed("ses_a")).toBe(false)
    expect(sessionApprovalDockClaimed("ses_b")).toBe(true)

    releaseB()
    expect(sessionApprovalDockClaimed("ses_b")).toBe(false)
    releaseB()
    expect(sessionApprovalDockClaimed("ses_b")).toBe(false)
    resetSessionApprovalClaim()
  })

  test("同一会话连续 claim:后立者胜,先立者的迟到释放不清掉后立者(token 所有权)", () => {
    // 审计第 2 轮 Major 复现:owner 仅存 sessionID 时此断言必红(afterLateRelease === false)。
    resetSessionApprovalClaim()
    const releaseA = claimSessionApprovalDock("ses_same")
    const releaseB = claimSessionApprovalDock("ses_same")
    expect(sessionApprovalDockClaimed("ses_same")).toBe(true)

    releaseA() // A 的迟到释放:token 不匹配 → no-op,B 仍持权(watcher 不得误判无人持权)
    expect(sessionApprovalDockClaimed("ses_same")).toBe(true)

    releaseB()
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
