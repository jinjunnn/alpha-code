// `#1474`(REQ-229 AC4)进行中的工作过程:纯逻辑(实时窗口 / 步数 / 当前动作 / 已等 / 终端尾巴)。
import { describe, expect, test } from "bun:test"
import type { ReasoningPart, ToolPart } from "@opencode-ai/sdk/v2/client"
import {
  liveActionOf,
  liveReasoningTitle,
  liveSinceOf,
  liveStepNumberOf,
  liveTerminalTailOf,
  liveWaitedMs,
  liveWindowOf,
  PROCESS_LIVE_RECENT,
} from "./process-live"
import { buildProcessSteps, type ProcessItem, type TimelineProcessStep } from "./timeline-model"

function builtin(name: string) {
  return { identity: { source: "builtin", origin: "", name }, technicalId: name, authority: { kind: "not-asserted" } }
}

function tool(id: string, name: string, state: Record<string, unknown>, display: unknown = builtin(name)): ToolPart {
  return {
    id,
    sessionID: "ses_1",
    messageID: "msg_a",
    type: "tool",
    callID: `call_${id}`,
    tool: name,
    display,
    state: { input: {}, ...state },
  } as unknown as ToolPart
}

const done = { status: "completed", output: "", title: "x", metadata: {}, time: { start: 0, end: 1 } }
const running = (start = 0) => ({ status: "running", title: "x", time: { start } })

function reason(id: string, text: string, time: { start: number; end?: number }): ReasoningPart {
  return { id, sessionID: "ses_1", messageID: "msg_a", type: "reasoning", text, time } as ReasoningPart
}

const steps = (items: ProcessItem[]): TimelineProcessStep[] => buildProcessSteps(items)
const keys = (list: readonly TimelineProcessStep[]) => list.map((step) => step.key)

describe("#1474 实时窗口", () => {
  test("最近 2 个已结束的行 + 全部正在跑的(保序);过渡话也算一行;其余计入「前面还有 N 步」", () => {
    const list = steps([
      { type: "reasoning", part: reason("r1", "a", { start: 0, end: 1 }), streaming: false },
      { type: "tool", part: tool("t1", "read", done) },
      { type: "say", part: { id: "s1", sessionID: "ses_1", messageID: "msg_a", type: "text", text: "我先搜" } },
      { type: "tool", part: tool("t2", "bash", done) },
      { type: "tool", part: tool("w1", "websearch", running()) },
      { type: "tool", part: tool("w2", "websearch", running()) },
    ])
    const window = liveWindowOf(list)
    expect(PROCESS_LIVE_RECENT).toBe(2)
    expect(keys(window.visible)).toEqual(["say:s1", "tool:t2", "tool:w1", "tool:w2"])
    expect(window.hidden).toBe(2)
  })

  test("正在跑的步骤即使很早也留在窗口里;没有更早的就不收", () => {
    const list = steps([
      { type: "tool", part: tool("t0", "bash", running()) },
      { type: "tool", part: tool("t1", "read", done) },
      { type: "tool", part: tool("t2", "grep", done) },
      { type: "tool", part: tool("t3", "glob", done) },
    ])
    const window = liveWindowOf(list)
    expect(keys(window.visible)).toEqual(["tool:t0", "tool:t2", "tool:t3"])
    expect(window.hidden).toBe(1)
    expect(liveWindowOf(list.slice(0, 2)).hidden).toBe(0)
  })
})

