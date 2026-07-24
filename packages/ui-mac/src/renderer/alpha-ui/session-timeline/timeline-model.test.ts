import { describe, expect, test } from "bun:test"
import type {
  AssistantMessage,
  FilePart,
  Message,
  Part,
  ReasoningPart,
  TextPart,
  ToolPart,
  UserMessage,
} from "@opencode-ai/sdk/v2/client"
import {
  boundedText,
  commentOf,
  MARKDOWN_MAX_CHARS,
  projectTimelineRows,
  reuseTimelineRows,
  segmentUserText,
  USER_TEXT_MAX_CHARS,
} from "./timeline-model"

function userMsg(id: string, created: number, over: Partial<UserMessage> = {}): UserMessage {
  return {
    id,
    sessionID: "ses_1",
    role: "user",
    time: { created },
    agent: "build",
    model: { providerID: "deepseek", modelID: "deepseek-reasoner" },
    ...over,
  }
}

function assistantMsg(id: string, parentID: string, over: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id,
    sessionID: "ses_1",
    role: "assistant",
    time: { created: 10, completed: 20 },
    parentID,
    modelID: "deepseek-reasoner",
    providerID: "deepseek",
    mode: "build",
    agent: "build",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...over,
  }
}

function textPart(id: string, messageID: string, text: string, over: Partial<TextPart> = {}): TextPart {
  return { id, sessionID: "ses_1", messageID, type: "text", text, ...over }
}

function reasoningPart(id: string, messageID: string, text: string, over: Partial<ReasoningPart> = {}): ReasoningPart {
  return { id, sessionID: "ses_1", messageID, type: "reasoning", text, time: { start: 0, end: 6000 }, ...over }
}

function toolPart(id: string, messageID: string, tool: string, over: Partial<ToolPart> = {}): ToolPart {
  return {
    id,
    sessionID: "ses_1",
    messageID,
    type: "tool",
    callID: `call_${id}`,
    tool,
    state: { status: "completed", input: {}, output: "", title: tool, metadata: {}, time: { start: 0, end: 1 } },
    ...over,
  }
}

function filePart(id: string, messageID: string, over: Partial<FilePart> = {}): FilePart {
  return {
    id,
    sessionID: "ses_1",
    messageID,
    type: "file",
    mime: "image/png",
    filename: "screenshot.png",
    url: "data:image/png;base64,xxxx",
    ...over,
  }
}

function project(messages: Message[], parts: Record<string, Part[]>, status = "idle") {
  return projectTimelineRows({ messages, partsOf: (id) => parts[id] ?? [], status })
}

