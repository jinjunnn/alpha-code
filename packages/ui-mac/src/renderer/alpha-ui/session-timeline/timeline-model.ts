// REQ-125 C5/C6 — alpha 时间线行模型(纯投影,零 DOM、零上游组件)。
//
// 输入 = SDK typed 通道的地面真相(serverSync().session.data 的 message/part/session_status),
// 输出 = 视图可直接 <For> 的行数组。设计:
//   · 行对象只承载「结构」(kind/key/引用),内容(text/时长/工具状态)由视图经 solid store
//     proxy 反应式读取 —— 流式 delta 不重建行 DOM;
//   · reuseTimelineRows 以 key+rev+proxy 同一性做行复用,保证 <For> 的引用稳定;
//   · `#1473`:一回合的 reasoning / tool / 过渡话 → **一个** process 行(有序步骤;连续同类同来源且已
//     结束的工具调用合成一步);回答 = 最后一次工具调用之后的 text → markdown 行;
//     助手侧 file part → media 预览行;完成的第一方 cloud facade 工具(identity 判定)→ artifacts 产物链接行
//     —— 两者都是结果,排在回答之后;
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
import { egressPolicyDenialOf } from "../../../shared/egress-denial"
import { isCloudFacadeToolPart } from "../cloud-facade-identity"
import type { AlphaSessionIdentity } from "../session-workspace/session-workspace-core"
import { toolCardDispatchOf } from "./cards/tool-card-model"

/** I7 资源耗尽面:单块内容进渲染管线前的硬上限(字符)。 */
export const MARKDOWN_MAX_CHARS = 60_000
export const USER_TEXT_MAX_CHARS = 20_000
export const REASONING_MAX_CHARS = 20_000
export const REASONING_SUMMARY_MAX_CHARS = 120
export const TURN_ERROR_MAX_CHARS = 4_000
export const RETRY_MESSAGE_MAX_CHARS = 500

export function boundedText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return { text: text.slice(0, max), truncated: true }
}

/**
 * 折叠头只消费 reasoning 起始行里的显式标题形态。普通正文不做首句猜测，
 * 中段 Markdown 也不回溯匹配，避免把原始思维链提升到常显标题；标题本身在
 * 进入 DOM 前收窄字段帽。
 */
