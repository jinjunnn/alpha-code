// ext-pack-facts — REQ-104 #396:套件(Pack)整包事实的纯派生(已批设计稿
// docs/design/2026-07-17-req104-pack-facts)。输入 = 已解析的子项 CatalogEntry,输出 = 可直接
// 渲染的聚合值。纯函数、零 IPC、零账本面。
//
// 诚实口径(v5 稿硬约束):
//   · 体积只统计钉死校验的 remoteAsset 字节;会下载可执行载荷但目录未钉字节的子项(npm 装取、
//     无资产 remote skill/agent)如实计「未知」,绝不估算;随包资产(builtin/vendored)与
//     config-only 安装(mcp/cloud)零下载,不算未知。
//   · 能力并集与 #348 安装确认框同一派生真源(shared capabilitiesForCatalogEntry),永不漂移。
//   · 支持等级取全体子项的最低档(SUPPORT_TIERS 序 = 高→低)。

import type { CatalogEntry } from "./catalog-types"
import { capabilitiesForCatalogEntry, MANIFEST_CAPABILITIES, type ManifestCapability } from "../../shared/ext-capability-authorization"
import {
  runtimeSurfacesForCatalogEntry,
  supportTierForSource,
  RUNTIME_SURFACES,
  SUPPORT_TIERS,
  type RuntimeSurface,
  type SupportTier,
} from "../../shared/ext-ownership"

export type PackCapRow = {
  cap: ManifestCapability
  /** 贡献该能力的子项 displayName(去重,保子项顺序)。 */
  from: string[]
}

export type PackFacts = {
  /** 钉死资产字节合计(remoteAsset.files[].bytes)。 */
  knownBytes: number
  /** 体积未知的子项数(下载可执行载荷但目录未钉字节)。 */
  unknownSizeCount: number
  /** 所需密钥变量名并集(去重,保序)。 */
  secrets: string[]
  /** 无密钥要求的子项数(密钥行的「其余 N 项无密钥」)。 */
  secretFreeCount: number
  /** 运行面并集(RUNTIME_SURFACES 序)。 */
  surfaces: RuntimeSurface[]
  /** 全体子项的最低支持档。 */
  lowestTier: SupportTier
  /** 能力并集(高风险优先,组内按枚举序),含贡献来源。 */
  caps: PackCapRow[]
}

/** 与 ext-authz.tsx 同一高风险集(展示分级;真源语义在 #348 词汇表)。 */
const HIGH_RISK_CAPS = new Set<ManifestCapability>(["engine:plugin", "process:spawn"])
const MANIFEST_ORDER = new Map<ManifestCapability, number>(MANIFEST_CAPABILITIES.map((c, i) => [c, i]))

/** 单子项下载体积判定:known 字节 / 未知 / 零下载。 */
function entryDownload(entry: CatalogEntry): { kind: "known"; bytes: number } | { kind: "unknown" } | { kind: "none" } {
  if (entry.remoteAsset) {
    let bytes = 0
    for (const f of entry.remoteAsset.files) bytes += f.bytes
    return { kind: "known", bytes }
  }
  const spec = entry.installSpec
  if (entry.type === "plugin") return spec?.kind === "plugin" && spec.vendoredAssetKey ? { kind: "none" } : { kind: "unknown" }
  if (entry.type === "skill") return spec?.kind === "skill" && spec.source === "builtin" ? { kind: "none" } : { kind: "unknown" }
  if (entry.type === "agent") return spec?.kind === "agent" && spec.source === "builtin" ? { kind: "none" } : { kind: "unknown" }
  // mcp/cloud:config-only 安装,无下载载荷(local MCP 的运行时拉取由「本机子进程」运行面表达)。
  return { kind: "none" }
}

export function derivePackFacts(children: CatalogEntry[]): PackFacts {
  let knownBytes = 0
  let unknownSizeCount = 0
  const secrets: string[] = []
  let secretFreeCount = 0
  const surfaceSet = new Set<RuntimeSurface>()
  let lowestTierIdx = 0
  const capFrom = new Map<ManifestCapability, string[]>()

  for (const child of children) {
    const dl = entryDownload(child)
    if (dl.kind === "known") knownBytes += dl.bytes
    else if (dl.kind === "unknown") unknownSizeCount += 1

    const envVars = child.installSpec?.kind === "mcp" ? (child.installSpec.requiredEnvVars ?? []) : []
    if (envVars.length === 0) secretFreeCount += 1
    for (const v of envVars) if (!secrets.includes(v)) secrets.push(v)

    for (const s of runtimeSurfacesForCatalogEntry(child)) surfaceSet.add(s)

    const tierIdx = SUPPORT_TIERS.indexOf(supportTierForSource(child.source))
    if (tierIdx > lowestTierIdx) lowestTierIdx = tierIdx

    for (const cap of capabilitiesForCatalogEntry(child)) {
      const list = capFrom.get(cap) ?? []
      if (!list.includes(child.displayName)) list.push(child.displayName)
      capFrom.set(cap, list)
    }
  }

  const enumOrder = [...capFrom.keys()].sort((a, b) => MANIFEST_ORDER.get(a)! - MANIFEST_ORDER.get(b)!)
  const caps: PackCapRow[] = [
    ...enumOrder.filter((c) => HIGH_RISK_CAPS.has(c)),
    ...enumOrder.filter((c) => !HIGH_RISK_CAPS.has(c)),
  ].map((cap) => ({ cap, from: capFrom.get(cap)! }))

  return {
    knownBytes,
    unknownSizeCount,
    secrets,
    secretFreeCount,
    surfaces: RUNTIME_SURFACES.filter((s) => surfaceSet.has(s)),
    lowestTier: SUPPORT_TIERS[lowestTierIdx] ?? "user",
    caps,
  }
}

/** 体积展示:≥1 MB 一位小数,其下取整 KB;0 = 「0 KB」(全 config-only 的诚实零)。 */
export function formatPackBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.ceil(bytes / 1024)} KB`
}
