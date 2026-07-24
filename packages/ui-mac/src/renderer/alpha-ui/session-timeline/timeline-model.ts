// REQ-125 C5 — alpha 时间线行模型(纯投影,零 DOM、零上游组件)。
//
// 输入 = SDK typed 通道的地面真相(serverSync().session.data 的 message/part/session_status),
// 输出 = 视图可直接 <For> 的行数组。设计:
//   · 行对象只承载「结构」(kind/key/引用),内容(text/时长/工具状态)由视图经 solid store
//     proxy 反应式读取 —— 流式 delta 不重建行 DOM;
//   · reuseTimelineRows 以 key+rev+proxy 同一性做行复用,保证 <For> 的引用稳定;
//   · 工具/子任务/媒体等非文本 part 一律投影为占位行(C6 换成真卡),消息流不断链;
//   · 未知 part 类型 fail-closed:不渲染、不猜测(不注入任何内容);
//   · I7 有界:boundedText 把超大文本截断后才交给渲染管线(sanitizer/Shiki 不吃整串)。
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

/** I7 资源耗尽面:单块内容进渲染管线前的硬上限(字符)。 */
export const MARKDOWN_MAX_CHARS = 60_000
export const USER_TEXT_MAX_CHARS = 20_000
export const REASONING_MAX_CHARS = 20_000

export function boundedText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return { text: text.slice(0, max), truncated: true }
}

export interface TimelineSegment {
  text: string
  kind?: "file" | "agent"
}

export interface TimelineAttachment {
  partID: string
  name: string
  media: "image" | "file"
  label: string
}

export interface TimelineComment {
  partID: string
  path: string
  comment: string
  startLine?: number
  endLine?: number
}

export type TimelineRow =
  | { kind: "turn"; key: string; rev: string; userMessageID: string; createdAt: number }
  | {
      kind: "user"
      key: string
      rev: string
      message: UserMessage
      text: string
      truncated: boolean
      segments: TimelineSegment[]
      attachments: TimelineAttachment[]
      comments: TimelineComment[]
    }
  | { kind: "reasoning"; key: string; rev: string; part: ReasoningPart; streaming: boolean }
  | { kind: "markdown"; key: string; rev: string; part: TextPart; streaming: boolean }
  | { kind: "placeholder"; key: string; rev: string; part: Part; tool?: string }
  | { kind: "divider"; key: string; rev: string; userMessageID: string; label: "compaction" | "interrupted" }
  | { kind: "thinking"; key: string; rev: string; userMessageID: string }

export interface TimelineProjectionInput {
  messages: readonly Message[]
  partsOf: (messageID: string) => readonly Part[]
  /** session_status[sessionID].type;缺省视为 "idle"。 */
  status: string
}

/** 用户消息里被 dock/审批面接管、时间线不渲染的工具。 */
const HIDDEN_TOOLS = new Set(["todowrite"])

function attachmentOf(part: FilePart): TimelineAttachment | undefined {
  if (!part.url.startsWith("data:")) return undefined
  const name = part.filename?.trim() || part.mime
  return {
    partID: part.id,
    name,
    media: part.mime.startsWith("image/") ? "image" : "file",
    label: attachmentLabel(name, part.mime),
  }
}

function attachmentLabel(name: string, mime: string) {
  if (mime.startsWith("image/")) return mime.slice("image/".length).toUpperCase()
  if (mime === "application/pdf") return "PDF"
  const base = name.split("/").at(-1) ?? name
  const dot = base.lastIndexOf(".")
  if (dot <= 0) return "FILE"
  return base.slice(dot + 1).toUpperCase()
}

const COMMENT_NOTE_RE =
  /^The user made the following comment regarding (this file|line (\d+)|lines (\d+) through (\d+)) of (.+?): ([\s\S]+)$/

