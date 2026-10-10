// `#1473`(REQ-229 AC1–AC3)工作过程投影:从生产装配(projectTimelineRows)出发。
import { describe, expect, test } from "bun:test"
import type {
  AssistantMessage,
  Message,
  Part,
  ReasoningPart,
  TextPart,
  ToolPart,
  UserMessage,
} from "@opencode-ai/sdk/v2/client"
import { RESEARCH_TURN_MS, RESEARCH_USER, researchTurn } from "../../../../test-component/process-fold.fixture"
import {
  buildProcessSteps,
  processSummaryOf,
  projectTimelineRows,
  splitDuration,
  type TimelineProcessStep,
  type TimelineRow,
} from "./timeline-model"

function project(messages: Message[], parts: Record<string, Part[]>, status = "idle") {
  return projectTimelineRows({ messages, partsOf: (id) => parts[id] ?? [], status })
}

function processRows(rows: readonly TimelineRow[]) {
  return rows.filter((row): row is Extract<TimelineRow, { kind: "process" }> => row.kind === "process")
}

function shape(steps: readonly TimelineProcessStep[]) {
  return steps.map((step) => (step.kind === "say" ? "say" : `${step.kind}×${step.parts.length}`))
}

const user = (id = "msg_u", created = 1000): UserMessage => ({
  id,
  sessionID: "ses_1",
  role: "user",
  time: { created },
  agent: "build",
  model: { providerID: "p", modelID: "m" },
})

