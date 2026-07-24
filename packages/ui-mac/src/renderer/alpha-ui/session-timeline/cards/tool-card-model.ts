// REQ-125 C6 — 工具卡纯模型(零 DOM、零 solid、零上游组件)。
//
// 职责:把 SDK typed 通道进来的 ToolPart(I2:消费点窄化,所有 input/metadata 均
// typeof 防御读取)投影成卡片可渲染的结构 —— 分派表(kind)、四态(status)、头部
// (动词/目标/统计)、有界输出体(I7:字符+行数双帽,超限截断并标记)。
// 未知工具 fail-closed:kind="unknown",渲染为有界纯文本通用卡,不猜测形态。
import type { ToolPart, ToolState } from "@opencode-ai/sdk/v2/client"

// ── I7 输出体硬帽 ────────────────────────────────────────────────────────────
export const TOOL_BODY_MAX_CHARS = 16_000
export const TOOL_BODY_MAX_LINES = 400
export const TOOL_LIST_MAX_ITEMS = 50
export const TOOL_LINKS_MAX = 8
export const WRITE_PREVIEW_LINES = 2
export const TOOL_ERROR_MAX_CHARS = 4_000

export interface BoundedBlock {
  text: string
  truncated: boolean
}

/** 字符 + 行数双帽;两者任一超限即截断(截断标记由渲染层显式呈现,不伪装完整)。 */
export function boundedBlock(
  raw: string,
  maxChars = TOOL_BODY_MAX_CHARS,
  maxLines = TOOL_BODY_MAX_LINES,
): BoundedBlock {
  let text = raw
  let truncated = false
  if (text.length > maxChars) {
    text = text.slice(0, maxChars)
    truncated = true
  }
  let lines = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      lines += 1
      if (lines >= maxLines) {
        text = text.slice(0, index)
        truncated = true
        break
      }
    }
  }
  return { text, truncated }
}

// ── 分派表与四态 ────────────────────────────────────────────────────────────
export type ToolCardKind =
  | "read"
  | "list"
  | "glob"
  | "grep"
  | "webfetch"
  | "websearch"
  | "bash"
  | "edit"
  | "write"
  | "apply_patch"
  | "skill"
  | "task"
  | "unknown"

const TOOL_CARD_KINDS: Record<string, ToolCardKind> = {
  read: "read",
  list: "list",
  glob: "glob",
  grep: "grep",
  webfetch: "webfetch",
  websearch: "websearch",
  bash: "bash",
  edit: "edit",
  write: "write",
  apply_patch: "apply_patch",
  skill: "skill",
  task: "task",
}

/** 分派:已知工具 → 专卡分支;其余一律 fail-closed 走未知工具通用卡。 */
export function toolCardKindOf(tool: string): ToolCardKind {
  return TOOL_CARD_KINDS[tool] ?? "unknown"
}

export type ToolCardStatus = "pending" | "running" | "error" | "success"

export function toolCardStatusOf(state: ToolState): ToolCardStatus {
  if (state.status === "pending") return "pending"
  if (state.status === "running") return "running"
  if (state.status === "error") return "error"
  return "success"
}

// ── 防御读取(I2) ──────────────────────────────────────────────────────────
function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function finiteOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function inputOf(part: ToolPart): Record<string, unknown> {
  const input = part.state.input
  return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {}
}

function metadataOf(part: ToolPart): Record<string, unknown> {
  if (!("metadata" in part.state)) return {}
  const metadata = part.state.metadata
  return typeof metadata === "object" && metadata !== null ? (metadata as Record<string, unknown>) : {}
}

function outputOf(part: ToolPart): string {
  return part.state.status === "completed" && typeof part.state.output === "string" ? part.state.output : ""
}

export function basenameOf(path: string): string {
  const normalized = path.replaceAll("\\", "/")
  const at = normalized.lastIndexOf("/")
  return at < 0 ? normalized : normalized.slice(at + 1)
}

export function dirnameOf(path: string): string {
  const normalized = path.replaceAll("\\", "/")
  const at = normalized.lastIndexOf("/")
  return at < 0 ? "" : normalized.slice(0, at + 1)
}

