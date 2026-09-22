// REQ-160 AC2 客户端侧(`#1353`)—— 把当前启用的关键词表同步到本机,并在发送前查一遍。
//
// MAIN-ONLY,与上报同源:凭据 `archive_access_token` 只在主进程,而**词表本身也不下放 renderer**。
// 路由文档写着它为什么需要凭据:「Published without a credential it becomes a public oracle for
// composing a message that passes」—— 把整份表送进渲染进程等于把那个 oracle 摆在 devtools 里。
// 所以 renderer 问的是「这句话要不要拦」(`alpha-moderation-check`),拿回一个布尔值。
//
// ── 这不是安全边界 ─────────────────────────────────────────────────────────────────────
// 这道拦截跑在用户自己的电脑上,懂技术的人能绕过。它的价值只有一个:让无心撞上的人**当场**
// 就知道、当场就能改。真正算数的复核与留证在服务端入库时(alpha-web `lib/moderation/events.ts`)。
//
// ── 读不到就不拦(fail-open),这是已批设计的明文裁决 ───────────────────────────────────
// 已批帧 `docs/design/2026-09-19-req160-send-blocked-notice/design.md` §3「不出现」一行:
// 「词表没同步下来、或读不到时,**不拦也不提示** —— 没做过的检查不摆出一个做过的样子」。
// 与本仓默认的 fail-closed 纪律相反,是有意的:这一层不是闸门,把用户的消息按一份**没读到的**
// 词表拦下来,是用一个我们没做过的检查去阻断真实工作。
//
// ── 401 丢表 / 5xx 留表 ────────────────────────────────────────────────────────────────
// 线契约(`docs/contracts/chat-archive-upload.md` § Keyword list sync)自己把这两件事分开了:
// 503 写着「Retry — an outage must not be read as "the list is empty"」⇒ 留着上次那份;
// 401 是「没有 bearer,或它不是一张活的 archive_access」⇒ 换人/登出了,手里那份不再属于这台
// 机器当前的身份,丢掉。

import { ALPHA_PATHS } from "../shared/alpha-config"
import { isBlockedByKeywords, parseKeywordPayload, type ModerationKeyword } from "../shared/moderation-keywords"

export type ModerationKeywordLog = {
  info: (message: string, meta?: unknown) => void
  warn: (message: string, meta?: unknown) => void
}

export type ModerationKeywordDeps = {
  /** alpha-web 基址(`resolveEndpoints().web`)。 */
  webBase: () => string
  /** `archive_access_token`;缺席 = 未登录或签发端还没铸 ⇒ 不问,也不留旧表。 */
  token: () => string | undefined
  fetch?: typeof fetch
  log?: ModerationKeywordLog
  /** 两次同步之间的间隔。表变得很少,渲染侧每次发送读的是本机快照,所以这里不必勤。 */
  refreshIntervalMs?: number
  requestTimeoutMs?: number
  /**
   * 排一次性定时器,返回取消它的函数。默认 `setTimeout` + `unref()`;测试用它注入假时钟,
   * 因为 `start()` 的节奏本身就是判据(`#1387` AC3:失败之后不必等满一轮)。
   */
  setTimer?: (run: () => void, delayMs: number) => () => void
}

/** `refresh()` 的结论。`unavailable` = **没问出来**,与「问过了,是空表」(`updated` + 空数组)相反。 */
export type ModerationRefreshOutcome = "updated" | "unchanged" | "unavailable"

export type ModerationKeywordStore = {
  /** 当前这台机器手里的表;`undefined` = 从来没拿到过 / 已被 401 丢掉 ⇒ 不拦。 */
  snapshot: () => readonly ModerationKeyword[] | undefined
  /** 这句话此刻要不要拦。表不在 ⇒ `false`(见抬头 fail-open 一段)。永不抛。 */
  blocks: (text: string) => boolean
  refresh: () => Promise<ModerationRefreshOutcome>
  /** 立刻同步一次,并按间隔续订;返回退订。 */
  start: () => () => void
}