describe("REQ-125 C5 行模型投影:消息 → 行", () => {
  test("完整回合投影为 用户气泡 → 推理块 → Markdown → 工具占位行,首回合无分隔", () => {
    const rows = project(
      [userMsg("msg_u1", 1000), assistantMsg("msg_a1", "msg_u1")],
      {
        msg_u1: [textPart("prt_u1", "msg_u1", "检查仓库结构")],
        msg_a1: [
          reasoningPart("prt_r1", "msg_a1", "先列目录看结构"),
          textPart("prt_t1", "msg_a1", "**发现**:结构完好"),
          toolPart("prt_o1", "msg_a1", "bash"),
        ],
      },
    )

    expect(rows.map((row) => row.kind)).toEqual(["user", "reasoning", "markdown", "placeholder"])
    expect(rows.map((row) => row.key)).toEqual(["user:msg_u1", "reason:prt_r1", "md:prt_t1", "part:prt_o1"])
    const placeholder = rows[3]!
    expect(placeholder.kind === "placeholder" && placeholder.tool).toBe("bash")
  })

  test("第二回合前插入带时间戳的回合分隔", () => {
    const rows = project(
      [userMsg("msg_u1", 1000), userMsg("msg_u2", 2000)],
      {
        msg_u1: [textPart("prt_u1", "msg_u1", "第一问")],
        msg_u2: [textPart("prt_u2", "msg_u2", "第二问")],
      },
    )

    expect(rows.map((row) => row.kind)).toEqual(["user", "turn", "user"])
    const turn = rows[1]!
    expect(turn.kind === "turn" && turn.createdAt).toBe(2000)
  })

  test("提及分段:file/agent part 的 source 区间切出高亮片段", () => {
    const text = "对照 README.md 核对,交给 @build 处理"
    const fileStart = text.indexOf("README.md")
    const agentStart = text.indexOf("@build")
    const rows = project([userMsg("msg_u1", 1000)], {
      msg_u1: [
        textPart("prt_u1", "msg_u1", text),
        filePart("prt_f1", "msg_u1", {
          url: "file:///tmp/README.md",
          source: {
            type: "file",
            path: "README.md",
            text: { value: "README.md", start: fileStart, end: fileStart + "README.md".length },
          },
        }),
        {
          id: "prt_g1",
          sessionID: "ses_1",
          messageID: "msg_u1",
          type: "agent",
          name: "build",
          source: { value: "@build", start: agentStart, end: agentStart + "@build".length },
        },
      ],
    })

    const user = rows[0]!
    if (user.kind !== "user") throw new Error("expected user row")
    expect(user.segments.map((segment) => [segment.kind ?? "text", segment.text])).toEqual([
      ["text", "对照 "],
      ["file", "README.md"],
      ["text", " 核对,交给 "],
      ["agent", "@build"],
      ["text", " 处理"],
    ])
  })

  test("附件卡:仅 data: URL 的 file part 成卡;内联引用不算附件", () => {
    const rows = project([userMsg("msg_u1", 1000)], {
      msg_u1: [
        textPart("prt_u1", "msg_u1", "看下这两个文件"),
        filePart("prt_f1", "msg_u1"),
        filePart("prt_f2", "msg_u1", { mime: "text/plain", filename: "notes.md", url: "data:text/plain;base64,eA==" }),
        filePart("prt_f3", "msg_u1", {
          url: "file:///tmp/README.md",
          source: { type: "file", path: "README.md", text: { value: "x", start: 0, end: 1 } },
        }),
      ],
    })

    const user = rows[0]!
    if (user.kind !== "user") throw new Error("expected user row")
    expect(user.attachments.map((attachment) => [attachment.name, attachment.media, attachment.label])).toEqual([
      ["screenshot.png", "image", "PNG"],
      ["notes.md", "file", "MD"],
    ])
  })

  test("内联评论卡:synthetic 评论 part 不进气泡文本,metadata 与字面 note 两种载体都解析", () => {
    const metaComment = textPart("prt_c1", "msg_u1", "ignored", {
      synthetic: true,
      metadata: {
        opencodeComment: { path: "button.css", comment: "焦点环别再隐藏", selection: { startLine: 42, endLine: 42 } },
      },
    })
    const noteComment = textPart(
      "prt_c2",
      "msg_u1",
      "The user made the following comment regarding lines 3 through 9 of app.tsx: 这段抽出去",
      { synthetic: true },
    )
    const rows = project([userMsg("msg_u1", 1000)], {
      msg_u1: [metaComment, noteComment, textPart("prt_u1", "msg_u1", "按评论改")],
    })

    const user = rows[0]!
    if (user.kind !== "user") throw new Error("expected user row")
    expect(user.text).toBe("按评论改")
    expect(user.comments).toEqual([
      { partID: "prt_c1", path: "button.css", comment: "焦点环别再隐藏", startLine: 42, endLine: 42 },
      { partID: "prt_c2", path: "app.tsx", comment: "这段抽出去", startLine: 3, endLine: 9 },
    ])
    expect(commentOf(textPart("prt_x", "msg_u1", "普通文本"))).toBeUndefined()
  })

  test("流式:busy + 未完成回复 → 末段文本 streaming,推理块未收尾 streaming", () => {
    const streamingReason = reasoningPart("prt_r1", "msg_a1", "推理中", { time: { start: 0 } })
    const rows = project(
      [userMsg("msg_u1", 1000), assistantMsg("msg_a1", "msg_u1", { time: { created: 10 } })],
      {
        msg_u1: [textPart("prt_u1", "msg_u1", "开始")],
        msg_a1: [streamingReason, textPart("prt_t1", "msg_a1", "正在生成的回答")],
      },
      "busy",
    )

    const reasoning = rows[1]!
    const markdown = rows[2]!
    expect(reasoning.kind === "reasoning" && reasoning.streaming).toBe(true)
    expect(markdown.kind === "markdown" && markdown.streaming).toBe(true)

    const idleRows = project(
      [userMsg("msg_u1", 1000), assistantMsg("msg_a1", "msg_u1")],
      { msg_u1: [textPart("prt_u1", "msg_u1", "开始")], msg_a1: [textPart("prt_t1", "msg_a1", "完成的回答")] },
      "idle",
    )
    const settled = idleRows[1]!
    expect(settled.kind === "markdown" && settled.streaming).toBe(false)
  })

  test("思考中:busy + 活跃回合无可见输出 → thinking 行;有输出即不再出现", () => {
    const thinking = project(
      [userMsg("msg_u1", 1000)],
      { msg_u1: [textPart("prt_u1", "msg_u1", "开始")] },
      "busy",
    )
    expect(thinking.map((row) => row.kind)).toEqual(["user", "thinking"])

    const withOutput = project(
      [userMsg("msg_u1", 1000), assistantMsg("msg_a1", "msg_u1", { time: { created: 10 } })],
      { msg_u1: [textPart("prt_u1", "msg_u1", "开始")], msg_a1: [textPart("prt_t1", "msg_a1", "输出")] },
      "busy",
    )
    expect(withOutput.some((row) => row.kind === "thinking")).toBe(false)

    const idle = project([userMsg("msg_u1", 1000)], { msg_u1: [textPart("prt_u1", "msg_u1", "开始")] }, "idle")
    expect(idle.some((row) => row.kind === "thinking")).toBe(false)
  })

  test("工具过滤:todowrite 与 pending/running question 不渲染;未知 part 类型 fail-closed 跳过", () => {
    const rows = project(
      [userMsg("msg_u1", 1000), assistantMsg("msg_a1", "msg_u1")],
      {
        msg_u1: [textPart("prt_u1", "msg_u1", "开始")],
        msg_a1: [
          toolPart("prt_o1", "msg_a1", "todowrite"),
          toolPart("prt_o2", "msg_a1", "question", {
            state: { status: "running", input: {}, title: "q", time: { start: 0 } },
          }),
          toolPart("prt_o3", "msg_a1", "question"),
          { id: "prt_o4", sessionID: "ses_1", messageID: "msg_a1", type: "mystery" } as unknown as Part,
        ],
      },
    )

    expect(rows.filter((row) => row.kind === "placeholder").map((row) => row.key)).toEqual(["part:prt_o3"])
  })

  test("压缩与中断投影为对应分隔行", () => {
    const rows = project(
      [userMsg("msg_u1", 1000), assistantMsg("msg_a1", "msg_u1", { error: { name: "MessageAbortedError", data: { message: "" } } })],
      {
        msg_u1: [
          textPart("prt_u1", "msg_u1", "开始"),
          { id: "prt_k1", sessionID: "ses_1", messageID: "msg_u1", type: "compaction", auto: false },
        ],
        msg_a1: [textPart("prt_t1", "msg_a1", "被打断的回答")],
      },
    )

    expect(rows.map((row) => row.kind)).toEqual(["user", "divider", "markdown", "divider"])
    const labels = rows.flatMap((row) => (row.kind === "divider" ? [row.label] : []))
    expect(labels).toEqual(["compaction", "interrupted"])
  })

  test("空会话投影为空行集(空态由视图渲染)", () => {
    expect(project([], {})).toEqual([])
  })

  test("I7 有界:超长用户文本截断并保留标记;分段以截断后文本为准", () => {
    const long = "字".repeat(USER_TEXT_MAX_CHARS + 100)
    const rows = project([userMsg("msg_u1", 1000)], { msg_u1: [textPart("prt_u1", "msg_u1", long)] })
    const user = rows[0]!
    if (user.kind !== "user") throw new Error("expected user row")
    expect(user.truncated).toBe(true)
    expect(user.text.length).toBe(USER_TEXT_MAX_CHARS)

    expect(boundedText("a".repeat(MARKDOWN_MAX_CHARS + 1), MARKDOWN_MAX_CHARS)).toMatchObject({ truncated: true })
    expect(boundedText("ok", MARKDOWN_MAX_CHARS)).toEqual({ text: "ok", truncated: false })

    // 越界/重叠的提及区间被忽略(fail-closed),不切碎文本。
    expect(
      segmentUserText("短文本", [
        { start: 1, end: 99, kind: "file" },
        { start: -1, end: 2, kind: "agent" },
      ]),
    ).toEqual([{ text: "短文本" }])
  })
})

