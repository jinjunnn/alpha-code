import { describe, expect, test } from "bun:test"
import { parseRoute } from "../../../shared/route-manifest"
import { isCrossServerSessionError, workspaceContextOf } from "./session-workspace-core"

/** URL-safe base64 目录段(与 route-manifest encodeDirectory 同构;经 parseRoute 消费验证)。 */
const slug = (dir: string) => btoa(dir).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")

describe("REQ-088 T2 chrome 展示模型(只读 route manifest,零 upstream context)", () => {
  test("session 路由(带 id)→ 项目 basename + 会话尾 8 位", () => {
    const ctx = workspaceContextOf(parseRoute(`/${slug("/Users/tide/app/alpha-work")}/session/ses_0123456789abcdef`))
    expect(ctx).toEqual({
      directory: "/Users/tide/app/alpha-work",
      project: "alpha-work",
      sessionId: "ses_0123456789abcdef",
      sessionShort: "89abcdef",
    })
  })

  test("session 路由(无 id,draft 过渡态)→ sessionShort 为空(chrome 显示「新会话」)", () => {
    const ctx = workspaceContextOf(parseRoute(`/${slug("/tmp/proj")}/session`))
    expect(ctx?.project).toBe("proj")
    expect(ctx?.sessionId).toBeUndefined()
    expect(ctx?.sessionShort).toBeUndefined()
  })

  test("非 session 路由(workspace 不该挂载的位置)→ undefined", () => {
    expect(workspaceContextOf(parseRoute("/"))).toBeUndefined()
    expect(workspaceContextOf(parseRoute("/new-session?draftId=d1"))).toBeUndefined()
    expect(workspaceContextOf(parseRoute("/!!!invalid/session/x"))).toBeUndefined()
  })
})

describe("REQ-088 T2 跨 server 错误有界识别(C4 S5 最小安全解)", () => {
  test("引擎 control-plane 文案族 → true(大小写不敏感,含 id 尾缀)", () => {
    expect(isCrossServerSessionError(new Error("Session not found: ses_abc123"))).toBe(true)
    expect(isCrossServerSessionError(new Error("session not found"))).toBe(true)
    expect(isCrossServerSessionError("Session not found: ses_x")).toBe(true)
    expect(isCrossServerSessionError({ message: "Session not found: ses_x" })).toBe(true)
  })

  test("其余错误一律 false ⇒ 调用方 rethrow 回 SurfaceBoundary(致命链路语义不变)", () => {
    expect(isCrossServerSessionError(new Error("Model not found: openai/gpt"))).toBe(false)
    expect(isCrossServerSessionError(new Error("network timeout"))).toBe(false)
    expect(isCrossServerSessionError(new Error(""))).toBe(false)
    expect(isCrossServerSessionError(undefined)).toBe(false)
    expect(isCrossServerSessionError(null)).toBe(false)
    expect(isCrossServerSessionError({})).toBe(false)
    expect(isCrossServerSessionError(42)).toBe(false)
  })
})
