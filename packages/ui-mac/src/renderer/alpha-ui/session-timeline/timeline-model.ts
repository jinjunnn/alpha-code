// REQ-125 C5/C6 — alpha 时间线行模型(纯投影,零 DOM、零上游组件)。
//
// 输入 = SDK typed 通道的地面真相(serverSync().session.data 的 message/part/session_status),
// 输出 = 视图可直接 <For> 的行数组。设计:
//   · 行对象只承载「结构」(kind/key/引用),内容(text/时长/工具状态)由视图经 solid store
//     proxy 反应式读取 —— 流式 delta 不重建行 DOM;
//   · reuseTimelineRows 以 key+rev+proxy 同一性做行复用,保证 <For> 的引用稳定;
//   · 工具 part → tool 行(C6 真卡);连续已完成的探查类工具 ≥2 个 → toolgroup 折叠组;
//     助手侧 file part → media 预览行;完成的 cloud_* 工具 → artifacts 产物链接行;
//   · 回合级错误(非中断)→ turnError 行;session_status=retry → retry 行(对齐 v2 行模型);
//   · 未知 part 类型 fail-closed:不渲染、不猜测(subtask 同上游 v1/v2 一致不渲染);
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
export const TURN_ERROR_MAX_CHARS = 4_000
export const RETRY_MESSAGE_MAX_CHARS = 500

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

/** 产物链接行的一条链接(名字来自完成态 cloud 工具输出,fail-closed:解析不出即无行)。 */
export interface TimelineArtifactLink {
  runId: string
  name: string
}

/** 媒体预览行的数据快照(写一次:工具附件/顶层 file part 在完成后不再变)。 */
export interface TimelineMediaSource {
  /** 产生它的 part(顶层 file part 自身,或所属 tool part)。 */
  partID: string
  name: string
  mime: string
  url: string
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
  | { kind: "tool"; key: string; rev: string; part: ToolPart; tool: string }
  | { kind: "toolgroup"; key: string; rev: string; parts: ToolPart[] }
  | { kind: "media"; key: string; rev: string; media: TimelineMediaSource }
  | { kind: "artifacts"; key: string; rev: string; partID: string; links: TimelineArtifactLink[] }
  | { kind: "retry"; key: string; rev: string; userMessageID: string; attempt: number; message: string }
  | { kind: "turnError"; key: string; rev: string; userMessageID: string; name: string; message: string }
  | { kind: "divider"; key: string; rev: string; userMessageID: string; label: "compaction" | "interrupted" }
  | { kind: "thinking"; key: string; rev: string; userMessageID: string }

export interface TimelineProjectionInput {
  messages: readonly Message[]
  partsOf: (messageID: string) => readonly Part[]
  /** session_status[sessionID].type;缺省视为 "idle"。 */
  status: string
  /** session_status[sessionID] 为 retry 时的载荷(attempt/message),对齐 v2 行模型的 Retry 行。 */
  retry?: { attempt: number; message: string }
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
    if (part.type === "agent" && part.source)
      spans.push({ start: part.source.start, end: part.source.end, kind: "agent" })
  }
  return spans
}

function renderableToolPart(part: ToolPart) {
  if (HIDDEN_TOOLS.has(part.tool)) return false
  // question 的 pending/running 渲染在 composer dock(C7 领域),时间线只保留已回答的记录。
  if (part.tool === "question") return part.state.status !== "pending" && part.state.status !== "running"
  return true
}

/** 「已探索」折叠组的成员工具(与上游 CONTEXT_GROUP_TOOLS 同集合)。 */
const CONTEXT_GROUP_TOOLS = new Set(["read", "glob", "grep", "list"])
/** 连续多少个已完成探查工具起折叠成组(单个保留独立卡)。 */
export const CONTEXT_GROUP_MIN = 2
/** I7:单个折叠组的成员上限;超长连续段切成多个组行。 */
export const CONTEXT_GROUP_MAX = 24

/**
 * 只有「已完成、且无附件」的探查工具进折叠组 —— 运行中/出错的工具保留独立卡
 * (状态可见);带附件(如 read 图片)的保留独立卡,媒体预览行不被折叠吞掉。
 */
function groupableToolPart(part: ToolPart) {
  if (!CONTEXT_GROUP_TOOLS.has(part.tool)) return false
  if (part.state.status !== "completed") return false
  return toolMediaOf(part).length === 0
}

