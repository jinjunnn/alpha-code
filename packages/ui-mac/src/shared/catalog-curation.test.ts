// catalog-curation 消费端契约测试(REQ-104 #397)。真源 = vendored 契约向量
// (src/shared/catalog-intake-contract/testvectors/,45 文件,alpha-web@9b1ea4b,由
// alpha-web scripts/gen-intake-testvectors.mjs 确定性再生)——TS 移植与 mjs 执行器的
// 任何语义/文案漂移在此逐向量暴露。执行方式与供给侧 tests/catalog-intake-contract.test.mjs
// 同构:curation 向量走 checkCurationContract(+ 消费端 decode 面),provenance/SBOM 向量
// 走各自 validator(它们是 blob 内容的校验器,不进 entry 解码面)。
import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"

import {
  assertCanonicalBlobBytes,
  canonicalJsonBytes,
  checkCurationContract,
  checkProvenanceContract,
  checkSbomContract,
  curationActivationFacts,
  curationBlobUrl,
  decodeEntryCuration,
  isCurationArchived,
  isReviewExpired,
  utf8Compare,
  type Curation,
  type CurationStatus,
} from "./catalog-curation"

const VECTORS_DIR = path.join(import.meta.dir, "catalog-intake-contract", "testvectors")
const readJson = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(VECTORS_DIR, name), "utf8"))

type VectorIndex = {
  schema: string
  curation: { valid: string[]; invalid: { file: string; errorIncludes: string }[] }
  provenance: { valid: string[]; invalid: { file: string; errorIncludes: string }[] }
  sbom: { valid: string[]; invalid: { file: string; errorIncludes: string }[] }
}
const index = readJson("vectors.json") as VectorIndex

type CurationWrapper = { catalogId: string; version: string; entryType: string; hasPayloadAssets: boolean; curation: unknown }
type ProvenanceWrapper = { catalogId: string; version: string; provenance: unknown }
type SbomWrapper = { sbom: unknown }

/** 向量 wrapper → 消费端 entry 形态(hasPayloadAssets ⇒ 合成 remoteAsset.files 非空)。 */
const entryOf = (w: CurationWrapper) => ({
  id: w.catalogId,
  type: w.entryType,
  version: w.version,
  curation: w.curation,
  ...(w.hasPayloadAssets ? { remoteAsset: { files: [{}] } } : {}),
})

describe("契约向量:curation(结构面 + 跨字段不变量,与供给侧执行器同判)", () => {
  test("向量索引完整(45 文件:44 数据 fixture + vectors.json)", () => {
    expect(fs.readdirSync(VECTORS_DIR).length).toBe(45)
    expect(index.schema).toBe("alpha.catalog-intake.testvectors.v1")
    expect(index.curation.valid.length + index.curation.invalid.length).toBe(23)
    expect(index.provenance.valid.length + index.provenance.invalid.length).toBe(11)
    expect(index.sbom.valid.length + index.sbom.invalid.length).toBe(10)
  })

  for (const file of index.curation.valid) {
    test(`正向 ${file} → 契约通过 + decode 采信`, () => {
      const w = readJson(file) as CurationWrapper
      expect(
        checkCurationContract(w.curation, {
          catalogId: w.catalogId,
          version: w.version,
          entryType: w.entryType,
          hasPayloadAssets: w.hasPayloadAssets,
        }),
      ).toBe("")
      const status = decodeEntryCuration(entryOf(w))
      expect(status.kind).toBe("curated")
    })
  }

  for (const { file, errorIncludes } of index.curation.invalid) {
    test(`负向 ${file} → fail-closed(reason 含期望子串)`, () => {
      const w = readJson(file) as CurationWrapper
      const err = checkCurationContract(w.curation, {
        catalogId: w.catalogId,
        version: w.version,
        entryType: w.entryType,
        hasPayloadAssets: w.hasPayloadAssets,
      })
      expect(err).toContain(errorIncludes)
      const status = decodeEntryCuration(entryOf(w))
      expect(status.kind).toBe("invalid")
      expect((status as { kind: "invalid"; reason: string }).reason).toContain(errorIncludes)
    })
  }
})

