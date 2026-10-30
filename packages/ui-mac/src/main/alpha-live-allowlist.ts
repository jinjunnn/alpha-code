// REQ-127 #681 / ADR-039:平台模型目录的 **last-known-good 快照**(文件桥,复用 A6 的
// 「main 写 / sidecar 读」模式),外加平台段的**唯一投影**。
//
// 网关 GET /v1/models 是「允许哪些**平台代理**模型、以及它们各自的计价倍数」的权威源
// (edition-scoped)。后台刷新器(catalog-refresher.ts)把一份**已通过严格 ModelCatalogV2 校验**的
// 快照写到 <userData>/alpha-live-models.json(已下载);每次 fork 前 main 把它钉成
// alpha-applied-catalog.json(已应用,`#1555`),buildAlphaModelConfig(sidecar)与 picker 的
// effective catalog(main)只读钉住的那份。
//
// 三条本模块承重的纪律:
//
//  1. **写前与读回共用同一个校验函数**(`isValidCatalogSnapshot`)。此前两处各写一份「什么算有效
//     缓存」,于是空缓存时一边 0 行、一边静态 9 行 —— 分叉不是 bug 的结果,是两份判据的结果。
//  2. **快照没有自己的 schema version**。旧 V1 缓存缺 basis 与逐行 pair,被同一个校验函数自然判无效;
//     另立一个版本轴只会让 endpoint/payload/cache 各有一代(ADR-039 §1 明确否决)。
//  3. **`models` 为空视为无效**。一次合法但空的目录响应(空 edition / 配置失误)不得把磁盘上的
//     合法 LKG 原子覆盖成空快照 —— `every` 对空数组恒真,这是可达的数据丢失路径。
//
// 缓存缺失 / 损坏 / 旧代 / 网关不可达 → 平台段回退内置 snapshot(alpha-models.json)且**不声称任何
// 价格**,picker 永不空白(B20)。
//
// REQ-109 #595:BYOK 供应商白名单(旧 `byokProviders` 字段)已撤销 —— BYOK 目录只由本地
// alpha-models.json 决定,快照里不再有任何 BYOK 策略面(契约 docs/contracts/byok-availability.md)。
//
// electron-free:sidecar(utilityProcess)经 alpha-models.ts 读;main 经 alpha-platform-models.ts 写。

import * as path from "node:path"
import * as fs from "node:fs"
import { writeFileAtomicSync } from "./ext-atomic-fs"
import type { PlatformModel, PricingMultiplier } from "../shared/alpha-model-types"

/** 快照里的一行:id 与 pricing 是远端权威,展示元数据一律不进快照。 */
export type CatalogSnapshotModel = {
  id: string
  provider?: string
  minPlan?: string
  pricing: PricingMultiplier
}

export type CatalogSnapshot = {
  /** ISO 时间戳(同步成功时刻)。 */
  fetchedAt: string
  /** 网关判定的 edition(cn/intl/…)。 */
  edition?: string
  /** 倍数相对的基准模型 id。**单位定义,不是目录成员** —— 不得假设它在 models 里。 */
  pricingBasisModelId: string
  /** edition-scoped 平台模型清单(registry 真实 id),非空。 */
  models: CatalogSnapshotModel[]
}

const FILE = "alpha-live-models.json"

export function liveAllowlistPath(userDataPath: string): string {
  return path.join(userDataPath, FILE)
}

/** 可信 pair:有限、正、且落在 0.1 网格上(契约固定「平台已 half-up 到一位小数」)。
 *
 *  ⚠️ 这**不是**「恰好一位小数」的判据,词法上也做不到:JSON 解码之后 `1` 与 `1.0` 是同一个 JS
 *  number。它能证明的只是「落在 0.1 网格」—— 于是 1.05 这类没被 half-up 过的值会被拒,而 1.0 与 1
 *  一视同仁地放行。倍数不是 schema 能表达的语义,所以它落在这里而不是 JSON Schema 里。 */
export const isTrustedPair = (pair: unknown): pair is PricingMultiplier => {
  if (!pair || typeof pair !== "object") return false
  const candidate = pair as Partial<PricingMultiplier>
  const ok = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n > 0 && Math.round(n * 10) / 10 === n
  return ok(candidate.input) && ok(candidate.output)
}

/** 完整快照校验。**写前与读回必须都调它** —— 两处各写一份判据正是本票要消灭的形态。 */
export function isValidCatalogSnapshot(value: unknown): value is CatalogSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const snapshot = value as Partial<CatalogSnapshot>
  if (typeof snapshot.fetchedAt !== "string" || !snapshot.fetchedAt) return false
  if (snapshot.edition !== undefined && typeof snapshot.edition !== "string") return false
  if (typeof snapshot.pricingBasisModelId !== "string" || !snapshot.pricingBasisModelId) return false
  if (!Array.isArray(snapshot.models) || snapshot.models.length === 0) return false
  return snapshot.models.every(
    (model) =>
      !!model &&
      typeof model === "object" &&
      typeof model.id === "string" &&
      !!model.id &&
      (model.provider === undefined || typeof model.provider === "string") &&
      (model.minPlan === undefined || typeof model.minPlan === "string") &&
      isTrustedPair(model.pricing),
  )
}