describe("#1474 第 N 步与当前动作", () => {
  test("已结束的思考 / 工具步骤 + 正在进行的一步(并行算一步);过渡话不算;一步都没有 = 0", () => {
    expect(liveStepNumberOf([])).toBe(0)
    const list = steps([
      { type: "reasoning", part: reason("r1", "a", { start: 0, end: 1 }), streaming: false },
      { type: "say", part: { id: "s1", sessionID: "ses_1", messageID: "msg_a", type: "text", text: "x" } },
      { type: "tool", part: tool("w1", "websearch", running()) },
      { type: "tool", part: tool("w2", "websearch", running()) },
    ])
    expect(liveStepNumberOf(list)).toBe(2)
    expect(liveStepNumberOf(list.slice(0, 2))).toBe(1)
  })

  test("并行同类:以最后一个正在跑的为准,计同合并键的个数", () => {
    const list = steps([
      { type: "tool", part: tool("w1", "websearch", running()) },
      { type: "tool", part: tool("b1", "bash", running()) },
      { type: "tool", part: tool("w2", "websearch", running()) },
      { type: "tool", part: tool("w3", "websearch", running()) },
    ])
    expect(liveActionOf(list)).toEqual({ type: "tool", family: "search", count: 3 })
    expect(liveActionOf(list.slice(0, 2))).toEqual({ type: "tool", family: "bash", count: 1 })
  })

  test("动作族:网页打开 / 我方动词 / 非我方工具只给被动净化的名称(不读输入)", () => {
    expect(liveActionOf(steps([{ type: "tool", part: tool("f1", "webfetch", running()) }]))).toMatchObject({
      family: "fetch",
    })
    expect(liveActionOf(steps([{ type: "tool", part: tool("r1", "read", running()) }]))).toEqual({
      type: "tool",
      family: "verb",
      verbKey: "alpha.timeline.tool.read",
      count: 1,
    })
    const mcp = {
      identity: { source: "mcp", origin: "notion", name: "search" },
      technicalId: "notion_search",
      authority: { kind: "not-asserted" },
    }
    const action = liveActionOf(
      steps([{ type: "tool", part: tool("m1", "notion_search", { ...running(), input: { query: "secret" } }, mcp) }]),
    )
    expect(action).toEqual({ type: "tool", family: "named", name: "search", count: 1 })
    expect(JSON.stringify(action)).not.toContain("secret")
  })

  test("没有工具在跑 ⇒ 正在思考;流式思考只在小标题那一行写完后带上它", () => {
    expect(liveActionOf([])).toEqual({ type: "thinking" })
    const streaming = (text: string) =>
      steps([{ type: "reasoning", part: reason("r1", text, { start: 0 }), streaming: true }])
    expect(liveActionOf(streaming("Let me check the docs"))).toEqual({ type: "thinking" })
    expect(liveActionOf(streaming("**核对字"))).toEqual({ type: "thinking" })
    expect(liveActionOf(streaming("**核对字段表**\n\n然后"))).toEqual({ type: "thinking", title: "核对字段表" })
    expect(liveReasoningTitle("\n\n## 拆分步骤\nbody")).toBe("拆分步骤")
    expect(liveReasoningTitle("first line is prose\nmore")).toBeUndefined()
  })
})

describe("#1474 已等与终端尾巴", () => {
  test("超过 10 秒才写「已等」;起点缺席 / 时钟倒退不写;只对正在跑的工具与流式思考有起点", () => {
    expect(liveWaitedMs(0, 10_000)).toBeUndefined()
    expect(liveWaitedMs(0, 10_001)).toBe(10_001)
    expect(liveWaitedMs(undefined, 50_000)).toBeUndefined()
    expect(liveWaitedMs(50_000, 0)).toBeUndefined()

    const [runningStep] = steps([{ type: "tool", part: tool("t1", "bash", running(1234)) }])
    expect(liveSinceOf(runningStep!)).toBe(1234)
    const [doneStep] = steps([{ type: "tool", part: tool("t2", "bash", done) }])
    expect(liveSinceOf(doneStep!)).toBeUndefined()
    const [thinking] = steps([{ type: "reasoning", part: reason("r1", "a", { start: 77 }), streaming: true }])
    expect(liveSinceOf(thinking!)).toBe(77)
  })

  test("正在跑的命令露最后 3 行非空输出;结束 / 非命令 / 非我方工具一律没有", () => {
    const bash = (state: Record<string, unknown>, display?: unknown) =>
      tool("b1", "bash", { input: { command: "bun test" }, ...state }, display)
    expect(liveTerminalTailOf(bash({ ...running(), metadata: { output: "a\nb\n\nc\r\nd\n" } }))).toEqual([
      "b",
      "c",
      "d",
    ])
    expect(liveTerminalTailOf(bash({ ...running(), metadata: { output: "" } }))).toBeUndefined()
    expect(liveTerminalTailOf(bash({ ...done, output: "a\nb" }))).toBeUndefined()
    expect(liveTerminalTailOf(tool("w1", "websearch", running()))).toBeUndefined()
    const plugin = {
      identity: { source: "plugin", origin: "x", name: "bash" },
      technicalId: "bash",
      authority: { kind: "not-asserted" },
    }
    expect(liveTerminalTailOf(bash({ ...running(), metadata: { output: "secret\n" } }, plugin))).toBeUndefined()
  })
})