export function reasoningSummary(text: string): string | undefined {
  const markdown = text.slice(0, REASONING_MAX_CHARS).replace(/\r\n?/g, "\n").trimStart()
  const clean = (value: string) => {
    const summary = value
      .replace(/<[^>]+>/g, " ")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[*_~]+/g, "")
      .replace(/\s+/g, " ")
      .trim()
    return summary ? summary.slice(0, REASONING_SUMMARY_MAX_CHARS) : undefined
  }

  const html = markdown.match(/^<h([1-6])[^>]*>([\s\S]*?)<\/h\1>[ \t]*(?:\n|$)/i)
  if (html?.[2]) {
    const summary = clean(html[2])
    if (summary) return summary
  }

  const atx = markdown.match(/^#{1,6}[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?[ \t]*(?:\n|$)/)
  if (atx?.[1]) {
    const summary = clean(atx[1])
    if (summary) return summary
  }

  const strong = markdown.match(/^(?:\*\*(.+?)\*\*|__(.+?)__)[ \t]*(?:\n|$)/)
  const strongText = strong?.[1] ?? strong?.[2]
  if (strongText) return clean(strongText)
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
  /**
   * `#906`:产物的稳定标识(平台 descriptor id)。产物面板按 descriptor id / card key 匹配
   * (两者同一货币),名字**从不**是匹配键 —— 只递名字等于永不命中、静默选中该 run 的第一个
   * 产物。契约输出(ArtifactListV1 / CloudJobStatusV1)的 artifacts 项就是完整 descriptor,
   * 所以生产路径恒有 id;仅字符串降级形态缺席(那时按 fail-closed 处理:面板打开、不改选中)。
   */
  id?: string
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
  /** 引擎注册方声明的来源(E3/E4 chip 分型);缺席/非法 → chip 回通用形,不猜。 */
  source?: "command" | "mcp" | "skill"
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
      /** 复制/编辑使用原始正文；渲染仍只消费上限内的 text。 */
      copyText: () => string
      truncated: boolean
      segments: TimelineSegment[]
      attachments: TimelineAttachment[]
      comments: TimelineComment[]
      /** 斜杠命令来源(C7 可选供给;缺席 = 普通气泡)。 */
      slash?: { command: string; arguments?: string; source?: "command" | "mcp" | "skill" }
    }
  | { kind: "markdown"; key: string; rev: string; part: TextPart; streaming: boolean }
  | {
      /**
       * `#1473` 工作过程(design ⑧ #process-fold):一回合的思考 / 工具调用 / 过渡话收成**一行**,
       * 有序步骤列表;收起时一行摘要,展开后每步一行,再点一步看该类卡片的既有正文。
       * 它取代了逐 part 的 reasoning / tool / toolgroup 行;回答(最后一次工具调用之后的 text)
       * 仍是 markdown 行,媒体 / 产物 / 错误 / 中断 / 脚注 / 改动行仍在回答之后、工作过程之外。
       */
      kind: "process"
      key: string
      rev: string
      userMessageID: string
      steps: ProcessStep[]
      summary: ProcessSummary
    }
  | { kind: "media"; key: string; rev: string; media: TimelineMediaSource }
  | { kind: "artifacts"; key: string; rev: string; partID: string; links: TimelineArtifactLink[] }
  | { kind: "retry"; key: string; rev: string; userMessageID: string; attempt: number; message: string }
  | {
      kind: "turnError"
      key: string
      rev: string
      userMessageID: string
      name: string
      message: string
      /** `#1382`:这次失败是**这台电脑上的出网策略**拒的,带上被拒的目的地。缺席 = 普通失败,文案不变。 */
      egressDenied?: { authority: string }
    }
  | {
      kind: "divider"
      key: string
      rev: string
      userMessageID: string
      label: "compaction"
      /** 引擎已生成的 compaction assistant summary;视图默认折叠,不在此生成或猜测内容。 */
      summaryParts: TextPart[]
    }
  | { kind: "divider"; key: string; rev: string; userMessageID: string; label: "interrupted" }
  | { kind: "divider"; key: string; rev: string; userMessageID: string; label: "emptyTurn" }
  | {
      /**
       * `#1399` 回合脚行(design ② #turn-running):活跃回合的**最后一行**,从这条用户消息成为活跃回合起
       * 到 session_status 回到 idle 止,贯穿首个 part 未到 / 正文流式 / 推理中 / 工具执行中 / 自动重试。
       * 面(运行 / 等你)不在行模型里 —— 「等你」的真相住在 dock 的审批 feed 与 question 通道,经视图 prop 供给。
       */
      kind: "turnfoot"
      key: string
      rev: string
      userMessageID: string
      /** 计时起点 = 用户消息 time.created(不是行挂载时刻:中途重开会话显示真实已过时长)。 */
      startedAt: number
    }
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

// ── `#1473` 工作过程:步骤 / 分组 / 摘要 ─────────────────────────────────────
/**
 * 工具步骤的「同类同来源」判据(design ⑧ §2:连续、同类、同来源、都已结束的步骤合成一行)。
 * 类 = identity 分派的 kind(#879,不是裸别名);来源 = 分类 + origin;metadata-only 降级
 * 工具还按名称分 —— 两个不同的第三方工具不该被数成「同一个动作 N 次」。cloud 专用卡按规则
 * 标题分(网页搜索与下发任务不是一类动作)。
 */
export interface ProcessGroupLabel {
  kind: string
  category: string
  /** 动词的 i18n key(命中宿主规则的专用卡);缺席 = 渲染层退回名称。 */
  titleKey?: string
  /** 被动净化且有界的名称(metadata-only 时与来源分类一起显示;专用卡无 titleKey 时的退路)。 */
  name: string
  origin?: string
  metadataOnly: boolean
}

export type ProcessStep =
  | { kind: "reasoning"; key: string; part: ReasoningPart; streaming: boolean }
  | {
      /** 过渡话:后面还有工具调用的 text part;一行灰色正文,不参与合并,但切断合并。 */
      kind: "text"
      key: string
      part: TextPart
    }
  | {
      /** 一个或多个(已合并)工具调用;parts 按时间顺序,首项提供行上的「对象」。 */
      kind: "tools"
      key: string
      parts: ToolPart[]
      group: ProcessGroupLabel
    }

