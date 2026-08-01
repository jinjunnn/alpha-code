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
import type { AlphaSessionIdentity } from "../session-workspace/session-workspace-core"

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
  kind?: "file" | "agent" | "resource"
  /** 连接器段(resource)的来源名 = ResourceSource.clientName;其余形态诚实缺席。 */
  label?: string
}

/** 连接器来源名的字段帽(I7)。 */
export const MENTION_LABEL_MAX_CHARS = 60

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

// ── 斜杠命令 chip 的 typed 数据源(C7 session-slash-origin 登记;缺席零渲染) ──
/**
 * send 时 composer 捕获的一条命令来源登记(C7 SessionSlashOrigin 的消费面投影):
 * assistantMessageID 缺席(send 响应未带)= 对不上任何回合,该登记不出 chip。
 */
export interface TimelineSlashOrigin {
  /** send 响应捕获的 assistant messageID(用于对齐所属回合)。 */
  assistantMessageID?: string
  command: string
  arguments?: string
}

/** C7 的供给接口(sessionSlashOriginsFor);workspace 装配传入,缺席零渲染。 */
export type SessionSlashOriginsFor = (identity: AlphaSessionIdentity) => readonly TimelineSlashOrigin[]

/** 斜杠登记的字段帽与扫描预算(I7)。 */
export const SLASH_COMMAND_MAX_CHARS = 200
export const SLASH_ARGUMENTS_MAX_CHARS = 400
export const SLASH_ORIGINS_SCAN_MAX = 100

/** 回合末富脚注(A6/A7)的数据快照;缺字段诚实缺席。 */
export interface TimelineFootnote {
  /** provider 图标的来源(providerID);缺席即无图标。 */
  provider?: string
  agent?: string
  model?: string
  /** input+output+reasoning 合计;非有限或 ≤0 → 缺席。 */
  tokens?: number
  durationMs?: number
  /** 效率段:本回合提示词的缓存命中率(0–100 整数);无缓存读取即缺席(见 footnoteOf)。 */
  cacheHit?: number
}

/** 本回合改动汇总(S2)的一行;file = 服务端 git 相对路径(review 面板同一货币)。 */
export interface TimelineTurnDiffFile {
  file: string
  additions: number
  deletions: number
}

export const TURN_DIFF_FILES_MAX = 24
export const TURN_DIFF_SCAN_MAX = 200
const TURN_DIFF_FILE_MAX_CHARS = 400
const FOOTNOTE_FIELD_MAX_CHARS = 120

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
      /** 斜杠命令来源(C7 可选供给;缺席 = 普通气泡)。 */
      slash?: { command: string; arguments?: string }
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
  | {
      kind: "footnote"
      key: string
      rev: string
      userMessageID: string
      footnote: TimelineFootnote
      /** 复制正文(该回合全部助手 text part;调用时从数据面取,不预存大字符串)。 */
      copyText: () => string
    }
  | {
      kind: "diffsum"
      key: string
      rev: string
      userMessageID: string
      files: TimelineTurnDiffFile[]
      additions: number
      deletions: number
      truncated: boolean
    }

export interface TimelineProjectionInput {
  messages: readonly Message[]
  partsOf: (messageID: string) => readonly Part[]
  /** session_status[sessionID].type;缺省视为 "idle"。 */
  status: string
  /** session_status[sessionID] 为 retry 时的载荷(attempt/message),对齐 v2 行模型的 Retry 行。 */
  retry?: { attempt: number; message: string }
  /** 斜杠命令来源登记(C7 可选供给;缺席 = 不出 chip,fail-closed)。 */
  slashOrigins?: readonly TimelineSlashOrigin[]
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
  spans: readonly { start: number; end: number; kind: "file" | "agent" | "resource"; label?: string }[],
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
    result.push({
      text: text.slice(span.start, span.end),
      kind: span.kind,
      ...(span.label ? { label: span.label } : {}),
    })
    cursor = span.end
  }
  if (cursor < text.length) result.push({ text: text.slice(cursor) })
  return result
}

