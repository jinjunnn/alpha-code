// ext-inventory-present — REQ-103 slice UI(#195):把 inventoryView 只读真源(逐扩展五维所有权
// + availability/activation/health 三态)翻译成呈现原语。纯函数、零 IPC、零 store —— 返回 i18n
// KEY(不返回已翻译串),使 renderer 组件保持薄壳、映射逻辑可 bun:test 直接锁死。
//
// 消费方:extension-detail.tsx(所有权段 + 来源与签名段)、extension-hub.tsx(已安装行三态)。
//
// 数据面边界(与设计稿对不上的字段,如实不造,交主会话裁决):
//   · 权限「能力授权总账」段:inventoryView 不含 per-扩展 capability 列表,CatalogEntry 无
//     capabilities 字段 —— 本模块不合成,详情页该段暂缺(OPEN)。
//   · 来源与签名:仅有 ownership.distributed + view.catalogChannel + view.catalogVersion;
//     发布钥(如「alpha-web-1」)不在读面 —— 如实省略(降精,不造)。
//   · 隔离态(签名撤销强制停用):ext-states.ts 的 HealthIssue 联合无 revoked/quarantine kind
//     —— isSwitchLocked 只在既有 kind 上判定,当前恒不锁(OPEN:数据面需补 kind)。

import type { InventoryRow, ExtInventory } from "../../preload/types"
import type { DistributionChannel, OwnershipDims, RuntimeSurface, SupportTier } from "../../shared/ext-ownership"
import type { HealthView } from "../../shared/ext-states"

/** 一行陈述:标签 key + 值(多值 key 数组,或字面串)。TSX 负责 t() 与拼接。 */
export type PresentRow = { labelKey: string; valueKeys?: string[]; value?: string }

// ── 值域 → i18n key(作者/甄选/分发/运行面/支持;未知值如实落 unknown,不猜)──────────────────

/** 作者维:catalog source / user / unknown。sourceLabel 只覆盖 official/community/alpha,此处补 user/unknown。 */
export function authoredLabelKey(authored: string): string {
  switch (authored) {
    case "official":
      return "alpha.ext.partyOfficial"
    case "community":
      return "alpha.ext.partyCommunity"
    case "alpha":
      return "alpha.ext.partyAlpha"
    case "user":
      return "alpha.ext.partyUser"
    default:
      return "alpha.ext.partyUnknown"
  }
}

/** 甄选维:alpha(经 Alpha 策展)/ 其余(未经甄选,自装)。 */
export function curatedLabelKey(curated: string): string {
  return curated === "alpha" ? "alpha.ext.curatedAlpha" : "alpha.ext.curatedUser"
}

export function distributionLabelKey(channel: DistributionChannel): string {
  switch (channel) {
    case "bundled":
      return "alpha.ext.distBundled"
    case "remote-catalog":
      return "alpha.ext.distRemoteCatalog"
    case "npm":
      return "alpha.ext.distNpm"
    case "engine-config":
      return "alpha.ext.distEngineConfig"
    case "cloud":
      return "alpha.ext.distCloud"
    case "local-import":
      return "alpha.ext.distLocalImport"
  }
}

export function runtimeSurfaceLabelKey(surface: RuntimeSurface): string {
  switch (surface) {
    case "engine-process":
      return "alpha.ext.surfEngineProcess"
    case "local-subprocess":
      return "alpha.ext.surfLocalSubprocess"
    case "remote-service":
      return "alpha.ext.surfRemoteService"
    case "model-context":
      return "alpha.ext.surfModelContext"
    case "cloud-pipeline":
      return "alpha.ext.surfCloudPipeline"
  }
}

export function supportTierLabelKey(tier: SupportTier): string {
  switch (tier) {
    case "alpha":
      return "alpha.ext.tierAlpha"
    case "curated":
      return "alpha.ext.tierCurated"
    case "community":
      return "alpha.ext.tierCommunity"
    case "user":
      return "alpha.ext.tierUser"
  }
}

// ── 详情页:所有权段(AC1 锚:作者与甄选分开陈述,永不塌缩成「Alpha 出品」)────────────────────

export function ownershipRows(ownership: OwnershipDims): PresentRow[] {
  return [
    { labelKey: "alpha.ext.ownAuthor", valueKeys: [authoredLabelKey(ownership.authored)] },
    { labelKey: "alpha.ext.ownCurated", valueKeys: [curatedLabelKey(ownership.curated)] },
    { labelKey: "alpha.ext.ownDistributed", valueKeys: [distributionLabelKey(ownership.distributed)] },
    {
      labelKey: "alpha.ext.ownRuntime",
      valueKeys: ownership.runtimeSurfaces.map(runtimeSurfaceLabelKey),
    },
    { labelKey: "alpha.ext.ownSupport", valueKeys: [supportTierLabelKey(ownership.supportTier)] },
  ]
}

