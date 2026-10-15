// REQ-234 `#1529` I6:parentPort `alpha.*` 消息族封闭 —— 只认三种 ext → main 的形状,其余(含未知 alpha.* type、
// main → ext 方向、形状不对)一律 undefined,由收方丢弃。
import { describe, expect, test } from "bun:test"
import {
  buildReloadRequest,
  isAlphaSidecarMessage,
  isHubRequestId,
  parseAlphaSidecarInbound,
  parseReloadRequest,
} from "./alpha-sidecar-messages"

describe("alpha-sidecar-messages — 入站只认三种(I6)", () => {
  test("三种 ext → main 的消息按合同解析;多余字段不进结果", () => {
    expect(
      parseAlphaSidecarInbound({
        type: "alpha.hub.view.request",
        id: 3,
        directory: "/work/a",
        sessionID: "ses_1",
        agent: "build",
        query: "pdf",
        extra: "dropped",
      }),
    ).toEqual({ type: "alpha.hub.view.request", id: 3, directory: "/work/a", sessionID: "ses_1", agent: "build", query: "pdf" })
    expect(parseAlphaSidecarInbound({ type: "alpha.hub.request.request", id: 4, requestId: "req_abcdefgh" })).toEqual({
      type: "alpha.hub.request.request",
      id: 4,
      requestId: "req_abcdefgh",
    })
    expect(
      parseAlphaSidecarInbound({
        type: "alpha.reload.report",
        generation: 7,
        scope: { directory: "/work/a" },
        outcome: "waiting",
        directories: ["/work/a"],
        error: "2 session(s) busy",
      }),
    ).toEqual({
      type: "alpha.reload.report",
      generation: 7,
      scope: { directory: "/work/a" },
      outcome: "waiting",
      directories: ["/work/a"],
      error: "2 session(s) busy",
    })
  })

  test("未知 alpha.* type、main → ext 方向、形状不对:一律 undefined", () => {
    const rejected: unknown[] = [
      { type: "alpha.hub.install", id: 1, catalogId: "mcp:x" },
      { type: "alpha.reload.request", generation: 1, scope: "global", items: [], reason: "x" },
      { type: "alpha.hub.view.reply", id: 1, view: { directory: "/", rows: [], warnings: [] } },
      { type: "alpha.hub.view.request", id: -1, directory: "/work" },
      { type: "alpha.hub.view.request", id: 1.5, directory: "/work" },
      { type: "alpha.hub.view.request", id: 1, directory: "" },
      { type: "alpha.hub.view.request", id: 1, directory: "/work", sessionID: 7 },
      { type: "alpha.hub.request.request", id: 1, requestId: "short" },
      { type: "alpha.hub.request.request", id: 1, requestId: "has space in it" },
      { type: "alpha.reload.report", generation: 1, scope: "everything", outcome: "reloaded", directories: [] },
      { type: "alpha.reload.report", generation: 1, scope: { directory: "/a", extra: 1 }, outcome: "reloaded", directories: [] },
      { type: "alpha.reload.report", generation: 1, scope: "global", outcome: "maybe", directories: [] },
      { type: "alpha.reload.report", generation: 1, scope: "global", outcome: "reloaded", directories: [3] },
      null,
      "alpha.hub.view.request",
      [],
    ]
    for (const message of rejected) expect(parseAlphaSidecarInbound(message)).toBeUndefined()
  })

  test("族判定只看 alpha. 前缀:write-probe / ready 等既有消息不属于本族", () => {
    expect(isAlphaSidecarMessage({ type: "alpha.anything" })).toBe(true)
    expect(isAlphaSidecarMessage({ type: "write-probe-result", id: 1, outcome: "writable" })).toBe(false)
    expect(isAlphaSidecarMessage({ type: "ready" })).toBe(false)
    expect(isAlphaSidecarMessage(undefined)).toBe(false)
  })

  test("requestId 形状冻结:8–64 位 [A-Za-z0-9_-]", () => {
    expect(isHubRequestId("abcd1234")).toBe(true)
    expect(isHubRequestId("A_b-".repeat(16))).toBe(true)
    expect(isHubRequestId("abc1234")).toBe(false)
    expect(isHubRequestId("x".repeat(65))).toBe(false)
    expect(isHubRequestId("abcd/1234")).toBe(false)
    expect(isHubRequestId(12345678)).toBe(false)
  })

  test("main 构造的重载请求过得了 ext 侧的严格解析;force 只有 true 一种取值", () => {
    const built = buildReloadRequest({
      generation: 2,
      scope: { directory: "/work/a" },
      items: [{ id: "skill:writer", scope: "global" }],
      reason: "installed skill writer",
      force: true,
    })
    expect(parseReloadRequest(built)).toEqual(built)
    expect(parseReloadRequest(buildReloadRequest({ generation: 3, scope: "global", items: [], reason: "x" }))).toEqual({
      type: "alpha.reload.request",
      generation: 3,
      scope: "global",
      items: [],
      reason: "x",
    })
    expect(parseReloadRequest({ ...built, force: false })).toBeUndefined()
    expect(parseReloadRequest({ ...built, items: [{ id: "x", scope: "everywhere" }] })).toBeUndefined()
  })
})