// ── 头部模型 ────────────────────────────────────────────────────────────────
export interface ToolCardHead {
  kind: ToolCardKind
  status: ToolCardStatus
  /** 动词的 i18n key;unknown 无动词(工具名 mono 直出)。 */
  titleKey?: string
  /** mono 目标(文件名/模式/命令/查询/URL)。 */
  target?: string
  /** 次级细节(目录/include 等)。 */
  detail?: string
  /** 计数徽标(文件数/命中数)。 */
  count?: { unit: "files" | "matches"; value: number }
  /** +N/−N 改动徽标。 */
  stat?: { additions: number; deletions: number }
  /** bash 完成态退出码(缺失 = 引擎未报,徽标退回「完成」)。 */
  exit?: number
  toolName: string
}

const TITLE_KEYS: Partial<Record<ToolCardKind, string>> = {
  read: "alpha.timeline.tool.read",
  list: "alpha.timeline.tool.list",
  glob: "alpha.timeline.tool.glob",
  grep: "alpha.timeline.tool.grep",
  webfetch: "alpha.timeline.tool.webfetch",
  websearch: "alpha.timeline.tool.websearch",
  edit: "alpha.timeline.tool.edit",
  write: "alpha.timeline.tool.write",
  apply_patch: "alpha.timeline.tool.patch",
  skill: "alpha.timeline.tool.skill",
  task: "alpha.timeline.tool.task",
}

export function toolCardHeadOf(part: ToolPart): ToolCardHead {
  const kind = toolCardKindOf(part.tool)
  const status = toolCardStatusOf(part.state)
  const input = inputOf(part)
  const metadata = metadataOf(part)
  const head: ToolCardHead = { kind, status, titleKey: TITLE_KEYS[kind], toolName: part.tool }

  switch (kind) {
    case "read": {
      const filePath = stringOf(input.filePath)
      if (filePath) {
        head.target = basenameOf(filePath)
        head.detail = dirnameOf(filePath)
      }
      return head
    }
    case "list": {
      head.target = stringOf(input.path)
      return head
    }
    case "glob": {
      head.target = stringOf(input.pattern)
      const count = finiteOf(metadata.count)
      if (count !== undefined) head.count = { unit: "files", value: Math.max(0, Math.floor(count)) }
      return head
    }
    case "grep": {
      head.target = stringOf(input.pattern)
      const include = stringOf(input.include)
      if (include) head.detail = `include=${include}`
      const matches = finiteOf(metadata.matches)
      if (matches !== undefined) head.count = { unit: "matches", value: Math.max(0, Math.floor(matches)) }
      return head
    }
    case "webfetch": {
      head.target = stringOf(input.url)
      return head
    }
    case "websearch": {
      head.target = stringOf(input.query)
      return head
    }
    case "bash": {
      head.target = stringOf(input.command)
      const exit = finiteOf(metadata.exit)
      if (status === "success" && exit !== undefined) head.exit = exit
      return head
    }
    case "edit": {
      const filePath = stringOf(input.filePath)
      if (filePath) {
        head.target = basenameOf(filePath)
        head.detail = dirnameOf(filePath)
      }
      head.stat = editStatOf(metadata)
      return head
    }
    case "write": {
      const filePath = stringOf(input.filePath)
      if (filePath) {
        head.target = basenameOf(filePath)
        head.detail = dirnameOf(filePath)
      }
      const content = stringOf(input.content)
      if (content) head.stat = { additions: countLines(content), deletions: 0 }
      return head
    }
    case "apply_patch": {
      const files = patchFilesOf(part)
      if (files.rows.length > 0) {
        head.count = { unit: "files", value: files.rows.length }
        head.stat = files.rows.reduce(
          (sum, row) => ({ additions: sum.additions + row.additions, deletions: sum.deletions + row.deletions }),
          { additions: 0, deletions: 0 },
        )
      }
      return head
    }
    case "skill": {
      head.target = stringOf(input.name) ?? stringOf(metadata.name)
      return head
    }
    case "task": {
      head.target = stringOf(input.description)
      return head
    }
    default:
      return head
  }
}

function editStatOf(metadata: Record<string, unknown>): { additions: number; deletions: number } | undefined {
  const filediff = metadata.filediff
  if (typeof filediff !== "object" || filediff === null) return undefined
  const additions = finiteOf((filediff as { additions?: unknown }).additions)
  const deletions = finiteOf((filediff as { deletions?: unknown }).deletions)
  if (additions === undefined && deletions === undefined) return undefined
  return { additions: Math.max(0, additions ?? 0), deletions: Math.max(0, deletions ?? 0) }
}

function countLines(text: string): number {
  let lines = 1
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) lines += 1
  return lines
}

// ── 输出体模型(全部有界) ──────────────────────────────────────────────────
export interface PatchFileRow {
  badge: "add" | "modify" | "delete" | "move"
  path: string
  additions: number
  deletions: number
}

