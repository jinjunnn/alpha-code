// REQ-234 `#1529`(基线 docs/design/2026-10-14-req234-hub-agent-install-baseline.md §2.2 / §2.5 / §2.6)——
// main ⇄ sidecar(parentPort)上 `alpha.*` 这一族窄消息的**唯一合同**,两侧共用。
//
// 形制与 workspace-write-probe.ts 相同:一份文件、build/parse 成对、parse 一律 fail-closed(形状不对 ⇒ undefined,
// 由收方丢弃并记一行,不带着半条消息去做事)。本族**穷举**(I6):
//
//   ext → main   alpha.hub.view.request     { id, directory, sessionID?, agent?, query? }  只读:按目录算视图
//   ext → main   alpha.hub.request.request  { id, requestId }                              只读:某次安装请求的阶段
//   ext → main   alpha.reload.report        { generation, scope, outcome, directories, error? }  记录
//   main → ext   alpha.reload.request       { generation, scope, items, reason, force? }   ext 调度器入队
//   main → ext   alpha.hub.view.reply / alpha.hub.request.reply                              对 id 的应答
//
// 未知 type 两侧都忽略;sidecar.ts 的 parseCommand 对这些 type 返回 undefined,两边不改对方的分支。
// 安全边界(S12):sidecar 里任何 JS 都能发 ext → main 的三种;main 对它们只做**只读查询与重载请求**,
// 没有任何一条能安装、启用或写盘。
//
// 本文件被 packages/ext 经相对路径 import(与 alpha-identity 同一先例),所以**不得**依赖 electron / node:fs。
// C1 合并后冻结:消息族与载荷、状态词、agentNote、requestId 形状与阶段词(基线 §4 末段)。

// ── 状态词(§2.5)────────────────────────────────────────────────────────────────────────────

export const HUB_STATE_WORDS = ["not-installed", "installed", "reload-pending", "available"] as const
export type HubStateWord = (typeof HUB_STATE_WORDS)[number]

/**
 * 原因的机器码(`detail` 是给人看的技术细节,只进日志 / 次要文字):
 *   disabled       已装,账本 desiredState = disabled(装完即停用,不承诺可用)
 *   reload-waiting 有在途重载(排队、等会话空闲、或引擎状态查不到)
 *   reload-failed  最近一次重载报告失败
 *   not-loaded     没有在途重载,但本目录的即时核验没过
 */
export const HUB_REASON_CODES = ["disabled", "reload-waiting", "reload-failed", "not-loaded"] as const
export type HubReasonCode = (typeof HUB_REASON_CODES)[number]
export type HubStateReason = { code: HubReasonCode; detail?: string }

export type HubViewRow = {
  /** catalog id 或 `user:<name>`。 */
  id: string
  /** 安装行 = 账本作用域;未安装的目录行 = null。行身份 = (id, scope)。 */
  scope: "global" | "project" | null
  name: string
  kind: string
  displayName: string
  description: string
  installed: boolean
  enabled: boolean
  state: HubStateWord
  stateReason?: HubStateReason
  /** `none` / `secret:<VAR,…>` / `platform-login`。只含变量名,从不含值。 */
  authorization: string
  /** 只出现在 ext 侧的应答里,且只对技能行;不改 `state`(I4)。 */
  agentNote?: string
}

export type HubView = { directory: string; rows: HubViewRow[]; warnings: string[] }

/** agentNote 的两句固定文案(基线 §2.5 技能行原文)。 */
export const AGENT_NOTE_DENIED = "本会话的 agent 规则拒绝该技能,调用会被拒"
export const AGENT_NOTE_UNVERIFIED = "本会话权限未核验"

// ── 安装请求的阶段(§2.3,I9)──────────────────────────────────────────────────────────────────

export const HUB_REQUEST_STAGES = ["confirming", "submitted", "committed", "failed", "declined"] as const
export type HubRequestStage = (typeof HUB_REQUEST_STAGES)[number]

/** requestId 由 ext 生成(随机),随审批请求的 metadata 走;形状冻结。 */
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/
export function isHubRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID.test(value)
}