const assistant = (id: string, over: Partial<AssistantMessage> = {}): AssistantMessage => ({
  id,
  sessionID: "ses_1",
  role: "assistant",
  time: { created: 1100, completed: 9000 },
  parentID: "msg_u",
  modelID: "m",
  providerID: "p",
  mode: "build",
  agent: "build",
  path: { cwd: "/tmp", root: "/tmp" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  ...over,
})

const text = (id: string, body: string): TextPart => ({
  id,
  sessionID: "ses_1",
  messageID: "msg_a",
  type: "text",
  text: body,
})
const reason = (id: string, over: Partial<ReasoningPart> = {}): ReasoningPart => ({
  id,
  sessionID: "ses_1",
  messageID: "msg_a",
  type: "reasoning",
  text: "想一想",
  time: { start: 0, end: 2000 },
  ...over,
})

function builtin(name: string) {
  return { identity: { source: "builtin", origin: "", name }, technicalId: name, authority: { kind: "not-asserted" } }
}
function mcp(origin: string, name: string) {
  return {
    identity: { source: "mcp", origin, name },
    technicalId: `${origin}_${name}`,
    authority: { kind: "not-asserted" },
  }
}

function tool(id: string, name: string, over: Partial<ToolPart> = {}): ToolPart {
  return {
    id,
    sessionID: "ses_1",
    messageID: "msg_a",
    type: "tool",
    callID: `call_${id}`,
    tool: name,
    display: builtin(name),
    state: { status: "completed", input: {}, output: "", title: name, metadata: {}, time: { start: 0, end: 1 } },
    ...over,
  } as ToolPart
}

const failedState = { status: "error", input: {}, error: "boom", time: { start: 0, end: 1 } } as ToolPart["state"]
const runningState = { status: "running", input: {}, title: "x", time: { start: 0 } } as ToolPart["state"]

describe("#1473 真实 18 步研究回合(生产装配)", () => {
  const { messages, parts } = researchTurn()
  const rows = projectTimelineRows({ messages, partsOf: (id) => parts[id] ?? [], status: "idle" })

  test("回答之前恰好一行工作过程;回答 = 最后一次工具调用之后的文字;脚注与它们都在外面", () => {
    expect(rows.map((row) => row.kind)).toEqual(["user", "process", "markdown", "footnote"])
    expect(processRows(rows)).toHaveLength(1)
    const answer = rows[2]!
    expect(answer.kind === "markdown" && answer.part.text).toContain("criteria 本身不能嵌套")
    expect(answer.key).toBe("md:prt_msg_research_a6_1")
  })

  test("展开后 12 行:思考 6 段 + 搜索 4/2/4/4/2 + 打开网页 2 次合成一行", () => {
    const process = processRows(rows)[0]!
    expect(shape(process.steps)).toEqual([
      "reasoning×1",
      "tool×4",
      "reasoning×1",
      "tool×2",
      "tool×2",
      "reasoning×1",
      "tool×4",
      "reasoning×1",
      "tool×4",
      "reasoning×1",
      "tool×2",
      "reasoning×1",
    ])
    const fetches = process.steps[3]!
    expect(fetches.kind === "tool" && fetches.parts.map((part) => part.tool)).toEqual(["webfetch", "webfetch"])
  })

  test("摘要:搜索 16 次(思考不计)· 2 步没成功 · 整轮用时 3 分 27 秒", () => {
    const process = processRows(rows)[0]!
    const summary = processSummaryOf(process.steps)
    expect(summary.actions).toEqual([
      expect.objectContaining({ titleKey: "alpha.timeline.cloud.webSearch", count: 16 }),
    ])
    expect(summary.failed).toBe(2)
    expect(summary.reasoningCount).toBe(6)
    expect(process.turnFailed).toBe(false)
    expect(process.userMessageID).toBe(RESEARCH_USER)
    expect(process.durationMs).toBe(RESEARCH_TURN_MS)
    expect(splitDuration(process.durationMs!)).toEqual({ minutes: 3, seconds: 27 })
  })

  test("脚注不再带用时(它只量最后一条助手消息,与整轮计时同名不同量)", () => {
    const footnote = rows.at(-1)!
    if (footnote.kind !== "footnote") throw new Error("expected footnote")
    expect("durationMs" in footnote.footnote).toBe(false)
  })
})

describe("#1473 合并规则", () => {
  const items = (list: Parameters<typeof buildProcessSteps>[0]) => shape(buildProcessSteps(list))

  test("思考不与工具合并;连续都已结束的思考合成一步", () => {
    expect(
      items([
        { type: "reasoning", part: reason("r1"), streaming: false },
        { type: "reasoning", part: reason("r2"), streaming: false },
        { type: "tool", part: tool("t1", "read") },
        { type: "reasoning", part: reason("r3"), streaming: false },
      ]),
    ).toEqual(["reasoning×2", "tool×1", "reasoning×1"])
  })

  test("过渡话独占一步并切断合并", () => {
    expect(
      items([
        { type: "tool", part: tool("t1", "read") },
        { type: "say", part: text("s1", "我先读一下") },
        { type: "tool", part: tool("t2", "read") },
      ]),
    ).toEqual(["tool×1", "say", "tool×1"])
  })

  test("同类不同来源不合并:两个第三方 MCP 工具、同名不同 server、第三方冒名 read 都各自成步", () => {
    expect(
      items([
        { type: "tool", part: tool("t1", "a_search", { display: mcp("a", "search") }) },
        { type: "tool", part: tool("t2", "a_fetch", { display: mcp("a", "fetch") }) },
        { type: "tool", part: tool("t3", "b_fetch", { display: mcp("b", "fetch") }) },
        { type: "tool", part: tool("t4", "read") },
        { type: "tool", part: tool("t5", "x_read", { display: mcp("x", "read") }) },
      ]),
    ).toEqual(["tool×1", "tool×1", "tool×1", "tool×1", "tool×1"])
    // 对照:同一个第三方工具连续调用照常合并。
    expect(
      items([
        { type: "tool", part: tool("t1", "a_search", { display: mcp("a", "search") }) },
        { type: "tool", part: tool("t2", "a_search", { display: mcp("a", "search") }) },
      ]),
    ).toEqual(["tool×2"])
  })

  test("运行中 / 等待中的步骤永不合并,也不吞下前后的同类步骤;失败与成功的已结束步骤照常合并", () => {
    expect(
      items([
        { type: "tool", part: tool("t1", "read") },
        { type: "tool", part: tool("t2", "read", { state: runningState }) },
        { type: "tool", part: tool("t3", "read", { state: runningState }) },
        { type: "tool", part: tool("t4", "read") },
        { type: "tool", part: tool("t5", "read", { state: failedState }) },
      ]),
    ).toEqual(["tool×1", "tool×1", "tool×1", "tool×2"])
    expect(
      items([
        { type: "reasoning", part: reason("r1", { time: { start: 0 } }), streaming: true },
        { type: "reasoning", part: reason("r2"), streaming: false },
      ]),
    ).toEqual(["reasoning×1", "reasoning×1"])
  })
})

describe("#1473 哪段文字是回答", () => {
  test("工具之后的文字是回答;工具之前的文字是过渡话(留在工作过程里)", () => {
    const rows = project([user(), assistant("msg_a")], {
      msg_u: [{ ...text("u", "问"), messageID: "msg_u" }],
      msg_a: [text("s1", "我先搜一下"), tool("t1", "read"), text("a1", "答案")],
    })
    expect(rows.map((row) => row.kind)).toEqual(["user", "process", "markdown", "footnote"])
    expect(shape(processRows(rows)[0]!.steps)).toEqual(["say", "tool×1"])
    expect(rows[2]!.key).toBe("md:a1")
  })

  test("最后一次工具之后没有文字:把最后一段过渡话提为回答,更早的仍是过渡话", () => {
    const rows = project([user(), assistant("msg_a")], {
      msg_u: [{ ...text("u", "问"), messageID: "msg_u" }],
      msg_a: [text("s1", "第一段"), tool("t1", "read"), text("s2", "第二段"), tool("t2", "bash")],
    })
    expect(rows.map((row) => row.kind)).toEqual(["user", "process", "markdown", "footnote"])
    expect(shape(processRows(rows)[0]!.steps)).toEqual(["say", "tool×1", "tool×1"])
    expect(rows[2]!.key).toBe("md:s2")
  })

  test("一个字都没有:只出工作过程,不编造回答;零产出的 unknown 回合仍走空回合行", () => {
    const toolsOnly = project([user(), assistant("msg_a")], {
      msg_u: [{ ...text("u", "问"), messageID: "msg_u" }],
      msg_a: [tool("t1", "bash")],
    })
    expect(toolsOnly.map((row) => row.kind)).toEqual(["user", "process", "footnote"])

    const empty = project([user(), assistant("msg_a", { finish: "unknown" } as never)], {
      msg_u: [{ ...text("u", "问"), messageID: "msg_u" }],
    })
    expect(empty.map((row) => row.kind)).toEqual(["user", "divider"])
  })

  test("只思考、没用工具:工作过程只有思考,回答在外面", () => {
    const rows = project([user(), assistant("msg_a")], {
      msg_u: [{ ...text("u", "问"), messageID: "msg_u" }],
      msg_a: [reason("r1"), text("a1", "可以")],
    })
    expect(rows.map((row) => row.kind)).toEqual(["user", "process", "markdown", "footnote"])
    expect(shape(processRows(rows)[0]!.steps)).toEqual(["reasoning×1"])
  })

  test("没有思考也没有工具:不出工作过程行", () => {
    const rows = project([user(), assistant("msg_a")], {
      msg_u: [{ ...text("u", "问"), messageID: "msg_u" }],
      msg_a: [text("a1", "直接回答")],
    })
    expect(rows.some((row) => row.kind === "process")).toBe(false)
  })

  test("媒体、中断、回合错误都在回答之后、工作过程之外", () => {
    const media = {
      id: "f1",
      sessionID: "ses_1",
      messageID: "msg_a",
      type: "file",
      mime: "image/png",
      url: "data:image/png;base64,eA==",
    } as Part
    const interrupted = project(
      [user(), assistant("msg_a", { error: { name: "MessageAbortedError", data: { message: "" } } } as never)],
      {
        msg_u: [{ ...text("u", "问"), messageID: "msg_u" }],
        msg_a: [tool("t1", "read"), media, text("a1", "写到一半")],
      },
    )
    expect(interrupted.map((row) => row.kind)).toEqual(["user", "process", "markdown", "media", "divider"])

    const failed = project(
      [user(), assistant("msg_a", { error: { name: "APIError", data: { message: "overloaded" } } } as never)],
      { msg_u: [{ ...text("u", "问"), messageID: "msg_u" }], msg_a: [tool("t1", "read", { state: failedState })] },
    )
    expect(failed.map((row) => row.kind)).toEqual(["user", "process", "turnError"])
    // 回合失败时摘要不写「哪里不顺」(错误卡已在外面)。
    expect(processRows(failed)[0]!.turnFailed).toBe(true)
  })
})

describe("#1473 摘要", () => {
  test("动作计数最多三类,按次数排;失败不计入动作,另计", () => {
    const steps = buildProcessSteps([
      { type: "tool", part: tool("a1", "read") },
      { type: "say", part: text("s", "x") },
      { type: "tool", part: tool("b1", "bash") },
      { type: "tool", part: tool("b2", "bash") },
      { type: "tool", part: tool("b3", "bash") },
      { type: "tool", part: tool("g1", "grep") },
      { type: "tool", part: tool("g2", "grep") },
      { type: "tool", part: tool("w1", "write") },
      { type: "tool", part: tool("f1", "webfetch", { state: failedState }) },
    ])
    const summary = processSummaryOf(steps)
    expect(summary.actions.map((action) => [action.titleKey, action.count])).toEqual([
      ["alpha.timeline.step.bash", 3],
      ["alpha.timeline.tool.grep", 2],
      ["alpha.timeline.tool.read", 1],
    ])
    expect(summary.failed).toBe(1)
  })

  test("metadata-only 工具在摘要里只有名称(无动词),不读输入", () => {
    const steps = buildProcessSteps([
      {
        type: "tool",
        part: tool("m1", "notion_search", {
          display: mcp("notion", "search"),
          state: {
            ...failedState,
            status: "completed",
            output: "secret",
            title: "t",
            metadata: {},
          } as ToolPart["state"],
        }),
      },
    ])
    expect(processSummaryOf(steps).actions).toEqual([{ key: expect.any(String), name: "search", count: 1 }])
  })

  test("回合仍在跑:不出用时;最后一条助手未完成:不出用时", () => {
    const rows = project(
      [user(), assistant("msg_a", { time: { created: 1100 } })],
      { msg_u: [{ ...text("u", "问"), messageID: "msg_u" }], msg_a: [tool("t1", "read", { state: runningState })] },
      "busy",
    )
    const process = processRows(rows)[0]!
    expect(process.active).toBe(true)
    expect(process.durationMs).toBeUndefined()
  })
})