function mentionSpans(parts: readonly Part[]) {
  const spans: { start: number; end: number; kind: "file" | "agent" | "resource"; label?: string }[] = []
  for (const part of parts) {
    if (part.type === "file" && !part.url.startsWith("data:")) {
      const source = part.source
      const textSource = source?.text
      if (!textSource || textSource.start === undefined || textSource.end === undefined) continue
      const span = { start: textSource.start, end: textSource.end }
      // 连接器提及(MCP 资源):来源名 = clientName;名字缺席则退回普通文件提及(fail-closed,
      // 不出没有名字的 chip)。
      //
      // 上游数据面缺口登记(#588,审计 R1):这条 resource 分支当前在生产不可达 ——
      // ① Alpha composer 只支持 file/agent 提及,V2 PromptInput 没有携带 clientName/uri 的
      //    resource 身份;② 旧 V1 路径收到 resource part 后,在 packages/opencode/src/session/
      //    prompt.ts(resolveUserPart,source.type==="resource" 分支,~L703)把原 part 替换成
      //    synthetic text/blob part,不保留 source.type==="resource" 的原件。
      // 按 #588 票面「上游数据面缺失则登记并保证组件可由模型构造」履约:本分支由模型可
      // 构造性契约与组件/单元测试覆盖;上游补齐 resource part 持久化后无需改动即生效。
      // 不在此伪造数据面、不改上游(跨票边界)。
      if (source.type === "resource" && typeof source.clientName === "string" && source.clientName.length > 0)
        spans.push({ ...span, kind: "resource", label: source.clientName.slice(0, MENTION_LABEL_MAX_CHARS) })
      else spans.push({ ...span, kind: "file" })
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

// ── 回合末富脚注(A6):数据源 = 已消费的 SDK 助手消息元数据 ──────────────────
function cappedField(value: unknown, max = FOOTNOTE_FIELD_MAX_CHARS): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined
  return value.length > max ? value.slice(0, max) : value
}

/**
 * 回合末脚注:只认「回合尾态 = 成功完成」——回合**最后一个**助手消息必须已完成且
 * 无错误,否则无脚注;不回溯早先的完成助手(成功→流式、成功→失败序列一律零脚注,
 * 旧指标不得与未终结/失败内容混用;复制动作随行同门)。字段独立诚实缺席(I2)。
 */
export function footnoteOf(assistants: readonly AssistantMessage[]): TimelineFootnote | undefined {
  const source = assistants.at(-1)
  if (!source || typeof source.time.completed !== "number" || source.error) return undefined
  const footnote: TimelineFootnote = {}
  footnote.provider = cappedField(source.providerID)
  footnote.agent = cappedField(source.agent)
  footnote.model = cappedField(source.modelID)
  const tokens = source.tokens
  if (typeof tokens === "object" && tokens !== null) {
    const total = [tokens.input, tokens.output, tokens.reasoning]
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0)
      .reduce((sum, value) => sum + value, 0)
    if (total > 0) footnote.tokens = total
    // 效率段:本回合提示词的缓存命中率 = cache.read /(cache.read + cache.write + input)。
    // 分母是完整提示词:session.ts getUsage 已把 tokens.input 规范化为「非缓存输入」
    // (inputTokens − cacheRead − cacheWrite),read/write/input 三段互斥 —— 分母漏掉
    // write 会把档位系统性算高(审计 R1 Blocker:input=500/read=200/write=300 曾显示
    // 29%「中」,真实 200/1000=20%「低」)。cache.read 为 0 时无法区分「模型不支持缓存」
    // 与「首轮冷启动」,一律缺席 —— 不拿零值装成「效率低」。
    const cached = tokens.cache?.read
    if (typeof cached === "number" && Number.isFinite(cached) && cached > 0) {
      const nonCached = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0)
      const prompt = cached + nonCached(tokens.cache?.write) + nonCached(tokens.input)
      footnote.cacheHit = Math.round((cached / prompt) * 100)
    }
  }
  const completed = source.time.completed
  if (typeof completed === "number" && Number.isFinite(source.time.created) && completed >= source.time.created)
    footnote.durationMs = completed - source.time.created
  return footnote
}