export type HubRequestRecord = {
  requestId: string
  catalogId: string
  stage: HubRequestStage
  /** committed 时由 main 安装体写入:落在哪个作用域。 */
  scope?: "global" | "project"
  /** failed 的原因。 */
  reason?: string
}

// ── 重载(§2.6)────────────────────────────────────────────────────────────────────────────────

export type ReloadScope = "global" | { directory: string }
export type ReloadItem = { id: string; scope: "global" | "project" }
export const RELOAD_OUTCOMES = ["reloaded", "failed", "waiting"] as const
export type ReloadOutcome = (typeof RELOAD_OUTCOMES)[number]

// ── 消息 ──────────────────────────────────────────────────────────────────────────────────────

export type HubViewRequestMessage = {
  type: "alpha.hub.view.request"
  id: number
  directory: string
  sessionID?: string
  agent?: string
  query?: string
}
export type HubRequestQueryMessage = { type: "alpha.hub.request.request"; id: number; requestId: string }
export type ReloadReportMessage = {
  type: "alpha.reload.report"
  generation: number
  scope: ReloadScope
  outcome: ReloadOutcome
  directories: string[]
  /** failed:失败原因;waiting:在等什么(「2 session(s) busy」/「status of <dir> unknown」)。 */
  error?: string
}
export type ReloadRequestMessage = {
  type: "alpha.reload.request"
  generation: number
  scope: ReloadScope
  items: ReloadItem[]
  reason: string
  /** 用户显式「现在重载」:只跳过「等空闲」这一条,不跳过状态查不到(§2.6)。 */
  force?: true
}
export type HubViewReplyMessage =
  | { type: "alpha.hub.view.reply"; id: number; view: HubView }
  | { type: "alpha.hub.view.reply"; id: number; error: string }
export type HubRequestReplyMessage =
  | { type: "alpha.hub.request.reply"; id: number; record: HubRequestRecord | null }
  | { type: "alpha.hub.request.reply"; id: number; error: string }

export type AlphaSidecarInbound = HubViewRequestMessage | HubRequestQueryMessage | ReloadReportMessage
export type AlphaSidecarOutbound = ReloadRequestMessage | HubViewReplyMessage | HubRequestReplyMessage

const MAX_TEXT = 4_096

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}
function isText(value: unknown, max = MAX_TEXT): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max
}
function isOptionalText(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.length <= MAX_TEXT)
}

/** `alpha.*` 前缀:收方据此决定「是不是本族」;是本族但 parse 不过 = 丢弃 + 记一行。 */
export function isAlphaSidecarMessage(value: unknown): boolean {
  return isRecord(value) && typeof value.type === "string" && value.type.startsWith("alpha.")
}

export function parseReloadScope(value: unknown): ReloadScope | undefined {
  if (value === "global") return "global"
  if (!isRecord(value) || Object.keys(value).length !== 1 || !isText(value.directory)) return
  return { directory: value.directory }
}

function parseReloadItems(value: unknown): ReloadItem[] | undefined {
  if (!Array.isArray(value) || value.length > 256) return
  const items: ReloadItem[] = []
  for (const item of value) {
    if (!isRecord(item) || !isText(item.id, 256) || (item.scope !== "global" && item.scope !== "project")) return
    items.push({ id: item.id, scope: item.scope })
  }
  return items
}