describe("契约向量:provenance(blob validator)", () => {
  for (const file of index.provenance.valid) {
    test(`正向 ${file}`, () => {
      const w = readJson(file) as ProvenanceWrapper
      expect(checkProvenanceContract(w.provenance, { catalogId: w.catalogId, version: w.version })).toBe("")
    })
  }
  for (const { file, errorIncludes } of index.provenance.invalid) {
    test(`负向 ${file}`, () => {
      const w = readJson(file) as ProvenanceWrapper
      expect(checkProvenanceContract(w.provenance, { catalogId: w.catalogId, version: w.version })).toContain(errorIncludes)
    })
  }
})

describe("契约向量:SBOM 剖面(blob validator)", () => {
  for (const file of index.sbom.valid) {
    test(`正向 ${file}`, () => {
      const w = readJson(file) as SbomWrapper
      expect(checkSbomContract(w.sbom)).toBe("")
    })
  }
  for (const { file, errorIncludes } of index.sbom.invalid) {
    test(`负向 ${file}`, () => {
      const w = readJson(file) as SbomWrapper
      expect(checkSbomContract(w.sbom)).toContain(errorIncludes)
    })
  }
})

describe("decodeEntryCuration:消费端特有 fail-closed 面(§7.1 行 3/4)", () => {
  const validWrapper = readJson("curation.labs.json") as CurationWrapper

  test("无 curation 键 = 未策展(不是错误)", () => {
    expect(decodeEntryCuration({ id: "mcp:x", type: "mcp", version: "1.0.0" })).toEqual({ kind: "uncurated" })
  })

  test("entry 无 version → invalid(blob URL 绑定无法成立)", () => {
    const status = decodeEntryCuration({ id: validWrapper.catalogId, type: validWrapper.entryType, curation: validWrapper.curation })
    expect(status.kind).toBe("invalid")
    expect((status as { reason: string }).reason).toContain("no entry-level version")
  })

  test("curation 非对象 → invalid(结构面拒)", () => {
    const status = decodeEntryCuration({ id: "mcp:x", type: "mcp", version: "1.0.0", curation: "yes" })
    expect(status.kind).toBe("invalid")
  })

  test("非法 catalogId(注入形态)→ invalid,不进 URL 推导", () => {
    const status = decodeEntryCuration({
      id: "mcp:../evil",
      type: "mcp",
      version: validWrapper.version,
      curation: validWrapper.curation,
    })
    expect(status.kind).toBe("invalid")
  })

  test("hasPayloadAssets 由消费端资产面如实传入(connection-only + remoteAsset = invalid)", () => {
    const w = readJson("curation.connector-connection-only.json") as CurationWrapper
    expect(w.hasPayloadAssets).toBe(false)
    const withPayload = decodeEntryCuration({ ...entryOf(w), remoteAsset: { files: [{}] } })
    expect(withPayload.kind).toBe("invalid")
    expect((withPayload as { reason: string }).reason).toContain("forbids payload assets")
  })
})