describe("REQ-125 C5 行复用:流式 delta 不重建行", () => {
  const messages = [userMsg("msg_u1", 1000), assistantMsg("msg_a1", "msg_u1", { time: { created: 10 } })]
  const streamingText = textPart("prt_t1", "msg_a1", "第一段")
  const parts: Record<string, Part[]> = {
    msg_u1: [textPart("prt_u1", "msg_u1", "开始")],
    msg_a1: [streamingText],
  }

  test("同一数据两次投影经 reuse 后返回同一数组引用", () => {
    const first = project(messages, parts, "busy")
    const second = reuseTimelineRows(first, project(messages, parts, "busy"))
    expect(second).toBe(first)
  })

  test("文本增量(同 part 对象)保留行引用;流式收尾才重建该行", () => {
    const first = reuseTimelineRows(undefined, project(messages, parts, "busy"))
    streamingText.text = "第一段第二段"
    const second = reuseTimelineRows(first, project(messages, parts, "busy"))
    expect(second[1]).toBe(first[1]!)

    const done = reuseTimelineRows(second, project(messages, parts, "idle"))
    expect(done[1]).not.toBe(second[1]!)
    const row = done[1]!
    expect(row.kind === "markdown" && row.streaming).toBe(false)
  })

  test("part 引用被整体替换时不复用旧行(防 stale proxy)", () => {
    const first = reuseTimelineRows(undefined, project(messages, parts, "busy"))
    const replaced: Record<string, Part[]> = {
      ...parts,
      msg_a1: [textPart("prt_t1", "msg_a1", "第一段第二段")],
    }
    const second = reuseTimelineRows(first, project(messages, replaced, "busy"))
    expect(second[1]).not.toBe(first[1]!)
  })
})