// ── 媒体预览行:工具附件是生产上图片/PDF 的真实通道(processor 完成时写入
// ToolStateCompleted.attachments;顶层 file part 仅用户消息/兜底)。──────────
export const TOOL_ATTACHMENTS_MAX = 6
/** 附件数组的总迭代预算(含非法项)—— 与 cards 列表扫描同一双约束纪律。 */
export const TOOL_ATTACHMENTS_SCAN_MAX = 50
const MEDIA_NAME_MAX = 200

/** 防御读取完成态工具附件(I2):非法条目丢弃;数量与迭代均有界(I7)。 */
export function toolMediaOf(part: ToolPart): TimelineMediaSource[] {
  if (part.state.status !== "completed") return []
  const attachments = part.state.attachments
  if (!Array.isArray(attachments)) return []
  const result: TimelineMediaSource[] = []
  for (let index = 0; index < attachments.length; index += 1) {
    if (index >= TOOL_ATTACHMENTS_SCAN_MAX || result.length >= TOOL_ATTACHMENTS_MAX) break
    const item = attachments[index]
    if (typeof item !== "object" || item === null) continue
    const record = item as { id?: unknown; mime?: unknown; url?: unknown; filename?: unknown }
    if (typeof record.mime !== "string" || !record.mime) continue
    if (typeof record.url !== "string" || !record.url) continue
    const filename = typeof record.filename === "string" ? record.filename.trim() : ""
    result.push({
      partID: typeof record.id === "string" && record.id ? record.id : part.id,
      name: (filename || record.mime).slice(0, MEDIA_NAME_MAX),
      mime: record.mime,
      url: record.url,
    })
  }
  return result
}

export function mediaSourceOfFilePart(part: FilePart): TimelineMediaSource {
  return {
    partID: part.id,
    name: (part.filename?.trim() || part.mime).slice(0, MEDIA_NAME_MAX),
    mime: part.mime,
    url: part.url,
  }
}

// ── 产物链接行(§⑥):完成态 cloud_* 工具输出里的产物名 → 链接行 ─────────────
const CLOUD_TOOL_PREFIX = "cloud_"
export const ARTIFACT_LINKS_MAX = 12
const ARTIFACT_OUTPUT_PARSE_MAX = 100_000
const artifactLinksCache = new WeakMap<object, { output: string; links: TimelineArtifactLink[] }>()

function parseArtifactLinks(output: string): TimelineArtifactLink[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return []
  }
  if (typeof parsed !== "object" || parsed === null) return []
  const record = parsed as { job_id?: unknown; status?: unknown; artifacts?: unknown }
  if (typeof record.job_id !== "string" || !record.job_id) return []
  if (record.status !== "completed") return []
  if (!Array.isArray(record.artifacts)) return []
  const links: TimelineArtifactLink[] = []
  for (const item of record.artifacts) {
    if (links.length >= ARTIFACT_LINKS_MAX) break
    if (typeof item === "string" && item) {
      links.push({ runId: record.job_id, name: item })
      continue
    }
    if (typeof item === "object" && item !== null) {
      const name = (item as { name?: unknown }).name
      if (typeof name === "string" && name) links.push({ runId: record.job_id, name })
    }
  }
  return links
}

/** fail-closed:非 cloud 工具/未完成/输出超限/解析不出 artifacts 名字 → 空(不出行)。 */
export function artifactLinksOf(part: ToolPart): TimelineArtifactLink[] {
  if (!part.tool.startsWith(CLOUD_TOOL_PREFIX)) return []
  if (part.state.status !== "completed") return []
  const output = part.state.output
  if (typeof output !== "string" || output.length === 0 || output.length > ARTIFACT_OUTPUT_PARSE_MAX) return []
  const cached = artifactLinksCache.get(part)
  if (cached && cached.output === output) return cached.links
  const links = parseArtifactLinks(output)
  artifactLinksCache.set(part, { output, links })
  return links
}