/** 复制正文:该回合全部助手的非 synthetic text part,按顺序以空行连接。 */
export function turnCopyText(
  assistants: readonly AssistantMessage[],
  partsOf: (messageID: string) => readonly Part[],
): string {
  const blocks: string[] = []
  for (const assistant of assistants) {
    for (const part of partsOf(assistant.id)) {
      if (part.type !== "text" || part.synthetic) continue
      const text = part.text?.trim()
      if (text) blocks.push(text)
    }
  }
  return blocks.join("\n\n")
}

// ── 本回合改动汇总(S2):数据源 = userMessage.summary.diffs(服务端回合后写入) ──
/** 非负有限数才合法;其余(含缺失/NaN/负数)= 畸形,整条丢弃(审计 minor)。 */
function diffCountOf(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined
  return Math.floor(value)
}

/**
 * I2/I7 防御读取:畸形条目**整条丢弃**——超长文件名不截断(截断会指向另一个路径)、
 * 非法 ±行数不改写为 0(不伪造统计);项数帽 + 扫描预算;无合法行 → undefined。
 */
export function turnDiffsOf(message: UserMessage): {
  files: TimelineTurnDiffFile[]
  additions: number
  deletions: number
  truncated: boolean
} | undefined {
  const diffs = message.summary?.diffs
  if (!Array.isArray(diffs) || diffs.length === 0) return undefined
  const files: TimelineTurnDiffFile[] = []
  let truncated = false
  for (let index = 0; index < diffs.length; index += 1) {
    if (index >= TURN_DIFF_SCAN_MAX || files.length >= TURN_DIFF_FILES_MAX) {
      truncated = true
      break
    }
    const item = diffs[index]
    if (typeof item !== "object" || item === null) continue
    const record = item as { file?: unknown; additions?: unknown; deletions?: unknown }
    if (typeof record.file !== "string" || record.file.length === 0) continue
    if (record.file.length > TURN_DIFF_FILE_MAX_CHARS) continue
    const additions = diffCountOf(record.additions)
    const deletions = diffCountOf(record.deletions)
    if (additions === undefined || deletions === undefined) continue
    files.push({ file: record.file, additions, deletions })
  }
  if (files.length === 0) return undefined
  return {
    files,
    additions: files.reduce((sum, row) => sum + row.additions, 0),
    deletions: files.reduce((sum, row) => sum + row.deletions, 0),
    truncated,
  }
}

// ── 面板联动的路径纪律(I1,审计 Major-2) ───────────────────────────────────
const DRIVE_LETTER_RE = /^[A-Za-z]:/

/**
 * 把「在面板打开」目标证明为安全的 workspace-relative 路径(review 面板货币):
 * 只接受 ①位于 identity.directory 之下的绝对路径(剥前缀)②本就相对的路径;
 * 归一(\→/)后不得残留 ".."/"."/空段/盘符/绝对残留。无法证明 → undefined,
 * 消费侧零动作(pill/diffsum 同门;不把工作区外的路径递进 jumpToReview)。
 */
export function reviewPathOf(path: string, directory: string): string | undefined {
  const normalized = path.replaceAll("\\", "/")
  const root = directory.replaceAll("\\", "/").replace(/\/+$/, "")
  let relative: string | undefined
  if (root && normalized.startsWith(`${root}/`)) relative = normalized.slice(root.length + 1)
  else if (!normalized.startsWith("/") && !DRIVE_LETTER_RE.test(normalized)) relative = normalized
  if (!relative) return undefined
  if (DRIVE_LETTER_RE.test(relative)) return undefined
  const segments = relative.split("/")
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) return undefined
  return relative
}

