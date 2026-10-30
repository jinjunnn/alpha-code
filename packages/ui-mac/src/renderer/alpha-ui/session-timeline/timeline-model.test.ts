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
  cloudImageOf,
  cloudImageViewOf,
  commentOf,
  footnoteOf,
  formatTurnElapsed,
  MARKDOWN_MAX_CHARS,
  MENTION_LABEL_MAX_CHARS,
  projectTimelineRows,
  REASONING_MAX_CHARS,
  REASONING_SUMMARY_MAX_CHARS,
  reasoningSummary,
  reuseTimelineRows,
  RETRY_MESSAGE_MAX_CHARS,
  reviewPathOf,
  segmentUserText,
  type TimelineRow,
  SLASH_ARGUMENTS_MAX_CHARS,
  SLASH_COMMAND_MAX_CHARS,
  slashOriginForTurn,
  TURN_DIFF_FILES_MAX,
  turnDiffsOf,
  turnErrorOf,
  TURN_ERROR_MAX_CHARS,
  USER_TEXT_MAX_CHARS,
} from "./timeline-model"
import { PROJECT_HIDDEN_DIR } from "../../../shared/project-hidden-dir"

describe("#863 reasoning 折叠头安全摘要", () => {
  test("只提取显式标题并清理展示标记；普通正文不猜摘要", () => {
    expect(reasoningSummary("## 规划 `README` 探查顺序\n\n先列目录")).toBe("规划 README 探查顺序")
    expect(reasoningSummary("<h3>核对 <em>配置</em></h3>\n正文")).toBe("核对 配置")
    expect(reasoningSummary("**归纳 [风险](https://example.com)**\n\n正文")).toBe("归纳 风险")
    expect(reasoningSummary("先列目录看结构,再读 README 抓事实。")).toBeUndefined()
  })

  test("不从普通正文中段回溯 Markdown 标记，也不把有歧义的 setext 形态当摘要", () => {
    expect(reasoningSummary("先核对认证流。\n**用户 API key 是 sk-live-example**\n再轮换密钥。")).toBeUndefined()
    expect(reasoningSummary("先重新考虑计划。\n\n# 内部步骤 4\n继续正文")).toBeUndefined()
    expect(reasoningSummary("客户记录里有敏感字段。\n---\n继续正文")).toBeUndefined()
  })

  test("标题在进入常显折叠头前有硬上限", () => {
    expect(reasoningSummary(`# ${"摘".repeat(REASONING_SUMMARY_MAX_CHARS + 20)}`)).toHaveLength(
      REASONING_SUMMARY_MAX_CHARS,
    )
    expect(reasoningSummary(`${"内".repeat(REASONING_MAX_CHARS)}\n# 预算外标题`)).toBeUndefined()
  })
})

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

