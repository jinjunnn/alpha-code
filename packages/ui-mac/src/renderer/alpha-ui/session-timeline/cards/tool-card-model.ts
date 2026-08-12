// REQ-125 C6 / #879 — 工具卡纯模型(零 DOM、零 solid、零上游组件)。
//
// 职责:把 SDK typed 通道进来的 ToolPart 投影成卡片可渲染的结构。#879 起:
// **专用卡只由完整稳定 identity(#878 的 ToolDisplaySnapshotV1)命中宿主拥有的
// 精确展示规则**;`part.tool` 是模型别名(technicalId),不再参与任何分派判定。
// identity 缺失 / 非法、规则未命中、第三方 MCP / plugin 一律 metadata-only:
// 只显示来源分类、被动净化且有界的名称与结构化状态,**不读 input / metadata /
// output / error 任何字段**。命中规则的卡,字段先走类别 allowlist 与 typed
// normalization(I2 防御读取),再过共享 redactor(tool-redactor);redactor
// 任一步失败即隐藏整字段(AC5),不回退 raw string。
import type { ToolAuthority, ToolIdentity, ToolPart, ToolState } from "@opencode-ai/sdk/v2/client"
import { DIFF_PATCH_MAX_CHARS } from "./tool-diff"
import { redactPath, redactText, redactUrl, type RedactResult } from "./tool-redactor"

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
/** 路径帽:超长路径 fail-closed 不渲染(截断的路径指向错误目标)。 */
export const TOOL_PATH_MAX_CHARS = 1_024
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

// ── #879 identity 分派(唯一的专用卡入口) ──────────────────────────────────
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

/** 展示层的可信来源分类(只从持久化 identity + authority 导出,禁止从别名猜)。 */
export type ToolSourceCategory = "builtin" | "host" | "alpha-cloud" | "mcp" | "plugin" | "unknown"

export interface ToolCardDispatch {
  /** 命中宿主规则的专用卡分支;metadata-only 时恒为 "unknown"。 */
  kind: ToolCardKind
  category: ToolSourceCategory
  /** true = 严格降级卡:无参数、无错误、无输出、无展开体。 */
  metadataOnly: boolean
  /** 被动净化且有界的展示名称(identity.name;快照缺失时退回别名)。 */
  name: string
  /** mcp / plugin 的来源 origin(server 配置键 / plugin 命名空间),净化有界。 */
  origin?: string
}

