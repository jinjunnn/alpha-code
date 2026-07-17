// ext-inventory — REQ-103 slice 1(#195):Hub BuiltinPolicy 的主进程只读聚合面。
//
// 单一只读查询:输入 = 既有真源(已验 catalog 条目 + packaged seed 视图 + v2/v1 安装账本 +
// office-advisories),输出 = 逐扩展 { 五维所有权 + availability/activation/health 三态 } 的
// JSON 纯值视图(IPC 序列化就绪)。本切片**不开 preload/IPC 通道**(下一切片接线);也**零写入**:
// 不动账本、不动配置、不动磁盘 —— 纯读、纯推导。
//
// 分层:
//   · aggregateInventory —— 纯函数核心(bun:test 直接锁行为);
//   · collectInventory —— 薄采集器:用既有 reader(readLedgerV2 / readPackagedSeed /
//     alphaRoot)把磁盘真源变成 aggregate 的输入。catalog 由调用方注入(已验 catalog 的
//     resolve 面归 ext-ipc 既有机器;本模块不重复实现验签/回退链)。
//
// 身份与 join 规则:
//   · 安装行:一行 = (record.id, scope) —— global 与 project 同名安装是两行(父 AC5:可区分、
//     可单独操作);record.id 是 catalog id 或 `user:<name>`(ADR-028 §2,未策展不可自称 catalog)。
//   · 浏览行:catalog/seed 有、任何账本无 → scope=null 的未安装行(availability 与激活态正交)。
//   · advisory(REQ-105 archived)对安装行与浏览行同样生效 —— health 与 availability 正交。

import type { InstallReceipt } from "../preload/types"
import type { CatalogEntry } from "../renderer/extensions/catalog-types"
import { officeAdvisoryFor } from "../shared/office-advisories"
import {
  ownershipFromCatalogEntry,
  ownershipFromInstall,
  ownershipFromSeedAsset,
  type CatalogTrustChannel,
  type OwnershipDims,
} from "../shared/ext-ownership"
import {
  deriveActivation,
  deriveAvailability,
  deriveHealth,
  type ActivationState,
  type AvailabilityView,
  type HealthView,
} from "../shared/ext-states"
import { readLedgerV2, type InstallRecordV2 } from "./ext-receipt-v2"
import { readPackagedSeed } from "./ext-seed"
import { alphaRoot } from "./alpha-workdir"

// ── 输入(现有真源的已解码形状)─────────────────────────────────────────────────────────────────

export type InventoryCatalogInput = {
  entries: CatalogEntry[]
  /** remote/cache = signed channel(ed25519 已验);bundled = 随包快照。 */
  channel: CatalogTrustChannel
  version: string
}

export type InventorySeedAsset = { id: string; type: string; source: string; platformCompatible: boolean }

export type InventoryLedgerInput = {
  scope: "global" | "project"
  records: InstallRecordV2[]
  v1Only: InstallReceipt[]
  warnings: string[]
}

export type InventorySources = {
  catalog: InventoryCatalogInput | null
  seedAssets: InventorySeedAsset[]
  ledgers: InventoryLedgerInput[]
  /** 采集层附加警告(seed 不可用、项目根非法等 —— 如实透传,不吞)。 */
  warnings?: string[]
}

// ── 输出(逐扩展五维 + 三态;纯 JSON)──────────────────────────────────────────────────────────

export type InventoryRow = {
  /** catalog entry id 或 `user:<name>`。 */
  id: string
  name: string
  kind: string
  /** 安装行 = "global" | "project";未安装浏览行 = null。 */
  scope: "global" | "project" | null
  ownership: OwnershipDims
  availability: AvailabilityView
  activation: ActivationState
  health: HealthView
  version?: string
  generation?: number
  origin?: string
}

export type ExtInventory = {
  catalogVersion: string | null
  catalogChannel: CatalogTrustChannel | null
  rows: InventoryRow[]
  warnings: string[]
}

const SCOPE_RANK: Record<string, number> = { global: 0, project: 1, null: 2 }

