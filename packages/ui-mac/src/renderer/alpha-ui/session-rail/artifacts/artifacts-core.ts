// REQ-125 C4 — pure model for the right-rail artifacts host.
//
// The panel embeds the approved artifact-workbench language verbatim (I5); this module only
// owns the rail-specific decisions: honest phase derivation, focus-target matching for the
// timeline linkage mount point, and the I8 identity key. Card derivation stays in
// workbench-core (REQ-093/094 truth), untouched.
import type { ArtifactCard, RunArtifactUsage } from "../../artifact-workbench/workbench-core"
import type { AlphaSessionIdentity } from "../../session-workspace/session-workspace-core"

/**
 * #660:两种空是两个事实,不得合并 —— `empty` = 这个项目一次云任务都没有(连切换条都不画,
 * 只能选空集的选择器是噪音);`empty-run` = 选中的这一次**已证实**没有产物(条留着,用户得能换走)。
 * `empty-unknown`(审计 Major-2)= 本地为空、平台侧取不到 —— 只说「平台列表不可用」,
 * **绝不宣称这一次是空的**:没拿到平台的答案之前,「这次没有产生文件」是一句没有根据的断言,
 * 正是本票要消灭的那类毛病。
 */
export type ArtifactsPhase = "loading" | "error" | "empty" | "empty-run" | "empty-unknown" | "cards"

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
}): ArtifactsPhase {
  if (input.usage === undefined) return "loading"
  if (!input.usage.ok) return "error"
  if (input.runId === undefined) return "empty"
  if (input.list === undefined) return "loading"
  if (!input.list.ok) return "error"
  if (input.cardCount > 0) return "cards"
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
