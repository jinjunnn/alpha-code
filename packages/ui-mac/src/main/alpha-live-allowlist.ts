// REQ-127 #681 / ADR-039:平台模型目录的 **last-known-good 快照**(文件桥,复用 A6 的
// 「main 写 / sidecar 读」模式),外加平台段的**唯一投影**。
//
// 网关 GET /v1/models 是「允许哪些**平台代理**模型、以及它们各自的计价倍数」的权威源
// (edition-scoped),`#1556` 起也是它们的名称 / 品牌 / 能力 / 档位(V3 `display`)的权威源。
// 后台刷新器(catalog-refresher.ts)把一份**已通过严格 ModelCatalogV3 校验**的
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
// 缓存缺失 / 损坏 / 旧代(含 V2 时代没有 `display` 的旧 LKG)/ 网关不可达 → 平台段为**空**且不声称任何价格
// (`#1556` AC1:picker 如实标「平台模型清单尚未获取」;随包平台清单已删除,不再回退)。
//
// REQ-109 #595:平台快照里没有任何 BYOK 策略面。`#1556` 起 BYOK 预置目录是另一份文档(下方 BYOK 段):
// 已下载 LKG 与随包首启引导取版本高者,fork 前与平台快照一起钉进已应用目录(契约 docs/contracts/byok-availability.md)。
//
// electron-free:sidecar(utilityProcess)经 alpha-models.ts 读;main 经 alpha-platform-models.ts 写。

import * as path from "node:path"
import * as fs from "node:fs"
import { writeFileAtomicSync } from "./ext-atomic-fs"
import type { ByokCatalogV1 } from "@alpha-code/contracts-consumer"
import type { PlatformModel, PlatformModelDisplay, PricingMultiplier } from "../shared/alpha-model-types"
import catalog from "./alpha-models.json"

/** 快照里的一行:全部字段都是远端权威(`#1556`:展示与能力字段随 V3 `display` 一起进快照)。 */
export type CatalogSnapshotModel = {
  id: string
  provider?: string
  minPlan?: string
  pricing: PricingMultiplier
  display: PlatformModelDisplay
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)

/** `display` 的判据(写前与读回同一份):name 非空、brand 是字符串,其余可选字段类型对。 */
const isValidDisplay = (display: unknown): display is PlatformModelDisplay =>
  isRecord(display) &&
  typeof display.name === "string" &&
  !!display.name &&
  typeof display.brand === "string" &&
  !!display.brand &&
  (display.reasoning === undefined || typeof display.reasoning === "boolean") &&
  (display.web === undefined || typeof display.web === "boolean") &&
  (display.variants === undefined || (isRecord(display.variants) && Object.values(display.variants).every(isRecord)))

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
      isTrustedPair(model.pricing) &&
      isValidDisplay(model.display),
  )
}

/** 读快照;缺失 / 坏 JSON / 旧代 / 任一行 pair 不可信 → null(平台段为空且不声称价格)。 */
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

// ── REQ-237 `#1556`(方案 req236 §2.3):BYOK 预置目录 —— 已下载 LKG 与随包首启引导 ─────────────────
//
// 已下载 LKG 只由 catalog-refresher.ts 写,写进去的是 adoptByokCatalog 采纳后的那一份(schema 通过、版本更高、
// 只剩 App 适配器表认识的 provider)。随包 `byokCatalog` 与它同构,只作首启引导:两者取 `catalog_version` 高者
// (方案 §2.3 规则 5:App 升级带来更高的随包版本时随包胜出)。拉取失败 / 校验失败 / 未登录都不写 LKG,
// 所以已有条目从不因失败而减少(I5)。

const BYOK_FILE = "alpha-byok-catalog.json"
const BUNDLED_BYOK = (catalog as unknown as { byokCatalog: ByokCatalogV1 }).byokCatalog

export function byokCatalogPath(userDataPath: string): string {
  return path.join(userDataPath, BYOK_FILE)
}

/** 本机 BYOK 目录文件(LKG 与钉住副本)的判据,写前与读回同一份。完整 schema 在采纳时已由 ByokCatalogV1 decoder 判过;
 *  这里只守「读回来的还是那个形状」(sidecar 也读,不在它的模块图里引 Ajv)。 */
export function isValidByokCatalog(value: unknown): value is ByokCatalogV1 {
  if (!isRecord(value) || value.schema_version !== 1) return false
  if (typeof value.catalog_version !== "number" || !Number.isSafeInteger(value.catalog_version) || value.catalog_version <= 0)
    return false
  if (!Array.isArray(value.providers)) return false
  return value.providers.every(
    (provider) =>
      isRecord(provider) &&
      typeof provider.id === "string" &&
      typeof provider.name === "string" &&
      typeof provider.preset === "boolean" &&
      Array.isArray(provider.models) &&
      provider.models.every(
        (model) =>
          isRecord(model) &&
          typeof model.id === "string" &&
          typeof model.name === "string" &&
          typeof model.image_input === "boolean" &&
          (model.reasoning === undefined || typeof model.reasoning === "boolean") &&
          (model.variants === undefined || (isRecord(model.variants) && Object.values(model.variants).every(isRecord))),
      ),
  )
}

