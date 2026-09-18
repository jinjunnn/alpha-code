// REQ-160 `#1324` —— 上报游标:「哪些轮次已经有了终态」的唯一记录,以及**响应怎么归类**。
// electron-free、root 参数化(与 alpha-installs / alpha-workdir 同测试性模式)。
//
// ── 429 单开一格,这是本文件存在的主要理由 ──────────────────────────────────────────────────
// 线契约(alpha-web `docs/contracts/chat-archive-upload.md` §Responses)对客户端只写了三句:
//   · 2xx → 推进游标;
//   · **429 以外**的 4xx → 终态:推进游标、不重发、本地记一行那个错误码;
//   · 5xx、网络错误、**以及 429** → 退避重发,**游标不动**。
// 把 429 归进「4xx 终态」会正好丢掉数据,而且丢的是**故障期那一批**:
// 数据库故障 ⇒ 路由答 503 ⇒ 客户端重试 ⇒ **每一次重试都记在同一个按用户的限流桶上**
// (桶在验签之后、其它拒绝之前扣)⇒ 桶满 ⇒ 路由改答 429 ⇒ 若当终态推过去,被推过去的正是这次
// 故障卡住、一条都还没存进去的那批轮次。(`alpha-web#218` 合并前审计第 1 轮 MAJOR。)
// 判据在 chat-archive-cursor.test.ts 的「503 → 重试 → 429 → 游标不动」那条:它跑的是上报器的
// 生产路径,不是本文件的纯函数,所以把 `classifyArchiveResponse` 改回旧口径它会红。
//
// ── 未知状态码往哪一边倒 ────────────────────────────────────────────────────────────────────
// 只有 400–499(429 除外)推进游标。1xx/3xx 与任何没列进契约的状态一律按可重试处理:
// 推进游标是**不可逆的丢弃**,退避重发最多浪费一次请求。
//
// ── 游标值为什么是 assistant 的 `engine_message_id`,以及为什么能直接比大小 ──────────────────
// 引擎的 id 是「时间升序」型:`msg_` + 12 位定宽十六进制的 (ms×4096+序号) + 14 位随机 base62
// (`packages/opencode/src/id/id.ts:51-67`)。定宽 + 全 ASCII ⇒ **字典序 = 时间序**,与引擎自己
// 排消息用的 `(time_created, id)` 同向。唯一的退化窗口是进程重启后同一毫秒内序号归零(1ms),
// 而重发一条已存过的轮次在服务端是无副作用的(`UNIQUE (session_id, engine_message_id)`)。
//
// ── 没有 outbox ────────────────────────────────────────────────────────────────────────────
// 重试 = 下一次 idle 重扫(基线 §2.6)。所以本文件只需要记「到哪儿为止是终态」,不需要记
// 「哪些待发」;进程被杀、断网、关机都只会让下一次 idle 多扫几条,不会丢。

import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { writeFileAtomicSync } from "./ext-atomic-fs"

export const CHAT_ARCHIVE_CURSOR_FILE = "chat-archive-cursor.json"

/** 429 没给 `Retry-After` 时的退避;给了就按它(秒)。 */
export const DEFAULT_RATE_LIMIT_BACKOFF_MS = 60_000
/** `Retry-After` 再长也不在一次 idle 里等过这么久 —— 等不起就交给下一次 idle 重扫。 */
export const MAX_RATE_LIMIT_BACKOFF_MS = 300_000

export type ChatArchiveCursorState = {
  schema_version: 1
  /** 功能首次启用的时刻(ms)。只上报此后**完成**的轮次;历史不回填(owner 2026-09-17)。 */
  enabled_at: number
  /** sessionId → 最后一条终态过的 assistant `engine_message_id`。 */
  sessions: Record<string, string>
}

export type ChatArchiveCursorStore = {
  enabledAt: () => number
  lastReported: (sessionId: string) => string | undefined
  /** 终态(2xx 或 429 以外的 4xx)之后推进。同一会话只向前走,不回退。 */
  advance: (sessionId: string, assistantMessageId: string) => void
  snapshot: () => ChatArchiveCursorState
}

function emptyState(now: number): ChatArchiveCursorState {
  return { schema_version: 1, enabled_at: now, sessions: {} }
}