export interface ProcessSummary {
  /** 动作计数(按次数降序,最多 PROCESS_SUMMARY_ACTIONS_MAX 类);思考不进摘要。 */
  actions: { group: ProcessGroupLabel; count: number }[]
  /** 失败(error 态)的工具调用次数 —— 只在回合本身成功时由渲染层写成琥珀提示。 */
  failed: number
  /** 思考总时长(毫秒,只在没有任何工具动作时供摘要退回「思考 N 秒」)。 */
  reasoningMs: number
  /** 整轮用时:用户消息创建 → 最后一条助手消息完成;回合未结束即缺席。 */
  durationMs?: number
  /** 回合本身是否成功结束(无回合级错误、未被中止、已完成);失败提示只在 true 时出现。 */
  turnSucceeded: boolean
}

export const PROCESS_SUMMARY_ACTIONS_MAX = 3
/** I7:单个合并步骤的成员上限;超长连续段切成多个步骤。 */
export const PROCESS_GROUP_MAX = 24

function processGroupLabelOf(part: ToolPart): ProcessGroupLabel {
  const dispatch = toolCardDispatchOf(part)
  return {
    kind: dispatch.kind,
    category: dispatch.category,
    titleKey: dispatch.cloudRule?.titleKey ?? PROCESS_TITLE_KEYS[dispatch.kind],
    name: dispatch.name,
    origin: dispatch.origin,
    metadataOnly: dispatch.metadataOnly,
  }
}

/** 与 cards/tool-card-model 的 TITLE_KEYS 同一张表的只读副本(模型层不 import 渲染层的表)。 */
const PROCESS_TITLE_KEYS: Record<string, string | undefined> = {
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

/** 合并键:同类(kind / 云规则标题)+ 同来源(分类 + origin)+ metadata-only 时再按名称。 */
export function processGroupKeyOf(label: ProcessGroupLabel): string {
  const base = `${label.category}\u0000${label.origin ?? ""}\u0000${label.titleKey ?? label.kind}`
  return label.metadataOnly ? `${base}\u0000${label.name}` : base
}

/** 已结束 = completed / error;pending / running 的步骤永不合并。 */
export function toolStepFinished(part: ToolPart): boolean {
  return part.state.status === "completed" || part.state.status === "error"
}

/** 一次工具调用的用时(毫秒);未结束 / 时间非法即缺席。 */
export function toolStepDurationMs(part: ToolPart): number | undefined {
  const time = (part.state as { time?: { start?: unknown; end?: unknown } }).time
  if (typeof time?.start !== "number" || typeof time.end !== "number") return undefined
  return time.end >= time.start ? time.end - time.start : undefined
}

/** `#1399`:活跃回合在等你 —— 等你批准(审批弹窗)或等你回答(输入框上方的提问卡)。缺席 = 运行面。 */
export type TimelineTurnWait = "approval" | "question"

/** `#1399` 回合脚行计时:m:ss,整秒向下取整,分钟不进位到小时;负值(时钟偏斜)钉 0:00。 */
export function formatTurnElapsed(elapsedMs: number): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`
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

/** 被 dock/审批面接管、时间线不渲染的**宿主内建**工具(identity 判定;别名不是准入)。 */
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

/**
 * #934:「从时间线隐藏」是第一方特权,只有引擎铸造的 builtin identity 才能命中 ——
 * 第三方(plugin/MCP)或无快照历史行,不论把工具叫什么名字都照常渲染(fail-closed
 * 方向 = 可见:静默执行才是这里要关的洞)。category==="builtin" 只能由
 * toolCardDispatchOf 对合法快照(source ∈ {builtin, builtin-v2})铸出,别名不参与。
 */
function builtinIdentityNameOf(part: ToolPart): string | undefined {
  const dispatch = toolCardDispatchOf(part)
  return dispatch.category === "builtin" ? dispatch.name : undefined
}

function renderableToolPart(part: ToolPart) {
  const builtinName = builtinIdentityNameOf(part)
  if (builtinName !== undefined && HIDDEN_TOOLS.has(builtinName)) return false
  // question 的 pending/running 渲染在 composer dock(C7 领域),时间线只保留已回答的
  // 记录;这条接管同样只属于 builtin identity 的 question(#934,与 HIDDEN_TOOLS 同闸)。
  if (builtinName === "question") return part.state.status !== "pending" && part.state.status !== "running"
  return true
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

// ── 产物链接行(§⑥):完成态云 facade 工具输出里的产物名 → 链接行 ─────────────
// #879 审计 R-final:准入是 identity 判定,不是 `cloud_` 别名前缀。判定本体在
// cloud-facade-identity.ts(#934 起与 run-watcher 共用同一枚铸币),铸币依据与
// 「不比对 authority」的审计裁决也钉在那里。
// fail-closed:identity 缺失(历史行)/形状非法 一律无产物行。
export const ARTIFACT_LINKS_MAX = 12
const ARTIFACT_OUTPUT_PARSE_MAX = 100_000
/** `#906`:id 进 DOM 前的字段帽(平台 id 形如 `art_job_x_0_deadbeef`,远短于此)。 */
const ARTIFACT_ID_MAX_CHARS = 200
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
      if (typeof name !== "string" || !name) continue
      // `#906`:descriptor id 是产物面板唯一认得的匹配键,必须一路带到 intent。
      const id = (item as { id?: unknown }).id
      const stable = typeof id === "string" && id.length > 0 && id.length <= ARTIFACT_ID_MAX_CHARS ? id : undefined
      links.push(stable ? { runId: record.job_id, name, id: stable } : { runId: record.job_id, name })
    }
  }
  return links
}

