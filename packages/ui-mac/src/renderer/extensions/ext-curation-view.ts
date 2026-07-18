// ext-curation-view — REQ-104 #397 PR-B:四级货架与策展呈现的**纯派生层**(零 IPC、零账本、零样式)。
// 真源 = shared/catalog-curation decodeEntryCuration(fail-closed 采信);本层只做展示决策:
//   · 推荐准入(合同 §7.2 + v6 已批稿):curated 且 上游未归档/未失养、复审未过期(排他截止)、
//     全框架适配、**无活跃安全公示**(advisory 永远赢,§1;阻断事实来自 main 派生的已验公示面,
//     不用 renderer 静态表)。
//   · 四货架固定序 核心→精选→接入→实验室,空货架整组隐藏(不造数据)。
//   · 类型 tab:已分级/未分级切分(invalid = fail-closed,与未策展同呈现;差异只在详情页一行上报)。
//   · 词汇映射(tier/能力 token → 用户语言 i18n key;未知 token 原样 mono,不猜翻译)。

import {
  decodeEntryCuration,
  isReviewExpired,
  type Curation,
  type CurationStatus,
  type CurationTier,
} from "../../shared/catalog-curation"
import type { Catalog, CatalogEntry } from "./catalog-types"

/** 货架固定序(v6 稿:核心 → 精选 → 接入 → 实验室)。 */
export const SHELF_ORDER: readonly CurationTier[] = ["core", "precache", "connector", "labs"]

/** tier → 货架 chip 文案 key(用户语言:核心/精选/接入/实验室)。 */
export const SHELF_CHIP_KEYS: Record<CurationTier, string> = {
  core: "alpha.ext.shelfCore",
  precache: "alpha.ext.shelfPrecache",
  connector: "alpha.ext.shelfConnector",
  labs: "alpha.ext.shelfLabs",
}

/** tier → 货架标题/副标题 key(推荐页组头)。 */
export const SHELF_TITLE_KEYS: Record<CurationTier, { title: string; sub: string }> = {
  core: { title: "alpha.ext.shelfCoreTitle", sub: "alpha.ext.shelfCoreSub" },
  precache: { title: "alpha.ext.shelfPrecacheTitle", sub: "alpha.ext.shelfPrecacheSub" },
  connector: { title: "alpha.ext.shelfConnectorTitle", sub: "alpha.ext.shelfConnectorSub" },
  labs: { title: "alpha.ext.shelfLabsTitle", sub: "alpha.ext.shelfLabsSub" },
}

/** 甄选能力 token → 用户语言 key(intake 观察面词汇;未知 token 返回 null → 原样 mono 展示)。 */
export const CAPABILITY_LABEL_KEYS: Record<string, string> = {
  "fs:read": "alpha.ext.capFsRead",
  "fs:write": "alpha.ext.capFsWrite",
  "net:http": "alpha.ext.capNetHttp",
  "env:read": "alpha.ext.capEnvRead",
  "proc:spawn": "alpha.ext.capProcSpawn",
}

/** 整目录解码一次(fail-closed;Map 键 = entry.id)。 */
export function curationMapOf(catalog: Catalog): Map<string, CurationStatus> {
  const map = new Map<string, CurationStatus>()
  for (const e of catalog.entries) map.set(e.id, decodeEntryCuration(e))
  return map
}

export const curationOf = (map: ReadonlyMap<string, CurationStatus> | undefined, id: string): CurationStatus =>
  map?.get(id) ?? { kind: "uncurated" }

export const curatedOf = (status: CurationStatus): Curation | null => (status.kind === "curated" ? status.curation : null)

export const isArchived = (status: CurationStatus): boolean =>
  status.kind === "curated" && status.curation.review.upstreamStatus === "archived"

export const isUnmaintained = (status: CurationStatus): boolean =>
  status.kind === "curated" && status.curation.review.upstreamStatus === "unmaintained"

export const isExpired = (status: CurationStatus, nowIso: string): boolean =>
  status.kind === "curated" && isReviewExpired(status.curation, nowIso)