/** main 侧:ext → main 的三种。别的一律 undefined(含 main → ext 的方向)。 */
export function parseAlphaSidecarInbound(value: unknown): AlphaSidecarInbound | undefined {
  if (!isRecord(value)) return
  if (value.type === "alpha.hub.view.request") {
    if (!isId(value.id) || !isText(value.directory)) return
    if (!isOptionalText(value.sessionID) || !isOptionalText(value.agent) || !isOptionalText(value.query)) return
    return {
      type: "alpha.hub.view.request",
      id: value.id,
      directory: value.directory,
      ...(typeof value.sessionID === "string" && value.sessionID ? { sessionID: value.sessionID } : {}),
      ...(typeof value.agent === "string" && value.agent ? { agent: value.agent } : {}),
      ...(typeof value.query === "string" ? { query: value.query } : {}),
    }
  }
  if (value.type === "alpha.hub.request.request") {
    if (!isId(value.id) || !isHubRequestId(value.requestId)) return
    return { type: "alpha.hub.request.request", id: value.id, requestId: value.requestId }
  }
  if (value.type === "alpha.reload.report") {
    const scope = parseReloadScope(value.scope)
    if (!isId(value.generation) || !scope) return
    if (typeof value.outcome !== "string" || !(RELOAD_OUTCOMES as readonly string[]).includes(value.outcome)) return
    if (!Array.isArray(value.directories) || !value.directories.every((d) => isText(d))) return
    if (!isOptionalText(value.error)) return
    return {
      type: "alpha.reload.report",
      generation: value.generation,
      scope,
      outcome: value.outcome as ReloadOutcome,
      directories: value.directories as string[],
      ...(typeof value.error === "string" && value.error ? { error: value.error } : {}),
    }
  }
  return
}

/** ext 侧:main → ext 的重载请求。 */
export function parseReloadRequest(value: unknown): ReloadRequestMessage | undefined {
  if (!isRecord(value) || value.type !== "alpha.reload.request") return
  const scope = parseReloadScope(value.scope)
  const items = parseReloadItems(value.items)
  if (!isId(value.generation) || !scope || !items || !isText(value.reason)) return
  if (value.force !== undefined && value.force !== true) return
  return {
    type: "alpha.reload.request",
    generation: value.generation,
    scope,
    items,
    reason: value.reason,
    ...(value.force === true ? { force: true as const } : {}),
  }
}

export function buildReloadRequest(input: {
  generation: number
  scope: ReloadScope
  items: ReloadItem[]
  reason: string
  force?: boolean
}): ReloadRequestMessage {
  return {
    type: "alpha.reload.request",
    generation: input.generation,
    scope: input.scope === "global" ? "global" : { directory: input.scope.directory },
    items: input.items.map((item) => ({ id: item.id, scope: item.scope })),
    reason: input.reason,
    ...(input.force ? { force: true as const } : {}),
  }
}

export function buildHubViewReply(id: number, result: { view: HubView } | { error: string }): HubViewReplyMessage {
  return "view" in result
    ? { type: "alpha.hub.view.reply", id, view: result.view }
    : { type: "alpha.hub.view.reply", id, error: result.error }
}

export function buildHubRequestReply(
  id: number,
  result: { record: HubRequestRecord | null } | { error: string },
): HubRequestReplyMessage {
  return "record" in result
    ? { type: "alpha.hub.request.reply", id, record: result.record }
    : { type: "alpha.hub.request.reply", id, error: result.error }
}

// ── ext 侧(`#1531`):建 ext → main 的三种、解析 main → ext 的两种应答 ──────────────────────────────
//
// 线形不变(仍是上面冻结的那几种);这里只补 ext 那一侧的 build/parse,与 main 侧 parseAlphaSidecarInbound 同一纪律:
// 应答形状不对 ⇒ undefined,由 ext 当「无法判断」处理,不带着半个视图去回答 agent。

export function buildHubViewRequest(input: {
  id: number
  directory: string
  sessionID?: string
  agent?: string
  query?: string
}): HubViewRequestMessage {
  return {
    type: "alpha.hub.view.request",
    id: input.id,
    directory: input.directory,
    ...(input.sessionID ? { sessionID: input.sessionID } : {}),
    ...(input.agent ? { agent: input.agent } : {}),
    ...(input.query !== undefined ? { query: input.query } : {}),
  }
}

export function buildHubRequestQuery(id: number, requestId: string): HubRequestQueryMessage {
  return { type: "alpha.hub.request.request", id, requestId }
}