/** fail-closed:identity 非第一方 cloud facade/未完成/输出超限/解析不出 artifacts 名字 → 空(不出行)。 */
export function artifactLinksOf(part: ToolPart): TimelineArtifactLink[] {
  if (!isCloudFacadeToolPart(part)) return []
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
/**
 * REQ-160 AC3(`#1318` / `#1325`)—— 「助手回合跑完了,却一个字都没回」。
 *
 * 四条**同时**成立才算(票面 §Scope,owner 2026-09-11 复述确认):
 *   ① 回合已结束(有 `finish`,且不是被用户中止 —— 那是中断行的辖区);
 *   ② `finish` 为 `unknown`;
 *   ③ 这一回合没有渲染出任何可见正文(投影层的 `emitted === 0`);
 *   ④ `tokens.output === 0`。
 *
 * **少一条都不算。** 尤其 ③:`finish=unknown` 但有正文的回合**不是**这一类(票面 Non-goals
 * 明写),把它算进来会把正常回复标成异常。
 *
 * 这是**启发式**:存储里没有 error、也没有任何内容安全枚举(票面 §Context)。所以呈现层只
 * 陈述确知的事实,原因以可能性给出 —— 见设计稿 2026-09-11-req160-empty-turn-row §4。
 */
export function isEmptyUnknownTurn(assistant: AssistantMessage, emitted: number): boolean {
  if (emitted > 0) return false
  if (assistant.error) return false // 被中止 / 真错误各有自己的行
  const finish = (assistant as { finish?: unknown }).finish
  if (finish !== "unknown") return false
  const tokens = (assistant as { tokens?: { output?: unknown } }).tokens
  return typeof tokens === "object" && tokens !== null && tokens.output === 0
}

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
  // `#1473`:用时不再进脚注 —— 它此前只量最后一条助手消息(created → completed),与整轮计时同名
  // 不同量;整轮用时(用户消息创建 → 最后一条助手完成)现在住在工作过程摘要(ProcessSummary.durationMs)。
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
): { command: string; arguments?: string; source?: "command" | "mcp" | "skill" } | undefined {
  if (!Array.isArray(origins)) return undefined
  for (let index = 0; index < origins.length && index < SLASH_ORIGINS_SCAN_MAX; index += 1) {
    const item = origins[index]
    if (typeof item !== "object" || item === null) continue
    const record = item as { assistantMessageID?: unknown; command?: unknown; arguments?: unknown; source?: unknown }
    if (typeof record.assistantMessageID !== "string" || !assistantIDs.has(record.assistantMessageID)) continue
    if (typeof record.command !== "string" || record.command.length === 0) continue
    const args = typeof record.arguments === "string" && record.arguments.length > 0 ? record.arguments : undefined
    // E3/E4:来源只认注册方声明的三个字面量;其余值一律按缺席处理(通用 chip,不猜)。
    const source =
      record.source === "command" || record.source === "mcp" || record.source === "skill" ? record.source : undefined
    return {
      command: record.command.slice(0, SLASH_COMMAND_MAX_CHARS),
      arguments: args?.slice(0, SLASH_ARGUMENTS_MAX_CHARS),
      ...(source ? { source } : {}),
    }
  }
  return undefined
}