export const isSessionGrant = (status: CurationStatus): boolean =>
  status.kind === "curated" && status.curation.activationPolicy === "session-grant"

/** 推荐准入(合同 §7.2;v6 稿 F4):不满足任一条即退出推荐 —— 仍在类型 tab 与搜索可见。
 *  框架适配:消费端无项目框架探测面 → 保守只收全适配(["*"]);非 * 声明不进推荐(合同
 *  「可被显式搜索到,但不进推荐/默认面」)。 */
export function isRecommendable(id: string, status: CurationStatus, nowIso: string, advisoryBlocked: ReadonlySet<string>): boolean {
  if (status.kind !== "curated") return false
  if (advisoryBlocked.has(id)) return false // advisory 永远赢(§1;main 派生已验公示阻断事实)
  const c = status.curation
  if (c.review.upstreamStatus === "archived" || c.review.upstreamStatus === "unmaintained") return false
  if (isReviewExpired(c, nowIso)) return false // 排他截止:恰好等于即过期
  if (!(c.applicability.frameworks.length === 1 && c.applicability.frameworks[0] === "*")) return false
  return true
}

export type Shelf = { tier: CurationTier; items: CatalogEntry[] }

/** 推荐页四货架(固定序;空货架剔除 —— 组隐藏,不造数据)。 */
export function buildShelves(
  entries: readonly CatalogEntry[],
  statusById: ReadonlyMap<string, CurationStatus>,
  nowIso: string,
  advisoryBlocked: ReadonlySet<string>,
): Shelf[] {
  const byTier = new Map<CurationTier, CatalogEntry[]>()
  for (const e of entries) {
    const status = curationOf(statusById, e.id)
    if (!isRecommendable(e.id, status, nowIso, advisoryBlocked)) continue
    const tier = (status as { kind: "curated"; curation: Curation }).curation.tier
    const arr = byTier.get(tier) ?? []
    arr.push(e)
    byTier.set(tier, arr)
  }
  return SHELF_ORDER.filter((tier) => byTier.has(tier)).map((tier) => ({ tier, items: byTier.get(tier)! }))
}

/** 类型 tab 切分:已分级(curated)在前,未分级(未策展 + fail-closed)尾组。
 *  invalid 与未策展**同呈现**(不发明「未知级」徽章;差异只在详情页一行如实上报)。 */
export function splitBrowse(
  entries: readonly CatalogEntry[],
  statusById: ReadonlyMap<string, CurationStatus>,
): { graded: CatalogEntry[]; ungraded: CatalogEntry[] } {
  const graded: CatalogEntry[] = []
  const ungraded: CatalogEntry[] = []
  for (const e of entries) (curationOf(statusById, e.id).kind === "curated" ? graded : ungraded).push(e)
  return { graded, ungraded }
}

/** 域名清单折叠(v6 稿:≤max 全列;>max 前 max 条 + 「展开全部 N 个」)。 */
export function foldDomains(domains: readonly string[], max = 6): { shown: string[]; total: number; folded: boolean } {
  if (domains.length <= max) return { shown: [...domains], total: domains.length, folded: false }
  return { shown: domains.slice(0, max), total: domains.length, folded: true }
}

/** 复审期限的日期呈现(YYYY-MM-DD;时间部分不进 UI)。 */
export const reviewDateOf = (utc: string): string => utc.slice(0, 10)

/** 下载体积呈现输入(v5/v6 同一诚实口径:known 精确、none/0 = 仅写配置、unknown 不估算)。 */
export function downloadPresentation(c: Curation): { kind: "known"; bytes: number } | { kind: "config-only" } | { kind: "unknown" } {
  const dl = c.summaries.download
  if (dl.basis === "none" || dl.bytes === 0) return { kind: "config-only" }
  if (dl.bytes === null || dl.basis === "unknown") return { kind: "unknown" }
  return { kind: "known", bytes: dl.bytes }
}

/** 体积近似呈现(与 v5 整包事实同一诚实口径:只呈现已知精确字节的换算,不估算)。 */
export function formatBytesApprox(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}