describe("消费决策辅助(§7.2)", () => {
  const labs = readJson("curation.labs.json") as CurationWrapper
  const curated = decodeEntryCuration(entryOf(labs)) as { kind: "curated"; curation: Curation }

  test("labs 恒 session-grant;facts 透传声明", () => {
    expect(curated.curation.activationPolicy).toBe("session-grant")
    const facts = curationActivationFacts(curated, "2026-07-18T00:00:00.000Z")
    expect(facts.activationPolicy).toBe("session-grant")
  })

  test("reviewBefore 排他截止:恰好等于即过期", () => {
    const rb = curated.curation.review.reviewBefore
    expect(isReviewExpired(curated.curation, new Date(Date.parse(rb)).toISOString())).toBe(true)
    expect(isReviewExpired(curated.curation, new Date(Date.parse(rb) - 1000).toISOString())).toBe(false)
    expect(curationActivationFacts(curated, new Date(Date.parse(rb)).toISOString()).reviewExpired).toBe(true)
  })

  test("uncurated/invalid → 空 facts(#395 保守规则兜底)", () => {
    expect(curationActivationFacts({ kind: "uncurated" }, "2026-07-18T00:00:00.000Z")).toEqual({})
    expect(curationActivationFacts({ kind: "invalid", reason: "x" } as CurationStatus, "2026-07-18T00:00:00.000Z")).toEqual({})
  })

  test("isCurationArchived 只对 curated + archived 为真", () => {
    expect(isCurationArchived(curated)).toBe(false)
    const archived = {
      ...curated,
      curation: { ...curated.curation, review: { ...curated.curation.review, upstreamStatus: "archived" as const } },
    }
    expect(isCurationArchived(archived)).toBe(true)
    expect(isCurationArchived({ kind: "uncurated" })).toBe(false)
  })
})

describe("canonical 字节执行器(合同 §4/§6,消费端逐字节复验)", () => {
  test("canonical roundtrip:parse → 重序列化字节相等", () => {
    const value = { b: [2, 1], a: "文", nested: { z: null, a: true } }
    const bytes = canonicalJsonBytes(value)
    expect(assertCanonicalBlobBytes(bytes, "t")).toEqual(JSON.parse(new TextDecoder().decode(bytes)))
  })

  test("非 canonical(键序 / 缩进 / 无尾随换行 / CRLF)→ 拒", () => {
    const te = new TextEncoder()
    expect(() => assertCanonicalBlobBytes(te.encode('{"b":1,"a":2}'), "t")).toThrow("not canonical")
    expect(() => assertCanonicalBlobBytes(te.encode('{\n  "a": 1\n}'), "t")).toThrow("not canonical") // 缺尾随换行
    expect(() => assertCanonicalBlobBytes(te.encode('{\r\n  "a": 1\r\n}\r\n'), "t")).toThrow("not canonical")
  })

  test("非法 UTF-8 / 非 JSON → 拒", () => {
    expect(() => assertCanonicalBlobBytes(new Uint8Array([0xff, 0xfe]), "t")).toThrow("not valid UTF-8")
    expect(() => assertCanonicalBlobBytes(new TextEncoder().encode("not json\n"), "t")).toThrow("not valid JSON")
  })

  test("非 NFC 字符串 → 拒(生成面断言)", () => {
    expect(() => canonicalJsonBytes({ a: "é" })).toThrow("not NFC-normalized")
  })

  test("utf8Compare 是字节序(非 UTF-16 码元序)", () => {
    // U+FF61(EF BD A1)< U+10000(F0 90 80 80)按 UTF-8 字节;UTF-16 码元序相反(FF61 > D800)。
    expect(utf8Compare("｡", "\u{10000}") < 0).toBe(true)
    expect(["\u{10000}", "｡"].sort()[0]).toBe("\u{10000}") // 默认 sort 与字节序不同向的铁证
  })

  test("blob URL 推导逐字(id 冒号转点 + content-addressed 文件名)", () => {
    const sha = "a".repeat(64)
    expect(curationBlobUrl("mcp:github", "1.0.0", "sbom", sha)).toBe(
      // ac#1132 域名切换:独立字面量刻意不 import 生产常量(比较基准与被测对象同源 = 自指等价链)。
      `https://codepuppy.cn/catalog/assets/mcp.github/1.0.0/alpha-curation/sbom/${sha}.cdx.json`,
    )
    expect(() => curationBlobUrl("mcp:../evil", "1.0.0", "sbom", sha)).toThrow("invalid catalogId")
    expect(() => curationBlobUrl("mcp:github", "../v", "sbom", sha)).toThrow("invalid version")
  })
})
