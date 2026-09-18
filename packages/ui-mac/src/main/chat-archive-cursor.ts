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
// ── 401 也单开一格,理由与 429 同形(R1 审计 BLOCKER)────────────────────────────────────────
// 线契约的表把 401 写成 terminal。**客户端这一侧不照它做**,因为游标是纯客户端状态,而 401 的
// 原因同样**不在这一轮里**:access token TTL 15 分钟、约 10 分钟刷一轮;睡眠唤醒之后、或一次
// 刷新失败之后,令牌会处在「在场但已过期」的状态 —— 那时该会话**每一条**待发轮次都会挨个 401,
// 按 terminal 处理就是把整条积压一次推过去、永久丢掉。这与 429 是同一个形状:
// **拒绝的原因不在这一轮的内容里,所以这一轮不该为它背锅。**
// 401 与 429 的差别只在处置:429 要按 `Retry-After` 等;401 在**同一次 idle 内重发毫无意义**
// (手里还是那把过期钥匙),所以它的处置是「立刻停下这一趟、游标不动」,等下一次 idle ——
// 那时续期调度器已经换好令牌。配套的省一次请求在 `alpha-auth.getArchiveAccessToken()`:
// 令牌已过期时它直接返回 undefined,连这一发都不发。
//
// ── 未知状态码往哪一边倒 ────────────────────────────────────────────────────────────────────
// 只有 400–499(401 / 429 除外)推进游标。1xx/3xx 与任何没列进契约的状态一律按可重试处理:
// 推进游标是**不可逆的丢弃**,退避重发最多浪费一次请求。
//
// ── 游标值为什么是 assistant 的 `engine_message_id`,以及为什么能直接比大小 ──────────────────
// 引擎的 id 是「时间升序」型:`msg_` + 12 位定宽十六进制的 (ms×4096+序号) + 14 位随机 base62
// (`packages/opencode/src/id/id.ts:51-67`)。定宽 + 全 ASCII ⇒ **字典序 = 时间序**,与引擎自己
// 排消息用的 `(time_created, id)` 同向。唯一的退化窗口是进程重启后同一毫秒内序号归零(1ms),
// 而重发一条已存过的轮次在服务端是无副作用的(`UNIQUE (session_id, engine_message_id)`)。
//
// ── 游标绑账号,不绑这台机器(R1 审计 MAJOR)────────────────────────────────────────────────
// owner 的「只上报启用后的轮次、历史不回填」是**按账号**各算一次,不是按安装各算一次。
// 不绑的话有一条真实路径把 A 的对话发给 B:A 登出(令牌清掉、上报停下、**游标停在原处**)
// → 用户照样能用 BYOK 继续聊很久 → B 在同一台机器登录 → 下一次 idle 时游标还指着 A 那条线,
// 于是 A 登出之后的那些轮次被用 **B 的 bearer** 发出去,服务端按 B 的 `sub` 落库。
// 修法:`getAuthIdentityEpoch()`(登入/登出才推进,token 轮换不算)一变就把 `enabled_at`
// 重铸为「当下」并清空各会话游标 —— 新身份从它自己的「当下」开始,一条旧轮次都不带过去。
// 该计数器是**进程内**的(`alpha-auth.ts:140` 每次启动从 0 起),所以这里只比进程内的变化,
// 不把它写进文件跨重启比 —— 那样每次冷启动都会误判成换了账号,把「当下」一路往后挪。
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
  /** `alpha-auth.getAuthIdentityEpoch()`。变化 = 换了账号(登入/登出),见抬头。 */
  identityEpoch?: () => number
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

  // 只记**本进程**看到的那个值,不落盘(理由见抬头:计数器每次启动从 0 起)。
  let seenIdentityEpoch = deps.identityEpoch?.()
  const syncIdentity = () => {
    if (!deps.identityEpoch) return
    const epoch = deps.identityEpoch()
    if (epoch === seenIdentityEpoch) return
    seenIdentityEpoch = epoch
    // 换了账号:新身份从它自己的「当下」开始,旧账号那几条会话游标一并丢掉 —— 留着它们唯一的
    // 作用是让新账号的某条轮次被旧账号的 id 压住,而「不回填」已经由新的 enabled_at 管住了。
    state = emptyState(now())
    persist()
  }

  return {
    enabledAt: () => {
      syncIdentity()
      return state.enabled_at
    },
    lastReported: (sessionId) => {
      syncIdentity()
      return state.sessions[sessionId]
    },
    advance: (sessionId, assistantMessageId) => {
      syncIdentity()
      if (!assistantMessageId) return
      const current = state.sessions[sessionId]
      if (current !== undefined && assistantMessageId <= current) return
      state.sessions[sessionId] = assistantMessageId
      persist()
    },
    snapshot: () => {
      syncIdentity()
      return { ...state, sessions: { ...state.sessions } }
    },
  }
}

export type ArchiveDisposition =
  /** 这一轮到此为止:推进游标。`outcome` 区分「存下了」与「被终态拒了」。 */
  | { kind: "advance"; outcome: "stored" | "terminal" }
  /** 这一轮还没有结论:**游标不动**。`unauthorized` 额外要求**本趟立刻停**(同一把过期钥匙
   *  重发只会再 401),其余两种在本趟内退避重发。 */
  | { kind: "retry"; outcome: "rate-limited" | "unauthorized" | "unavailable"; backoffMs?: number }

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
 * 按线契约 §Responses 归类一次上报响应。**429 与 401 都不是终态** —— 见本文件抬头。
 * (401 这一格是本仓与线契约表**有意**的差异,编排器 2026-09-18 裁决;alpha-web 侧的契约文档
 * 由编排器同步。不要照那张表把它改回 terminal。)
 */
export function classifyArchiveResponse(status: number, headers?: { get(name: string): string | null }): ArchiveDisposition {
  if (status >= 200 && status < 300) return { kind: "advance", outcome: "stored" }
  if (status === 401) return { kind: "retry", outcome: "unauthorized" }
  if (status === 429) {
    return { kind: "retry", outcome: "rate-limited", backoffMs: retryAfterMs(headers?.get("retry-after")) }
  }
  if (status >= 400 && status < 500) return { kind: "advance", outcome: "terminal" }
  // 5xx 与任何契约没列的状态:不可逆的丢弃 vs 多发一次请求 —— 倒向后者。
  return { kind: "retry", outcome: "unavailable" }
}
