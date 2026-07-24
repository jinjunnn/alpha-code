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
  test("释放幂等且只释放自己的声明(迟到释放不打掉后立者)", () => {
    resetSessionApprovalClaim()
    const releaseA = claimSessionApprovalDock("ses_a")
    expect(sessionApprovalDockClaimed("ses_a")).toBe(true)

    const releaseB = claimSessionApprovalDock("ses_b")
    expect(sessionApprovalDockClaimed("ses_a")).toBe(false)
    expect(sessionApprovalDockClaimed("ses_b")).toBe(true)

    // A 的迟到释放不得打掉 B 的持权(先立后破的交接安全)。
    releaseA()
    expect(sessionApprovalDockClaimed("ses_b")).toBe(true)

    releaseB()
    expect(sessionApprovalDockClaimed("ses_b")).toBe(false)
    releaseB()
    expect(sessionApprovalDockClaimed("ses_b")).toBe(false)
    resetSessionApprovalClaim()
  })

  test("undefined 会话永不判定为已接管", () => {
    resetSessionApprovalClaim()
    claimSessionApprovalDock("ses_a")
    expect(sessionApprovalDockClaimed(undefined)).toBe(false)
    resetSessionApprovalClaim()
  })
})