/**
 * 回合级错误(排除中断):读第一个出错助手消息的 name+message,均有界(I7)。
 *
 * `#1382` 另读一格:这次失败是不是**这台电脑上的出网围栏**拒的。实测(bun fetch → @ai-sdk/openai
 * 与 @ai-sdk/anthropic 各一臂 → `ProviderError.parseAPICallError`)两处都拿得到同一份拒绝正文:
 *   `data.message`      = `Forbidden: alpha egress policy: <authority> denied (reason=unregistered) — …`
 *   `data.responseBody` = 原始正文(逐字)
 * 两处都读,是因为 `message` 那一份由上游的 `message()` 启发式拼出来(它只在 SDK 给的 message
 * 恰好等于状态短语时才把 responseBody 接上去);`responseBody` 则是逐字透传,不依赖那条启发式。
 * 判据细到 `reason=unregistered`:502 `dial-failed` 的正文带同一个前缀,但那是**真的连不上**,
 * 说成「被策略拦下」会把人引去查放行名单(见 shared/egress-denial.ts 的第 2 条纪律)。
 */
export function turnErrorOf(
  assistants: readonly AssistantMessage[],
): { name: string; message: string; egressDenied?: { authority: string } } | undefined {
  const failed = assistants.find((message) => message.error && message.error.name !== "MessageAbortedError")
  if (!failed?.error) return undefined
  const data = (failed.error as { data?: { message?: unknown; responseBody?: unknown } }).data
  const raw = typeof data?.message === "string" ? data.message : ""
  const body = typeof data?.responseBody === "string" ? data.responseBody : ""
  const egressDenied = egressPolicyDenialOf(raw) ?? egressPolicyDenialOf(body)
  return {
    name: failed.error.name,
    message: boundedText(raw, TURN_ERROR_MAX_CHARS).text,
    ...(egressDenied ? { egressDenied } : {}),
  }
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
    const userParts = input.partsOf(userMessage.id)
    const textPart = userParts.find((part): part is TextPart => part.type === "text" && !part.synthetic)
    const rawText = textPart?.text ?? ""
    const { text, truncated } = boundedText(rawText, USER_TEXT_MAX_CHARS)
    const segments = segmentUserText(text, mentionSpans(userParts))
    const attachments = userParts.flatMap((part) => (part.type === "file" ? (attachmentOf(part) ?? []) : []))
    const comments = userParts.flatMap((part) => commentOf(part) ?? [])
    const turnAssistants = assistantsByParent.get(userMessage.id) ?? []
    const slash = slashOriginForTurn(input.slashOrigins, new Set(turnAssistants.map((message) => message.id)))

    // 用户气泡是否渲染 —— 回合分隔行跟着它走(#620)。分隔行原来在此之前**无条件** push,
    // 于是没有气泡的回合(如「继续生成」发出的 synthetic 续写)会在时间线上留下一条
    // 孤零零的「时间 · 新回合」。分隔行的语义是「上一段到此为止,下面是你新说的话」,
    // 没有那句话就没有可分隔的东西;该回合的助手输出照常渲染。
    const userVisible = Boolean(text || attachments.length > 0 || comments.length > 0 || slash)

    if (index > 0 && userVisible)
      rows.push({
        kind: "turn",
        key: `turn:${userMessage.id}`,
        rev: String(userMessage.time.created),
        userMessageID: userMessage.id,
        createdAt: userMessage.time.created,
      })

    if (userVisible)
      rows.push({
        kind: "user",
        key: `user:${userMessage.id}`,
        rev: [
          text,
          String(truncated),
          segments.map((segment) => `${segment.kind ?? "t"}:${segment.text.length}:${segment.label ?? ""}`).join(","),
          attachments.map((attachment) => attachment.partID).join(","),
          comments.map((comment) => comment.partID).join(","),
          slash ? `${slash.command}\u0000${slash.arguments ?? ""}\u0000${slash.source ?? ""}` : "",
        ].join("§"),
        message: userMessage,
        text,
        copyText: () => rawText,
        truncated,
        segments,
        attachments,
        comments,
        slash,
      })

    const compacted = userParts.some((part) => part.type === "compaction")
    const compactionSummaryParts = compacted
      ? turnAssistants.flatMap((assistant) =>
          assistant.summary && typeof assistant.time.completed === "number"
            ? input
                .partsOf(assistant.id)
                .filter((part): part is TextPart => part.type === "text" && !!part.text?.trim())
            : [],
        )
      : []

    if (compacted)
      rows.push({
        kind: "divider",
        key: `compaction:${userMessage.id}`,
        rev: `compaction:${compactionSummaryParts.map((part) => part.id).join(",")}`,
        userMessageID: userMessage.id,
        label: "compaction",
        summaryParts: compactionSummaryParts,
      })

    let emitted = 0
    const assistants = turnAssistants
    const turnActive = userMessage.id === activeUserID && input.status !== "idle"

    // ── `#1473` 一回合 = 一行工作过程 + 完整的回答(design ⑧ §2 / §4) ──────────────
    // 先把整回合(跨本回合全部助手消息)的可见 part 按时间顺序摊平,再按「最后一次工具调用」
    // 切成两半:之前的 reasoning / tool / text 进工作过程(text 即过渡话),之后的 text 是回答。
    type TurnItem =
      | { type: "text"; part: TextPart; assistant: AssistantMessage; streaming: boolean }
      | { type: "reasoning"; part: ReasoningPart; assistant: AssistantMessage; streaming: boolean }
      | { type: "tool"; part: ToolPart; assistant: AssistantMessage }
    const items: TurnItem[] = []
    // 媒体行(顶层 file part / 工具附件)与产物行:结果,不进工作过程 —— 回答之后按原顺序列出。
    const trailing: TimelineRow[] = []
    const emittedByAssistant = new Map<string, number>()
    const bump = (assistant: AssistantMessage) =>
      emittedByAssistant.set(assistant.id, (emittedByAssistant.get(assistant.id) ?? 0) + 1)

    for (const assistant of assistants) {
      const parts = input.partsOf(assistant.id)
      // compaction assistant 的完成态 text 已收进上方分隔行作为「保留要点」;不再当普通助手正文
      // 重复摊开。其内部 reasoning 也不进入普通时间线,错误仍由回合级错误行呈现。
      const compactionSummary = compacted && assistant.summary === true
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
            if (compactionSummary) continue
            items.push({ type: "text", part, assistant, streaming: streamingHere && lastVisible === part })
            bump(assistant)
            continue
          }
          case "reasoning": {
            if (!part.text?.trim()) continue
            if (compactionSummary) continue
            items.push({ type: "reasoning", part, assistant, streaming: streamingHere && part.time.end === undefined })
            bump(assistant)
            continue
          }
          case "tool": {
            if (!renderableToolPart(part)) continue
            items.push({ type: "tool", part, assistant })
            bump(assistant)
            const links = artifactLinksOf(part)
            if (links.length > 0)
              trailing.push({
                kind: "artifacts",
                key: `artifacts:${part.id}`,
                rev: links.map((link) => `${link.runId}/${link.id ?? ""}/${link.name}`).join("|"),
                partID: part.id,
                links,
              })
            // 工具附件(生产上图片/PDF 的真实通道)→ 媒体预览行。
            // #587 审计 R-final:媒体行与卡同一条 identity 分派闸 —— metadata-only 降级
            // (第三方 MCP/plugin/快照缺失或非法)的 part,其附件(远端可控的 data: URL 与
            // 文件名)不得绕过降级卡在主时间线渲染。fail-closed:降级即零媒体行。
            if (toolCardDispatchOf(part).metadataOnly) continue
            toolMediaOf(part).forEach((media, index) => {
              trailing.push({
                kind: "media",
                key: `media:${part.id}:${index}`,
                rev: `${media.mime}§${media.name}§${media.url.length}`,
                media,
              })
            })
            continue
          }
          case "file": {
            const media = mediaSourceOfFilePart(part)
            trailing.push({
              kind: "media",
              key: `part:${part.id}`,
              rev: `${media.mime}§${media.name}§${media.url.length}`,
              media,
            })
            bump(assistant)
            continue
          }
          default:
            // agent/snapshot/subtask/retry/compaction 等非文本流 part:无视觉合同,fail-closed
            // 不渲染(subtask 与上游 v1/v2 行为一致;retry 行由 session_status 驱动)。
            continue
        }
      }
    }

    // 回答 = 最后一次工具调用之后的 text part(§4)。没有时把最后一段过渡话提为回答 ——
    // 只对已结束的回合这么做:活跃回合里「文字之后又开始调工具」正是过渡话的定义,不能一边
    // 跑一边把它提成回答再收回去(实时形态归 #1474)。
    let lastToolIndex = -1
    items.forEach((item, index) => {
      if (item.type === "tool") lastToolIndex = index
    })
    const isAnswer = (item: TurnItem, index: number) => item.type === "text" && index > lastToolIndex
    const answerIndexes = new Set(items.map((_, index) => index).filter((index) => isAnswer(items[index]!, index)))
    if (answerIndexes.size === 0 && !turnActive) {
      for (let index = items.length - 1; index >= 0; index -= 1) {
        if (items[index]!.type === "text") {
          answerIndexes.add(index)
          break
        }
      }
    }

    const steps: ProcessStep[] = []
    const actionCounts = new Map<string, { group: ProcessGroupLabel; count: number }>()
    let failed = 0
    let reasoningMs = 0
    let run: { key: string; group: ProcessGroupLabel; parts: ToolPart[] } | undefined
    const flushRun = () => {
      if (!run) return
      const { group, parts } = run
      run = undefined
      // I7:超长连续段切成多个步骤。
      for (let start = 0; start < parts.length; start += PROCESS_GROUP_MAX) {
        const chunk = parts.slice(start, start + PROCESS_GROUP_MAX)
        steps.push({ kind: "tools", key: `tools:${chunk[0]!.id}`, parts: chunk, group })
      }
    }
    items.forEach((item, index) => {
      if (answerIndexes.has(index)) {
        // 被提为回答的过渡话不进步骤,但它仍然切断合并 —— 它前后的两次工具调用在时间上本就隔着一段话,
        // 不因为那段话被提走就并成「同一个动作 2 次」。
        flushRun()
        return
      }
      if (item.type === "text") {
        // 过渡话:一行灰色正文,不参与合并,但切断合并。
        flushRun()
        steps.push({ kind: "text", key: `say:${item.part.id}`, part: item.part })
        return
      }
      if (item.type === "reasoning") {
        // 思考不与工具合并,也不与思考合并(每段一行:思考 N 秒)。
        flushRun()
        steps.push({ kind: "reasoning", key: `reason:${item.part.id}`, part: item.part, streaming: item.streaming })
        const { start, end } = item.part.time
        if (typeof end === "number" && end >= start) reasoningMs += end - start
        return
      }
      const part = item.part
      const group = processGroupLabelOf(part)
      const key = processGroupKeyOf(group)
      const counted = actionCounts.get(key)
      if (counted) counted.count += 1
      else actionCounts.set(key, { group, count: 1 })
      if (part.state.status === "error") failed += 1
      // 合并:连续、同类同来源、都已结束;运行中 / 待运行的步骤永不合并(自己一行,也不吸收后者)。
      if (run && run.key === key && toolStepFinished(part)) {
        run.parts.push(part)
        return
      }
      flushRun()
      if (toolStepFinished(part)) run = { key, group, parts: [part] }
      else steps.push({ kind: "tools", key: `tools:${part.id}`, parts: [part], group })
    })
    flushRun()

    const lastAssistant = assistants.at(-1)
    const turnFinished =
      !turnActive && assistants.length > 0 && assistants.every((assistant) => typeof assistant.time.completed === "number")
    const turnSucceeded = turnFinished && assistants.every((assistant) => !assistant.error)
    const completedAt = lastAssistant?.time.completed
    const durationMs =
      turnFinished && typeof completedAt === "number" && completedAt >= userMessage.time.created
        ? completedAt - userMessage.time.created
        : undefined
    const actions = [...actionCounts.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, PROCESS_SUMMARY_ACTIONS_MAX)
    const summary: ProcessSummary = {
      actions,
      failed,
      reasoningMs,
      turnSucceeded,
      ...(durationMs !== undefined ? { durationMs } : {}),
    }
    if (steps.length > 0)
      rows.push({
        kind: "process",
        key: `process:${userMessage.id}`,
        rev: [
          steps
            .map((step) =>
              step.kind === "tools"
                ? `${step.key}=${step.parts.map((part) => `${part.id}:${part.state.status}`).join(",")}`
                : step.kind === "reasoning"
                  ? `${step.key}=${String(step.streaming)}:${String(step.part.time.end ?? "")}`
                  : step.key,
            )
            .join("|"),
          actions.map((action) => `${processGroupKeyOf(action.group)}=${action.count}`).join(","),
          String(failed),
          String(reasoningMs),
          String(durationMs ?? ""),
          String(turnSucceeded),
        ].join("§"),
        userMessageID: userMessage.id,
        steps,
        summary,
      })

    items.forEach((item, index) => {
      if (!answerIndexes.has(index) || item.type !== "text") return
      rows.push({
        kind: "markdown",
        key: `md:${item.part.id}`,
        rev: String(item.streaming),
        part: item.part,
        streaming: item.streaming,
      })
    })
    rows.push(...trailing)

    for (const assistant of assistants) {
      emitted += emittedByAssistant.get(assistant.id) ?? 0
      if (assistant.error?.name === "MessageAbortedError")
        rows.push({
          kind: "divider",
          key: `interrupted:${assistant.id}`,
          rev: "interrupted",
          userMessageID: userMessage.id,
          label: "interrupted",
        })
      else if (isEmptyUnknownTurn(assistant, emitted))
        rows.push({
          kind: "divider",
          key: `emptyTurn:${assistant.id}`,
          rev: "emptyTurn",
          userMessageID: userMessage.id,
          label: "emptyTurn",
        })
    }

    // 回合末富脚注(A6):只在回合尾态成功完成且有可见内容时出行;当前活跃回合
    // (busy/retry 等非 idle)尾态未定,一律不出(审计 Major-1)。
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
        rev: `${turnError.name}§${turnError.message}§${turnError.egressDenied?.authority ?? ""}`,
        userMessageID: userMessage.id,
        name: turnError.name,
        message: turnError.message,
        ...(turnError.egressDenied ? { egressDenied: turnError.egressDenied } : {}),
      })

    // `#1399` 回合脚行:活跃回合(session_status 非 idle)的**最后一行**。此前这里是 thinking 行,只在
    // `emitted === 0` 时入列 —— 吐出第一个 part 就消失,正文流式 / 推理中 / 工具执行中三个子状态里时间线
    // 一动不动,那正是 owner 观察到的「一轮在跑时页面什么都不动」。现在它与回合同寿命:结局(完成 / 中止 /
    // 出错 / 空回合)到来时 status 已回到 idle,本行不再入列,位置由脚注 / 中断行 / 错误卡 / 空回合行接管。
    // rev 只带计时起点:面翻转不重建行对象(视图靠同一个 DOM 节点翻 data-face,live region 不插拔)。
    if (userMessage.id === activeUserID && input.status !== "idle")
      rows.push({
        kind: "turnfoot",
        key: `turnfoot:${userMessage.id}`,
        rev: String(userMessage.time.created),
        userMessageID: userMessage.id,
        startedAt: userMessage.time.created,
      })
  })

  return rows
}

function sameProcessStep(before: ProcessStep, next: ProcessStep): boolean {
  if (before.kind !== next.kind || before.key !== next.key) return false
  if (before.kind === "tools" && next.kind === "tools")
    return before.parts.length === next.parts.length && before.parts.every((part, index) => part === next.parts[index])
  return (before as { part: unknown }).part === (next as { part: unknown }).part
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
    if (before.kind === "process" && row.kind === "process") {
      // rev 已含每步的 key 与状态;这里只再核对承载的 store proxy 同一性(防 stale proxy)。
      if (before.steps.length !== row.steps.length) return row
      if (before.steps.some((step, index) => !sameProcessStep(step, row.steps[index]!))) return row
    }
    reused += 1
    return before
  })
  if (reused === next.length && previous.length === next.length) return previous as TimelineRow[]
  return result
}