/** 纯函数聚合:既有真源的已解码输入 → 逐扩展五维 + 三态(确定性排序:id ↑,scope global<project<浏览行)。 */
export function aggregateInventory(sources: InventorySources): ExtInventory {
  const warnings: string[] = [...(sources.warnings ?? [])]
  const catalogById = new Map<string, CatalogEntry>()
  for (const entry of sources.catalog?.entries ?? []) catalogById.set(entry.id, entry)
  const seedById = new Map<string, InventorySeedAsset>()
  for (const asset of sources.seedAssets) seedById.set(asset.id, asset)

  const rows: InventoryRow[] = []
  const installedIds = new Set<string>()
  const channel = sources.catalog?.channel

  const availabilityFor = (id: string, installed: boolean): AvailabilityView =>
    deriveAvailability({
      installed,
      bundledCompatible: seedById.get(id)?.platformCompatible === true,
      inCatalog: catalogById.has(id),
    })

  for (const ledger of sources.ledgers) {
    warnings.push(...ledger.warnings)

    for (const record of ledger.records) {
      installedIds.add(record.id)
      const entry = catalogById.get(record.id)
      const advisory = officeAdvisoryFor({ id: record.id, name: record.name })
      rows.push({
        id: record.id,
        name: record.name,
        kind: record.kind,
        scope: ledger.scope,
        ownership: ownershipFromInstall(record, entry && channel ? { entry, channel } : undefined),
        availability: availabilityFor(record.id, true),
        activation: deriveActivation({ ledger: "v2", desiredState: record.desiredState }),
        health: deriveHealth({
          installed: true,
          ...(advisory ? { advisory: { catalogId: advisory.catalogId, archivedAt: advisory.archivedAt } } : {}),
          ledger: "v2",
          ...(record.transaction ? { transactionState: record.transaction.state, transactionId: record.transaction.id } : {}),
        }),
        ...(record.version ? { version: record.version } : {}),
        generation: record.generation,
        origin: record.origin,
      })
    }

    for (const receipt of ledger.v1Only) {
      installedIds.add(receipt.id)
      const entry = catalogById.get(receipt.id)
      const advisory = officeAdvisoryFor({ id: receipt.id, name: receipt.name })
      rows.push({
        id: receipt.id,
        name: receipt.name,
        kind: receipt.type,
        scope: ledger.scope,
        ownership: ownershipFromInstall(
          { id: receipt.id, kind: receipt.type, origin: receipt.origin },
          entry && channel ? { entry, channel } : undefined,
        ),
        availability: availabilityFor(receipt.id, true),
        activation: deriveActivation({ ledger: "v1" }),
        health: deriveHealth({
          installed: true,
          ...(advisory ? { advisory: { catalogId: advisory.catalogId, archivedAt: advisory.archivedAt } } : {}),
          ledger: "v1",
        }),
        ...(receipt.version ? { version: receipt.version } : {}),
        origin: receipt.origin,
      })
    }
  }

  // 浏览行:catalog 有、任何账本无(availability=catalog/bundled;激活态恒 not-installed —— 不塌缩)。
  for (const entry of sources.catalog?.entries ?? []) {
    if (installedIds.has(entry.id)) continue
    const advisory = officeAdvisoryFor({ id: entry.id, name: entry.name })
    rows.push({
      id: entry.id,
      name: entry.name,
      kind: entry.type,
      scope: null,
      ownership: ownershipFromCatalogEntry(entry, channel ?? "bundled"),
      availability: availabilityFor(entry.id, false),
      activation: deriveActivation({ ledger: "none" }),
      health: deriveHealth({
        installed: false,
        ...(advisory ? { advisory: { catalogId: advisory.catalogId, archivedAt: advisory.archivedAt } } : {}),
      }),
      ...(typeof entry.version === "string" && entry.version ? { version: entry.version } : {}),
    })
  }

  // seed-only 浏览行(资产在 seed、不在 catalog、未安装 —— 如实露出,分发责任 bundled)。
  for (const asset of sources.seedAssets) {
    if (installedIds.has(asset.id) || catalogById.has(asset.id)) continue
    const name = asset.id.includes(":") ? asset.id.slice(asset.id.indexOf(":") + 1) : asset.id
    rows.push({
      id: asset.id,
      name,
      kind: asset.type,
      scope: null,
      ownership: ownershipFromSeedAsset(asset),
      availability: availabilityFor(asset.id, false),
      activation: deriveActivation({ ledger: "none" }),
      health: deriveHealth({ installed: false }),
    })
  }

  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : SCOPE_RANK[String(a.scope)]! - SCOPE_RANK[String(b.scope)]!))
  return {
    catalogVersion: sources.catalog?.version ?? null,
    catalogChannel: sources.catalog?.channel ?? null,
    rows,
    warnings,
  }
}

// ── 薄采集器(既有 reader → aggregate 输入;零写入)────────────────────────────────────────────