/** 与上游 send 侧约定一致的评论载体:synthetic text part + opencodeComment metadata(或字面 note)。 */
export function commentOf(part: Part): TimelineComment | undefined {
  if (part.type !== "text" || !part.synthetic) return undefined
  const meta = (part.metadata as { opencodeComment?: unknown } | undefined)?.opencodeComment
  if (meta && typeof meta === "object") {
    const path = (meta as { path?: unknown }).path
    const comment = (meta as { comment?: unknown }).comment
    if (typeof path === "string" && typeof comment === "string") {
      const selection = (meta as { selection?: { startLine?: unknown; endLine?: unknown } }).selection
      const startLine = Number(selection?.startLine)
      const endLine = Number(selection?.endLine)
      return {
        partID: part.id,
        path,
        comment,
        startLine: Number.isFinite(startLine) ? startLine : undefined,
        endLine: Number.isFinite(endLine) ? endLine : undefined,
      }
    }
  }
  const match = part.text?.match(COMMENT_NOTE_RE)
  if (!match) return undefined
  const start = match[2] ? Number(match[2]) : match[3] ? Number(match[3]) : undefined
  const end = match[2] ? Number(match[2]) : match[4] ? Number(match[4]) : undefined
  return { partID: part.id, path: match[5]!, comment: match[6]!, startLine: start, endLine: end }
}

/** 按 file/agent part 的 source 区间把用户文本切成提及片段(区间越界/重叠即忽略,fail-closed)。 */
export function segmentUserText(
  text: string,
  spans: readonly { start: number; end: number; kind: "file" | "agent" }[],
): TimelineSegment[] {
  const ordered = [...spans]
    .filter((span) => Number.isFinite(span.start) && Number.isFinite(span.end))
    .filter((span) => span.start >= 0 && span.end > span.start && span.end <= text.length)
    .sort((a, b) => a.start - b.start)
  const result: TimelineSegment[] = []
  let cursor = 0
  for (const span of ordered) {
    if (span.start < cursor) continue
    if (span.start > cursor) result.push({ text: text.slice(cursor, span.start) })
    result.push({ text: text.slice(span.start, span.end), kind: span.kind })
    cursor = span.end
  }
  if (cursor < text.length) result.push({ text: text.slice(cursor) })
  return result
}

function mentionSpans(parts: readonly Part[]) {
  const spans: { start: number; end: number; kind: "file" | "agent" }[] = []
  for (const part of parts) {
    if (part.type === "file" && !part.url.startsWith("data:")) {
      const textSource = part.source?.text
      if (textSource && textSource.start !== undefined && textSource.end !== undefined)
        spans.push({ start: textSource.start, end: textSource.end, kind: "file" })
      continue
    }
    if (part.type === "agent" && part.source) spans.push({ start: part.source.start, end: part.source.end, kind: "agent" })
  }
  return spans
}

function renderableToolPart(part: ToolPart) {
  if (HIDDEN_TOOLS.has(part.tool)) return false
  // question 的 pending/running 渲染在 composer dock(C7 领域),时间线只保留已回答的记录。
  if (part.tool === "question") return part.state.status !== "pending" && part.state.status !== "running"
  return true
}