/** 回合级错误(排除中断):读第一个出错助手消息的 name+message,均有界(I7)。 */
export function turnErrorOf(assistants: readonly AssistantMessage[]): { name: string; message: string } | undefined {
  const failed = assistants.find((message) => message.error && message.error.name !== "MessageAbortedError")
  if (!failed?.error) return undefined
  const data = (failed.error as { data?: { message?: unknown } }).data
  const raw = typeof data?.message === "string" ? data.message : ""
  return { name: failed.error.name, message: boundedText(raw, TURN_ERROR_MAX_CHARS).text }
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
    const textPart = userParts.find((part): part is TextPart => part.type === "text" && !part.synthetic)
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
    const assistants = assistantsByParent.get(userMessage.id) ?? []

    // 连续已完成的探查工具缓冲:≥ CONTEXT_GROUP_MIN 折叠成「已探索」组,单个保留独立卡;
    // 单组成员 ≤ CONTEXT_GROUP_MAX(I7),超长连续段切成多个组行。
    let contextRun: ToolPart[] = []
    const pushToolRow = (part: ToolPart) => {
      rows.push({ kind: "tool", key: `part:${part.id}`, rev: `tool:${part.tool}`, part, tool: part.tool })
      const links = artifactLinksOf(part)
      if (links.length > 0)
        rows.push({
          kind: "artifacts",
          key: `artifacts:${part.id}`,
          rev: links.map((link) => `${link.runId}/${link.name}`).join("|"),
          partID: part.id,
          links,
        })
      // 工具附件(生产上图片/PDF 的真实通道)→ 媒体预览行,挂在工具卡之后。
      toolMediaOf(part).forEach((media, index) => {
        rows.push({
          kind: "media",
          key: `media:${part.id}:${index}`,
          rev: `${media.mime}§${media.name}§${media.url.length}`,
          media,
        })
      })
    }
    const flushContextRun = () => {
      if (contextRun.length === 0) return
      const run = contextRun
      contextRun = []
      for (let start = 0; start < run.length; start += CONTEXT_GROUP_MAX) {
        const chunk = run.slice(start, start + CONTEXT_GROUP_MAX)
        if (chunk.length >= CONTEXT_GROUP_MIN) {
          rows.push({
            kind: "toolgroup",
            key: `group:${chunk[0]!.id}`,
            rev: chunk.map((part) => part.id).join("|"),
            parts: chunk,
          })
        } else {
          chunk.forEach(pushToolRow)
        }
      }
    }

    for (const assistant of assistants) {
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
                part.type === "file",
            )
        : undefined
      for (const part of parts) {
        switch (part.type) {
          case "text": {
            if (!part.text?.trim()) continue
            flushContextRun()
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
            flushContextRun()
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
            if (groupableToolPart(part)) contextRun.push(part)
            else {
              flushContextRun()
              pushToolRow(part)
            }
            emitted += 1
            continue
          }
          case "file": {
            flushContextRun()
            const media = mediaSourceOfFilePart(part)
            rows.push({
              kind: "media",
              key: `part:${part.id}`,
              rev: `${media.mime}§${media.name}§${media.url.length}`,
              media,
            })
            emitted += 1
            continue
          }
          default:
            // agent/snapshot/subtask/retry/compaction 等非文本流 part:无视觉合同,fail-closed
            // 不渲染(subtask 与上游 v1/v2 行为一致;retry 行由 session_status 驱动)。
            continue
        }
      }
      flushContextRun()
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

    if (userMessage.id === activeUserID && input.status === "retry" && input.retry) {
      const message = boundedText(input.retry.message, RETRY_MESSAGE_MAX_CHARS).text
      rows.push({
        kind: "retry",
        key: `retry:${userMessage.id}`,
        rev: `${input.retry.attempt}§${message}`,
        userMessageID: userMessage.id,
        attempt: input.retry.attempt,
        message,
      })
    }

    const turnError = turnErrorOf(assistants)
    if (turnError)
      rows.push({
        kind: "turnError",
        key: `turn-error:${userMessage.id}`,
        rev: `${turnError.name}§${turnError.message}`,
        userMessageID: userMessage.id,
        name: turnError.name,
        message: turnError.message,
      })
  })

  return rows
}

/** 行复用:key+kind+rev 相同且承载的 store proxy 同一 → 保留旧行对象(<For> 引用稳定,流式不重建 DOM)。 */
export function reuseTimelineRows(previous: readonly TimelineRow[] | undefined, next: TimelineRow[]): TimelineRow[] {
  if (!previous || previous.length === 0) return next
  const byKey = new Map(previous.map((row) => [row.key, row] as const))
  let reused = 0
  const result = next.map((row) => {
    const before = byKey.get(row.key)
    if (!before || before.kind !== row.kind || before.rev !== row.rev) return row
    if ("part" in before && "part" in row && before.part !== row.part) return row
    if (before.kind === "user" && row.kind === "user" && before.message !== row.message) return row
    if (before.kind === "toolgroup" && row.kind === "toolgroup") {
      if (before.parts.length !== row.parts.length) return row
      if (before.parts.some((part, index) => part !== row.parts[index])) return row
    }
    reused += 1
    return before
  })
  if (reused === next.length && previous.length === next.length) return previous as TimelineRow[]
  return result
}
