// REQ-104 #397 PR-B —— 货架/分组/词汇映射纯函数测试(v6 已批稿语义逐条钉住)。
import { describe, expect, test } from "bun:test"
import { curationBlobUrl, type CurationStatus } from "../../shared/catalog-curation"
import type { Catalog, CatalogEntry } from "./catalog-types"
import {
  CAPABILITY_LABEL_KEYS,
  SHELF_CHIP_KEYS,
  SHELF_ORDER,
  buildShelves,
  curationMapOf,
  downloadPresentation,
  foldDomains,
  formatBytesApprox,
  isRecommendable,
  splitBrowse,
} from "./ext-curation-view"

const SHA_A = "a".repeat(64)
const SHA_B = "b".repeat(64)
const curation = (
  catalogId: string,
  over: Partial<{
    tier: string
    activationPolicy: string
    upstreamStatus: string
    reviewedAt: string
    reviewBefore: string
    frameworks: string[]
    download: { bytes: number | null; basis: string }
  }> = {},
) => ({
  schema: "alpha.catalog.curation.v1",
  tier: over.tier ?? "precache",
  activationPolicy: over.activationPolicy ?? "default-disabled",
  deliveryMode: "installable",
  review: {
    reviewedAt: over.reviewedAt ?? "2026-07-01T00:00:00Z",
    reviewedBy: "alpha-review",
    upstreamStatus: over.upstreamStatus ?? "active",
    supportTier: "best-effort",
    reviewBefore: over.reviewBefore ?? "2027-07-01T00:00:00Z",
  },
  applicability: { frameworks: over.frameworks ?? ["*"] },
  summaries: {
    capabilities: [],
    networkDomains: [],
    requiredSecrets: [],
    runtimeDependencies: [],
    download: over.download ?? { bytes: null, basis: "unknown" },
  },
  refs: {
    sbom: { sha256: SHA_A, bytes: 1024, url: curationBlobUrl(catalogId, "1.0.0", "sbom", SHA_A), format: "cyclonedx-1.6+json" },
    intakeProvenance: {
      sha256: SHA_B,
      bytes: 512,
      url: curationBlobUrl(catalogId, "1.0.0", "intakeProvenance", SHA_B),
      format: "alpha.intake-provenance.v1+json",
    },
  },
})

const entry = (id: string, cur?: unknown): CatalogEntry =>
  ({
    id,
    type: id.split(":")[0],
    name: id.split(":")[1],
    displayName: id,
    description: "t",
    source: "official",
    category: "dev",
    version: "1.0.0",
    ...(cur !== undefined ? { curation: cur } : {}),
  }) as CatalogEntry

const NOW = "2026-07-18T00:00:00.000Z"
const noAdvisories = new Set<string>()