function decodeState(raw: unknown, now: number): ChatArchiveCursorState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyState(now)
  const value = raw as Record<string, unknown>
  if (value.schema_version !== 1) return emptyState(now)
  const enabledAt = value.enabled_at
  if (typeof enabledAt !== "number" || !Number.isFinite(enabledAt)) return emptyState(now)
  const sessions: Record<string, string> = {}
  const rawSessions = value.sessions
  if (rawSessions && typeof rawSessions === "object" && !Array.isArray(rawSessions)) {
    for (const [sessionId, messageId] of Object.entries(rawSessions as Record<string, unknown>)) {
      if (typeof messageId === "string" && messageId.length > 0) sessions[sessionId] = messageId
    }
  }
  return { schema_version: 1, enabled_at: enabledAt, sessions }
}

/**
 * 打开(必要时铸出)游标。文件不存在 / 读不动 / 形状不认得 ⇒ 当成「现在启用」重铸:
 * 那样最坏只是不回填一段历史,而把一个读不懂的文件当成空游标去回填,会把**启用之前**的
 * 全部历史会话一次性传上去 —— owner 明确不要的那件事。
 */
export function openChatArchiveCursor(deps: {
  userDataPath: string
  now?: () => number
  onWriteError?: (error: unknown) => void
}): ChatArchiveCursorStore {
  const now = deps.now ?? Date.now
  const file = join(deps.userDataPath, CHAT_ARCHIVE_CURSOR_FILE)
  let state: ChatArchiveCursorState
  let loadedFromDisk = false
  try {
    state = decodeState(JSON.parse(readFileSync(file, "utf8")) as unknown, now())
    loadedFromDisk = true
  } catch {
    state = emptyState(now())
  }

  const persist = () => {
    try {
      mkdirSync(deps.userDataPath, { recursive: true, mode: 0o700 })
      writeFileAtomicSync(file, JSON.stringify(state), { mode: 0o600 })
    } catch (error) {
      deps.onWriteError?.(error)
    }
  }

  // 首次启用:立刻把 enabled_at 落盘。不落盘的话,进程每起一次就把「当下」往后挪一次,
  // 期间完成的轮次会被两边都判成「不归我管」而永久漏掉。
  if (!loadedFromDisk) persist()

  return {
    enabledAt: () => state.enabled_at,
    lastReported: (sessionId) => state.sessions[sessionId],
    advance: (sessionId, assistantMessageId) => {
      if (!assistantMessageId) return
      const current = state.sessions[sessionId]
      if (current !== undefined && assistantMessageId <= current) return
      state.sessions[sessionId] = assistantMessageId
      persist()
    },
    snapshot: () => ({ ...state, sessions: { ...state.sessions } }),
  }
}

export type ArchiveDisposition =
  /** 这一轮到此为止:推进游标。`outcome` 区分「存下了」与「被终态拒了」。 */
  | { kind: "advance"; outcome: "stored" | "terminal" }
  /** 这一轮还没有结论:退避重发,**游标不动**。 */
  | { kind: "retry"; outcome: "rate-limited" | "unavailable"; backoffMs?: number }

/** `Retry-After`(秒)→ 毫秒。缺席/非法 → 默认退避;超上限截到上限。 */
export function retryAfterMs(header: string | null | undefined): number {
  const raw = (header ?? "").trim()
  // 空串必须先挡掉:`Number("")` 是 **0**,不是 NaN —— 不挡就把「服务端没给退避」读成「立刻重发」。
  if (raw === "") return DEFAULT_RATE_LIMIT_BACKOFF_MS
  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_RATE_LIMIT_BACKOFF_MS
  return Math.min(Math.max(Math.round(seconds * 1000), 1000), MAX_RATE_LIMIT_BACKOFF_MS)
}

/**
 * 按线契约 §Responses 归类一次上报响应。**429 不是终态** —— 见本文件抬头。
 */
export function classifyArchiveResponse(status: number, headers?: { get(name: string): string | null }): ArchiveDisposition {
  if (status >= 200 && status < 300) return { kind: "advance", outcome: "stored" }
  if (status === 429) {
    return { kind: "retry", outcome: "rate-limited", backoffMs: retryAfterMs(headers?.get("retry-after")) }
  }
  if (status >= 400 && status < 500) return { kind: "advance", outcome: "terminal" }
  // 5xx 与任何契约没列的状态:不可逆的丢弃 vs 多发一次请求 —— 倒向后者。
  return { kind: "retry", outcome: "unavailable" }
}
