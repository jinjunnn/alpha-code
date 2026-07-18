// REQ-104 #397(必改①)—— session-grant oracle:纯判定(fail-closed 采信)+ 同步读链兜底。
import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { curationBlobUrl } from "../shared/catalog-curation"
import { readSessionGrantIdsSync, sessionGrantIdsFromEntries } from "./ext-curation-policy"

const SHA_A = "a".repeat(64)
const SHA_B = "b".repeat(64)
const curation = (catalogId: string, version: string, over: Partial<{ tier: string; activationPolicy: string }> = {}) => ({
  schema: "alpha.catalog.curation.v1",
  tier: over.tier ?? "labs",
  activationPolicy: over.activationPolicy ?? "session-grant",
  deliveryMode: "installable",
  review: {
    reviewedAt: "2026-07-01T00:00:00Z",
    reviewedBy: "alpha-review",
    upstreamStatus: "active",
    supportTier: "best-effort",
    reviewBefore: "2027-07-01T00:00:00Z",
  },
  applicability: { frameworks: ["*"] },
  summaries: { capabilities: [], networkDomains: [], requiredSecrets: [], runtimeDependencies: [], download: { bytes: null, basis: "unknown" } },
  refs: {
    sbom: { sha256: SHA_A, bytes: 1024, url: curationBlobUrl(catalogId, version, "sbom", SHA_A), format: "cyclonedx-1.6+json" },
    intakeProvenance: {
      sha256: SHA_B,
      bytes: 512,
      url: curationBlobUrl(catalogId, version, "intakeProvenance", SHA_B),
      format: "alpha.intake-provenance.v1+json",
    },
  },
})

describe("sessionGrantIdsFromEntries(纯判定,fail-closed 采信)", () => {
  test("curated session-grant 进集合;default-disabled / 未策展 / 校验失败(未知键)不进", () => {
    const entries = [
      { id: "mcp:labs1", type: "mcp", name: "l1", version: "1.0.0", curation: curation("mcp:labs1", "1.0.0") },
      {
        id: "mcp:pre1",
        type: "mcp",
        name: "p1",
        version: "1.0.0",
        curation: curation("mcp:pre1", "1.0.0", { tier: "precache", activationPolicy: "default-disabled" }),
      },
      { id: "mcp:plain", type: "mcp", name: "u" }, // 未策展
      { id: "mcp:bad", type: "mcp", name: "b", version: "1.0.0", curation: { ...curation("mcp:bad", "1.0.0"), rogue: 1 } }, // invalid
      null,
      "junk",
    ]
    expect([...sessionGrantIdsFromEntries(entries)]).toEqual(["mcp:labs1"])
  })
})

describe("readSessionGrantIdsSync(同步读链,r1-4:不可判定 ≠ 空集)", () => {
  test("无已验 LKG/v1 缓存 → ok:false(远端状态未知),partialIds = 随包可识别子集(当前随包无 curation → 空)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "curation-oracle-"))
    try {
      const oracle = readSessionGrantIdsSync(dir, "stable")
      expect(oracle.ok).toBe(false)
      if (!oracle.ok) {
        expect(oracle.reason).toContain("no verified channel LKG")
        expect(oracle.partialIds.size).toBe(0)
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