describe("buildShelves(推荐页四货架)", () => {
  test("固定序 核心→精选→接入→实验室;空货架隐藏;未策展不进", () => {
    const cat: Catalog = {
      version: "t",
      entries: [
        entry("mcp:labs1", curation("mcp:labs1", { tier: "labs", activationPolicy: "session-grant" })),
        entry("skill:pre1", { ...curation("skill:pre1"), tier: "precache" }),
        entry("mcp:conn1", curation("mcp:conn1", { tier: "connector" })),
        entry("skill:plain"), // 未策展 → 不进推荐
      ],
    }
    const shelves = buildShelves(cat.entries, curationMapOf(cat), NOW, noAdvisories)
    expect(shelves.map((s) => s.tier)).toEqual(["precache", "connector", "labs"]) // core 空 → 隐藏
    expect(shelves.every((s) => s.items.length === 1)).toBe(true)
    expect(SHELF_ORDER).toEqual(["core", "precache", "connector", "labs"])
  })

  test("排除规则:归档/失养/过期(排他)/非全框架/活跃公示/校验失败,逐条退出推荐", () => {
    const archived = entry("mcp:a", curation("mcp:a", { upstreamStatus: "archived" }))
    const unmaint = entry("mcp:u", curation("mcp:u", { upstreamStatus: "unmaintained" }))
    const expired = entry("mcp:e", curation("mcp:e", { reviewedAt: "2025-01-01T00:00:00Z", reviewBefore: "2026-01-01T00:00:00Z" }))
    const exactExpiry = entry("mcp:x", curation("mcp:x", { reviewedAt: "2025-01-01T00:00:00Z", reviewBefore: "2026-07-18T00:00:00Z" }))
    const framework = entry("mcp:f", curation("mcp:f", { frameworks: ["react"] }))
    const advised = entry("mcp:adv", curation("mcp:adv"))
    const invalid = entry("mcp:bad", { ...curation("mcp:bad"), rogue: 1 })
    const ok = entry("mcp:ok", curation("mcp:ok"))
    const cat: Catalog = { version: "t", entries: [archived, unmaint, expired, exactExpiry, framework, advised, invalid, ok] }
    const map = curationMapOf(cat)
    const shelves = buildShelves(cat.entries, map, NOW, new Set(["mcp:adv"]))
    expect(shelves).toHaveLength(1)
    expect(shelves[0]!.items.map((e) => e.id)).toEqual(["mcp:ok"])
    // 排他截止:恰好等于 now 即过期。
    expect(isRecommendable("mcp:x", map.get("mcp:x")!, "2026-07-18T00:00:00Z", noAdvisories)).toBe(false)
    expect(isRecommendable("mcp:x", map.get("mcp:x")!, "2026-07-17T23:59:59Z", noAdvisories)).toBe(true)
  })
})

describe("splitBrowse(类型 tab 已分级/未分级)", () => {
  test("curated 前置;未策展与校验失败同入未分级(不部分采信)", () => {
    const cat: Catalog = {
      version: "t",
      entries: [entry("mcp:c", curation("mcp:c")), entry("mcp:plain"), entry("mcp:bad", { ...curation("mcp:bad"), rogue: 1 })],
    }
    const { graded, ungraded } = splitBrowse(cat.entries, curationMapOf(cat))
    expect(graded.map((e) => e.id)).toEqual(["mcp:c"])
    expect(ungraded.map((e) => e.id)).toEqual(["mcp:plain", "mcp:bad"])
  })
})

describe("词汇与折叠(v6 稿词汇表)", () => {
  test("chip 映射四色四货架;能力 token 全映射,未知 token 无映射(原样 mono)", () => {
    expect(Object.keys(SHELF_CHIP_KEYS).sort()).toEqual(["connector", "core", "labs", "precache"])
    expect(Object.keys(CAPABILITY_LABEL_KEYS).sort()).toEqual(["env:read", "fs:read", "fs:write", "net:http", "proc:spawn"])
    expect(CAPABILITY_LABEL_KEYS["repo:read"]).toBeUndefined()
  })

  test("域名折叠:≤6 全列;>6 前 6 + 总数", () => {
    const six = ["a.com", "b.com", "c.com", "d.com", "e.com", "f.com"]
    expect(foldDomains(six)).toEqual({ shown: six, total: 6, folded: false })
    const seven = [...six, "g.com"]
    const folded = foldDomains(seven)
    expect(folded.folded).toBe(true)
    expect(folded.shown).toHaveLength(6)
    expect(folded.total).toBe(7)
  })

  test("体积诚实口径:known 换算 / none·0 = 仅写配置 / unknown 不估算", () => {
    const known = curation("mcp:k", { download: { bytes: 5652480, basis: "catalog-assets" } })
    const none = curation("mcp:n", { download: { bytes: 0, basis: "none" } })
    const unknown = curation("mcp:u", { download: { bytes: null, basis: "unknown" } })
    expect(downloadPresentation(known as never)).toEqual({ kind: "known", bytes: 5652480 })
    expect(downloadPresentation(none as never)).toEqual({ kind: "config-only" })
    expect(downloadPresentation(unknown as never)).toEqual({ kind: "unknown" })
    expect(formatBytesApprox(5652480)).toBe("5.4 MB")
    expect(formatBytesApprox(14336)).toBe("14 KB")
  })
})