export type CollectInventoryOpts = {
  /** 已验 catalog(remote/cache 验签 / bundled 快照)—— 由调用方经既有 resolve 面注入。 */
  catalog: InventoryCatalogInput | null
  /** `<resourcesPath>/extension-seed`;null/undefined = 无打包 seed。 */
  seedDir?: string | null
  /** 平台 token 注入(测试);缺省 = 当前进程平台。 */
  platformToken?: string
  /** 全局账本根(env-scoped `~/.alpha`,REQ-098 main 真源)。 */
  globalRoot: string
  /** 当前项目目录(可选;项目账本 = `<project>/.alpha`,fail-closed 由 alphaRoot/readLedgerV2 承载)。 */
  projectDir?: string
}

/** 只读采集 + 聚合:任何真源不可用都如实进 warnings,绝不抛错清零其它面。 */
export function collectInventory(opts: CollectInventoryOpts): ExtInventory {
  return collectInventoryWithWarnings(opts, [])
}

function collectInventoryWithWarnings(opts: CollectInventoryOpts, priorWarnings: string[]): ExtInventory {
  const warnings: string[] = [...priorWarnings]

  let seedAssets: InventorySeedAsset[] = []
  if (opts.seedDir) {
    const seed = readPackagedSeed(opts.seedDir, opts.platformToken ? { platformToken: opts.platformToken } : {})
    if (seed.ok) {
      seedAssets = seed.seed.assets.map((a) => ({ id: a.id, type: a.type, source: a.source, platformCompatible: a.platformCompatible }))
    } else {
      warnings.push(`packaged seed unavailable: ${seed.error}`)
    }
  }

  const ledgers: InventoryLedgerInput[] = []
  const globalLedger = readLedgerV2(opts.globalRoot)
  ledgers.push({ scope: "global", records: globalLedger.records, v1Only: globalLedger.v1Only, warnings: globalLedger.warnings })

  if (opts.projectDir !== undefined) {
    const projectRoot = alphaRoot(opts.projectDir)
    if (projectRoot === null) {
      warnings.push(`project ledger skipped: invalid project root ${opts.projectDir} (fail closed)`)
    } else {
      const projectLedger = readLedgerV2(projectRoot)
      ledgers.push({ scope: "project", records: projectLedger.records, v1Only: projectLedger.v1Only, warnings: projectLedger.warnings })
    }
  }

  return aggregateInventory({ catalog: opts.catalog, seedAssets, ledgers, warnings })
}

// ── 只读查询面(REQ-103 slice 2a,#195):唯一的 governance IPC 通道核心 ─────────────────────────
//
// electron-free 工厂:ext-ipc 只做一行 ipcMain.handle 接线(通道名单点定义在 ext-ipc)。
// 契约(负向面在 ext-security-boundaries.test 钉死):
//   · 纯读 —— 本函数与其全部被调面零写入(不动账本/配置/磁盘);
//   · renderer 唯一输入 = projectDir(与既有 ext-list-installs(-v2) 同信任面:当前打开项目);
//     非 string / 空串输入如实丢弃并留 warning,绝不抛错;
//   · catalog resolve 失败不清零其它真源:catalog=null + warning,账本/seed 行照常返回;
//   · 输出 = ExtInventory 纯 JSON(结构化克隆安全,零函数/句柄)。

export type InventoryQueryDeps = {
  /** 已验 catalog resolve 面(remote/cache 验签 → bundled 快照),由 ext-ipc 注入既有机器。 */
  resolveCatalog(): Promise<InventoryCatalogInput | null>
  /** `<resourcesPath>/extension-seed`;null = 无打包 seed。 */
  seedDir: string | null
  platformToken?: string
  globalRoot(): string
}

export function createInventoryQuery(deps: InventoryQueryDeps): (projectDir?: unknown) => Promise<ExtInventory> {
  return async (projectDir?: unknown): Promise<ExtInventory> => {
    const warnings: string[] = []

    let catalog: InventoryCatalogInput | null = null
    try {
      catalog = await deps.resolveCatalog()
    } catch (error) {
      warnings.push(`catalog unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }

    let dir: string | undefined
    if (typeof projectDir === "string" && projectDir) {
      dir = projectDir
    } else if (projectDir !== undefined && projectDir !== null) {
      warnings.push("projectDir ignored: not a non-empty string (read-only face, fail closed)")
    }

    return collectInventoryWithWarnings(
      {
        catalog,
        seedDir: deps.seedDir,
        ...(deps.platformToken ? { platformToken: deps.platformToken } : {}),
        globalRoot: deps.globalRoot(),
        ...(dir !== undefined ? { projectDir: dir } : {}),
      },
      warnings,
    )
  }
}
