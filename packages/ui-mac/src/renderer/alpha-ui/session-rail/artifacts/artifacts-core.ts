// REQ-125 C4 — pure model for the right-rail artifacts host.
//
// The panel embeds the approved artifact-workbench language verbatim (I5); this module only
// owns the rail-specific decisions: honest phase derivation, focus-target matching for the
// timeline linkage mount point, and the I8 identity key. Card derivation stays in
// workbench-core (REQ-093/094 truth), untouched.
import type { ArtifactCard, RunArtifactUsage } from "../../artifact-workbench/workbench-core"
import type { AlphaSessionIdentity } from "../../session-workspace/session-workspace-core"
import { cloudImageViewOf, type CloudImageRunFacts, type CloudImageView } from "../../session-timeline/timeline-model"

/**
 * #660:两种空是两个事实,不得合并 —— `empty` = 这个项目一次云任务都没有(连切换条都不画,
 * 只能选空集的选择器是噪音);`empty-run` = 选中的这一次**已证实**没有产物(条留着,用户得能换走)。
 * `empty-unknown`(审计 Major-2)= 本地为空、平台侧取不到 —— 只说「平台列表不可用」,
 * **绝不宣称这一次是空的**:没拿到平台的答案之前,「这次没有产生文件」是一句没有根据的断言,
 * 正是本票要消灭的那类毛病。
 */
export type ArtifactsPhase =
  | "loading"
  | "error"
  | "empty"
  | "empty-run"
  | "empty-unknown"
  | "cards"
  /** REQ-236 `#1552`:「本次对话」范围里一次都没有(项目里别的对话可能有)。 */
  | "empty-scope"
  /** REQ-236 `#1552`:选中的这次还没交付完(排队 / 生成 / 正在保存 / 没存到本机)—— 显示交付状态,不说「没有产物」。 */
  | "run-status"

/**
 * Honest panel phase from the three read channels. Fail-closed: anything not proven readable
 * renders as loading/error, never as an optimistic empty — and the run-level empty claim
 * additionally requires the platform listing to have answered (cloud ok + merged result empty).
 */
export function artifactsPhaseOf(input: {
  usage: { ok: boolean } | undefined
  runId: string | undefined
  list: { ok: boolean } | undefined
  /** 平台列表:undefined = 尚未回答(pending);ok:false = 取不到(离线/未登录)。 */
  cloud: { ok: boolean } | undefined
  cardCount: number
  /** REQ-236 `#1552`:范围过滤之后、项目里是否还有别的 run(「本次对话」为空 ≠ 项目为空)。 */
  scopeHidesRuns?: boolean
  /** REQ-236 `#1552`:宿主 tracker 对选中 run 的交付态(runDeliveryOf);undefined = 已交付或宿主不知道。 */
  delivery?: RunDelivery
}): ArtifactsPhase {
  if (input.usage === undefined) return "loading"
  if (!input.usage.ok) return "error"
  if (input.runId === undefined) return input.scopeHidesRuns ? "empty-scope" : "empty"
  if (input.list === undefined) return "loading"
  if (!input.list.ok) return "error"
  if (input.cardCount > 0) return "cards"
  if (input.delivery) return "run-status"
  if (input.cloud === undefined) return "loading"
  return input.cloud.ok ? "empty-run" : "empty-unknown"
}

// ---------------------------------------------------------------------------
// #660 B1:run 时刻(纯值;`now` 可注入)
// ---------------------------------------------------------------------------

/**
 * run 行/条的时刻,拆成结构给 view 走 i18n 模板。`kind` 分档只看本地日历:
 * 同日 = today,昨日 = yesterday,同年 = date,跨年 = date-year。
 */
export type RunMoment =
  | { kind: "today"; time: string }
  | { kind: "yesterday"; time: string }
  | { kind: "date"; month: number; day: number; time: string }
  | { kind: "date-year"; year: number; month: number; day: number; time: string }

/**
 * manifest `updatedAt` → RunMoment。**失败关闭**:缺失或解析不出 → null,调用方回落显示
 * 编号 —— 绝不渲染一个错误的时间(⑦-5 第 5 条的缓解面)。
 */
export function runMomentOf(updatedAt: string | null | undefined, now: Date): RunMoment | null {
  if (typeof updatedAt !== "string" || updatedAt.length === 0) return null
  const ms = Date.parse(updatedAt)
  if (Number.isNaN(ms)) return null
  const at = new Date(ms)
  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (sameDay(at, now)) return { kind: "today", time }
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (sameDay(at, yesterday)) return { kind: "yesterday", time }
  if (at.getFullYear() === now.getFullYear()) return { kind: "date", month: at.getMonth() + 1, day: at.getDate(), time }
  return { kind: "date-year", year: at.getFullYear(), month: at.getMonth() + 1, day: at.getDate(), time }
}