// ── 斜杠命令 chip:登记按 assistant messageID 对齐所属回合 ───────────────────
/** fail-closed:登记缺席/字段非法/对不上回合 → undefined(不出 chip)。 */
export function slashOriginForTurn(
  origins: readonly TimelineSlashOrigin[] | undefined,
  assistantIDs: ReadonlySet<string>,
): { command: string; arguments?: string } | undefined {
  if (!Array.isArray(origins)) return undefined
  for (let index = 0; index < origins.length && index < SLASH_ORIGINS_SCAN_MAX; index += 1) {
    const item = origins[index]
    if (typeof item !== "object" || item === null) continue
    const record = item as { assistantMessageID?: unknown; command?: unknown; arguments?: unknown }
    if (typeof record.assistantMessageID !== "string" || !assistantIDs.has(record.assistantMessageID)) continue
    if (typeof record.command !== "string" || record.command.length === 0) continue
    const args = typeof record.arguments === "string" && record.arguments.length > 0 ? record.arguments : undefined
    return {
      command: record.command.slice(0, SLASH_COMMAND_MAX_CHARS),
      arguments: args?.slice(0, SLASH_ARGUMENTS_MAX_CHARS),
    }
  }
  return undefined
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
    const turnAssistants = assistantsByParent.get(userMessage.id) ?? []
    const slash = slashOriginForTurn(input.slashOrigins, new Set(turnAssistants.map((message) => message.id)))

    if (text || attachments.length > 0 || comments.length > 0 || slash)
      rows.push({
        kind: "user",
        key: `user:${userMessage.id}`,
        rev: [
          text,
          String(truncated),
          segments.map((segment) => `${segment.kind ?? "t"}:${segment.text.length}:${segment.label ?? ""}`).join(","),
          attachments.map((attachment) => attachment.partID).join(","),
          comments.map((comment) => comment.partID).join(","),
          slash ? `${slash.command}\u0000${slash.arguments ?? ""}` : "",
        ].join("§"),
        message: userMessage,
        text,
        truncated,
        segments,
        attachments,
        comments,
        slash,
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
    const assistants = turnAssistants

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

    // 回合末富脚注(A6):只在回合尾态成功完成且有可见内容时出行;当前活跃回合
    // (busy/retry 等非 idle)尾态未定,一律不出(审计 Major-1)。
    const turnActive = userMessage.id === activeUserID && input.status !== "idle"
    const footnote = emitted > 0 && !turnActive ? footnoteOf(assistants) : undefined
    if (footnote)
      rows.push({
        kind: "footnote",
        key: `footnote:${userMessage.id}`,
        rev: [
          footnote.provider ?? "",
          footnote.agent ?? "",
          footnote.model ?? "",
          footnote.cacheHit ?? "",
          footnote.tokens ?? "",
          footnote.durationMs ?? "",
        ].join("§"),
        userMessageID: userMessage.id,
        footnote,
        copyText: () => turnCopyText(assistants, input.partsOf),
      })

    // 本回合改动汇总(S2):userMessage.summary.diffs 解析出合法行才出行(fail-closed)。
    const turnDiffs = turnDiffsOf(userMessage)
    if (turnDiffs)
      rows.push({
        kind: "diffsum",
        key: `diffsum:${userMessage.id}`,
        rev: [
          turnDiffs.files.map((row) => `${row.file}:${row.additions}/${row.deletions}`).join(","),
          String(turnDiffs.truncated),
        ].join("§"),
        userMessageID: userMessage.id,
        files: turnDiffs.files,
        additions: turnDiffs.additions,
        deletions: turnDiffs.deletions,
        truncated: turnDiffs.truncated,
      })

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