/** 有效的宿主内建 display 快照(identity 分派闸的正向输入;#587 媒体行同闸)。 */
function builtinDisplay(name: string) {
  return { identity: { source: "builtin", origin: "", name }, technicalId: name, authority: { kind: "not-asserted" } }
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

/** `#1473`:工具调用住在 process 行的步骤里。 */
function processOf(rows: readonly TimelineRow[]) {
  const row = rows.find((candidate) => candidate.kind === "process")
  if (!row || row.kind !== "process") throw new Error("expected process row")
  return row
}

function toolStepsOf(rows: readonly TimelineRow[]) {
  return rows.flatMap((row) =>
    row.kind === "process" ? row.steps.flatMap((step) => (step.kind === "tool" ? [step] : [])) : [],
  )
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
  test("完整回合投影为 用户气泡 → 工作过程 → 回答(最后一段过渡话提为回答),首回合无分隔", () => {
    const rows = project([userMsg("msg_u1", 1000), assistantMsg("msg_a1", "msg_u1")], {
      msg_u1: [textPart("prt_u1", "msg_u1", "检查仓库结构")],
      msg_a1: [
        reasoningPart("prt_r1", "msg_a1", "先列目录看结构"),
        textPart("prt_t1", "msg_a1", "**发现**:结构完好"),
        toolPart("prt_o1", "msg_a1", "bash"),
      ],
    })

    expect(rows.map((row) => row.kind)).toEqual(["user", "process", "markdown", "footnote"])
    expect(rows.map((row) => row.key)).toEqual(["user:msg_u1", "process:msg_u1", "md:prt_t1", "footnote:msg_u1"])
    const process = processOf(rows)
    expect(process.steps.map((step) => step.kind)).toEqual(["reasoning", "tool"])
    expect(toolStepsOf(rows)[0]!.parts[0]!.tool).toBe("bash")
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

  // #620:分隔行原来在气泡之前**无条件** push,于是 synthetic 续写(「继续生成」发出的那条)
  // 会留下一条孤零零的「新回合」。分隔行现在跟着气泡走;续写的助手输出照常渲染。
  test("回合里只有 synthetic 输入时:既无用户气泡,也不留分隔行,助手续写照常出行", () => {
    const rows = project(
      [
        userMsg("msg_u1", 3000),
        assistantMsg("msg_a1", "msg_u1"),
        userMsg("msg_u2", 4000),
        assistantMsg("msg_a2", "msg_u2"),
      ],
      {
        msg_u1: [textPart("prt_u1", "msg_u1", "把配置抽成常量")],
        msg_a1: [textPart("prt_t1", "msg_a1", "抽好了前一半")],
        msg_u2: [textPart("prt_u2", "msg_u2", "接着写", { synthetic: true })],
        msg_a2: [textPart("prt_t2", "msg_a2", "后一半也抽完了")],
      },
    )

    expect(rows.map((row) => row.kind)).toEqual(["user", "markdown", "footnote", "markdown", "footnote"])
    expect(rows.some((row) => row.kind === "turn")).toBe(false)
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

    const reasoning = processOf(rows).steps[0]!
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

  // `#1399` 回合脚行的核心判断(一轮在跑时,时间线里要有一个从头到尾都在的元素)由 `#1474` 的工作过程继承:
  // 脚行并入工作过程的实时标题,工作过程在回合开始即出现、与回合同寿命。五个子状态里它都在,且
  // 自动重试不再另挂一张卡(重试写进同一个标题)。
  test("#1474 工作过程与回合同寿命:首个 part 未到 / 正文流式 / 推理中 / 工具执行中 / 自动重试,行都在", () => {
    const user = userMsg("msg_u1", 1000)
    const userParts = { msg_u1: [textPart("prt_u1", "msg_u1", "开始")] }
    const streaming = assistantMsg("msg_a1", "msg_u1", { time: { created: 1010 } })

    const first = project([user], userParts, "busy")
    expect(first.map((row) => row.kind)).toEqual(["user", "process"])
    expect(first[1]).toMatchObject({
      kind: "process",
      key: "process:msg_u1",
      userMessageID: "msg_u1",
      steps: [],
      active: true,
      startedAt: 1000,
      answering: false,
    })
    expect("retry" in first[1]!).toBe(false)

    // 纯文字回答:工作过程在回答之前,回答一开始输出就标 answering(视图据此收成一行)。
    const text = project([user, streaming], { ...userParts, msg_a1: [textPart("prt_t1", "msg_a1", "输出")] }, "busy")
    expect(text.map((row) => row.kind)).toEqual(["user", "process", "markdown"])
    expect(text[1]).toMatchObject({ kind: "process", active: true, answering: true })

    const reasoning = project(
      [user, streaming],
      { ...userParts, msg_a1: [reasoningPart("prt_r1", "msg_a1", "先想想", { time: { start: 0 } })] },
      "busy",
    )
    expect(reasoning.map((row) => row.kind)).toEqual(["user", "process"])
    expect(reasoning[1]).toMatchObject({ answering: false })

    const tool = project(
      [user, streaming],
      {
        ...userParts,
        msg_a1: [
          toolPart("prt_o1", "msg_a1", "bash", {
            state: { status: "running", input: {}, title: "bash", time: { start: 0 } },
          }),
        ],
      },
      "busy",
    )
    expect(tool.map((row) => row.kind)).toEqual(["user", "process"])

    const retry = project([user, streaming], { ...userParts, msg_a1: [textPart("prt_t1", "msg_a1", "输出")] }, "retry", {
      attempt: 2,
      message: "限流",
    })
    expect(retry.map((row) => row.kind)).toEqual(["user", "process", "markdown"])
    expect(retry[1]).toMatchObject({ kind: "process", active: true, retry: { attempt: 2, message: "限流" } })
    // 对照臂:旧的回合脚行与重试行类型在任何活跃子状态里都不再出现。
    for (const rows of [first, text, reasoning, tool, retry])
      expect(rows.some((row) => ["turnfoot", "retry", "thinking"].includes(row.kind as string))).toBe(false)
  })

  test("#1474 回合进行中:工具之前的文字是过渡话,不被提为回答(否则工具还在跑时工作过程就被误判为回答已开始)", () => {
    const user = userMsg("msg_u1", 1000)
    const parts = {
      msg_u1: [textPart("prt_u1", "msg_u1", "开始")],
      msg_a1: [
        textPart("prt_s1", "msg_a1", "我先搜一下"),
        toolPart("prt_o1", "msg_a1", "bash", {
          state: { status: "running", input: {}, title: "bash", time: { start: 0 } },
        }),
      ],
    }
    const live = project([user, assistantMsg("msg_a1", "msg_u1", { time: { created: 1010 } })], parts, "busy")
    expect(live.map((row) => row.kind)).toEqual(["user", "process"])
    const process = live[1]!
    if (process.kind !== "process") throw new Error("expected process")
    expect(process.answering).toBe(false)
    expect(process.steps.map((step) => step.kind)).toEqual(["say", "tool"])

    // 回答开始输出(最后一次工具之后有文字)⇒ answering;之后又调工具 ⇒ 那段文字改判为过渡话、answering 回落。
    const done = toolPart("prt_o1", "msg_a1", "bash")
    const answered = project(
      [user, assistantMsg("msg_a1", "msg_u1", { time: { created: 1010 } })],
      { ...parts, msg_a1: [done, textPart("prt_a1", "msg_a1", "结论")] },
      "busy",
    )
    expect(answered.map((row) => row.kind)).toEqual(["user", "process", "markdown"])
    expect(answered[1]).toMatchObject({ answering: true })
    const again = project(
      [user, assistantMsg("msg_a1", "msg_u1", { time: { created: 1010 } })],
      {
        ...parts,
        msg_a1: [
          done,
          textPart("prt_a1", "msg_a1", "结论"),
          toolPart("prt_o2", "msg_a1", "bash", {
            state: { status: "running", input: {}, title: "bash", time: { start: 0 } },
          }),
        ],
      },
      "busy",
    )
    expect(again.map((row) => row.kind)).toEqual(["user", "process"])
    expect(again[1]).toMatchObject({ answering: false })
    const moved = again[1]!
    if (moved.kind !== "process") throw new Error("expected process")
    expect(moved.steps.map((step) => (step.kind === "say" ? `say:${step.part.id}` : step.kind))).toEqual([
      "tool",
      "say:prt_a1",
      "tool",
    ])

    // 结束态照旧:最后一次工具之后没有文字,最后一段过渡话被提为回答。
    const settled = project(
      [user, assistantMsg("msg_a1", "msg_u1")],
      { ...parts, msg_a1: [textPart("prt_s1", "msg_a1", "我先搜一下"), toolPart("prt_o1", "msg_a1", "bash")] },
      "idle",
    )
    expect(settled.map((row) => row.kind)).toEqual(["user", "process", "markdown", "footnote"])
  })

  test("#1474 工作过程只在活跃回合里无条件出现:上一回合已完成且没有步骤时不出", () => {
    const rows = project(
      [userMsg("msg_u1", 1000), assistantMsg("msg_a1", "msg_u1"), userMsg("msg_u2", 2000)],
      {
        msg_u1: [textPart("prt_u1", "msg_u1", "第一句")],
        msg_a1: [textPart("prt_t1", "msg_a1", "回答")],
        msg_u2: [textPart("prt_u2", "msg_u2", "第二句")],
      },
      "busy",
    )
    expect(rows.map((row) => row.kind)).toEqual(["user", "markdown", "footnote", "turn", "user", "process"])
  })

  test("#1399/#1474 结局同帧让位:完成 → 脚注;中止 → 中断行;出错 → 错误卡;零正文 → 空回合行 —— 都不再有实时工作过程", () => {
    const user = userMsg("msg_u1", 1000)
    const userParts = { msg_u1: [textPart("prt_u1", "msg_u1", "开始")] }

    const done = project(
      [user, assistantMsg("msg_a1", "msg_u1")],
      { ...userParts, msg_a1: [textPart("prt_t1", "msg_a1", "回答")] },
      "idle",
    )
    expect(done.map((row) => row.kind)).toEqual(["user", "markdown", "footnote"])

    const aborted = project(
      [user, assistantMsg("msg_a1", "msg_u1", { error: { name: "MessageAbortedError", data: { message: "" } } })],
      { ...userParts, msg_a1: [textPart("prt_t1", "msg_a1", "写到一半")] },
      "idle",
    )
    expect(aborted.map((row) => row.kind)).toEqual(["user", "markdown", "divider"])
    expect(aborted[2]).toMatchObject({ kind: "divider", label: "interrupted" })

    const failed = project(
      [user, assistantMsg("msg_a1", "msg_u1", { error: { name: "APIError", data: { message: "rate_limit_exceeded" } } })],
      userParts,
      "idle",
    )
    expect(failed.map((row) => row.kind)).toEqual(["user", "turnError"])

    const empty = project([user, assistantMsg("msg_a1", "msg_u1", { finish: "unknown" } as never)], userParts, "idle")
    expect(empty.map((row) => row.kind)).toEqual(["user", "divider"])
    expect(empty[1]).toMatchObject({ kind: "divider", label: "emptyTurn" })

    // 对照臂:旧「正在思考」胶囊的行类型不再存在于任何结局里。
    for (const rows of [done, aborted, failed, empty])
      expect(rows.some((row) => (row.kind as string) === "thinking")).toBe(false)
  })

  test("工具过滤:builtin identity 的 todowrite 与 pending/running question 不渲染;未知 part 类型 fail-closed 跳过", () => {
    const rows = project([userMsg("msg_u1", 1000), assistantMsg("msg_a1", "msg_u1")], {
      msg_u1: [textPart("prt_u1", "msg_u1", "开始")],
      msg_a1: [
        // #934:隐藏是第一方特权,夹具须带 builtin 快照(与真实 builtin 调用同形状)。
        toolPart("prt_o1", "msg_a1", "todowrite", { display: builtinDisplay("todowrite") }),
        toolPart("prt_o2", "msg_a1", "question", {
          display: builtinDisplay("question"),
          state: { status: "running", input: {}, title: "q", time: { start: 0 } },
        }),
        toolPart("prt_o3", "msg_a1", "question", { display: builtinDisplay("question") }),
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

    expect(toolStepsOf(rows).flatMap((step) => step.parts.map((part) => part.id))).toEqual(["prt_o3"])
    // subtask part 与上游 v1/v2 一致:无视觉合同,不渲染。
    expect(rows.some((row) => "key" in row && row.key.includes("prt_o5"))).toBe(false)
  })

  test("合并:连续、同类、都已结束的工具合成一步;换类 / 运行中都切断,运行中的步骤永不合并", () => {
    const running = { status: "running", input: {}, title: "read", time: { start: 0 } } as ToolPart["state"]
    const rows = project([userMsg("msg_u1", 1000), assistantMsg("msg_a1", "msg_u1")], {
      msg_u1: [textPart("prt_u1", "msg_u1", "开始")],
      msg_a1: [
        // #934:合并归属按 identity 分派,夹具带 builtin 快照(与真实调用同形状)。
        toolPart("prt_g1", "msg_a1", "read", { display: builtinDisplay("read") }),
        toolPart("prt_g2", "msg_a1", "read", { display: builtinDisplay("read") }),
        toolPart("prt_g3", "msg_a1", "grep", { display: builtinDisplay("grep") }),
        toolPart("prt_g4", "msg_a1", "grep", { display: builtinDisplay("grep") }),
        toolPart("prt_x1", "msg_a1", "bash", { display: builtinDisplay("bash") }),
        toolPart("prt_g5", "msg_a1", "read", { display: builtinDisplay("read"), state: running }),
        toolPart("prt_g6", "msg_a1", "read", { display: builtinDisplay("read"), state: running }),
        toolPart("prt_g7", "msg_a1", "read", { display: builtinDisplay("read") }),
      ],
    })

    expect(rows.map((row) => row.kind)).toEqual(["user", "process", "footnote"])
    expect(toolStepsOf(rows).map((step) => step.parts.map((part) => part.id))).toEqual([
      ["prt_g1", "prt_g2"],
      ["prt_g3", "prt_g4"],
      ["prt_x1"],
      ["prt_g5"],
      ["prt_g6"],
      ["prt_g7"],
    ])
    expect(toolStepsOf(rows)[0]!.key).toBe("tool:prt_g1")
  })

  test("媒体行:助手侧 file part 投影为 media 行(快照含名字/mime/url)", () => {
    const rows = project([userMsg("msg_u1", 1000), assistantMsg("msg_a1", "msg_u1")], {
      msg_u1: [textPart("prt_u1", "msg_u1", "截个图")],
      msg_a1: [filePart("prt_f1", "msg_a1")],
    })
    expect(rows.map((row) => row.kind)).toEqual(["user", "media", "footnote"])
    const media = rows[1]!
    if (media.kind !== "media") throw new Error("expected media row")
    expect(media.media).toMatchObject({ partID: "prt_f1", name: "screenshot.png", mime: "image/png" })
  })

  test("媒体行(生产通道):完成态工具附件投影为 media 行,带附件的探查工具不进折叠组", () => {
    const withAttachment = toolPart("prt_r1", "msg_a1", "read", {
      display: builtinDisplay("read"),
      state: {
        status: "completed",
        input: { filePath: "/a/shot.png" },
        output: "Image read successfully",
        title: "read",
        metadata: {},
        time: { start: 0, end: 1 },
        // 生产形态(processor 完成时写入):附件可缺 id/filename。
        attachments: [{ type: "file", mime: "image/png", url: "data:image/png;base64,eA==" }],
      } as ToolPart["state"],
    })
    const rows = project([userMsg("msg_u1", 1000), assistantMsg("msg_a1", "msg_u1")], {
      msg_u1: [textPart("prt_u1", "msg_u1", "读下截图")],
      msg_a1: [
        withAttachment,
        toolPart("prt_r2", "msg_a1", "read", { display: builtinDisplay("read") }),
        toolPart("prt_r3", "msg_a1", "grep", { display: builtinDisplay("grep") }),
      ],
    })
    // `#1473`:媒体行挂在工作过程之外(回答之后);附件不再阻止同类步骤合并。
    expect(rows.map((row) => row.kind)).toEqual(["user", "process", "media", "footnote"])
    expect(toolStepsOf(rows).map((step) => step.parts.length)).toEqual([2, 1])
    const media = rows[2]!
    if (media.kind !== "media") throw new Error("expected media row")
    expect(media.key).toBe("media:prt_r1:0")
    expect(media.media).toMatchObject({ partID: "prt_r1", name: "image/png", mime: "image/png" })

    // 畸形附件条目 fail-closed 丢弃(快照有效,专测附件形状闸)。
    const malformed = toolPart("prt_r9", "msg_a1", "read", {
      display: builtinDisplay("read"),
      state: {
        status: "completed",
        input: {},
        output: "",
        title: "read",
        metadata: {},
        time: { start: 0, end: 1 },
        attachments: [null, { type: "file" }, { mime: "image/png" }, "junk"],
      } as unknown as ToolPart["state"],
    })
    const failClosed = project([userMsg("msg_u1", 1000), assistantMsg("msg_a1", "msg_u1")], {
      msg_u1: [textPart("prt_u1", "msg_u1", "x")],
      msg_a1: [malformed],
    })
    expect(failClosed.some((row) => row.kind === "media")).toBe(false)
  })

  test("媒体行同 identity 分派闸(#587 R-final):metadata-only 降级的 part 附件零媒体行", () => {
    const attachments = [{ type: "file", mime: "image/png", url: "data:image/png;base64,eA==" }]
    const state = {
      status: "completed",
      input: {},
      output: "ok",
      title: "远端标题",
      metadata: {},
      time: { start: 0, end: 1 },
      attachments,
    } as ToolPart["state"]
    // 第三方 MCP identity(降级卡):附件不得渲染为媒体行。
    const thirdParty = toolPart("prt_m1", "msg_a1", "srv_capture", {
      display: {
        identity: { source: "mcp", origin: "srv", name: "capture" },
        technicalId: "srv_capture",
        authority: { kind: "not-asserted" },
      },
      state,
    } as Partial<ToolPart>)
    // 快照缺失(历史行/非法形状):同样 fail-closed。
    const noSnapshot = toolPart("prt_m2", "msg_a1", "read", { state })
    const rows = project([userMsg("msg_u1", 1000), assistantMsg("msg_a1", "msg_u1")], {
      msg_u1: [textPart("prt_u1", "msg_u1", "x")],
      msg_a1: [thirdParty, noSnapshot],
    })
    expect(toolStepsOf(rows).flatMap((step) => step.parts)).toHaveLength(2)
    expect(rows.some((row) => row.kind === "media")).toBe(false)
  })

  test("I7 合并组成员上限:超长连续同类段切成多组", () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      toolPart(`prt_g${index}`, "msg_a1", "read", { display: builtinDisplay("read") }),
    )
    const rows = project([userMsg("msg_u1", 1000), assistantMsg("msg_a1", "msg_u1")], {
      msg_u1: [textPart("prt_u1", "msg_u1", "翻仓库")],
      msg_a1: many,
    })
    expect(toolStepsOf(rows).map((step) => step.parts.length)).toEqual([24, 6])
  })

  test("产物链接行:identity 为第一方 cloud facade 且完成态、输出解析出 artifacts 名单才出行(fail-closed)", () => {
    const output = JSON.stringify({
      job_id: "job_1",
      status: "completed",
      artifacts: [{ name: "季度分析.docx" }, "营收对比.png", { bogus: true }],
    })
    const cloudDisplay = {
      identity: { source: "mcp", origin: "cloud", name: "await" },
      technicalId: "cloud_await",
      authority: { kind: "alpha-cloud", bindingId: "mcp:cloud", evidenceDigest: `sha256:${"a".repeat(64)}` },
    } as ToolPart["display"]
    const cloudDone = toolPart("prt_c1", "msg_a1", "cloud_await", {
      display: cloudDisplay,
      state: { status: "completed", input: {}, output, title: "await", metadata: {}, time: { start: 0, end: 1 } },
    })
    const rows = project([userMsg("msg_u1", 1000), assistantMsg("msg_a1", "msg_u1")], {
      msg_u1: [textPart("prt_u1", "msg_u1", "跑云任务")],
      msg_a1: [cloudDone],
    })
    expect(rows.map((row) => row.kind)).toEqual(["user", "process", "artifacts", "footnote"])
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
          display: cloudDisplay,
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
          display: cloudDisplay,
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

    // #879 审计 R-final:别名前缀 cloud_ 不再是准入 —— identity 缺失的 cloud_await
    // 同一份合法产物 payload 也不出行(历史行 / 无快照来源 fail-closed)。
    expect(
      artifactLinksOf(
        toolPart("prt_c5", "msg_a1", "cloud_await", {
          state: { status: "completed", input: {}, output, title: "await", metadata: {}, time: { start: 0, end: 1 } },
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

  // `#1382` —— 围栏拒绝的归因必须一路走到行模型。实测(真代理 + bun fetch + @ai-sdk/openai /
  // @ai-sdk/anthropic)两处各拿得到一份:`data.message` 由上游启发式拼出、`data.responseBody`
  // 逐字透传。两处分开断,是因为只读其中一处的实现会在另一半上静默失败。
  test("回合级错误:围栏拒绝从 message 与 responseBody 两处都认得出,并带上被拒的目的地", () => {
    const fromMessage = turnErrorOf([
      assistantMsg("msg_a1", "msg_u1", {
        error: {
          name: "APIError",
          data: {
            message:
              "Forbidden: alpha egress policy: api.deepseek.com:443 denied (reason=unregistered) — blocked by this app's local egress policy — the destination is neither a registered app endpoint (packages/ui-mac/src/main/network-egress-registry.ts) nor one of the built-in model providers this machine holds a key for",
          },
        } as AssistantMessage["error"],
      }),
    ])
    expect(fromMessage?.egressDenied).toEqual({ authority: "api.deepseek.com:443" })

    // `message` 那一半被上游改成别的措辞时,`responseBody` 仍逐字带着正文 —— 归因不能跟着丢。
    const fromBody = turnErrorOf([
      assistantMsg("msg_a1", "msg_u1", {
        error: {
          name: "APIError",
          data: {
            message: "Forbidden",
            responseBody:
              "alpha egress policy: api.deepseek.com:443 denied (reason=unregistered) — blocked by this app's local egress policy\n",
          },
        } as AssistantMessage["error"],
      }),
    ])
    expect(fromBody?.egressDenied).toEqual({ authority: "api.deepseek.com:443" })
    expect(fromBody?.message).toBe("Forbidden") // 原始 message 照旧保留,归因是另加的一格

    // 投影到行:authority 进 rev,否则同一回合从「普通失败」变成「围栏拒绝」时行不会重建。
    const rows = project(
      [
        userMsg("msg_u1", 1000),
        assistantMsg("msg_a1", "msg_u1", {
          error: {
            name: "APIError",
            data: { message: "Forbidden: alpha egress policy: api.deepseek.com:443 denied (reason=unregistered) — x" },
          } as AssistantMessage["error"],
        }),
      ],
      { msg_u1: [textPart("prt_u1", "msg_u1", "开始")] },
    )
    const last = rows.at(-1)!
    if (last.kind !== "turnError") throw new Error("expected turnError row")
    expect(last.egressDenied).toEqual({ authority: "api.deepseek.com:443" })
    expect(last.rev).toContain("api.deepseek.com:443")
  })

  test("回合级错误:不是围栏拒绝的失败一律不归因(含带同一前缀的 dial-failed)", () => {
    const plain = [
      "Failed after 3 attempts. Last error: Cannot connect to API: Unable to connect. Is the computer able to access the url?",
      "Failed after 3 attempts. Last error: Bad Gateway",
      "Provider response headers timed out after 60000ms",
      "alpha egress policy: github.com:443 denied (reason=dial-failed) — registered destination could not be reached (ETIMEDOUT)",
    ]
    for (const message of plain) {
      const turn = turnErrorOf([
        assistantMsg("msg_a1", "msg_u1", {
          error: { name: "APIError", data: { message } } as AssistantMessage["error"],
        }),
      ])
      expect({ message, egressDenied: turn?.egressDenied }).toEqual({ message, egressDenied: undefined })
      expect(turn?.message).toBe(message) // 文案不变 —— AC2
    }
  })

  test("重试:status=retry 且活跃回合 → 工作过程带 retry(attempt + 有界 message),不另挂重试行", () => {
    const rows = project([userMsg("msg_u1", 1000)], { msg_u1: [textPart("prt_u1", "msg_u1", "开始")] }, "retry", {
      attempt: 2,
      message: "gateway 429",
    })
    // `#1474` 起重试写进工作过程的实时标题(「正在重试 · 第 N 次 · 原因」),不再与运行行并存。
    expect(rows.map((row) => row.kind)).toEqual(["user", "process"])
    const process = rows[1]!
    if (process.kind !== "process") throw new Error("expected process row")
    expect(process.retry).toEqual({ attempt: 2, message: "gateway 429" })

    const long = project([userMsg("msg_u1", 1000)], { msg_u1: [textPart("prt_u1", "msg_u1", "开始")] }, "retry", {
      attempt: 3,
      message: "x".repeat(RETRY_MESSAGE_MAX_CHARS + 50),
    })
    const bounded = long[1]!
    if (bounded.kind !== "process") throw new Error("expected process row")
    expect(bounded.retry?.message).toHaveLength(RETRY_MESSAGE_MAX_CHARS)

    const idle = project([userMsg("msg_u1", 1000)], { msg_u1: [textPart("prt_u1", "msg_u1", "开始")] }, "idle")
    expect(idle.some((row) => row.kind === "process")).toBe(false)
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
    const compaction = rows.find((row) => row.kind === "divider" && row.label === "compaction")
    if (!compaction || compaction.label !== "compaction") throw new Error("expected compaction divider")
    expect(compaction.summaryParts).toEqual([])
  })

  test("压缩助手的既有 summary 收进分隔行,不再重复投影为普通 Markdown/脚注", () => {
    const summary = textPart("prt_sum", "msg_a1", "## 保留要点\n\n- 已确认安全边界")
    const rows = project(
      [userMsg("msg_u1", 1000), assistantMsg("msg_a1", "msg_u1", { summary: true, mode: "compaction" })],
      {
        msg_u1: [{ id: "prt_k1", sessionID: "ses_1", messageID: "msg_u1", type: "compaction", auto: true }],
        msg_a1: [reasoningPart("prt_reason", "msg_a1", "压缩过程内部推理"), summary],
      },
    )

    expect(rows.map((row) => row.kind)).toEqual(["divider"])
    const divider = rows[0]!
    if (divider.kind !== "divider" || divider.label !== "compaction") throw new Error("expected compaction divider")
    expect(divider.summaryParts).toEqual([summary])
    expect(divider.rev).toContain("prt_sum")
  })

  test("压缩 summary 未完成时不暴露半截要点,也不回退成普通 Markdown", () => {
    const rows = project(
      [
        userMsg("msg_u1", 1000),
        assistantMsg("msg_a1", "msg_u1", {
          summary: true,
          mode: "compaction",
          time: { created: 10 },
        }),
      ],
      {
        msg_u1: [{ id: "prt_k1", sessionID: "ses_1", messageID: "msg_u1", type: "compaction", auto: true }],
        msg_a1: [textPart("prt_sum", "msg_a1", "尚未完成的半截摘要")],
      },
      "busy",
    )

    expect(rows.map((row) => row.kind)).toEqual(["divider", "process"])
    const divider = rows[0]!
    if (divider.kind !== "divider" || divider.label !== "compaction") throw new Error("expected compaction divider")
    expect(divider.summaryParts).toEqual([])
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

// ═══════════════ #588 — 连接器 chip(TL-06) ═══════════════

describe("#588 连接器提及(resource source → chip 段)", () => {
  const resourceFile = (over: Partial<FilePart> = {}) =>
    filePart("prt_res1", "msg_u1", {
      mime: "text/plain",
      filename: "issue-12",
      url: "https://example.invalid/issue/12",
      source: {
        type: "resource",
        clientName: "GitHub",
        uri: "github://issue/12",
        text: { value: "GitHub", start: 0, end: 6 },
      },
      ...over,
    })

  test("resource source → resource 段并携带来源名;file/agent 段不受影响", () => {
    const rows = project([userMsg("msg_u1", 1000)], {
      msg_u1: [textPart("prt_u1", "msg_u1", "GitHub 对照 README.md 核对", {}), resourceFile()],
    })
    const user = rows[0]!
    if (user.kind !== "user") throw new Error("expected user row")
    expect(user.segments).toEqual([
      { text: "GitHub", kind: "resource", label: "GitHub" },
      { text: " 对照 README.md 核对" },
    ])
  })

  test("来源名缺席 → 退回普通文件提及(不出没有名字的 chip)", () => {
    const rows = project([userMsg("msg_u1", 1000)], {
      msg_u1: [
        textPart("prt_u1", "msg_u1", "GitHub 对照"),
        resourceFile({
          source: {
            type: "resource",
            clientName: "",
            uri: "github://issue/12",
            text: { value: "GitHub", start: 0, end: 6 },
          } as never,
        }),
      ],
    })
    const user = rows[0]!
    if (user.kind !== "user") throw new Error("expected user row")
    expect(user.segments).toEqual([{ text: "GitHub", kind: "file" }, { text: " 对照" }])
  })

  test("I7:超长来源名走真实投影路径(mentionSpans)按帽截断", () => {
    // 输入必须真的超帽,且经 projectTimelineRows → mentionSpans 的生产 slice 路径 ——
    // 直接向 segmentUserText 传恰好等帽的 label 是伪闸门(审计 R1 Blocker:删掉生产
    // 截断仍会绿)。
    const rows = project([userMsg("msg_u1", 1000)], {
      msg_u1: [
        textPart("prt_u1", "msg_u1", "GitHub 对照 README.md 核对"),
        resourceFile({
          source: {
            type: "resource",
            clientName: "n".repeat(MENTION_LABEL_MAX_CHARS + 40),
            uri: "github://issue/12",
            text: { value: "GitHub", start: 0, end: 6 },
          },
        }),
      ],
    })
    const user = rows[0]!
    if (user.kind !== "user") throw new Error("expected user row")
    expect(user.segments[0]).toEqual({
      text: "GitHub",
      kind: "resource",
      label: "n".repeat(MENTION_LABEL_MAX_CHARS),
    })
  })
})

// ═══════════════ #591 — 富脚注 provider / 效率段 ═══════════════

describe("#591 富脚注 provider 与效率段", () => {
  const withTokens = (tokens: AssistantMessage["tokens"]) =>
    footnoteOf([assistantMsg("msg_a1", "msg_u1", { tokens })])

  test("provider 取 providerID;缺席即无图标来源", () => {
    expect(footnoteOf([assistantMsg("msg_a1", "msg_u1")])?.provider).toBe("deepseek")
    expect(footnoteOf([assistantMsg("msg_a1", "msg_u1", { providerID: "" as never })])?.provider).toBeUndefined()
  })

  test("效率段 = 缓存命中率;cache.read 为 0 时诚实缺席(不拿零值装「低」)", () => {
    expect(withTokens({ input: 1000, output: 200, reasoning: 0, cache: { read: 3000, write: 0 } })?.cacheHit).toBe(75)
    expect(withTokens({ input: 0, output: 200, reasoning: 0, cache: { read: 1200, write: 0 } })?.cacheHit).toBe(100)
    const cold = { input: 1000, output: 200, reasoning: 0, cache: { read: 0, write: 0 } }
    expect(withTokens(cold)?.cacheHit).toBeUndefined()
    expect(withTokens({ ...cold, cache: { read: -5, write: 0 } } as never)?.cacheHit).toBeUndefined()
  })

  test("分母含 cache.write:session.ts 已把 input 规范化为非缓存输入,漏 write 档位会偏高", () => {
    // 审计 R1 Blocker 反例:input=500/read=200/write=300 → 完整提示词 1000,命中 20%
    // (旧算式 read/(read+input)=200/700 会给出 29%)。
    expect(withTokens({ input: 500, output: 100, reasoning: 0, cache: { read: 200, write: 300 } })?.cacheHit).toBe(20)
    // write 非法(负数/缺席)按 0 计,不放大也不吞掉命中率。
    expect(withTokens({ input: 1000, output: 100, reasoning: 0, cache: { read: 1000, write: -7 } } as never)?.cacheHit).toBe(50)
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

  const markdownOf = (rows: readonly TimelineRow[]) => rows.find((row) => row.kind === "markdown")!

  test("文本增量(同 part 对象)保留行引用;流式收尾才重建该行", () => {
    const first = reuseTimelineRows(undefined, project(messages, parts, "busy"))
    streamingText.text = "第一段第二段"
    const second = reuseTimelineRows(first, project(messages, parts, "busy"))
    expect(markdownOf(second)).toBe(markdownOf(first))
    // `#1474`:活跃回合的工作过程行同样不因文本增量重建(实时标题的 live region 不插拔)。
    expect(second.find((row) => row.kind === "process")).toBe(first.find((row) => row.kind === "process")!)

    const done = reuseTimelineRows(second, project(messages, parts, "idle"))
    expect(markdownOf(done)).not.toBe(markdownOf(second))
    const row = markdownOf(done)
    expect(row.kind === "markdown" && row.streaming).toBe(false)
  })

  test("part 引用被整体替换时不复用旧行(防 stale proxy)", () => {
    const first = reuseTimelineRows(undefined, project(messages, parts, "busy"))
    const replaced: Record<string, Part[]> = {
      ...parts,
      msg_a1: [textPart("prt_t1", "msg_a1", "第一段第二段")],
    }
    const second = reuseTimelineRows(first, project(messages, replaced, "busy"))
    expect(markdownOf(second)).not.toBe(markdownOf(first))
  })
})

// ═══════════════ #568 — 富脚注 / 本回合改动汇总 / 斜杠命令来源 ═══════════════

describe("#568 回合末富脚注(A6)", () => {
  test("完成回合出 footnote 行:agent/model 在场,用时不在脚注(#1473),零 tokens 诚实缺席;copyText 取全部助手正文", () => {
    const rows = project([userMsg("msg_u1", 1000), assistantMsg("msg_a1", "msg_u1")], {
      msg_u1: [textPart("prt_u1", "msg_u1", "开始")],
      msg_a1: [textPart("prt_t1", "msg_a1", "第一段"), textPart("prt_t2", "msg_a1", "第二段")],
    })
    const last = rows.at(-1)!
    if (last.kind !== "footnote") throw new Error("expected footnote row")
    expect(last.footnote).toEqual({
      provider: "deepseek",
      agent: "build",
      model: "deepseek-reasoner",
      tokens: undefined,
    })
    expect(last.copyText()).toBe("第一段\n\n第二段")
  })

  test("tokens 合计 input+output+reasoning;非法数值字段丢弃不炸", () => {
    const rows = project(
      [
        userMsg("msg_u1", 1000),
        assistantMsg("msg_a1", "msg_u1", {
          tokens: { input: 1200, output: 2000, reasoning: 100, cache: { read: 0, write: 0 } },
        }),
      ],
      { msg_u1: [textPart("prt_u1", "msg_u1", "开始")], msg_a1: [textPart("prt_t1", "msg_a1", "答")] },
    )
    const last = rows.at(-1)!
    expect(last.kind === "footnote" && last.footnote.tokens).toBe(3300)

    const hostile = footnoteOf([
      assistantMsg("msg_a2", "msg_u1", { tokens: { input: Number.NaN, output: "x", reasoning: -5 } as never }),
    ])
    expect(hostile?.tokens).toBeUndefined()
  })

  test("未完成/出错的回合不出脚注(流式中与错误回合都 fail-closed)", () => {
    const streaming = project(
      [userMsg("msg_u1", 1000), assistantMsg("msg_a1", "msg_u1", { time: { created: 10 } })],
      { msg_u1: [textPart("prt_u1", "msg_u1", "开始")], msg_a1: [textPart("prt_t1", "msg_a1", "写到一半")] },
      "busy",
    )
    expect(streaming.some((row) => row.kind === "footnote")).toBe(false)

    const failed = project(
      [
        userMsg("msg_u1", 1000),
        assistantMsg("msg_a1", "msg_u1", { error: { name: "UnknownError", data: { message: "x" } } as never }),
      ],
      { msg_u1: [textPart("prt_u1", "msg_u1", "开始")], msg_a1: [textPart("prt_t1", "msg_a1", "半截")] },
    )
    expect(failed.some((row) => row.kind === "footnote")).toBe(false)
  })
})

describe("#1560 实际执行模型与所选不一致时脚注说明「实际使用 X」", () => {
  const turn = (user: UserMessage, assistant: AssistantMessage) =>
    project([user, assistant], {
      msg_u1: [textPart("prt_u1", "msg_u1", "开始")],
      msg_a1: [textPart("prt_t1", "msg_a1", "答")],
    })
  const footnoteRow = (rows: TimelineRow[]) => {
    const last = rows.at(-1)!
    if (last.kind !== "footnote") throw new Error("expected footnote row")
    return last
  }

  test("不一致(modelID 或 providerID 不同):脚注带实际执行的模型,且进 rev 以触发重渲染", () => {
    const byModel = footnoteRow(
      turn(
        userMsg("msg_u1", 1000, { model: { providerID: "deepseek", modelID: "deepseek-chat" } }),
        assistantMsg("msg_a1", "msg_u1"),
      ),
    )
    expect(byModel.footnote.actualModel).toBe("deepseek-reasoner")
    expect(byModel.rev).toContain("deepseek-reasoner")

    const byProvider = footnoteOf([assistantMsg("msg_a1", "msg_u1")], {
      providerID: "deepseek-byok",
      modelID: "deepseek-reasoner",
    })
    expect(byProvider?.actualModel).toBe("deepseek-reasoner")
  })

  test("一致或用户消息没记模型:不出说明,脚注与原来逐字段相同", () => {
    const same = footnoteRow(turn(userMsg("msg_u1", 1000), assistantMsg("msg_a1", "msg_u1")))
    expect(same.footnote.actualModel).toBeUndefined()
    expect(Object.keys(same.footnote)).not.toContain("actualModel")

    const unrecorded = footnoteRow(
      turn(userMsg("msg_u1", 1000, { model: undefined as never }), assistantMsg("msg_a1", "msg_u1")),
    )
    expect(unrecorded.footnote.actualModel).toBeUndefined()
  })
})

describe("#568 本回合改动汇总(S2)", () => {
  test("userMessage.summary.diffs 投影为 diffsum 行:合计与文件行;非法条目丢弃", () => {
    const rows = project(
      [
        userMsg("msg_u1", 1000, {
          summary: {
            diffs: [
              { file: "AGENTS.md", additions: 96, deletions: 0 },
              { file: "alpha-ui/button.css", additions: 8, deletions: 2 },
              { additions: 1, deletions: 1 },
              "junk",
              null,
            ] as never,
          },
        }),
      ],
      { msg_u1: [textPart("prt_u1", "msg_u1", "改一版")] },
    )
    const last = rows.at(-1)!
    if (last.kind !== "diffsum") throw new Error("expected diffsum row")
    expect(last.files).toEqual([
      { file: "AGENTS.md", additions: 96, deletions: 0 },
      { file: "alpha-ui/button.css", additions: 8, deletions: 2 },
    ])
    expect(last.additions).toBe(104)
    expect(last.deletions).toBe(2)
    expect(last.truncated).toBe(false)
  })

  test("fail-closed:summary 缺席/diffs 空/全非法 → 无 diffsum 行;超帽截断标记", () => {
    expect(
      project([userMsg("msg_u1", 1000)], { msg_u1: [textPart("prt_u1", "msg_u1", "无汇总")] }).some(
        (row) => row.kind === "diffsum",
      ),
    ).toBe(false)
    expect(turnDiffsOf(userMsg("msg_u2", 1, { summary: { diffs: [] } }))).toBeUndefined()
    expect(turnDiffsOf(userMsg("msg_u3", 1, { summary: { diffs: [{}, null, 42] as never } }))).toBeUndefined()

    const over = turnDiffsOf(
      userMsg("msg_u4", 1, {
        summary: {
          diffs: Array.from({ length: TURN_DIFF_FILES_MAX + 5 }, (_, index) => ({
            file: `f${index}.ts`,
            additions: 1,
            deletions: 0,
          })),
        },
      }),
    )
    expect(over?.files).toHaveLength(TURN_DIFF_FILES_MAX)
    expect(over?.truncated).toBe(true)
  })
})

describe("#568 斜杠命令来源(可选 typed 接口,C7 供给)", () => {
  test("登记按 assistant messageID 对齐到所属回合的用户行;其余回合不受影响", () => {
    const rows = projectTimelineRows({
      messages: [
        userMsg("msg_u1", 1000),
        assistantMsg("msg_a1", "msg_u1"),
        userMsg("msg_u2", 2000),
        assistantMsg("msg_a2", "msg_u2"),
      ],
      partsOf: (id) =>
        ((
          {
            msg_u1: [textPart("prt_u1", "msg_u1", "普通消息")],
            msg_u2: [textPart("prt_u2", "msg_u2", "expanded prompt body")],
          } as Record<string, Part[]>
        )[id] ?? []),
      status: "idle",
      slashOrigins: [{ assistantMessageID: "msg_a2", command: "review", arguments: "pr 12" }],
    })
    const users = rows.filter((row) => row.kind === "user")
    expect(users[0]!.kind === "user" && users[0]!.slash).toBeUndefined()
    const second = users[1]!
    if (second.kind !== "user") throw new Error("expected user row")
    expect(second.slash).toEqual({ command: "review", arguments: "pr 12" })
  })

  test("fail-closed:登记缺席/字段非法/对不上回合 → 无 chip;敌意超长字段被截断", () => {
    expect(slashOriginForTurn(undefined, new Set(["msg_a1"]))).toBeUndefined()
    expect(slashOriginForTurn([], new Set(["msg_a1"]))).toBeUndefined()
    expect(
      slashOriginForTurn([{ assistantMessageID: "msg_other", command: "init" }], new Set(["msg_a1"])),
    ).toBeUndefined()
    expect(
      slashOriginForTurn([{ assistantMessageID: "msg_a1", command: "" }], new Set(["msg_a1"])),
    ).toBeUndefined()
    expect(
      slashOriginForTurn([{ assistantMessageID: "msg_a1", command: 42 } as never], new Set(["msg_a1"])),
    ).toBeUndefined()

    const long = slashOriginForTurn(
      [{ assistantMessageID: "msg_a1", command: "c".repeat(1000), arguments: "a".repeat(1000) }],
      new Set(["msg_a1"]),
    )
    expect(long?.command).toHaveLength(SLASH_COMMAND_MAX_CHARS)
    expect(long?.arguments).toHaveLength(SLASH_ARGUMENTS_MAX_CHARS)
  })

  test("E3/E4:source 只透传注册方声明的三个字面量;未知值/缺席按缺席处理(不猜)", () => {
    const ids = new Set(["msg_a1"])
    expect(slashOriginForTurn([{ assistantMessageID: "msg_a1", command: "orbit-docs", source: "skill" }], ids)).toEqual(
      { command: "orbit-docs", source: "skill" },
    )
    expect(
      slashOriginForTurn(
        [{ assistantMessageID: "msg_a1", command: "atlas7:fetch-spec", arguments: "graphql", source: "mcp" }],
        ids,
      ),
    ).toEqual({ command: "atlas7:fetch-spec", arguments: "graphql", source: "mcp" })
    expect(
      slashOriginForTurn([{ assistantMessageID: "msg_a1", command: "triage-notes", source: "command" }], ids),
    ).toEqual({ command: "triage-notes", source: "command" })
    // 未知值(引擎从未声明过的字符串)与非字符串 → source 诚实缺席,chip 回通用形。
    expect(
      slashOriginForTurn([{ assistantMessageID: "msg_a1", command: "mystery", source: "wizard" } as never], ids)
        ?.source,
    ).toBeUndefined()
    expect(
      slashOriginForTurn([{ assistantMessageID: "msg_a1", command: "mystery", source: 7 } as never], ids)?.source,
    ).toBeUndefined()
    expect(slashOriginForTurn([{ assistantMessageID: "msg_a1", command: "mystery" }], ids)?.source).toBeUndefined()
  })
})

describe("#568 审计修复:脚注只认回合尾态成功完成(Major-1)", () => {
  test("序列 成功→流式:早先完成助手不回溯,零脚注(复制动作随行同门缺席)", () => {
    const rows = project(
      [
        userMsg("msg_u1", 1000),
        assistantMsg("msg_a1", "msg_u1"),
        assistantMsg("msg_a2", "msg_u1", { time: { created: 30 } }),
      ],
      {
        msg_u1: [textPart("prt_u1", "msg_u1", "开始")],
        msg_a1: [textPart("prt_t1", "msg_a1", "第一次完整回答")],
        msg_a2: [textPart("prt_t2", "msg_a2", "重新生成中")],
      },
      "busy",
    )
    expect(rows.some((row) => row.kind === "footnote")).toBe(false)
  })

  test("序列 成功→失败:尾态失败,零脚注(旧指标不得与失败内容混用)", () => {
    const rows = project(
      [
        userMsg("msg_u1", 1000),
        assistantMsg("msg_a1", "msg_u1"),
        assistantMsg("msg_a2", "msg_u1", {
          time: { created: 30, completed: 40 },
          error: { name: "rate_limit_exceeded", data: { message: "429" } } as never,
        }),
      ],
      {
        msg_u1: [textPart("prt_u1", "msg_u1", "开始")],
        msg_a1: [textPart("prt_t1", "msg_a1", "第一次完整回答")],
        msg_a2: [textPart("prt_t2", "msg_a2", "半截失败")],
      },
    )
    expect(rows.some((row) => row.kind === "footnote")).toBe(false)
    // footnoteOf 直接口径:最后一个助手不是成功完成 → undefined。
    expect(
      footnoteOf([assistantMsg("msg_a1", "msg_u1"), assistantMsg("msg_a2", "msg_u1", { time: { created: 30 } })]),
    ).toBeUndefined()
  })

  test("活跃回合(busy 且尾助手已完成、新助手未落地)不出脚注;结算后出", () => {
    const messages = [userMsg("msg_u1", 1000), assistantMsg("msg_a1", "msg_u1")]
    const parts = {
      msg_u1: [textPart("prt_u1", "msg_u1", "开始")],
      msg_a1: [textPart("prt_t1", "msg_a1", "回答")],
    }
    expect(project(messages, parts, "busy").some((row) => row.kind === "footnote")).toBe(false)
    expect(project(messages, parts, "idle").some((row) => row.kind === "footnote")).toBe(true)
  })
})

describe("#568 审计修复:reviewPathOf 安全 workspace-relative 证明(Major-2)", () => {
  const root = "/tmp/workspace"

  test("合法:根下绝对路径剥前缀;本就相对的路径原样;Windows 分隔符归一", () => {
    expect(reviewPathOf("/tmp/workspace/src/a.ts", root)).toBe("src/a.ts")
    expect(reviewPathOf("AGENTS.md", root)).toBe("AGENTS.md")
    expect(reviewPathOf("alpha-ui/button.css", root)).toBe("alpha-ui/button.css")
    expect(reviewPathOf("/tmp/workspace/src/b.ts", "/tmp/workspace/")).toBe("src/b.ts")
    expect(reviewPathOf("C:\\ws\\src\\a.ts", "C:\\ws")).toBe("src/a.ts")
  })

  test("四形态越根一律 undefined:外部绝对 / ../ 相对 / 盘符 / normalize 逃逸", () => {
    expect(reviewPathOf("/etc/passwd", root)).toBeUndefined()
    expect(reviewPathOf("../escape.ts", root)).toBeUndefined()
    expect(reviewPathOf("src/../../escape.ts", root)).toBeUndefined()
    expect(reviewPathOf("C:/evil/x.ts", root)).toBeUndefined()
    expect(reviewPathOf("C:\\evil\\x.ts", root)).toBeUndefined()
    expect(reviewPathOf("/tmp/workspace/../escape.ts", root)).toBeUndefined()
  })

  test("残留构件 fail-closed:空段 / . 段 / 根本身 / 空目录", () => {
    expect(reviewPathOf("src//a.ts", root)).toBeUndefined()
    expect(reviewPathOf("./a.ts", root)).toBeUndefined()
    expect(reviewPathOf("/tmp/workspace", root)).toBeUndefined()
    expect(reviewPathOf("/tmp/workspace/", root)).toBeUndefined()
    expect(reviewPathOf("a.ts", "")).toBe("a.ts")
  })
})

describe("#568 审计修复:diffsum 畸形条目整条丢弃(minor)", () => {
  test("超长文件名不截断成另一路径、非法/缺失 ±行数不改写为 0 —— 整条丢弃", () => {
    const result = turnDiffsOf(
      userMsg("msg_u1", 1, {
        summary: {
          diffs: [
            { file: "ok.ts", additions: 1, deletions: 0 },
            { file: "x".repeat(500), additions: 1, deletions: 0 },
            { file: "nan.ts", additions: Number.NaN, deletions: 0 },
            { file: "neg.ts", additions: 1, deletions: -3 },
            { file: "missing.ts", additions: 1 },
            { file: "str.ts", additions: "9", deletions: 0 },
          ] as never,
        },
      }),
    )
    expect(result?.files).toEqual([{ file: "ok.ts", additions: 1, deletions: 0 }])
    expect(result?.additions).toBe(1)
    expect(result?.deletions).toBe(0)
  })

  test("全部畸形 → undefined(不渲染空壳行)", () => {
    expect(
      turnDiffsOf(
        userMsg("msg_u2", 1, {
          summary: { diffs: [{ file: "y".repeat(401), additions: 1, deletions: 0 }] as never },
        }),
      ),
    ).toBeUndefined()
  })
})

describe("#1399 回合脚行计时 m:ss(从用户消息 time.created 起算,不是行挂载时刻)", () => {
  test("整秒向下取整;分钟不进位到小时;负值(时钟偏斜)钉 0:00", () => {
    expect(formatTurnElapsed(0)).toBe("0:00")
    expect(formatTurnElapsed(999)).toBe("0:00")
    expect(formatTurnElapsed(3_000)).toBe("0:03")
    expect(formatTurnElapsed(65_000)).toBe("1:05")
    expect(formatTurnElapsed(3_599_999)).toBe("59:59")
    expect(formatTurnElapsed(3_600_000)).toBe("60:00")
    expect(formatTurnElapsed(-5_000)).toBe("0:00")
  })
})

describe("REQ-236 #1552 生图卡:派发调用事实 → cloudImage 行与显示态", () => {
  const facade = (name: string) =>
    ({
      identity: { source: "mcp", origin: "cloud", name },
      technicalId: name,
      authority: { kind: "not-asserted" },
    }) as ToolPart["display"]
  const imageInput = { autonomy: "pipeline", kind: "image-generation", input: { prompt: "黄昏时分的海边灯塔" } }
  const dispatch = (state: ToolPart["state"], over: Partial<ToolPart> = {}) =>
    toolPart("prt_d1", "msg_a1", "cloud_cloud_dispatch", { display: facade("cloud_dispatch"), state, ...over })
  const accepted = JSON.stringify({ schema_version: 1, status: "queued", job_id: "job_img1" })
  const done = (output: string, input: unknown = imageInput) =>
    ({ status: "completed", input, output, title: "dispatch", metadata: {}, time: { start: 100, end: 1_100 } }) as ToolPart["state"]
  const turn = (...parts: ToolPart[]) =>
    project([userMsg("msg_u1", 1000), assistantMsg("msg_a1", "msg_u1")], {
      msg_u1: [textPart("prt_u1", "msg_u1", "画一张灯塔")],
      msg_a1: parts,
    })

  test("pending 即出卡(正在提交),挂在回答之后、不进工作过程", () => {
    const pending = dispatch({ status: "pending", input: imageInput, raw: "" } as ToolPart["state"])
    const rows = turn(pending, textPart("prt_t1", "msg_a1", "好的"))
    expect(rows.map((row) => row.kind)).toEqual(["user", "process", "markdown", "cloudImage", "footnote"])
    const card = rows.find((row) => row.kind === "cloudImage")!
    if (card.kind !== "cloudImage") throw new Error("expected cloudImage")
    expect(card.image).toEqual({ partID: "prt_d1", prompt: "黄昏时分的海边灯塔", call: { phase: "submitting" } })
    expect(cloudImageViewOf(card.image.call, null, false)).toEqual({ state: "submitting" })
  })

  test("受理前 error 读这次调用的错误;额度类拒绝带充值入口,连不上与其它拒绝不带", () => {
    const refused = (error: string) =>
      cloudImageOf(dispatch({ status: "error", input: imageInput, error, time: { start: 0, end: 1 } } as ToolPart["state"]))!
    const quota = refused(JSON.stringify({ error: "会员额度已用尽", code: "account_allowance_exhausted" }))
    expect(quota.call).toEqual({
      phase: "refused",
      refusal: "allowance",
      error: JSON.stringify({ error: "会员额度已用尽", code: "account_allowance_exhausted" }),
    })
    expect(cloudImageViewOf(quota.call, null, false)).toEqual({ state: "refused", refusal: "allowance", billing: true })
    const wallet = refused(`Error: ${JSON.stringify({ error: "x", code: "account_wallet_insufficient" })}`)
    expect(cloudImageViewOf(wallet.call, null, false)).toEqual({ state: "refused", refusal: "wallet", billing: true })
    expect(cloudImageViewOf(refused("MCP error -32001: Request timed out").call, null, false)).toEqual({
      state: "refused",
      refusal: "network",
      billing: false,
    })
    expect(cloudImageViewOf(refused(JSON.stringify({ error: "forbidden" })).call, null, false)).toEqual({
      state: "refused",
      refusal: "other",
      billing: false,
    })
    // 模型的文字不参与判定:同一回合里助手说「已经画好了」,卡片仍是「没有开始」。
    const rows = turn(
      dispatch({ status: "error", input: imageInput, error: "fetch failed", time: { start: 0, end: 1 } } as ToolPart["state"]),
      textPart("prt_t1", "msg_a1", "图片已经画好并保存了"),
    )
    const card = rows.find((row) => row.kind === "cloudImage")!
    if (card.kind !== "cloudImage") throw new Error("expected cloudImage")
    expect(card.image.call.phase).toBe("refused")
  })

  test("各交付态映射:排队 / 生成中(计时起点 = 受理时刻)/ 正在保存 / 出图 / 任务失败 / 取消 / 没存到本机", () => {
    const image = cloudImageOf(dispatch(done(accepted)))!
    expect(image.call).toEqual({ phase: "accepted", runId: "job_img1", acceptedAt: 1_100 })
    const call = image.call
    const run = (job: string, delivery: "pending" | "downloading" | "saved" | "failed", extra: object = {}) => ({
      job: { status: job, ...extra },
      delivery: { status: delivery },
    })
    expect(cloudImageViewOf(call, null, false)).toEqual({ state: "queued", since: 1_100 })
    expect(cloudImageViewOf(call, run("unknown", "pending"), false)).toEqual({ state: "queued", since: 1_100 })
    expect(cloudImageViewOf(call, run("queued", "pending"), false)).toEqual({ state: "queued", since: 1_100 })
    expect(cloudImageViewOf(call, run("running", "pending"), false)).toEqual({ state: "running", since: 1_100 })
    expect(cloudImageViewOf(call, run("completed", "downloading"), false)).toEqual({ state: "saving" })
    expect(cloudImageViewOf(call, run("completed", "saved"), false)).toEqual({ state: "saved" })
    expect(cloudImageViewOf(call, run("failed", "saved", { code: "image_safety_rejected" }), false)).toEqual({
      state: "failed",
      reason: "safety",
    })
    expect(cloudImageViewOf(call, run("failed", "saved", { code: "image_backend_unavailable" }), false)).toEqual({
      state: "failed",
      reason: "upstream",
    })
    expect(cloudImageViewOf(call, run("failed", "saved"), false)).toEqual({ state: "failed", reason: "other" })
    expect(cloudImageViewOf(call, run("cancelled", "saved"), false)).toEqual({ state: "cancelled" })
    const failed = (scope: string, code: string) => ({
      job: { status: "completed" },
      delivery: { status: "failed" as const, failure: { scope, code } },
    })
    expect(cloudImageViewOf(call, failed("download", "network"), false)).toEqual({
      state: "undelivered",
      reason: "network",
      retryable: true,
    })
    expect(cloudImageViewOf(call, failed("verify", "sha256-mismatch"), false)).toMatchObject({ reason: "incomplete" })
    expect(cloudImageViewOf(call, failed("download", "unauthorized"), false)).toMatchObject({ reason: "auth", retryable: true })
    expect(cloudImageViewOf(call, failed("download", "not-found"), false)).toMatchObject({ reason: "gone", retryable: false })
    expect(cloudImageViewOf(call, failed("download", "over-limit"), false)).toMatchObject({ reason: "full", retryable: false })
    expect(cloudImageViewOf(call, failed("register", "disk"), false)).toMatchObject({ reason: "register", retryable: true })
    // 本机核验通过是最强的事实:tracker 还没给状态(重载后)也直接出图。
    expect(cloudImageViewOf(call, null, true)).toEqual({ state: "saved" })
    expect(cloudImageViewOf(call, failed("download", "network"), true)).toEqual({ state: "saved" })
  })

  test("kind 不精确 / 非第一方 identity / 不是 dispatch 一律不出行", () => {
    const wrongKind = { autonomy: "pipeline", kind: "image-generation.prompt", input: { prompt: "x" } }
    expect(cloudImageOf(dispatch(done(accepted, wrongKind)))).toBeUndefined()
    expect(
      cloudImageOf(
        dispatch(done(accepted), {
          display: {
            identity: { source: "plugin", origin: "cloud", name: "cloud_dispatch" },
            technicalId: "cloud_dispatch",
            authority: { kind: "not-asserted" },
          } as ToolPart["display"],
        }),
      ),
    ).toBeUndefined()
    expect(cloudImageOf(dispatch(done(accepted), { display: undefined }))).toBeUndefined()
    expect(cloudImageOf(dispatch(done(accepted), { display: facade("cloud_status") }))).toBeUndefined()
    const rows = turn(dispatch(done(accepted, wrongKind)))
    expect(rows.some((row) => row.kind === "cloudImage")).toBe(false)
  })

  test("同回合取代产物链接行:同一任务的 await 产物行不重复出现,别的任务照常出行", () => {
    const awaitOut = (jobId: string) =>
      JSON.stringify({ job_id: jobId, status: "completed", artifacts: [{ id: `art_${jobId}_0_deadbeef`, name: "lighthouse.png" }] })
    const awaited = (id: string, jobId: string) =>
      toolPart(id, "msg_a1", "cloud_cloud_await", {
        display: facade("cloud_await"),
        state: { status: "completed", input: { job_id: jobId }, output: awaitOut(jobId), title: "await", metadata: {}, time: { start: 0, end: 1 } },
      })
    const rows = turn(dispatch(done(accepted)), awaited("prt_w1", "job_img1"), awaited("prt_w2", "job_other"))
    expect(rows.filter((row) => row.kind === "cloudImage")).toHaveLength(1)
    const artifactRows = rows.filter((row) => row.kind === "artifacts")
    expect(artifactRows).toHaveLength(1)
    if (artifactRows[0]!.kind !== "artifacts") throw new Error("expected artifacts")
    expect(artifactRows[0]!.links[0]!.runId).toBe("job_other")
  })
})

// ── REQ-236 `#1553` AC4:用户气泡上方附件卡的读取结果 ────────────────────────────────────────
describe("#1553 附件卡读取结果:只按会话里的真实读取调用与逐服务状态派生", () => {
  const DIR = "/Users/me/proj"
  const UUID = "0b8c7f9e-1d2a-4c3b-9e8f-7a6b5c4d3e2f"
  const docMeta = { v: 1, name: "需求说明 v3.docx", mime: "application/x-docx", size: 942_080, path: `attachments/${UUID}/需求说明 v3.docx`, reader: "word" }
  const pdfMeta = { v: 1, name: "合同.pdf", mime: "application/pdf", size: 10, path: `attachments/${UUID}/合同.pdf`, reader: "pdf" }
  const staged = (id: string, messageID: string, meta: object) =>
    textPart(id, messageID, "", { synthetic: true, metadata: { "codepuppy.attachment": meta } })
  const readCall = (id: string, messageID: string, path: string, over: { origin?: string; name?: string; state?: object } = {}) =>
    toolPart(id, messageID, "alpha-word_read_docx", {
      display: { identity: { source: "mcp", origin: over.origin ?? "alpha-word", name: over.name ?? "read_docx" }, technicalId: "alpha-word_read_docx", authority: { kind: "not-asserted" } },
      state: { status: "completed", input: { path }, output: '{"paragraphs":["x"]}', title: "", metadata: {}, time: { start: 0, end: 1 }, ...over.state },
    } as Partial<ToolPart>)
  const absolute = `${DIR}/${PROJECT_HIDDEN_DIR}/attachments/${UUID}/需求说明 v3.docx`
  const readsOf = (rows: readonly TimelineRow[], index = 0) => {
    const user = rows.filter((row) => row.kind === "user")[index]
    if (!user || user.kind !== "user") throw new Error("expected user row")
    return user.attachments.map((a) => (a.read?.kind === "failed" ? `failed:${a.read.reason}` : (a.read?.kind ?? "-")))
  }
  const run = (parts: Record<string, Part[]>, opts: { status?: string; services?: Record<string, unknown>; messages?: Message[] } = {}) =>
    projectTimelineRows({
      messages: opts.messages ?? [userMsg("msg_u1", 1000), assistantMsg("msg_a1", "msg_u1")],
      partsOf: (id) => parts[id] ?? [],
      status: opts.status ?? "idle",
      attachments: { directory: DIR, services: opts.services },
    })
  const connected = { "alpha-word": { status: "connected" }, "alpha-pdf": { status: "connected" } }

  test("「已读取」⇔ 同会话有该读取工具的成功调用且路径经同一规范化后相等;路径不同 / 第三方同名工具 / 别名同名都不算", () => {
    const base = { msg_u1: [textPart("prt_u", "msg_u1", "看看"), staged("prt_s", "msg_u1", docMeta)] }
    expect(readsOf(run({ ...base, msg_a1: [readCall("prt_t", "msg_a1", absolute.replace("/attachments/", "//attachments/./"))] }, { services: connected }))).toEqual(["read"])
    expect(readsOf(run({ ...base, msg_a1: [readCall("prt_t", "msg_a1", absolute.replace("需求说明", "别的"))] }, { services: connected }))).toEqual(["not-read"])
    expect(readsOf(run({ ...base, msg_a1: [readCall("prt_t", "msg_a1", absolute, { origin: "my-word" })] }, { services: connected }))).toEqual(["not-read"])
    expect(readsOf(run({ ...base, msg_a1: [readCall("prt_t", "msg_a1", absolute, { name: "write_docx" })] }, { services: connected }))).toEqual(["not-read"])
    const alias = toolPart("prt_t", "msg_a1", "alpha-word_read_docx", { state: { status: "completed", input: { path: absolute }, output: "", title: "", metadata: {}, time: { start: 0, end: 1 } } })
    expect(readsOf(run({ ...base, msg_a1: [alias] }, { services: connected }))).toEqual(["not-read"])
  })

  test("同一会话后面的回合(「重新读取」发出的那条)读成功了,先前那张卡也是「已读取」", () => {
    const messages = [userMsg("msg_u1", 1000), assistantMsg("msg_a1", "msg_u1"), userMsg("msg_u2", 2000), assistantMsg("msg_a2", "msg_u2")]
    const parts = {
      msg_u1: [textPart("prt_u", "msg_u1", "看看"), staged("prt_s", "msg_u1", docMeta)],
      msg_a1: [textPart("prt_x", "msg_a1", "没读")],
      msg_u2: [textPart("prt_u2", "msg_u2", "请读取附件"), staged("prt_s2", "msg_u2", docMeta)],
      msg_a2: [readCall("prt_t", "msg_a2", absolute)],
    }
    const rows = run(parts, { messages, services: connected })
    expect([readsOf(rows, 0), readsOf(rows, 1)]).toEqual([["read"], ["read"]])
  })

  test("工具报错 ⇒ 读取失败(超时单列);read_pdf 每页空串 ⇒ 读到 0 字,有字 ⇒ 已读取", () => {
    const base = { msg_u1: [textPart("prt_u", "msg_u1", "看看"), staged("prt_s", "msg_u1", docMeta)] }
    const failed = (error: string) => readCall("prt_t", "msg_a1", absolute, { state: { status: "error", input: { path: absolute }, error, time: { start: 0, end: 1 } } })
    expect(readsOf(run({ ...base, msg_a1: [failed("File is not a zip file")] }, { services: connected }))).toEqual(["failed:unreadable"])
    expect(readsOf(run({ ...base, msg_a1: [failed("MCP error -32001: Request timed out")] }, { services: connected }))).toEqual(["failed:timeout"])
    const pdfPath = `${DIR}/${PROJECT_HIDDEN_DIR}/attachments/${UUID}/合同.pdf`
    const pdfCall = (output: string) =>
      readCall("prt_t", "msg_a1", pdfPath, { origin: "alpha-pdf", name: "read_pdf", state: { output } })
    const pdfBase = { msg_u1: [textPart("prt_u", "msg_u1", "看看"), staged("prt_s", "msg_u1", pdfMeta)] }
    expect(readsOf(run({ ...pdfBase, msg_a1: [pdfCall(JSON.stringify({ path: pdfPath, pages: ["", " \n"] }))] }, { services: connected }))).toEqual(["empty"])
    expect(readsOf(run({ ...pdfBase, msg_a1: [pdfCall(JSON.stringify({ path: pdfPath, pages: ["", "第 2 页"] }))] }, { services: connected }))).toEqual(["read"])
  })

  test("没有读取调用:读取工具不可用 ⇒ 读取失败(没有启动);回合在跑 ⇒ 准备中 / 等助手读取;回合结束 ⇒ 这一轮没有读取", () => {
    const parts = { msg_u1: [textPart("prt_u", "msg_u1", "看看"), staged("prt_s", "msg_u1", docMeta)] }
    const running = [userMsg("msg_u1", 1000), assistantMsg("msg_a1", "msg_u1", { time: { created: 10 } })]
    expect(readsOf(run(parts, { services: {} }))).toEqual(["failed:not-running"])
    expect(readsOf(run(parts, { services: { "alpha-word": { status: "failed", error: "spawn ENOENT" } }, status: "busy", messages: running }))).toEqual(["failed:not-running"])
    expect(readsOf(run(parts, { services: { "alpha-word": { status: "disabled" } } }))).toEqual(["failed:not-running"])
    expect(readsOf(run(parts, { services: { "alpha-word": { status: "pending" } }, status: "busy", messages: running }))).toEqual(["waiting"])
    expect(readsOf(run(parts, { services: connected, status: "busy", messages: running }))).toEqual(["saved"])
    expect(readsOf(run(parts, { services: connected }))).toEqual(["not-read"])
    // 状态还没取到:不下「失败」的结论。
    expect(readsOf(run(parts, { services: undefined }))).toEqual(["not-read"])
    expect(readsOf(run(parts, { services: undefined, status: "busy", messages: running }))).toEqual(["saved"])
  })

  test("文本「已随消息发出」、图片带缩略图源;重载(从持久化的 JSON 再投影一次)状态不变;读取结果变了行的 rev 跟着变", () => {
    const parts: Record<string, Part[]> = {
      msg_u1: [
        textPart("prt_u", "msg_u1", "看看"),
        filePart("prt_i", "msg_u1"),
        filePart("prt_m", "msg_u1", { mime: "text/plain", filename: "纪要.md", url: "data:text/plain;base64,aGVsbG8=" }),
        staged("prt_s", "msg_u1", docMeta),
      ],
      msg_a1: [readCall("prt_t", "msg_a1", absolute)],
    }
    const rows = run(parts, { services: connected })
    const user = rows[0]!
    if (user.kind !== "user") throw new Error("expected user row")
    expect(user.attachments.map((a) => [a.name, a.media, a.read?.kind ?? "-", a.url ?? "-", a.size])).toEqual([
      ["screenshot.png", "image", "-", "data:image/png;base64,xxxx", 3],
      ["纪要.md", "file", "sent", "-", 5],
      ["需求说明 v3.docx", "file", "read", "-", 942_080],
    ])
    expect(user.attachments[2]!.staged).toEqual(docMeta as never)
    const reloaded = JSON.parse(JSON.stringify(parts)) as Record<string, Part[]>
    expect(readsOf(run(reloaded, { services: connected }))).toEqual(["-", "sent", "read"])
    const unread = run({ msg_u1: parts.msg_u1! }, { services: connected })[0]!
    expect(unread.kind === "user" && unread.rev !== user.rev).toBe(true)
  })
})