export type ToolCardBody =
  | { type: "none" }
  | { type: "text"; text: string; truncated: boolean }
  | { type: "term"; output: string; truncated: boolean; streaming: boolean }
  | { type: "files"; files: string[]; truncated: boolean }
  | { type: "diff"; patch: string }
  | { type: "write"; preview: string[]; totalLines: number }
  | { type: "patch"; files: PatchFileRow[]; truncated: boolean }
  | { type: "links"; urls: string[]; truncated: boolean }
  | { type: "error"; message: string; truncated: boolean }

export function toolCardBodyOf(part: ToolPart): ToolCardBody {
  const status = toolCardStatusOf(part.state)
  if (status === "error") {
    const message = part.state.status === "error" && typeof part.state.error === "string" ? part.state.error : ""
    const bounded = boundedBlock(message, TOOL_ERROR_MAX_CHARS)
    return { type: "error", message: bounded.text, truncated: bounded.truncated }
  }
  if (status === "pending") return { type: "none" }

  const kind = toolCardKindOf(part.tool)
  const metadata = metadataOf(part)

  if (kind === "bash") {
    // 运行中:流式子消息输出(服务端 metadata.output 预览流);完成:定格 output。
    const raw = status === "running" ? (stringOf(metadata.output) ?? "") : outputOf(part)
    const bounded = boundedBlock(raw)
    return { type: "term", output: bounded.text, truncated: bounded.truncated, streaming: status === "running" }
  }
  if (status === "running") return { type: "none" }

  switch (kind) {
    case "read": {
      const loaded = Array.isArray(metadata.loaded) ? metadata.loaded.filter((item) => typeof item === "string") : []
      if (loaded.length === 0) return { type: "none" }
      return {
        type: "files",
        files: loaded.slice(0, TOOL_LIST_MAX_ITEMS),
        truncated: loaded.length > TOOL_LIST_MAX_ITEMS,
      }
    }
    case "glob": {
      const lines = outputOf(part)
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("(") && line !== "No files found")
      if (lines.length === 0) return { type: "none" }
      return {
        type: "files",
        files: lines.slice(0, TOOL_LIST_MAX_ITEMS),
        truncated: lines.length > TOOL_LIST_MAX_ITEMS || metadata.truncated === true,
      }
    }
    case "grep":
    case "list": {
      const bounded = boundedBlock(outputOf(part))
      if (!bounded.text) return { type: "none" }
      return { type: "text", text: bounded.text, truncated: bounded.truncated }
    }
    case "webfetch":
      // 设计口径:仅触发行(URL 已在头部),不内联网页内容。
      return { type: "none" }
    case "websearch": {
      const urls = extractHttpUrls(outputOf(part))
      if (urls.length === 0) return { type: "none" }
      return { type: "links", urls: urls.slice(0, TOOL_LINKS_MAX), truncated: urls.length > TOOL_LINKS_MAX }
    }
    case "edit": {
      const patch = stringOf(metadata.diff)
      if (!patch) return { type: "none" }
      return { type: "diff", patch }
    }
    case "write": {
      const content = stringOf(inputOf(part).content)
      if (!content) return { type: "none" }
      const preview = content.split("\n", WRITE_PREVIEW_LINES + 1).slice(0, WRITE_PREVIEW_LINES)
      return {
        type: "write",
        preview: preview.map((line) => boundedBlock(line, 400, 1).text),
        totalLines: countLines(content),
      }
    }
    case "apply_patch":
      return patchBodyOf(part)
    case "skill":
    case "task":
      return { type: "none" }
    default: {
      // 未知工具:有界纯文本通用卡(fail-closed,不渲染任何富结构)。
      const bounded = boundedBlock(outputOf(part))
      if (!bounded.text) return { type: "none" }
      return { type: "text", text: bounded.text, truncated: bounded.truncated }
    }
  }
}

function patchBodyOf(part: ToolPart): ToolCardBody {
  const files = patchFilesOf(part)
  if (files.rows.length === 0) return { type: "none" }
  return { type: "patch", files: files.rows, truncated: files.truncated }
}

const PATCH_BADGES: Record<string, PatchFileRow["badge"]> = {
  add: "add",
  update: "modify",
  delete: "delete",
  move: "move",
}