export function buildReloadReport(input: {
  generation: number
  scope: ReloadScope
  outcome: ReloadOutcome
  directories: string[]
  error?: string
}): ReloadReportMessage {
  return {
    type: "alpha.reload.report",
    generation: input.generation,
    scope: input.scope === "global" ? "global" : { directory: input.scope.directory },
    outcome: input.outcome,
    directories: [...input.directories],
    ...(input.error ? { error: input.error } : {}),
  }
}

function parseStateReason(value: unknown): HubStateReason | undefined | null {
  if (value === undefined) return undefined
  if (!isRecord(value) || typeof value.code !== "string" || !(HUB_REASON_CODES as readonly string[]).includes(value.code)) return null
  if (value.detail !== undefined && typeof value.detail !== "string") return null
  return { code: value.code as HubReasonCode, ...(typeof value.detail === "string" ? { detail: value.detail } : {}) }
}

function parseHubViewRow(value: unknown): HubViewRow | undefined {
  if (!isRecord(value)) return
  const text = ["id", "name", "kind", "displayName", "description", "authorization"] as const
  if (!text.every((key) => typeof value[key] === "string")) return
  if (value.scope !== null && value.scope !== "global" && value.scope !== "project") return
  if (typeof value.installed !== "boolean" || typeof value.enabled !== "boolean") return
  if (typeof value.state !== "string" || !(HUB_STATE_WORDS as readonly string[]).includes(value.state)) return
  const reason = parseStateReason(value.stateReason)
  if (reason === null) return
  if (value.agentNote !== undefined && typeof value.agentNote !== "string") return
  return {
    id: value.id as string,
    scope: value.scope,
    name: value.name as string,
    kind: value.kind as string,
    displayName: value.displayName as string,
    description: value.description as string,
    installed: value.installed,
    enabled: value.enabled,
    state: value.state as HubStateWord,
    ...(reason ? { stateReason: reason } : {}),
    authorization: value.authorization as string,
    ...(typeof value.agentNote === "string" ? { agentNote: value.agentNote } : {}),
  }
}

/** ext 侧:main 对视图请求的应答。行里任何一条形状不对 ⇒ 整条应答作废(不呈现半个视图)。 */
export function parseHubViewReply(value: unknown): HubViewReplyMessage | undefined {
  if (!isRecord(value) || value.type !== "alpha.hub.view.reply" || !isId(value.id)) return
  if (typeof value.error === "string") return { type: "alpha.hub.view.reply", id: value.id, error: value.error }
  const view = value.view
  if (!isRecord(view) || typeof view.directory !== "string" || !Array.isArray(view.rows) || !Array.isArray(view.warnings)) return
  if (!view.warnings.every((warning) => typeof warning === "string")) return
  const rows = view.rows.map(parseHubViewRow)
  if (rows.some((row) => row === undefined)) return
  return {
    type: "alpha.hub.view.reply",
    id: value.id,
    view: { directory: view.directory, rows: rows as HubViewRow[], warnings: view.warnings as string[] },
  }
}

/** ext 侧:main 对阶段查询的应答。`record: null` = main 没有这次请求的记录(合法应答,不是错误)。 */
export function parseHubRequestReply(value: unknown): HubRequestReplyMessage | undefined {
  if (!isRecord(value) || value.type !== "alpha.hub.request.reply" || !isId(value.id)) return
  if (typeof value.error === "string") return { type: "alpha.hub.request.reply", id: value.id, error: value.error }
  if (value.record === null) return { type: "alpha.hub.request.reply", id: value.id, record: null }
  const record = value.record
  if (!isRecord(record) || !isHubRequestId(record.requestId) || !isText(record.catalogId, 256)) return
  if (typeof record.stage !== "string" || !(HUB_REQUEST_STAGES as readonly string[]).includes(record.stage)) return
  if (record.scope !== undefined && record.scope !== "global" && record.scope !== "project") return
  if (record.reason !== undefined && typeof record.reason !== "string") return
  return {
    type: "alpha.hub.request.reply",
    id: value.id,
    record: {
      requestId: record.requestId,
      catalogId: record.catalogId,
      stage: record.stage as HubRequestStage,
      ...(record.scope ? { scope: record.scope } : {}),
      ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
    },
  }
}