/** 读快照;缺失 / 坏 JSON / 旧代 / 任一行 pair 不可信 → null(调用方回退内置 snapshot 且不声称价格)。 */
export function readCatalogSnapshot(userDataPath: string): CatalogSnapshot | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(liveAllowlistPath(userDataPath), "utf8"))
    return isValidCatalogSnapshot(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** 写快照。**校验不过直接不写**(保留旧 LKG),过了才原子替换(tmp → fsync → rename)。
 *  原子写只保证不出现半个文件,不保证并发响应的新旧顺序 —— 唯一写入方是 catalog-refresher.ts 的单飞轮次。
 *  @returns 是否真的落盘。 */
export function writeCatalogSnapshot(userDataPath: string, snapshot: CatalogSnapshot): boolean {
  if (!isValidCatalogSnapshot(snapshot)) return false
  fs.mkdirSync(userDataPath, { recursive: true })
  writeFileAtomicSync(liveAllowlistPath(userDataPath), JSON.stringify(snapshot))
  return true
}

// ── REQ-237 `#1555`(方案 req236 §2.4):「已应用目录」—— fork 前钉住的那一份 ─────────────────
//
// LKG(上面那份)是**已下载**:后台刷新器随时可能改写它。引擎配置(buildAlphaModelConfig)与 picker
// (getEffectiveCatalog)若直接读 LKG,刷新一成功 picker 就变、引擎要等下一次 fork 才变 —— 两边不是同一份。
// 所以 main 在每次 fork 前(spawnLocalServer,紧接密钥文件之后)把当刻的 LKG 钉成这份文件,两个读者
// **只读它**;刷新器只写 LKG,从不写它。写失败 ⇒ 抛出,调用方按密钥文件写失败同样拒绝本次 fork。

const APPLIED_FILE = "alpha-applied-catalog.json"

export type AppliedCatalog = {
  /** 钉住它的那一代 sidecar(诊断用)。 */
  generation: number
  /** 钉住当刻的平台 LKG;没有有效 LKG ⇒ null(读者回退内置 snapshot 且不声称价格,同 LKG 缺失)。 */
  platform: CatalogSnapshot | null
}

export function appliedCatalogPath(userDataPath: string): string {
  return path.join(userDataPath, APPLIED_FILE)
}

/** fork 前调用:把当刻 LKG 原子写成「已应用目录」。写失败直接抛(fail closed,由 spawnLocalServer 拒绝 fork)。 */
export function pinAppliedCatalog(userDataPath: string, generation: number): AppliedCatalog {
  const applied: AppliedCatalog = { generation, platform: readCatalogSnapshot(userDataPath) }
  fs.mkdirSync(userDataPath, { recursive: true })
  writeFileAtomicSync(appliedCatalogPath(userDataPath), JSON.stringify(applied))
  return applied
}

/** 读已应用目录的平台段。缺失 / 坏 JSON / 快照过不了同一份判据 → null(与 readCatalogSnapshot 同一退化语义)。 */
export function readAppliedPlatformSnapshot(userDataPath: string): CatalogSnapshot | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(appliedCatalogPath(userDataPath), "utf8")) as Partial<AppliedCatalog> | null
    return isValidCatalogSnapshot(parsed?.platform) ? parsed.platform : null
  } catch {
    return null
  }
}

/** 平台段的**唯一**投影。picker(getEffectiveCatalog)与 sidecar(buildAlphaModelConfig)必须都走这里。
 *
 *  远端 authority:id 与 pricing 一律来自快照;本地只补 name/reasoning/web/variants 这些展示元数据。
 *  逐字段显式构造 —— 本地对象**从不**被 spread 进来,结构上无法覆盖远端字段。
 *
 *  `local` 由调用方传入(本模块不 import alpha-models.ts,避免循环依赖)。
 *
 *  [#679] 本地目录里**已经没有任何价格轴**。此前这里为快照里没被本地收录的模型合成一个最便宜的
 *  档位,于是「平台刚上线的 71.4×/178.6× 模型」在选择器上显示成「标准 ×1」—— 合成一个价格主张
 *  比不显示更坏。现在未知模型只降级 `name`(用 id 本名),价格仍是平台原值。 */
export function projectPlatformModels(
  local: readonly PlatformModel[],
  snapshot: CatalogSnapshot | null,
): PlatformModel[] {
  if (!snapshot) return local.map((model) => ({ ...model, pricing: undefined }))
  const byId = new Map(local.map((model) => [model.id, model]))
  return snapshot.models.map((remote) => {
    const meta = byId.get(remote.id)
    return {
      id: remote.id,
      name: meta?.name ?? remote.id,
      ...(meta?.reasoning ? { reasoning: true } : {}),
      ...(meta?.web ? { web: true } : {}),
      ...(meta?.variants ? { variants: meta.variants } : {}),
      pricing: remote.pricing,
    }
  })
}