export function projectTimelineRows(input: TimelineProjectionInput): TimelineRow[] {
  const rows: TimelineRow[] = []
  const users: UserMessage[] = []
  const assistantsByParent = new Map<string, AssistantMessage[]>()

  for (const message of input.messages) {
    if (message.role === "user") {
      users.push(message)
      continue
    }
    const existing = assistantsByParent.get(message.parentID)
    if (existing) existing.push(message)
    else assistantsByParent.set(message.parentID, [message])
  }

  const streamingAssistant =
    input.status === "busy"
      ? [...input.messages]
          .reverse()
          .find(
            (message): message is AssistantMessage =>
              message.role === "assistant" && typeof message.time.completed !== "number",
          )
      : undefined
  const activeUserID =
    (streamingAssistant && users.some((user) => user.id === streamingAssistant.parentID)
      ? streamingAssistant.parentID
      : undefined) ?? (input.status !== "idle" ? users.at(-1)?.id : undefined)

  users.forEach((userMessage, index) => {
    if (index > 0)
      rows.push({
        kind: "turn",
        key: `turn:${userMessage.id}`,
        rev: String(userMessage.time.created),
        userMessageID: userMessage.id,
        createdAt: userMessage.time.created,
      })

    const userParts = input.partsOf(userMessage.id)
    const textPart = userParts.find(
      (part): part is TextPart => part.type === "text" && !part.synthetic,
    )
    const rawText = textPart?.text ?? ""
    const { text, truncated } = boundedText(rawText, USER_TEXT_MAX_CHARS)
    const segments = segmentUserText(text, mentionSpans(userParts))
    const attachments = userParts.flatMap((part) => (part.type === "file" ? (attachmentOf(part) ?? []) : []))
    const comments = userParts.flatMap((part) => commentOf(part) ?? [])

    if (text || attachments.length > 0 || comments.length > 0)
      rows.push({
        kind: "user",
        key: `user:${userMessage.id}`,
        rev: [
          text,
          String(truncated),
          segments.map((segment) => `${segment.kind ?? "t"}:${segment.text.length}`).join(","),
          attachments.map((attachment) => attachment.partID).join(","),
          comments.map((comment) => comment.partID).join(","),
        ].join("§"),
        message: userMessage,
        text,
        truncated,
        segments,
        attachments,
        comments,
      })

    if (userParts.some((part) => part.type === "compaction"))
      rows.push({
        kind: "divider",
        key: `compaction:${userMessage.id}`,
        rev: "compaction",
        userMessageID: userMessage.id,
        label: "compaction",
      })

    let emitted = 0
    for (const assistant of assistantsByParent.get(userMessage.id) ?? []) {
      const parts = input.partsOf(assistant.id)
      const streamingHere = streamingAssistant?.id === assistant.id
      const lastVisible = streamingHere
        ? [...parts]
            .reverse()
            .find(
              (part) =>
                (part.type === "text" && !!part.text?.trim()) ||
                (part.type === "reasoning" && !!part.text?.trim()) ||
                (part.type === "tool" && renderableToolPart(part)) ||
                part.type === "subtask" ||
                part.type === "file",
            )
        : undefined
      for (const part of parts) {
        switch (part.type) {
          case "text": {
            if (!part.text?.trim()) continue
            rows.push({
              kind: "markdown",
              key: `md:${part.id}`,
              rev: String(streamingHere && lastVisible === part),
              part,
              streaming: streamingHere && lastVisible === part,
            })
            emitted += 1
            continue
          }
          case "reasoning": {
            if (!part.text?.trim()) continue
            rows.push({
              kind: "reasoning",
              key: `reason:${part.id}`,
              rev: String(streamingHere && part.time.end === undefined),
              part,
              streaming: streamingHere && part.time.end === undefined,
            })
            emitted += 1
            continue
          }
          case "tool": {
            if (!renderableToolPart(part)) continue
            rows.push({ kind: "placeholder", key: `part:${part.id}`, rev: `tool:${part.tool}`, part, tool: part.tool })
            emitted += 1
            continue
          }
          case "subtask":
          case "file": {
            rows.push({ kind: "placeholder", key: `part:${part.id}`, rev: part.type, part })
            emitted += 1
            continue
          }
          default:
            // agent/snapshot/retry/compaction 等非文本流 part:C5 无视觉合同,fail-closed 不渲染。
            continue
        }
      }
      if (assistant.error?.name === "MessageAbortedError")
        rows.push({
          kind: "divider",
          key: `interrupted:${assistant.id}`,
          rev: "interrupted",
          userMessageID: userMessage.id,
          label: "interrupted",
        })
    }

    if (userMessage.id === activeUserID && input.status === "busy" && emitted === 0)
      rows.push({ kind: "thinking", key: `thinking:${userMessage.id}`, rev: "", userMessageID: userMessage.id })
  })

  return rows
}

/** 行复用:key+kind+rev 相同且承载的 store proxy 同一 → 保留旧行对象(<For> 引用稳定,流式不重建 DOM)。 */
export function reuseTimelineRows(
  previous: readonly TimelineRow[] | undefined,
  next: TimelineRow[],
): TimelineRow[] {
  if (!previous || previous.length === 0) return next
  const byKey = new Map(previous.map((row) => [row.key, row] as const))
  let reused = 0
  const result = next.map((row) => {
    const before = byKey.get(row.key)
    if (!before || before.kind !== row.kind || before.rev !== row.rev) return row
    if ("part" in before && "part" in row && before.part !== row.part) return row
    if (before.kind === "user" && row.kind === "user" && before.message !== row.message) return row
    reused += 1
    return before
  })
  if (reused === next.length && previous.length === next.length) return previous as TimelineRow[]
  return result
}