const DEFAULT_REFRESH_INTERVAL_MS = 15 * 60_000
/**
 * 一次「没问出来」之后的重试间隔(`#1387` AC3)。常规周期是 15 分钟 —— 冷启动那次同步跑在令牌
 * 到位**之前**并放弃后,照常规周期就是整整一刻钟没有表(实测:用户在启动后第 36 秒发出消息,
 * 本机零拦截)。恒 ≤ `intervalMs`(它的下限是 60 秒),所以「失败后更快再试」这条不会被配置反转。
 */
const RETRY_INTERVAL_MS = 60_000
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const noopLog: ModerationKeywordLog = { info: () => {}, warn: () => {} }

function defaultSetTimer(run: () => void, delayMs: number): () => void {
  const handle = setTimeout(run, delayMs)
  // 这条定时器不该把进程钉活;Electron 主进程退出时它没有任何要保存的东西。
  ;(handle as unknown as { unref?: () => void }).unref?.()
  return () => clearTimeout(handle)
}

export function createModerationKeywordStore(deps: ModerationKeywordDeps): ModerationKeywordStore {
  const doFetch = deps.fetch ?? fetch
  const log = deps.log ?? noopLog
  const setTimer = deps.setTimer ?? defaultSetTimer
  const intervalMs = Math.max(60_000, deps.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS)
  const timeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS

  let keywords: ModerationKeyword[] | undefined
  let etag: string | undefined
  /** 同一时刻只允许一次在途同步:定时器与启动那次会叠在一起。 */
  let inFlight: Promise<ModerationRefreshOutcome> | undefined
  /** 上一次「没问出来」的原因;同一个原因只说一次。 */
  let unavailableReason: string | undefined

  function forget(why: string) {
    if (keywords === undefined && etag === undefined) return
    keywords = undefined
    etag = undefined
    log.info("moderation: keyword list dropped", { why })
  }

  /**
   * 「没问出来」的唯一出口。**每一条路径都要留下一行**(`#1387` AC2):没令牌与 401 这两条原本
   * 静默退出,于是「这道拦截整段时间是空的」在日志里与「拦了但没命中」长得一模一样 ——
   * 出事那次的日志里连一个 `moderation:` 字样都没有,没人、没有监控看得出来。
   *
   * 但同一个原因只说一次:失败会按 60 秒重试,而未登录的人**一直**没令牌,不折叠就是每分钟刷屏。
   * 同步一旦成功就把记忆清掉,下一次失败照样开口。
   */
  function noteUnavailable(reason: string, message: string, meta?: unknown): ModerationRefreshOutcome {
    if (unavailableReason !== reason) {
      unavailableReason = reason
      log.warn(message, meta)
    }
    return "unavailable"
  }

  async function fetchOnce(): Promise<ModerationRefreshOutcome> {
    const token = deps.token()
    if (!token) {
      // 未登录、或持久令牌已过期(`getArchiveAccessToken` 对过期令牌返回 undefined):不问,
      // 也不继续拿着上一位登录者同步下来的表。冷启动那 0.4 秒正落在这条路上 —— 所以它不能静默,
      // 而且醒来的路子是 auth 变更时的那一 kick(`notifyModerationAuthChanged`),不是等下一周期。
      forget("no archive_access token")
      return noteUnavailable("no-token", "moderation: keyword list unavailable", {
        reason: "no archive_access token",
      })
    }
    const base = deps.webBase().replace(/\/$/, "")
    const url = `${base}${ALPHA_PATHS.chatArchiveKeywords}`
    const controller = new AbortController()
    const killer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await doFetch(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          // 手里没有表的时候不发 If-None-Match:拿一个 304 回来会让我们**永远**没有表。
          ...(etag && keywords ? { "if-none-match": etag } : {}),
        },
        signal: controller.signal,
      })
      if (response.status === 304 && keywords) {
        unavailableReason = undefined
        return "unchanged"
      }
      if (response.status === 401) {
        forget("401 unauthorized")
        return noteUnavailable("401", "moderation: keyword list unavailable", { reason: "401 unauthorized" })
      }
      if (!response.ok) {
        // 503 `keywords_unavailable` 走这里:服务不可用不等于表是空的,手里那份留着。
        return noteUnavailable(`status:${response.status}`, "moderation: keyword sync refused", {
          status: response.status,
        })
      }
      const parsed = parseKeywordPayload(await response.json().catch(() => undefined))
      if (!parsed) {
        // 形状不合 = 没问出来。**不**把它当成空表 —— 那会静默关掉本机这一层。
        return noteUnavailable("payload", "moderation: keyword payload unreadable")
      }
      keywords = parsed
      etag = response.headers.get("etag") ?? undefined
      unavailableReason = undefined
      log.info("moderation: keyword list synced", { count: parsed.length })
      return "updated"
    } catch (error) {
      const detail = error instanceof Error ? error.message : error
      return noteUnavailable(`error:${String(detail)}`, "moderation: keyword sync failed", detail)
    } finally {
      clearTimeout(killer)
    }
  }

  async function refresh(): Promise<ModerationRefreshOutcome> {
    if (inFlight) return inFlight
    const run = fetchOnce().finally(() => {
      inFlight = undefined
    })
    inFlight = run
    return run
  }

  return {
    snapshot: () => keywords,
    blocks: (text: string) => {
      const current = keywords
      if (!current || current.length === 0) return false
      try {
        return isBlockedByKeywords(text, current)
      } catch {
        return false
      }
    },
    refresh,
    start: () => {
      // 一次性定时器自续,而不是固定周期的 `setInterval` —— 因为周期本身要随上一次的结论变:
      // 「没问出来」之后 60 秒再试,问到了才回到常规周期(`#1387` AC3)。
      let stopped = false
      let cancel: (() => void) | undefined
      const arm = (delayMs: number) => {
        if (stopped) return
        cancel = setTimer(() => void tick(), delayMs)
      }
      const tick = async () => {
        const outcome = await refresh().catch(() => "unavailable" as const)
        arm(outcome === "unavailable" ? RETRY_INTERVAL_MS : intervalMs)
      }
      void tick()
      return () => {
        stopped = true
        cancel?.()
      }
    },
  }
}