// ── 详情页:来源与签名段(信任链就近呈现;发布钥不在读面 → 降精省略,不造)──────────────────────

/** 签名/信任状态:已验签名通道(remote/cache)/ 随包内置信任(bundled)/ 不可用(null)。 */
export function trustSignatureKey(catalogChannel: ExtInventory["catalogChannel"]): string {
  if (catalogChannel === "remote" || catalogChannel === "cache") return "alpha.ext.trustSignedChannel"
  if (catalogChannel === "bundled") return "alpha.ext.trustBundled"
  return "alpha.ext.trustUnverified"
}

export function trustRows(
  ownership: OwnershipDims,
  catalogChannel: ExtInventory["catalogChannel"],
  catalogVersion: ExtInventory["catalogVersion"],
): PresentRow[] {
  const rows: PresentRow[] = [
    { labelKey: "alpha.ext.trustSignatureLabel", valueKeys: [trustSignatureKey(catalogChannel)] },
    { labelKey: "alpha.ext.trustDistLabel", valueKeys: [distributionLabelKey(ownership.distributed)] },
  ]
  if (catalogVersion) rows.push({ labelKey: "alpha.ext.trustVersionLabel", value: catalogVersion })
  return rows
}

// ── 已安装行:health 三态(与 activation/availability 正交)────────────────────────────────────
//
// dot 语义 = **运行健康**(设计稿的彩点)。ledger-v1-compat 是「完整性不可验」的后台注记(v1↔v2
// 迁移窗口的既有事实),不是运行故障 —— 不塌进运行健康 dot(否则现存 v1 安装会一片琥珀,与设计
// 稿「多数绿·运行健康」相悖)。archived/事务未落定/事务已回滚 = 真运行面警示 → warn。
export type HealthTone = "ok" | "warn" | "err" | "muted"
export type HealthPresentation = { tone: HealthTone; textKey: string }

const WARN_ISSUE_KINDS = new Set(["archived-upstream", "transaction-pending", "transaction-rolled-back"])

export function healthPresentation(health: HealthView): HealthPresentation {
  // 优先级:archived ≻ 事务回滚 ≻ 事务未落定 ≻ 健康(v1-compat 不作 dot 警示)。
  for (const issue of health.issues) {
    if (issue.kind === "archived-upstream") return { tone: "warn", textKey: "alpha.ext.healthArchived" }
  }
  for (const issue of health.issues) {
    if (issue.kind === "transaction-rolled-back") return { tone: "warn", textKey: "alpha.ext.healthTxRolledBack" }
    if (issue.kind === "transaction-pending") return { tone: "warn", textKey: "alpha.ext.healthTxPending" }
  }
  if (health.state === "unknown") return { tone: "muted", textKey: "alpha.ext.healthUnknown" }
  return { tone: "ok", textKey: "alpha.ext.healthOk" }
}

/** 该行是否含真运行面警示(archived/事务)—— 驱动「审查更新」旁的诚实提示与 dot 色。 */
export function hasWarnIssue(health: HealthView): boolean {
  return health.issues.some((i) => WARN_ISSUE_KINDS.has(i.kind))
}

/**
 * 隔离态锁开关判定(设计稿:签名撤销 → 系统强制停用,开关锁定)。
 * 当前数据面(ext-states.ts HealthIssue 联合)无 signature-revoked/quarantine kind —— 恒返回
 * false(不造隔离态)。数据面补该 kind 后,在此并入即自动锁开关(OPEN:见文件头)。
 */
export function isSwitchLocked(_health: HealthView): boolean {
  return false
}

// ── inventoryView 行查找:同 id 优先取已安装行(scope≠null),否则取浏览行(scope=null)──────────

export function inventoryRowFor(view: ExtInventory | undefined, id: string): InventoryRow | undefined {
  if (!view) return undefined
  const rows = view.rows.filter((r) => r.id === id)
  if (rows.length === 0) return undefined
  return rows.find((r) => r.scope !== null) ?? rows[0]
}

/** 精确取某 (id, scope) 安装行(已安装 pane 的三态 join;同名并存两 scope 各取各,AC5)。 */
export function inventoryInstallRow(
  view: ExtInventory | undefined,
  id: string,
  scope: "global" | "project",
): InventoryRow | undefined {
  return view?.rows.find((r) => r.id === id && r.scope === scope)
}