function patchFilesOf(part: ToolPart): { rows: PatchFileRow[]; truncated: boolean } {
  const files = metadataOf(part).files
  if (!Array.isArray(files)) return { rows: [], truncated: false }
  const rows: PatchFileRow[] = []
  for (const item of files) {
    if (rows.length >= TOOL_LIST_MAX_ITEMS) return { rows, truncated: true }
    if (typeof item !== "object" || item === null) continue
    const record = item as {
      relativePath?: unknown
      filePath?: unknown
      type?: unknown
      additions?: unknown
      deletions?: unknown
    }
    const path = stringOf(record.relativePath) ?? stringOf(record.filePath)
    const badge = typeof record.type === "string" ? PATCH_BADGES[record.type] : undefined
    if (!path || !badge) continue
    rows.push({
      badge,
      path,
      additions: Math.max(0, finiteOf(record.additions) ?? 0),
      deletions: Math.max(0, finiteOf(record.deletions) ?? 0),
    })
  }
  return { rows, truncated: false }
}

/** I6:只认 http(s) 协议的裸 URL(展示为显式外开链接;导航裁决在主进程)。 */
export function extractHttpUrls(text: string): string[] {
  if (!text) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`)\]]+/g)) {
    const url = match[0].replace(/[),.;:!?]+$/, "")
    if (seen.has(url)) continue
    seen.add(url)
    result.push(url)
    if (result.length >= TOOL_LINKS_MAX * 2) break
  }
  return result
}

// ── 分支专属信息 ────────────────────────────────────────────────────────────
export interface TaskCardInfo {
  description?: string
  agent?: string
  childSessionID?: string
  background: boolean
}

export function taskCardInfoOf(part: ToolPart): TaskCardInfo {
  const input = inputOf(part)
  const metadata = metadataOf(part)
  return {
    description: stringOf(input.description),
    agent: stringOf(input.subagent_type),
    childSessionID: stringOf(metadata.sessionId),
    background: metadata.background === true,
  }
}

export interface ContextRowInfo {
  tool: string
  titleKey?: string
  target?: string
  args: string[]
}

/** 「已探索」折叠组一行的动词/目标/参数(与上游 contextToolTrigger 同口径,防御读取)。 */
export function contextRowOf(part: ToolPart): ContextRowInfo {
  const input = inputOf(part)
  const pattern = stringOf(input.pattern)
  const filePath = stringOf(input.filePath)
  const path = stringOf(input.path)
  const include = stringOf(input.include)
  const offset = finiteOf(input.offset)
  const limit = finiteOf(input.limit)
  const kind = toolCardKindOf(part.tool)

  switch (kind) {
    case "read": {
      const args: string[] = []
      if (offset !== undefined) args.push(`offset=${offset}`)
      if (limit !== undefined) args.push(`limit=${limit}`)
      return { tool: part.tool, titleKey: TITLE_KEYS.read, target: filePath ? basenameOf(filePath) : undefined, args }
    }
    case "list":
      return { tool: part.tool, titleKey: TITLE_KEYS.list, target: path, args: [] }
    case "glob":
      return { tool: part.tool, titleKey: TITLE_KEYS.glob, target: pattern, args: [] }
    case "grep":
      return {
        tool: part.tool,
        titleKey: TITLE_KEYS.grep,
        target: pattern,
        args: include ? [`include=${include}`] : [],
      }
    default:
      return { tool: part.tool, titleKey: undefined, target: undefined, args: [] }
  }
}

export interface ContextGroupSummary {
  reads: number
  searches: number
  lists: number
}

export function contextGroupSummaryOf(parts: readonly ToolPart[]): ContextGroupSummary {
  return {
    reads: parts.filter((part) => part.tool === "read").length,
    searches: parts.filter((part) => part.tool === "glob" || part.tool === "grep").length,
    lists: parts.filter((part) => part.tool === "list").length,
  }
}

// ── 媒体预览行 ──────────────────────────────────────────────────────────────
/** data:image 且长度受限才内联缩略(I6/I7:不外联、不整吞超大 base64);其余走图标。 */
export const MEDIA_INLINE_URL_MAX = 2_000_000

export function mediaThumbable(url: string): boolean {
  return url.startsWith("data:image/") && url.length <= MEDIA_INLINE_URL_MAX
}

export function mediaLabelOf(mime: string, name: string): string {
  if (mime.startsWith("image/")) return mime.slice("image/".length).toUpperCase()
  if (mime === "application/pdf") return "PDF"
  const base = basenameOf(name)
  const dot = base.lastIndexOf(".")
  if (dot <= 0) return "FILE"
  return base.slice(dot + 1).toUpperCase()
}