// ── 主进程内部的单例出口 ────────────────────────────────────────────────────────────────
// 自动化(定时任务 / 一句话解析)也在主进程里发,它们与 `index.ts` 的接线之间没有别的通道;
// 与 `initAutomationLlm` 同一形态。未初始化 ⇒ `false`(fail-open,同抬头)。

let active: ModerationKeywordStore | undefined

export function initModerationKeywords(deps: ModerationKeywordDeps): ModerationKeywordStore {
  active = createModerationKeywordStore(deps)
  return active
}

/**
 * 自动化侧命中时说的那半句。与界面上那条提示用**同一个说法**(已批稿 §4:「没有通过内容安全
 * 审核」是产品里已经在用的词,时间线空回合行也是它)—— 两处说法不一致,用户会以为是两件事。
 *
 * 界面上是完整两句;这里是写进 `status.json` 的摘要与自动化解析的失败原因,所以只取承重的那半句,
 * 由调用点按各自的语境补上框。**不写「违规」「禁止」**,理由同已批稿 §4。
 */
export const MODERATION_BLOCKED_REASON = "没有通过内容安全审核"

/** 主进程侧的唯一查询点。表不在、没初始化、或匹配本身抛了 ⇒ `false`。 */
export function moderationBlocks(text: string): boolean {
  return active?.blocks(text) ?? false
}

/**
 * 「令牌可能到位了」—— auth 一变就同步一次(`#1387` AC1)。
 *
 * 冷启动那一次同步跑在令牌到位**之前**:实测 `app starting` 07:29:51.180、
 * `alpha-auth: tokens refreshed` 07:29:51.625,词表那唯一一次尝试落在这 0.4 秒里,拿到
 * `undefined` 就放弃,然后按 15 分钟睡过去 —— 用户在第 36 秒发出「澳门赌场」,本机零拦截。
 * 接住 auth 变更这个事件,比把周期调短对得多:后者只是把 15 分钟的洞换成小一点的洞。
 *
 * 未初始化 ⇒ no-op(与 `moderationBlocks` 同源)。`refresh()` 自带在途合流,auth 每次 publish
 * 都调一次是安全的,而且它自己不打日志 —— 常态下换回的是 304,一行都不写。
 */
export function notifyModerationAuthChanged(): void {
  void active?.refresh().catch(() => {})
}

/** 测试用:把单例摘掉,避免跨用例串味。 */
export function resetModerationKeywordsForTests(): void {
  active = undefined
}