export function readByokCatalogLkg(userDataPath: string): ByokCatalogV1 | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(byokCatalogPath(userDataPath), "utf8"))
    return isValidByokCatalog(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** 写 BYOK LKG(原子替换)。判据不过直接不写。唯一写入方是 catalog-refresher.ts 的单飞轮次。@returns 是否落盘。 */
export function writeByokCatalogLkg(userDataPath: string, byok: ByokCatalogV1): boolean {
  if (!isValidByokCatalog(byok)) return false
  fs.mkdirSync(userDataPath, { recursive: true })
  writeFileAtomicSync(byokCatalogPath(userDataPath), JSON.stringify(byok))
  return true
}

export type ByokCatalogChoice = { byok: ByokCatalogV1; source: "remote" | "bundled" }

/** 已下载的 BYOK 目录 = LKG 与随包首启引导里 `catalog_version` 更高的那一份(相等 ⇒ 随包)。 */
export function downloadedByokCatalog(userDataPath: string): ByokCatalogChoice {
  const lkg = readByokCatalogLkg(userDataPath)
  return lkg && lkg.catalog_version > BUNDLED_BYOK.catalog_version
    ? { byok: lkg, source: "remote" }
    : { byok: BUNDLED_BYOK, source: "bundled" }
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
  /** 钉住当刻的平台 LKG;没有有效 LKG ⇒ null(平台段为空且不声称价格,同 LKG 缺失)。 */
  platform: CatalogSnapshot | null
  /** `#1556`:钉住当刻的 BYOK 目录(LKG 与随包首启引导取高者)。 */
  byok: ByokCatalogV1
  byokSource: "remote" | "bundled"
}

export function appliedCatalogPath(userDataPath: string): string {
  return path.join(userDataPath, APPLIED_FILE)
}

/** fork 前调用:把当刻两份已下载目录原子写成「已应用目录」。写失败直接抛(fail closed,由 spawnLocalServer 拒绝 fork)。 */
export function pinAppliedCatalog(userDataPath: string, generation: number): AppliedCatalog {
  const byok = downloadedByokCatalog(userDataPath)
  const applied: AppliedCatalog = {
    generation,
    platform: readCatalogSnapshot(userDataPath),
    byok: byok.byok,
    byokSource: byok.source,
  }
  fs.mkdirSync(userDataPath, { recursive: true })
  writeFileAtomicSync(appliedCatalogPath(userDataPath), JSON.stringify(applied))
  return applied
}

function readAppliedFile(userDataPath: string): Partial<AppliedCatalog> | null {
  try {
    return JSON.parse(fs.readFileSync(appliedCatalogPath(userDataPath), "utf8")) as Partial<AppliedCatalog> | null
  } catch {
    return null
  }
}

/** 读已应用目录的平台段。缺失 / 坏 JSON / 快照过不了同一份判据 → null(与 readCatalogSnapshot 同一退化语义)。 */
export function readAppliedPlatformSnapshot(userDataPath: string): CatalogSnapshot | null {
  const parsed = readAppliedFile(userDataPath)
  return isValidCatalogSnapshot(parsed?.platform) ? parsed.platform : null
}

/** `#1556`:读已应用目录的 BYOK 段。还没钉过(首次 fork 之前)/ 坏 JSON / 过不了判据 → 随包首启引导。 */
export function readAppliedByokCatalog(userDataPath: string): ByokCatalogChoice {
  const parsed = readAppliedFile(userDataPath)
  return isValidByokCatalog(parsed?.byok)
    ? { byok: parsed.byok, source: parsed.byokSource === "remote" ? "remote" : "bundled" }
    : { byok: BUNDLED_BYOK, source: "bundled" }
}

/** 平台段的**唯一**投影。picker(getEffectiveCatalog)与 sidecar(buildAlphaModelConfig)必须都走这里。
 *
 *  `#1556`(AC1):每个字段都取自已应用快照 —— id 与 pricing 来自目录行,名称 / 品牌 / 能力 / 档位来自该行的
 *  `display`。没有有效快照 ⇒ 空:随包平台清单(第二份权威)已删除,不回退,也就不声称任何价格(#679 / I6)。 */
export function projectPlatformModels(snapshot: CatalogSnapshot | null): PlatformModel[] {
  if (!snapshot) return []
  return snapshot.models.map((remote) => ({
    id: remote.id,
    name: remote.display.name,
    brand: remote.display.brand,
    ...(remote.display.reasoning ? { reasoning: true } : {}),
    ...(remote.display.web ? { web: true } : {}),
    ...(remote.display.variants ? { variants: remote.display.variants } : {}),
    pricing: remote.pricing,
  }))
}
