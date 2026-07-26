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
/** 单项(列表项/文件路径/URL/头部目标)字符帽:先截单项,再进过滤/映射。 */
export const TOOL_ITEM_MAX_CHARS = 400
/** 对完整输出做行切/URL 扫描前的扫描预算:超出部分不扫描(截断标记诚实呈现)。 */
export const TOOL_SCAN_MAX_CHARS = 64_000
/** 不可信数组的总迭代预算(含非法项):项数帽之外的 CPU 帽 —— 海量非法尾不全扫。 */
export const TOOL_LIST_SCAN_MAX = 500
/** URL 帽:超长 URL 直接丢弃(截断的 URL 指向错误目标,fail-closed 不渲染)。 */
export const TOOL_URL_MAX_CHARS = 500
/** 默认展开的输出体(bash 终端流/错误体)超过此帽 → 默认收起,防多卡累积驻留 DOM。 */
export const OPEN_DEFAULT_MAX_CHARS = 4_000

export interface BoundedBlock {
  text: string
  truncated: boolean
}

/** 单项帽:超限截断(展示层配 ellipsis;是否丢弃由调用方决定)。 */
export function cappedItem(text: string, max = TOOL_ITEM_MAX_CHARS): string {
  return text.length > max ? text.slice(0, max) : text
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

// 分派表用 Map:敌意工具名(__proto__/constructor 等继承键)不可能命中原型成员,
// 未登记键一律 fail-closed 落 unknown。
const TOOL_CARD_KINDS = new Map<string, ToolCardKind>([
  ["read", "read"],
  ["list", "list"],
  ["glob", "glob"],
  ["grep", "grep"],
  ["webfetch", "webfetch"],
  ["websearch", "websearch"],
  ["bash", "bash"],
  ["edit", "edit"],
  ["write", "write"],
  ["apply_patch", "apply_patch"],
  ["skill", "skill"],
  ["task", "task"],
])

/** 分派:已知工具 → 专卡分支;其余一律 fail-closed 走未知工具通用卡。 */
export function toolCardKindOf(tool: string): ToolCardKind {
  return TOOL_CARD_KINDS.get(tool) ?? "unknown"
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

/** 头部字符串一律先过单项帽(I7):恶意超长 命令/路径/模式 不整串进 DOM。 */
function cappedStringOf(value: unknown): string | undefined {
  const text = stringOf(value)
  return text === undefined ? undefined : cappedItem(text)
}

export function toolCardHeadOf(part: ToolPart): ToolCardHead {
  const kind = toolCardKindOf(part.tool)
  const status = toolCardStatusOf(part.state)
  const input = inputOf(part)
  const metadata = metadataOf(part)
  const head: ToolCardHead = { kind, status, titleKey: TITLE_KEYS[kind], toolName: cappedItem(part.tool) }

  switch (kind) {
    case "read": {
      const filePath = cappedStringOf(input.filePath)
      if (filePath) {
        head.target = cappedItem(basenameOf(filePath))
        head.detail = cappedItem(dirnameOf(filePath))
      }
      return head
    }
    case "list": {
      head.target = cappedStringOf(input.path)
      return head
    }
    case "glob": {
      head.target = cappedStringOf(input.pattern)
      const count = finiteOf(metadata.count)
      if (count !== undefined) head.count = { unit: "files", value: Math.max(0, Math.floor(count)) }
      return head
    }
    case "grep": {
      head.target = cappedStringOf(input.pattern)
      const include = cappedStringOf(input.include)
      if (include) head.detail = `include=${include}`
      const matches = finiteOf(metadata.matches)
      if (matches !== undefined) head.count = { unit: "matches", value: Math.max(0, Math.floor(matches)) }
      return head
    }
    case "webfetch": {
      head.target = cappedStringOf(input.url)
      return head
    }
    case "websearch": {
      head.target = cappedStringOf(input.query)
      return head
    }
    case "bash": {
      head.target = cappedStringOf(input.command)
      const exit = finiteOf(metadata.exit)
      if (status === "success" && exit !== undefined) head.exit = exit
      return head
    }
    case "edit": {
      const filePath = cappedStringOf(input.filePath)
      if (filePath) {
        head.target = cappedItem(basenameOf(filePath))
        head.detail = cappedItem(dirnameOf(filePath))
      }
      head.stat = editStatOf(metadata)
      return head
    }
    case "write": {
      const filePath = cappedStringOf(input.filePath)
      if (filePath) {
        head.target = cappedItem(basenameOf(filePath))
        head.detail = cappedItem(dirnameOf(filePath))
      }
      // I7:总行数只在扫描预算内计数才可信;超预算不出统计徽标(诚实缺席)。
      const content = stringOf(input.content)
      if (content && content.length <= TOOL_SCAN_MAX_CHARS) head.stat = { additions: countLines(content), deletions: 0 }
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
      head.target = cappedStringOf(input.name) ?? cappedStringOf(metadata.name)
      return head
    }
    case "task": {
      head.target = cappedStringOf(input.description)
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
  | { type: "files"; files: string[]; truncated: boolean; badge?: "read" }
  | { type: "diff"; patch: string }
  | { type: "write"; path?: string; preview: string[]; totalLines: number; approx: boolean }
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
      // I7 双约束:项数帽(TOOL_LIST_MAX_ITEMS)+ 总迭代预算(TOOL_LIST_SCAN_MAX,
      // 含非法项计数)—— 「50 有效 + 海量非法尾」不全扫,CPU 有界。
      const loaded = metadata.loaded
      if (!Array.isArray(loaded)) return { type: "none" }
      const files: string[] = []
      let truncated = false
      for (let index = 0; index < loaded.length; index += 1) {
        if (index >= TOOL_LIST_SCAN_MAX || files.length >= TOOL_LIST_MAX_ITEMS) {
          truncated = true
          break
        }
        const item = loaded[index]
        if (typeof item !== "string" || item.length === 0) continue
        files.push(cappedItem(item))
      }
      if (files.length === 0) return { type: "none" }
      return { type: "files", files, truncated, badge: "read" }
    }
    case "glob": {
      // I7:先按扫描预算截整串,再行切;每行过单项帽后才进过滤。
      const output = outputOf(part)
      const scan = output.slice(0, TOOL_SCAN_MAX_CHARS)
      const files: string[] = []
      let overflow = output.length > scan.length
      for (const rawLine of scan.split("\n")) {
        if (files.length >= TOOL_LIST_MAX_ITEMS) {
          overflow = true
          break
        }
        const line = cappedItem(rawLine).trim()
        if (line.length === 0 || line.startsWith("(") || line === "No files found") continue
        files.push(line)
      }
      if (files.length === 0) return { type: "none" }
      return { type: "files", files, truncated: overflow || metadata.truncated === true }
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
      const input = inputOf(part)
      const content = stringOf(input.content)
      if (!content) return { type: "none" }
      // I7:预览只切开头一小段;总行数只在扫描预算内计数,超预算 approx(不伪装精确)。
      const previewScan = content.slice(0, WRITE_PREVIEW_LINES * (TOOL_ITEM_MAX_CHARS + 1) + 1)
      const preview = previewScan
        .split("\n", WRITE_PREVIEW_LINES + 1)
        .slice(0, WRITE_PREVIEW_LINES)
        .map((line) => cappedItem(line))
      const approx = content.length > TOOL_SCAN_MAX_CHARS
      const filePath = cappedStringOf(input.filePath)
      return {
        type: "write",
        path: filePath,
        preview,
        totalLines: countLines(approx ? content.slice(0, TOOL_SCAN_MAX_CHARS) : content),
        approx,
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

// 徽章表同样用 Map:敌意 type(__proto__/constructor 等)不可能命中原型成员 → 无徽章即丢行。
const PATCH_BADGES = new Map<string, PatchFileRow["badge"]>([
  ["add", "add"],
  ["update", "modify"],
  ["delete", "delete"],
  ["move", "move"],
])

function patchFilesOf(part: ToolPart): { rows: PatchFileRow[]; truncated: boolean } {
  const files = metadataOf(part).files
  if (!Array.isArray(files)) return { rows: [], truncated: false }
  const rows: PatchFileRow[] = []
  // 同 read 列表的双约束:项数帽 + 总迭代预算(海量非法尾不全扫)。
  for (let index = 0; index < files.length; index += 1) {
    if (index >= TOOL_LIST_SCAN_MAX || rows.length >= TOOL_LIST_MAX_ITEMS) return { rows, truncated: true }
    const item = files[index]
    if (typeof item !== "object" || item === null) continue
    const record = item as {
      relativePath?: unknown
      filePath?: unknown
      type?: unknown
      additions?: unknown
      deletions?: unknown
    }
    const path = cappedStringOf(record.relativePath) ?? cappedStringOf(record.filePath)
    const badge = typeof record.type === "string" ? PATCH_BADGES.get(record.type) : undefined
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

/** I6/I7:只认 http(s) 协议的裸 URL;扫描预算截整串,超长 URL 丢弃(不截半个 URL)。 */
export function extractHttpUrls(text: string): string[] {
  if (!text) return []
  const scan = text.slice(0, TOOL_SCAN_MAX_CHARS)
  const clipped = text.length > scan.length
  const seen = new Set<string>()
  const result: string[] = []
  for (const match of scan.matchAll(/https?:\/\/[^\s<>"'`)\]]+/g)) {
    // fail-closed:命中触达扫描边界且原文更长 → 可能是被截断的半个 URL,整条丢弃。
    if (clipped && (match.index ?? 0) + match[0].length >= scan.length) continue
    const url = match[0].replace(/[),.;:!?]+$/, "")
    if (url.length > TOOL_URL_MAX_CHARS) continue
    if (seen.has(url)) continue
    seen.add(url)
    result.push(url)
    if (result.length >= TOOL_LINKS_MAX * 2) break
  }
  return result
}

// ── 工具级错误卡的标题行(#590,design §③ .errcard 帧) ─────────────────────
/** 分类只扫错误文本开头一段(I7:超长错误体不整串扫)。 */
export const TOOL_ERROR_SCAN_MAX_CHARS = 400

/**
 * 常见网关/接口失败的状态码 ↔ 标准原因短语。只认这张表:表外的状态码不猜原因、
 * 表外的措辞不归类(fail-closed,与设计稿「未知错误代码按原样 mono 展示」同口径)。
 */
const HTTP_REASONS = new Map<number, string>([
  [400, "Bad Request"],
  [401, "Unauthorized"],
  [402, "Payment Required"],
  [403, "Forbidden"],
  [404, "Not Found"],
  [408, "Request Timeout"],
  [429, "Too Many Requests"],
  [500, "Internal Server Error"],
  [502, "Bad Gateway"],
  [503, "Service Unavailable"],
  [504, "Gateway Timeout"],
])

/**
 * 「模型网关错误」第一道门 = **工具类型**(R2 Blocker 修正):结构判据,不是词面。
 * `502 Bad Gateway` / `504 Gateway Timeout` 是标准 HTTP 原因短语,任何 webfetch/
 * curl 失败都可能带上;`gateway` 也随时出现在路径、命令名、主机名里 —— 所以对
 * 执行路径根本不经过模型网关的工具(read/bash/webfetch/…),词面证据再强也不可能
 * 是模型网关错误。白名单收窄到唯一真正经模型网关的工具:`task`(子代理会话的
 * 模型调用失败沿 opencode task 工具 Effect.fail 传为本卡错误文本)。websearch 走
 * Exa/Parallel 搜索 API、webfetch 抓任意网页、其余全是本地 FS/shell —— 都不进
 * 白名单;未知/MCP 工具同样 fail-closed 归「工具执行失败」。
 */
const GATEWAY_CAPABLE_TOOLS = new Set(["task"])

/**
 * 第二道门 = 词面证据(R1 Blocker 修正,只对白名单工具适用):只认两种**明确**
 * 证据之一 ——
 * ① 文本直接点名网关层(`网关` / `gateway`);
 * ② 模型词(`模型` / `model`)与模型路由层词(`代理` / `proxy` / `provider` /
 *   `baseURL`)同现。
 * 裸 URL、`api`、`http`、`endpoint`、单独的 `proxy`/`provider` 一律不算证据。
 * 任一道门不过 → 退回通用「工具执行失败」,保守漏报优于误报。
 */
const GATEWAY_LAYER_WORD = /网关|\bgateway\b/i
const MODEL_WORD = /模型|\bmodel\b/i
const MODEL_ROUTE_WORD = /代理|\bproxy\b|\bprovider\b|base_?url/i

function hasGatewayEvidence(scan: string): boolean {
  if (GATEWAY_LAYER_WORD.test(scan)) return true
  return MODEL_WORD.test(scan) && MODEL_ROUTE_WORD.test(scan)
}

export const TOOL_ERROR_TITLE_GATEWAY = "alpha.timeline.toolErrorGateway"
export const TOOL_ERROR_TITLE_GENERIC = "alpha.timeline.toolErrorGeneric"

export interface ToolErrorSummary {
  /** 类别标题的 i18n key。 */
  titleKey: string
  /** mono 代码副标(如 `404 · Not Found`);识别不出即缺席,不编造。 */
  code?: string
}

/**
 * (工具名, 错误文本)→ 标题行模型。纯函数,输入已是有界错误体。类别过双门:
 * 工具类型白名单(结构)→ 词面证据;代码副标只报文本里**真实出现**的东西:
 * 独立 3 位状态码(表内,不吃 `v1.404` 粘连片段)→ `NNN · Reason`;只出现标准
 * 原因短语 → 只给短语本身,不反推数字(数据面没有状态字段,`Not Found` 反推成
 * `404` 是把推测显示成事实);都没有 → 无代码。
 */
export function toolErrorSummaryOf(tool: string, message: string): ToolErrorSummary {
  if (!GATEWAY_CAPABLE_TOOLS.has(tool)) return { titleKey: TOOL_ERROR_TITLE_GENERIC }
  const scan = message.slice(0, TOOL_ERROR_SCAN_MAX_CHARS)
  if (!hasGatewayEvidence(scan)) return { titleKey: TOOL_ERROR_TITLE_GENERIC }
  for (const match of scan.matchAll(/(?<![\w.])(\d{3})(?![\w.])/g)) {
    const reason = HTTP_REASONS.get(Number(match[1]))
    if (reason) return { titleKey: TOOL_ERROR_TITLE_GATEWAY, code: `${match[1]} · ${reason}` }
  }
  const lower = scan.toLowerCase()
  for (const [, reason] of HTTP_REASONS) {
    if (lower.includes(reason.toLowerCase())) return { titleKey: TOOL_ERROR_TITLE_GATEWAY, code: reason }
  }
  return { titleKey: TOOL_ERROR_TITLE_GATEWAY }
}

// ── 「在面板打开」pill(T8):write/edit 卡头的文件目标 ──────────────────────
/** 路径帽:超长路径不进 intent(截断的路径指向错误目标,fail-closed 无 pill)。 */
export const OPEN_TARGET_MAX_CHARS = 1_024

/** write/edit 卡的面板打开目标 = 原始 input.filePath;其余工具/非法路径 → 无 pill。 */
export function openTargetOf(part: ToolPart): string | undefined {
  const kind = toolCardKindOf(part.tool)
  if (kind !== "write" && kind !== "edit") return undefined
  const filePath = inputOf(part).filePath
  if (typeof filePath !== "string" || filePath.length === 0 || filePath.length > OPEN_TARGET_MAX_CHARS) return undefined
  return filePath
}

// ── 诊断行(T19):edit/write 完成态 metadata.diagnostics 的有界投影 ─────────
export const DIAG_MAX_ROWS = 8
/** 外层帽(审计 Major-3):诊断映射的文件键扫描预算,超出即停(精确键命中不受限)。 */
export const DIAG_FILES_SCAN_MAX = 200

export interface DiagnosticRow {
  file: string
  line?: number
  message: string
}

function normalizedPath(path: string): string {
  return path.replaceAll("\\", "/")
}

/**
 * 只取本卡文件的 ERROR 级(severity=1)诊断,与上游 report() 同口径;四重帽(I7):
 * 外层文件键预算(DIAG_FILES_SCAN_MAX)+ 条数帽(DIAG_MAX_ROWS)+ 条目扫描预算
 * (TOOL_LIST_SCAN_MAX)+ 单条帽(cappedItem)。文件对不上/形状非法 → 空(fail-closed)。
 */
export function diagnosticsOf(part: ToolPart): { rows: DiagnosticRow[]; truncated: boolean } {
  const none = { rows: [], truncated: false }
  const kind = toolCardKindOf(part.tool)
  if (kind !== "write" && kind !== "edit") return none
  if (part.state.status !== "completed") return none
  const filePath = inputOf(part).filePath
  if (typeof filePath !== "string" || filePath.length === 0) return none
  const diagnostics = metadataOf(part).diagnostics
  if (typeof diagnostics !== "object" || diagnostics === null) return none
  const map = diagnostics as Record<string, unknown>
  // 外层文件数扫描预算(审计 Major-3):该映射可为全项目诊断,不做全量
  // Object.entries/归一化 —— 先走本文件精确键 O(1) 快路,再有界逐键扫描,
  // 预算耗尽即停(历史卡片数 × 项目文件数不再可放大)。
  let entry: unknown = Object.prototype.hasOwnProperty.call(map, filePath) ? map[filePath] : undefined
  if (entry === undefined) {
    const wanted = normalizedPath(filePath)
    let scanned = 0
    for (const key in map) {
      if (scanned >= DIAG_FILES_SCAN_MAX) break
      scanned += 1
      if (!Object.prototype.hasOwnProperty.call(map, key)) continue
      if (normalizedPath(key) === wanted) {
        entry = map[key]
        break
      }
    }
  }
  if (!Array.isArray(entry)) return none
  const file = cappedItem(basenameOf(filePath))
  const rows: DiagnosticRow[] = []
  let truncated = false
  for (let index = 0; index < entry.length; index += 1) {
    if (index >= TOOL_LIST_SCAN_MAX || rows.length >= DIAG_MAX_ROWS) {
      truncated = true
      break
    }
    const item = entry[index]
    if (typeof item !== "object" || item === null) continue
    const record = item as { severity?: unknown; message?: unknown; range?: { start?: { line?: unknown } } }
    if (record.severity !== 1) continue
    const message = stringOf(record.message)
    if (!message) continue
    const line = finiteOf(record.range?.start?.line)
    rows.push({
      file,
      line: line === undefined ? undefined : Math.max(0, Math.floor(line)) + 1,
      message: cappedItem(message),
    })
  }
  return { rows, truncated }
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
    description: cappedStringOf(input.description),
    agent: cappedStringOf(input.subagent_type),
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

/** 「已探索」折叠组一行的动词/目标/参数(与上游 contextToolTrigger 同口径,防御读取,单项帽)。 */
export function contextRowOf(part: ToolPart): ContextRowInfo {
  const input = inputOf(part)
  const pattern = cappedStringOf(input.pattern)
  const filePath = cappedStringOf(input.filePath)
  const path = cappedStringOf(input.path)
  const include = cappedStringOf(input.include)
  const offset = finiteOf(input.offset)
  const limit = finiteOf(input.limit)
  const kind = toolCardKindOf(part.tool)

  switch (kind) {
    case "read": {
      const args: string[] = []
      if (offset !== undefined) args.push(`offset=${offset}`)
      if (limit !== undefined) args.push(`limit=${limit}`)
      return {
        tool: part.tool,
        titleKey: TITLE_KEYS.read,
        target: filePath ? cappedItem(basenameOf(filePath)) : undefined,
        args,
      }
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