// 宿主拥有的精确展示规则表:key = 完整 identity 的 (source∈{builtin,builtin-v2},
// origin="", name)。Map 天然免疫原型继承键;未登记 identity 一律 metadata-only。
const HOST_BUILTIN_RULES = new Map<string, ToolCardKind>([
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

const IDENTITY_SOURCES: ReadonlySet<string> = new Set(["builtin", "builtin-v2", "plugin", "mcp", "host"])

// 名称是远端输入:剥控制字符与双向覆盖字符(视觉伪装),再过单项帽。
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g
function sanitizedName(value: string): string {
  const clean = cappedItem(value.replace(UNSAFE_NAME_CHARS, ""))
  return clean.length > 0 ? clean : "?"
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

/** #878 快照的防御校验:结构不完整/形状非法 = 无快照(按未知来源降级)。 */
function displaySnapshotOf(part: ToolPart): { identity: ToolIdentity; authority: ToolAuthority } | undefined {
  const display = (part as { display?: unknown }).display
  if (typeof display !== "object" || display === null) return undefined
  const record = display as { identity?: unknown; technicalId?: unknown; authority?: unknown; billing?: unknown }
  if (!nonEmptyString(record.technicalId)) return undefined
  const identity = record.identity
  if (typeof identity !== "object" || identity === null) return undefined
  const id = identity as { source?: unknown; origin?: unknown; name?: unknown }
  if (typeof id.source !== "string" || !IDENTITY_SOURCES.has(id.source)) return undefined
  if (typeof id.origin !== "string") return undefined
  if (!nonEmptyString(id.name)) return undefined
  const authority = record.authority
  if (typeof authority !== "object" || authority === null) return undefined
  const auth = authority as { kind?: unknown; bindingId?: unknown; evidenceDigest?: unknown }
  if (auth.kind === "alpha-cloud") {
    if (!nonEmptyString(auth.bindingId) || !nonEmptyString(auth.evidenceDigest)) return undefined
  } else if (auth.kind !== "not-asserted") {
    return undefined
  }
  if (record.billing !== undefined) {
    const billing = record.billing as { class?: unknown; evidenceId?: unknown }
    if (typeof billing !== "object" || billing === null) return undefined
    if (!nonEmptyString(billing.class) || !nonEmptyString(billing.evidenceId)) return undefined
  }
  return {
    identity: { source: id.source as ToolIdentity["source"], origin: id.origin, name: id.name },
    authority: auth as ToolAuthority,
  }
}

function categoryOf(identity: ToolIdentity, authority: ToolAuthority): ToolSourceCategory {
  switch (identity.source) {
    case "builtin":
    case "builtin-v2":
      return "builtin"
    case "host":
      return "host"
    case "mcp":
      return authority.kind === "alpha-cloud" ? "alpha-cloud" : "mcp"
    case "plugin":
      return "plugin"
    default:
      return "unknown"
  }
}

/**
 * 分派(AC1):只有完整 identity(source ∈ {builtin, builtin-v2} 且 origin="")
 * 精确命中宿主规则表才有专用卡;其余(host / mcp / plugin / 快照缺失或非法)
 * 一律 metadata-only。远端 annotation、标题、别名都不是分派输入。
 */
export function toolCardDispatchOf(part: ToolPart): ToolCardDispatch {
  const snapshot = displaySnapshotOf(part)
  if (!snapshot) {
    return { kind: "unknown", category: "unknown", metadataOnly: true, name: sanitizedName(part.tool) }
  }
  const { identity, authority } = snapshot
  const category = categoryOf(identity, authority)
  if ((identity.source === "builtin" || identity.source === "builtin-v2") && identity.origin === "") {
    const kind = HOST_BUILTIN_RULES.get(identity.name)
    if (kind !== undefined) return { kind, category, metadataOnly: false, name: sanitizedName(identity.name) }
  }
  const origin =
    (identity.source === "mcp" || identity.source === "plugin") && identity.origin.length > 0
      ? sanitizedName(identity.origin)
      : undefined
  return { kind: "unknown", category, metadataOnly: true, name: sanitizedName(identity.name), origin }
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

// ── redactor 接线辅助(AC3/AC5:失败 = 隐藏整字段) ─────────────────────────
/** 单行自由文本(命令/模式/查询/名称):脱敏 + 单项帽;失败或空结果 = undefined。 */
function redactedInlineOf(value: unknown, max = TOOL_ITEM_MAX_CHARS): { value?: string; hidden: boolean } {
  const text = stringOf(value)
  if (text === undefined) return { hidden: false }
  const result = redactText(text, max)
  if (!result.ok || result.value.length === 0) return { hidden: true }
  return { value: result.value, hidden: false }
}

/** 展示路径:redactPath;失败 = 隐藏。 */
function redactedPathOf(value: unknown): { value?: string; hidden: boolean } {
  const text = stringOf(value)
  if (text === undefined) return { hidden: false }
  const result = redactPath(text, TOOL_PATH_MAX_CHARS)
  if (!result.ok || result.value.length === 0) return { hidden: true }
  return { value: result.value, hidden: false }
}

// ── 头部模型 ────────────────────────────────────────────────────────────────
export interface ToolCardHead {
  kind: ToolCardKind
  status: ToolCardStatus
  category: ToolSourceCategory
  /** true = 严格降级卡:头部只有来源分类 + 名称 + 状态。 */
  metadataOnly: boolean
  /** 动词的 i18n key;metadata-only 无动词(来源分类文案由渲染层供给)。 */
  titleKey?: string
  /** mono 目标(文件名/模式/命令/查询/URL),已过 redactor。 */
  target?: string
  /** 目标存在但 redactor 失败/清空 → 渲染层显示确定的「详情已隐藏」。 */
  targetHidden?: boolean
  /** 次级细节(目录/include 等),已过 redactor。 */
  detail?: string
  /** 计数徽标(文件数/命中数)。 */
  count?: { unit: "files" | "matches"; value: number }
  /** +N/−N 改动徽标。 */
  stat?: { additions: number; deletions: number }
  /** bash 完成态退出码(缺失 = 引擎未报,徽标退回「完成」)。 */
  exit?: number
  /** 被动净化后的展示名称(identity.name;快照缺失时退回别名)。 */
  toolName: string
  /** mcp / plugin 降级卡的来源 origin(净化有界)。 */
  origin?: string
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

function assignInline(head: ToolCardHead, value: unknown) {
  const result = redactedInlineOf(value)
  if (result.hidden) head.targetHidden = true
  else if (result.value !== undefined) head.target = result.value
}

function assignPathTarget(head: ToolCardHead, value: unknown) {
  const result = redactedPathOf(value)
  if (result.hidden) head.targetHidden = true
  else if (result.value !== undefined) {
    head.target = cappedItem(basenameOf(result.value))
    head.detail = cappedItem(dirnameOf(result.value))
  }
}

export function toolCardHeadOf(part: ToolPart): ToolCardHead {
  const dispatch = toolCardDispatchOf(part)
  const status = toolCardStatusOf(part.state)
  const head: ToolCardHead = {
    kind: dispatch.kind,
    status,
    category: dispatch.category,
    metadataOnly: dispatch.metadataOnly,
    toolName: dispatch.name,
    origin: dispatch.origin,
  }
  // AC2:降级卡不读 input / metadata —— 到此为止。
  if (dispatch.metadataOnly) return head
  head.titleKey = TITLE_KEYS[dispatch.kind]

  const input = inputOf(part)
  const metadata = metadataOf(part)

  switch (dispatch.kind) {
    case "read": {
      assignPathTarget(head, input.filePath)
      return head
    }
    case "list": {
      const path = redactedPathOf(input.path)
      if (path.hidden) head.targetHidden = true
      else if (path.value !== undefined) head.target = cappedItem(path.value)
      return head
    }
    case "glob": {
      assignInline(head, input.pattern)
      const count = finiteOf(metadata.count)
      if (count !== undefined) head.count = { unit: "files", value: Math.max(0, Math.floor(count)) }
      return head
    }
    case "grep": {
      assignInline(head, input.pattern)
      const include = redactedInlineOf(input.include)
      if (include.value !== undefined) head.detail = `include=${include.value}`
      const matches = finiteOf(metadata.matches)
      if (matches !== undefined) head.count = { unit: "matches", value: Math.max(0, Math.floor(matches)) }
      return head
    }
    case "webfetch": {
      const url = stringOf(input.url)
      if (url !== undefined) {
        const clean = redactUrl(url, TOOL_URL_MAX_CHARS)
        if (clean.ok) head.target = cappedItem(clean.value)
        else head.targetHidden = true
      }
      return head
    }
    case "websearch": {
      assignInline(head, input.query)
      return head
    }
    case "bash": {
      assignInline(head, input.command)
      const exit = finiteOf(metadata.exit)
      if (status === "success" && exit !== undefined) head.exit = exit
      return head
    }
    case "edit": {
      assignPathTarget(head, input.filePath)
      head.stat = editStatOf(metadata)
      return head
    }
    case "write": {
      assignPathTarget(head, input.filePath)
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
      assignInline(head, stringOf(input.name) ?? metadata.name)
      return head
    }
    case "task": {
      assignInline(head, input.description)
      return head
    }
    default:
      return head
  }
}

/** bash 卡的命令说明副行(matched bash 专属;已过 redactor,失败即缺席)。 */
export function bashDescriptionOf(part: ToolPart): string | undefined {
  const dispatch = toolCardDispatchOf(part)
  if (dispatch.metadataOnly || dispatch.kind !== "bash") return undefined
  return redactedInlineOf(inputOf(part).description).value
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

// ── 输出体模型(全部有界,全部先过 redactor) ──────────────────────────────
export interface PatchFileRow {
  badge: "add" | "modify" | "delete" | "move"
  path: string
  additions: number
  deletions: number
}

export type ToolCardBody =
  | { type: "none" }
  | { type: "hidden" }
  | { type: "text"; text: string; truncated: boolean }
  | { type: "term"; output: string; truncated: boolean; streaming: boolean }
  | { type: "files"; files: string[]; truncated: boolean; badge?: "read" }
  | { type: "diff"; patch: string }
  | { type: "write"; path?: string; preview: string[]; totalLines: number; approx: boolean }
  | { type: "patch"; files: PatchFileRow[]; truncated: boolean }
  | { type: "links"; urls: string[]; truncated: boolean }
  | { type: "error"; message: string; truncated: boolean }

function textBodyOf(raw: string, maxChars = TOOL_BODY_MAX_CHARS, maxLines = TOOL_BODY_MAX_LINES): ToolCardBody {
  const clean = redactText(raw, maxChars, maxLines)
  if (!clean.ok) return { type: "hidden" }
  if (!clean.value) return clean.truncated ? { type: "hidden" } : { type: "none" }
  return { type: "text", text: clean.value, truncated: clean.truncated }
}

export function toolCardBodyOf(part: ToolPart): ToolCardBody {
  const dispatch = toolCardDispatchOf(part)
  // AC2:降级卡没有任何 body —— error / output / input 一律不进 DOM。
  if (dispatch.metadataOnly) return { type: "none" }

  const status = toolCardStatusOf(part.state)
  if (status === "error") {
    const message = part.state.status === "error" && typeof part.state.error === "string" ? part.state.error : ""
    const clean = redactText(message, TOOL_ERROR_MAX_CHARS)
    if (!clean.ok) return { type: "hidden" }
    return { type: "error", message: clean.value, truncated: clean.truncated }
  }
  if (status === "pending") return { type: "none" }

  const kind = dispatch.kind
  const metadata = metadataOf(part)

  if (kind === "bash") {
    // 运行中:流式子消息输出(服务端 metadata.output 预览流);完成:定格 output。
    const raw = status === "running" ? (stringOf(metadata.output) ?? "") : outputOf(part)
    const clean = redactText(raw, TOOL_BODY_MAX_CHARS, TOOL_BODY_MAX_LINES)
    if (!clean.ok) return { type: "hidden" }
    return { type: "term", output: clean.value, truncated: clean.truncated, streaming: status === "running" }
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
        const clean = redactPath(cappedItem(item), TOOL_PATH_MAX_CHARS)
        // redactor 失败的项整项隐藏(fail-closed),以截断标记诚实呈现缺席。
        if (!clean.ok || clean.value.length === 0) {
          truncated = true
          continue
        }
        files.push(cappedItem(clean.value))
      }
      if (files.length === 0) return { type: "none" }
      return { type: "files", files, truncated, badge: "read" }
    }
    case "glob": {
      // I7:先按扫描预算截整串,再行切;每行过单项帽 + redactor 后才进过滤。
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
        const clean = redactPath(line, TOOL_PATH_MAX_CHARS)
        if (!clean.ok || clean.value.length === 0) {
          overflow = true
          continue
        }
        files.push(cappedItem(clean.value))
      }
      if (files.length === 0) return { type: "none" }
      return { type: "files", files, truncated: overflow || metadata.truncated === true }
    }
    case "grep":
    case "list": {
      return textBodyOf(outputOf(part))
    }
    case "webfetch":
      // 设计口径:仅触发行(URL 已在头部),不内联网页内容。
      return { type: "none" }
    case "websearch": {
      const urls = extractHttpUrls(outputOf(part))
      const cleaned: string[] = []
      const seen = new Set<string>()
      let dropped = false
      for (const url of urls) {
        const clean = redactUrl(url, TOOL_URL_MAX_CHARS)
        if (!clean.ok) {
          dropped = true
          continue
        }
        if (seen.has(clean.value)) continue
        seen.add(clean.value)
        cleaned.push(clean.value)
      }
      if (cleaned.length === 0) return { type: "none" }
      return {
        type: "links",
        urls: cleaned.slice(0, TOOL_LINKS_MAX),
        truncated: dropped || cleaned.length > TOOL_LINKS_MAX,
      }
    }
    case "edit": {
      const patch = stringOf(metadata.diff)
      if (!patch) return { type: "none" }
      return redactedDiffOf(patch)
    }
    case "write": {
      const input = inputOf(part)
      const content = stringOf(input.content)
      if (!content) return { type: "none" }
      // I7:预览只切开头一小段;总行数只在扫描预算内计数,超预算 approx(不伪装精确)。
      const previewScan = content.slice(0, WRITE_PREVIEW_LINES * (TOOL_ITEM_MAX_CHARS + 1) + 1)
      const previewRaw = previewScan
        .split("\n", WRITE_PREVIEW_LINES + 1)
        .slice(0, WRITE_PREVIEW_LINES)
        .map((line) => cappedItem(line))
      const cleanPreview = redactText(previewRaw.join("\n"), WRITE_PREVIEW_LINES * (TOOL_ITEM_MAX_CHARS + 1))
      if (!cleanPreview.ok) return { type: "hidden" }
      const approx = content.length > TOOL_SCAN_MAX_CHARS
      const path = redactedPathOf(input.filePath)
      return {
        type: "write",
        path: path.hidden ? undefined : path.value,
        preview: cleanPreview.value.split("\n"),
        totalLines: countLines(approx ? content.slice(0, TOOL_SCAN_MAX_CHARS) : content),
        approx,
      }
    }
    case "apply_patch":
      return patchBodyOf(part)
    case "skill":
    case "task":
      return { type: "none" }
    default:
      // 命中规则的 kind 已全部枚举;不可达,fail-closed 兜底。
      return { type: "none" }
  }
}

/**
 * diff 补丁的逐行脱敏:保住行首 diff 标记(+/-/空格/@),对行内内容跑共享
 * redactor —— secret 赋值被替换后补丁仍可解析。任一行失败或补丁超帽 →
 * 整字段隐藏(AC5;旧「过大占位」由 hidden 标记接管,不再向 body 传 raw)。
 */
function redactedDiffOf(patch: string): ToolCardBody {
  if (patch.length > DIFF_PATCH_MAX_CHARS) return { type: "hidden" }
  const lines = patch.split("\n")
  const out: string[] = []
  for (const line of lines) {
    const first = line.charAt(0)
    const marker = first === "+" || first === "-" || first === " " || first === "@" ? first : ""
    const rest = line.slice(marker.length)
    if (rest.length === 0) {
      out.push(line)
      continue
    }
    const clean = redactText(rest, rest.length)
    if (!clean.ok) return { type: "hidden" }
    out.push(marker + clean.value)
  }
  return { type: "diff", patch: out.join("\n") }
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
  let truncated = false
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
    const rawPath = stringOf(record.relativePath) ?? stringOf(record.filePath)
    const badge = typeof record.type === "string" ? PATCH_BADGES.get(record.type) : undefined
    if (!rawPath || !badge) continue
    const clean = redactPath(cappedItem(rawPath), TOOL_PATH_MAX_CHARS)
    if (!clean.ok || clean.value.length === 0) {
      truncated = true
      continue
    }
    rows.push({
      badge,
      path: cappedItem(clean.value),
      additions: Math.max(0, finiteOf(record.additions) ?? 0),
      deletions: Math.max(0, finiteOf(record.deletions) ?? 0),
    })
  }
  return { rows, truncated }
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

// ── 「在面板打开」pill(T8):write/edit 卡头的文件目标 ──────────────────────
/** 路径帽:超长路径不进 intent(截断的路径指向错误目标,fail-closed 无 pill)。 */
export const OPEN_TARGET_MAX_CHARS = 1_024

/**
 * write/edit 卡的面板打开目标 = 原始 input.filePath(intent 的功能目标,不是
 * 展示文本,不脱敏);identity 分派命中 write/edit 规则才有 pill(#879)。
 */
export function openTargetOf(part: ToolPart): string | undefined {
  const dispatch = toolCardDispatchOf(part)
  if (dispatch.metadataOnly || (dispatch.kind !== "write" && dispatch.kind !== "edit")) return undefined
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
 * #879:入口按 identity 分派;message 过共享 redactor,失败整行隐藏。
 */
export function diagnosticsOf(part: ToolPart): { rows: DiagnosticRow[]; truncated: boolean } {
  const none = { rows: [], truncated: false }
  const dispatch = toolCardDispatchOf(part)
  if (dispatch.metadataOnly || (dispatch.kind !== "write" && dispatch.kind !== "edit")) return none
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
  const cleanFile = redactPath(cappedItem(filePath), TOOL_PATH_MAX_CHARS)
  if (!cleanFile.ok || cleanFile.value.length === 0) return none
  const file = cappedItem(basenameOf(cleanFile.value))
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
    const message = redactedInlineOf(record.message)
    if (message.hidden) {
      truncated = true
      continue
    }
    if (message.value === undefined) continue
    const line = finiteOf(record.range?.start?.line)
    rows.push({
      file,
      line: line === undefined ? undefined : Math.max(0, Math.floor(line)) + 1,
      message: message.value,
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
  const dispatch = toolCardDispatchOf(part)
  if (dispatch.metadataOnly || dispatch.kind !== "task") return { background: false }
  const input = inputOf(part)
  const metadata = metadataOf(part)
  return {
    description: redactedInlineOf(input.description).value,
    agent: redactedInlineOf(input.subagent_type).value,
    childSessionID: stringOf(metadata.sessionId),
    background: metadata.background === true,
  }
}

export interface ContextRowInfo {
  /** 分派后的 kind(图标/数据属性用),metadata-only 恒 "unknown"。 */
  kind: ToolCardKind
  /** 被动净化后的展示名称。 */
  tool: string
  titleKey?: string
  target?: string
  args: string[]
}

/** 「已探索」折叠组一行的动词/目标/参数(#879:identity 分派 + redactor,防御读取,单项帽)。 */
export function contextRowOf(part: ToolPart): ContextRowInfo {
  const dispatch = toolCardDispatchOf(part)
  const base: ContextRowInfo = { kind: dispatch.kind, tool: dispatch.name, args: [] }
  if (dispatch.metadataOnly) return base
  const input = inputOf(part)
  const offset = finiteOf(input.offset)
  const limit = finiteOf(input.limit)

  switch (dispatch.kind) {
    case "read": {
      const args: string[] = []
      if (offset !== undefined) args.push(`offset=${offset}`)
      if (limit !== undefined) args.push(`limit=${limit}`)
      const path = redactedPathOf(input.filePath)
      return {
        ...base,
        titleKey: TITLE_KEYS.read,
        target: path.value !== undefined ? cappedItem(basenameOf(path.value)) : undefined,
        args,
      }
    }
    case "list":
      return { ...base, titleKey: TITLE_KEYS.list, target: redactedPathOf(input.path).value }
    case "glob":
      return { ...base, titleKey: TITLE_KEYS.glob, target: redactedInlineOf(input.pattern).value }
    case "grep": {
      const include = redactedInlineOf(input.include)
      return {
        ...base,
        titleKey: TITLE_KEYS.grep,
        target: redactedInlineOf(input.pattern).value,
        args: include.value !== undefined ? [`include=${include.value}`] : [],
      }
    }
    default:
      return base
  }
}

export interface ContextGroupSummary {
  reads: number
  searches: number
  lists: number
}

export function contextGroupSummaryOf(parts: readonly ToolPart[]): ContextGroupSummary {
  const kinds = parts.map((part) => {
    const dispatch = toolCardDispatchOf(part)
    return dispatch.metadataOnly ? "unknown" : dispatch.kind
  })
  return {
    reads: kinds.filter((kind) => kind === "read").length,
    searches: kinds.filter((kind) => kind === "glob" || kind === "grep").length,
    lists: kinds.filter((kind) => kind === "list").length,
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

export type { RedactResult }