/** 编号中段截断(job_7f3a…c21e):它仍是唯一稳定身份,但退到第三顺位,不再是用户认路的东西。 */
export function shortRunId(runId: string): string {
  return runId.length <= 13 ? runId : `${runId.slice(0, 8)}…${runId.slice(-4)}`
}

/**
 * 「最近一次 / 上一次」只到第二行为止(再往下靠时刻本身定位),且只按面板排序后的位次给,
 * 不做任何会话级断言(①「顺带订正」定死的纪律)。
 */
export type RunOrdinal = "latest" | "previous" | undefined

export type RunRowModel = {
  runId: string
  moment: RunMoment | null
  ordinal: RunOrdinal
  artifactCount: number
  diskBytes: number
  missingCount: number
  readOnly: boolean
}

/** 排序后的 run 摘要 → 行模型(view 零 IPC、零 preload 类型,只吃这个)。 */
export function runRowModelOf(usage: RunArtifactUsage, index: number, now: Date): RunRowModel {
  return {
    runId: usage.runId,
    moment: runMomentOf(usage.updatedAt, now),
    ordinal: index === 0 ? "latest" : index === 1 ? "previous" : undefined,
    artifactCount: usage.artifactCount,
    diskBytes: usage.diskBytes,
    missingCount: usage.missingCount,
    readOnly: usage.readOnly,
  }
}

/**
 * Resolve a timeline focus target to a card: manifest artifact id first (the linkage
 * contract's identity), card key as fallback (covers legacy keys). Unknown ids resolve to
 * nothing — the panel keeps its current selection instead of guessing.
 */
export function findArtifactCard(cards: readonly ArtifactCard[], artifactId: string): ArtifactCard | undefined {
  return (
    cards.find((card) => card.descriptor?.id === artifactId) ?? cards.find((card) => card.key === artifactId)
  )
}

/** Stable key for I8 remounts: any identity change rebuilds the panel from scratch. */
export function artifactsIdentityKeyOf(identity: AlphaSessionIdentity | undefined): string | undefined {
  if (!identity) return undefined
  return [identity.serverKey, identity.directory, identity.sessionID].join("\u0000")
}

// ---------------------------------------------------------------------------
// REQ-236 #1552:「本次对话 / 项目全部」与未完成 run 的交付态
// ---------------------------------------------------------------------------

export type ArtifactsScope = "session" | "project"
/** run 归谁:本次对话(含其后代会话)/ 另一个对话 / 来源未记录(或查不到 —— 不猜)。 */
export type RunOwner = "this" | "other" | "none"

/** 沿 parentID 上溯的深度上限(方案 §2.5)。 */
export const SCOPE_ANCESTRY_MAX_DEPTH = 16

/**
 * 归属判定(AC4):run 记录的归属会话就是当前会话 ⇒ 属于;否则经 `parentOf`(生产 = v1 `session.get` 的
 * parentID)向上解析,命中当前会话 ⇒ 属于,到根 / 超深 / 查询失败 ⇒ 不属于。不依赖已加载的会话列表
 * (冷启动 renderer 只有根会话)。结果按会话缓存,寿命 = 面板这次挂载。
 */
export function createRunOwnership(
  currentSessionID: string,
  parentOf: (sessionID: string) => Promise<string | null | undefined>,
): (sessionID: string | null) => Promise<RunOwner> {
  const cache = new Map<string, Promise<RunOwner>>()
  return (sessionID) => {
    if (sessionID === null) return Promise.resolve("none")
    if (sessionID === currentSessionID) return Promise.resolve("this")
    const cached = cache.get(sessionID)
    if (cached) return cached
    const resolved = (async (): Promise<RunOwner> => {
      let id = sessionID
      for (let depth = 0; depth < SCOPE_ANCESTRY_MAX_DEPTH; depth += 1) {
        let parent: string | null | undefined
        try {
          parent = await parentOf(id)
        } catch {
          return "none"
        }
        if (!parent) return "other"
        if (parent === currentSessionID) return "this"
        id = parent
      }
      return "other"
    })()
    cache.set(sessionID, resolved)
    return resolved
  }
}

/** 交付还没落定的 run 在面板里怎么说 —— 与对话里的生图卡同源同词(cloudImageViewOf 是唯一判定)。 */
export type RunDelivery = Extract<CloudImageView, { state: "queued" | "running" | "saving" | "undelivered" }>

export function runDeliveryOf(state: CloudImageRunFacts | null | undefined, since?: number): RunDelivery | undefined {
  if (!state) return undefined
  const view = cloudImageViewOf({ phase: "accepted", runId: "", ...(since !== undefined ? { acceptedAt: since } : {}) }, state, false)
  return view.state === "queued" || view.state === "running" || view.state === "saving" || view.state === "undelivered"
    ? view
    : undefined
}

/** 「保存到…」的回执(本次操作的结果,不写进记录)。 */
export type ArtifactSaveReceipt = { kind: "ok"; folder: string; name: string } | { kind: "mismatch" } | { kind: "write" }
