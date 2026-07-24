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
  artifactLinksOf,
  boundedText,
  commentOf,
  MARKDOWN_MAX_CHARS,
  projectTimelineRows,
  reuseTimelineRows,
  segmentUserText,
  turnErrorOf,
  TURN_ERROR_MAX_CHARS,
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

function project(
  messages: Message[],
  parts: Record<string, Part[]>,
  status = "idle",
  retry?: { attempt: number; message: string },
) {
  return projectTimelineRows({ messages, partsOf: (id) => parts[id] ?? [], status, retry })
}

describe("REQ-125 C5 行模型投影:消息 → 行", () => {
  test("完整回合投影为 用户气泡 → 推理块 → Markdown → 工具卡行,首回合无分隔", () => {
    const rows = project([userMsg("msg_u1", 1000), assistantMsg("msg_a1", "msg_u1")], {
      msg_u1: [textPart("prt_u1", "msg_u1", "检查仓库结构")],
      msg_a1: [
        reasoningPart("prt_r1", "msg_a1", "先列目录看结构"),
        textPart("prt_t1", "msg_a1", "**发现**:结构完好"),
        toolPart("prt_o1", "msg_a1", "bash"),
      ],
    })

    expect(rows.map((row) => row.kind)).toEqual(["user", "reasoning", "markdown", "tool"])
    expect(rows.map((row) => row.key)).toEqual(["user:msg_u1", "reason:prt_r1", "md:prt_t1", "part:prt_o1"])
    const tool = rows[3]!
    expect(tool.kind === "tool" && tool.tool).toBe("bash")
  })

  test("第二回合前插入带时间戳的回合分隔", () => {
    const rows = project([userMsg("msg_u1", 1000), userMsg("msg_u2", 2000)], {
      msg_u1: [textPart("prt_u1", "msg_u1", "第一问")],
      msg_u2: [textPart("prt_u2", "msg_u2", "第二问")],
    })

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
    const thinking = project([userMsg("msg_u1", 1000)], { msg_u1: [textPart("prt_u1", "msg_u1", "开始")] }, "busy")
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
    const rows = project([userMsg("msg_u1", 1000), assistantMsg("msg_a1", "msg_u1")], {
      msg_u1: [textPart("prt_u1", "msg_u1", "开始")],
      msg_a1: [
        toolPart("prt_o1", "msg_a1", "todowrite"),
        toolPart("prt_o2", "msg_a1", "question", {
          state: { status: "running", input: {}, title: "q", time: { start: 0 } },
        }),
        toolPart("prt_o3", "msg_a1", "question"),
        { id: "prt_o4", sessionID: "ses_1", messageID: "msg_a1", type: "mystery" } as unknown as Part,
        {
          id: "prt_o5",
          sessionID: "ses_1",
          messageID: "msg_a1",
          type: "subtask",
          prompt: "p",
          description: "d",
          agent: "general",
        } as Part,
      ],
    })

    expect(rows.filter((row) => row.kind === "tool").map((row) => row.key)).toEqual(["part:prt_o3"])
    // subtask part 与上游 v1/v2 一致:无视觉合同,不渲染。
    expect(rows.some((row) => "key" in row && row.key.includes("prt_o5"))).toBe(false)
  })

  test("折叠组:连续 ≥2 个已完成探查工具成组;运行中/穿插非探查工具打断分组", () => {
    const rows = project([userMsg("msg_u1", 1000), assistantMsg("msg_a1", "msg_u1")], {
      msg_u1: [textPart("prt_u1", "msg_u1", "开始")],
      msg_a1: [
        toolPart("prt_g1", "msg_a1", "read"),
        toolPart("prt_g2", "msg_a1", "grep"),
        toolPart("prt_g3", "msg_a1", "list"),
        toolPart("prt_x1", "msg_a1", "bash"),
        toolPart("prt_g4", "msg_a1", "glob"),
        toolPart("prt_g5", "msg_a1", "read", {
          state: { status: "running", input: {}, title: "read", time: { start: 0 } },
        }),
      ],
    })

    expect(rows.map((row) => row.kind)).toEqual(["user", "toolgroup", "tool", "tool", "tool"])
    const group = rows[1]!
    if (group.kind !== "toolgroup") throw new Error("expected toolgroup row")
    expect(group.key).toBe("group:prt_g1")
    expect(group.parts.map((part) => part.id)).toEqual(["prt_g1", "prt_g2", "prt_g3"])
    // 单个已完成探查工具(glob)不成组;运行中的 read 保留独立卡。
    expect(rows.slice(2).map((row) => (row.kind === "tool" ? row.part.id : ""))).toEqual(["prt_x1", "prt_g4", "prt_g5"])
  })

  test("媒体行:助手侧 file part 投影为 media 行", () => {
    const rows = project([userMsg("msg_u1", 1000), assistantMsg("msg_a1", "msg_u1")], {
      msg_u1: [textPart("prt_u1", "msg_u1", "截个图")],
      msg_a1: [filePart("prt_f1", "msg_a1")],
    })
    expect(rows.map((row) => row.kind)).toEqual(["user", "media"])
  })

  test("产物链接行:完成态 cloud_* 工具输出解析出 artifacts 名单才出行(fail-closed)", () => {
    const output = JSON.stringify({
      job_id: "job_1",
      status: "completed",
      artifacts: [{ name: "季度分析.docx" }, "营收对比.png", { bogus: true }],
    })
    const cloudDone = toolPart("prt_c1", "msg_a1", "cloud_await", {
      state: { status: "completed", input: {}, output, title: "await", metadata: {}, time: { start: 0, end: 1 } },
    })
    const rows = project([userMsg("msg_u1", 1000), assistantMsg("msg_a1", "msg_u1")], {
      msg_u1: [textPart("prt_u1", "msg_u1", "跑云任务")],
      msg_a1: [cloudDone],
    })
    expect(rows.map((row) => row.kind)).toEqual(["user", "tool", "artifacts"])
    const artifacts = rows[2]!
    if (artifacts.kind !== "artifacts") throw new Error("expected artifacts row")
    expect(artifacts.links).toEqual([
      { runId: "job_1", name: "季度分析.docx" },
      { runId: "job_1", name: "营收对比.png" },
    ])

    // fail-closed 枚举:非 cloud 工具 / 非 completed run / 无 artifacts / 解析失败 → 无链接。
    expect(artifactLinksOf(toolPart("prt_c2", "msg_a1", "bash"))).toEqual([])
    expect(
      artifactLinksOf(
        toolPart("prt_c3", "msg_a1", "cloud_await", {
          state: {
            status: "completed",
            input: {},
            output: JSON.stringify({ job_id: "job_2", status: "running", artifacts: ["x"] }),
            title: "await",
            metadata: {},
            time: { start: 0, end: 1 },
          },
        }),
      ),
    ).toEqual([])
    expect(
      artifactLinksOf(
        toolPart("prt_c4", "msg_a1", "cloud_await", {
          state: {
            status: "completed",
            input: {},
            output: "not-json",
            title: "await",
            metadata: {},
            time: { start: 0, end: 1 },
          },
        }),
      ),
    ).toEqual([])
  })

  test("回合级错误:非中断错误在回合末投影 turnError 行(有界),中断只出分隔", () => {
    const failed = assistantMsg("msg_a1", "msg_u1", {
      error: {
        name: "ApiError",
        data: { message: "x".repeat(TURN_ERROR_MAX_CHARS + 50) },
      } as AssistantMessage["error"],
    })
    const rows = project([userMsg("msg_u1", 1000), failed], {
      msg_u1: [textPart("prt_u1", "msg_u1", "开始")],
      msg_a1: [textPart("prt_t1", "msg_a1", "半截回答")],
    })
    const last = rows.at(-1)!
    if (last.kind !== "turnError") throw new Error("expected turnError row")
    expect(last.name).toBe("ApiError")
    expect(last.message.length).toBe(TURN_ERROR_MAX_CHARS)

    expect(
      turnErrorOf([
        assistantMsg("msg_a2", "msg_u1", { error: { name: "MessageAbortedError", data: { message: "" } } }),
      ]),
    ).toBeUndefined()
  })

  test("重试:status=retry 且活跃回合 → retry 行(attempt + 有界 message)", () => {
    const rows = project([userMsg("msg_u1", 1000)], { msg_u1: [textPart("prt_u1", "msg_u1", "开始")] }, "retry", {
      attempt: 2,
      message: "gateway 429",
    })
    const last = rows.at(-1)!
    if (last.kind !== "retry") throw new Error("expected retry row")
    expect(last.attempt).toBe(2)
    expect(last.message).toBe("gateway 429")

    const idle = project([userMsg("msg_u1", 1000)], { msg_u1: [textPart("prt_u1", "msg_u1", "开始")] }, "idle")
    expect(idle.some((row) => row.kind === "retry")).toBe(false)
  })

  test("压缩与中断投影为对应分隔行", () => {
    const rows = project(
      [
        userMsg("msg_u1", 1000),
        assistantMsg("msg_a1", "msg_u1", { error: { name: "MessageAbortedError", data: { message: "" } } }),
      ],
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
