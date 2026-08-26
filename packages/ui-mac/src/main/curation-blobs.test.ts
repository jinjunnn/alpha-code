// REQ-104 #397 —— curation blob 通道:合同 §7.3 采信前置逐条负例 + 正向 + 内存缓存。
// fetch 注入(零网络);bytes/sha/canonical/剖面/绑定任一不符 = 失败态,绝不部分采信。
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { canonicalJsonBytes, curationBlobUrl } from "../shared/catalog-curation"
import { fetchCurationBlob, type CurationBlobDeps } from "./curation-blobs"
import type { CatalogEntry } from "../renderer/extensions/catalog-types"
import type { VerifiedCatalogEntry } from "./ext-install-planner"

const sha256Hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex")

const SBOM_OK = { bomFormat: "CycloneDX", specVersion: "1.6", components: [] }
const PROV_OK = {
  schema: "alpha.intake-provenance.v1",
  catalogId: "mcp:blobber",
  version: "1.0.0",
  source: { kind: "npm", locator: "npm:blobber", requestedRef: "1.0.0", resolved: `sha512:${"A".repeat(86)}==` },
  manifest: { sha256: "c".repeat(64), bytes: 4096 },
  lockDigests: [],
  artifactDigests: [],
}

/** entry + 与实际 blob 字节一致的 curation refs(sha/bytes 可按用例覆盖制造失配)。 */
function makeEntry(
  sbomBytes: Uint8Array,
  provBytes: Uint8Array,
  over: Partial<{ sbomSha: string; sbomLen: number; provSha: string; provLen: number }> = {},
): CatalogEntry {
  const id = "mcp:blobber"
  const version = "1.0.0"
  const sbomSha = over.sbomSha ?? sha256Hex(sbomBytes)
  const provSha = over.provSha ?? sha256Hex(provBytes)
  return {
    id,
    type: "mcp",
    name: "blobber",
    displayName: "b",
    description: "b",
    source: "official",
    category: "test",
    version,
    installSpec: { kind: "mcp", mcpType: "local", command: ["x"] },
    curation: {
      schema: "alpha.catalog.curation.v1",
      tier: "precache",
      activationPolicy: "default-disabled",
      deliveryMode: "installable",
      review: {
        reviewedAt: "2026-07-01T00:00:00Z",
        reviewedBy: "alpha-review",
        upstreamStatus: "active",
        supportTier: "best-effort",
        reviewBefore: "2027-07-01T00:00:00Z",
      },
      applicability: { frameworks: ["*"] },
      summaries: {
        capabilities: [],
        networkDomains: [],
        requiredSecrets: [],
        runtimeDependencies: [],
        download: { bytes: null, basis: "unknown" },
      },
      refs: {
        sbom: {
          sha256: sbomSha,
          bytes: over.sbomLen ?? sbomBytes.length,
          url: curationBlobUrl(id, version, "sbom", sbomSha),
          format: "cyclonedx-1.6+json",
        },
        intakeProvenance: {
          sha256: provSha,
          bytes: over.provLen ?? provBytes.length,
          url: curationBlobUrl(id, version, "intakeProvenance", provSha),
          format: "alpha.intake-provenance.v1+json",
        },
      },
    },
  }
}

type FetchCall = { url: string; init: RequestInit | undefined }

function makeDeps(entry: CatalogEntry | null, body: (url: string) => Uint8Array | { status: number } | Error) {
  const calls: FetchCall[] = []
  const deps: CurationBlobDeps = {
    resolveEntry: async () =>
      entry ? ({ entry, channel: "remote", catalogVersion: "2026-07-18.2" } satisfies VerifiedCatalogEntry) : null,
    fetchImpl: (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      const out = body(String(url))
      if (out instanceof Error) throw out
      if (out instanceof Uint8Array) return new Response(Buffer.from(out), { status: 200 })
      return new Response("nope", { status: out.status })
    }) as unknown as typeof fetch,
  }
  return { deps, calls }
}

describe("fetchCurationBlob(合同 §7.3 采信前置)", () => {
  test("正向 SBOM:全过采信 + 派生 URL + redirect:error;第二次命中内存缓存(零再拉取)", async () => {
    const bytes = canonicalJsonBytes(SBOM_OK)
    const entry = makeEntry(bytes, canonicalJsonBytes(PROV_OK))
    const { deps, calls } = makeDeps(entry, () => bytes)
    const r = await fetchCurationBlob(deps, "mcp:blobber", "sbom")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).toEqual(SBOM_OK)
    expect(calls).toHaveLength(1)
    // ac#1132 域名切换:独立字面量刻意不 import 生产常量(自指等价链纪律,同 catalog-curation.test.ts)。
    expect(calls[0]!.url).toBe(`https://codepuppy.cn/catalog/assets/mcp.blobber/1.0.0/alpha-curation/sbom/${sha256Hex(bytes)}.cdx.json`)
    expect((calls[0]!.init as { redirect?: string } | undefined)?.redirect).toBe("error")
    const again = await fetchCurationBlob(deps, "mcp:blobber", "sbom")
    expect(again.ok).toBe(true)
    expect(calls).toHaveLength(1) // content-addressed 缓存命中
  })

  test("正向 provenance:剖面 + entry 绑定全过", async () => {
    const prov = canonicalJsonBytes(PROV_OK)
    const entry = makeEntry(canonicalJsonBytes(SBOM_OK), prov)
    const { deps } = makeDeps(entry, () => prov)
    const r = await fetchCurationBlob(deps, "mcp:blobber", "provenance")
    expect(r.ok).toBe(true)
  })

  test("provenance entry 绑定失配(catalogId 不符)⇒ 拒", async () => {
    const rogue = canonicalJsonBytes({ ...PROV_OK, catalogId: "mcp:other" })
    const entry = makeEntry(canonicalJsonBytes(SBOM_OK), rogue)
    const { deps } = makeDeps(entry, () => rogue)
    const r = await fetchCurationBlob(deps, "mcp:blobber", "provenance")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("does not match entry")
  })

  test("sha256 失配 ⇒ 拒(不 parse)", async () => {
    const bytes = canonicalJsonBytes(SBOM_OK)
    const entry = makeEntry(bytes, canonicalJsonBytes(PROV_OK), { sbomSha: "f".repeat(64) })
    const { deps } = makeDeps(entry, () => bytes)
    const r = await fetchCurationBlob(deps, "mcp:blobber", "sbom")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("sha256 mismatch")
  })

  test("响应超过期望字节 ⇒ 流式硬帽即断;响应偏短 ⇒ 精确字节失配拒", async () => {
    const bytes = canonicalJsonBytes(SBOM_OK)
    const short = makeEntry(bytes, canonicalJsonBytes(PROV_OK), { sbomLen: 10 }) // 声明 10B,响应 74B → 硬帽 11B 即断
    const { deps: d1 } = makeDeps(short, () => bytes)
    const r1 = await fetchCurationBlob(d1, "mcp:blobber", "sbom")
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.reason).toContain("exceeds the expected")

    const long = makeEntry(bytes, canonicalJsonBytes(PROV_OK), { sbomLen: bytes.length + 7 })
    const { deps: d2 } = makeDeps(long, () => bytes)
    const r2 = await fetchCurationBlob(d2, "mcp:blobber", "sbom")
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.reason).toContain("size mismatch")
  })

  test("非 canonical 字节(sha/bytes 全对)⇒ 拒(必改③:canonical 复验不省略)", async () => {
    const raw = new TextEncoder().encode('{"bomFormat":"CycloneDX","specVersion":"1.6","components":[]}')
    const entry = makeEntry(raw, canonicalJsonBytes(PROV_OK))
    const { deps } = makeDeps(entry, () => raw)
    const r = await fetchCurationBlob(deps, "mcp:blobber", "sbom")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("not canonical")
  })

  test("SBOM 剖面违例(未知顶层键)⇒ 拒", async () => {
    const bad = canonicalJsonBytes({ ...SBOM_OK, serialNumber: "urn:uuid:x" })
    const entry = makeEntry(bad, canonicalJsonBytes(PROV_OK))
    const { deps } = makeDeps(entry, () => bad)
    const r = await fetchCurationBlob(deps, "mcp:blobber", "sbom")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('forbidden or unknown top-level key "serialNumber"')
  })

  test("重定向/网络错(redirect:error 抛)⇒ 失败态;HTTP 非 200 ⇒ 失败态", async () => {
    // 独立内容(≠ 其它用例)—— 模块级 content-addressed 缓存不会替这条用例回答。
    const bytes = canonicalJsonBytes({ ...SBOM_OK, components: [{ name: "redirect-case", version: "1" }] })
    const entry = makeEntry(bytes, canonicalJsonBytes(PROV_OK))
    const { deps: d1 } = makeDeps(entry, () => new Error("unexpected redirect"))
    const r1 = await fetchCurationBlob(d1, "mcp:blobber", "sbom")
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.reason).toContain("fetch failed")
    const { deps: d2 } = makeDeps(entry, () => ({ status: 404 }))
    const r2 = await fetchCurationBlob(d2, "mcp:blobber", "sbom")
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.reason).toContain("HTTP 404")
  })

  test("未策展 / 条目不可解析 / kind 非法 ⇒ 结构化拒", async () => {
    const uncurated = { ...makeEntry(canonicalJsonBytes(SBOM_OK), canonicalJsonBytes(PROV_OK)) }
    delete (uncurated as { curation?: unknown }).curation
    const { deps: d1 } = makeDeps(uncurated, () => new Error("must not fetch"))
    expect((await fetchCurationBlob(d1, "mcp:blobber", "sbom")).ok).toBe(false)

    const { deps: d2 } = makeDeps(null, () => new Error("must not fetch"))
    const r2 = await fetchCurationBlob(d2, "mcp:ghost", "sbom")
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.reason).toContain("not resolvable")

    const entry = makeEntry(canonicalJsonBytes(SBOM_OK), canonicalJsonBytes(PROV_OK))
    const { deps: d3 } = makeDeps(entry, () => new Error("must not fetch"))
    const r3 = await fetchCurationBlob(d3, "mcp:blobber", "sbomz")
    expect(r3.ok).toBe(false)
    if (!r3.ok) expect(r3.reason).toContain('not "sbom" | "provenance"')
  })

  test("curation 校验失败(fail-closed)⇒ blob 面同样拒(绝不部分采信 refs)", async () => {
    const entry = makeEntry(canonicalJsonBytes(SBOM_OK), canonicalJsonBytes(PROV_OK))
    ;(entry.curation as Record<string, unknown>).rogue = true
    const { deps } = makeDeps(entry, () => new Error("must not fetch"))
    const r = await fetchCurationBlob(deps, "mcp:blobber", "sbom")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("failed validation")
  })
})

// ── #397 r1-6:缓存命中必须携带完整采信上下文(kind + entry/version 绑定)──────────────────────────
describe("r1-6:跨上下文缓存复用被拒(缓存投毒面封死)", () => {
  test("同 digest 跨 kind:先作为合法 SBOM 采信,再被声明为 provenance → 不走缓存,剖面校验如实拒", async () => {
    const sbomBytes = canonicalJsonBytes({ ...SBOM_OK, components: [{ name: "cross-kind", version: "1" }] })
    const sha = sha256Hex(sbomBytes)
    // 同一 entry:sbom 与 provenance 两个 ref 声明同一 digest/bytes(schema 不禁止)。
    const entry = makeEntry(sbomBytes, sbomBytes, { provSha: sha, provLen: sbomBytes.length })
    const { deps, calls } = makeDeps(entry, () => sbomBytes)
    const asSbom = await fetchCurationBlob(deps, "mcp:blobber", "sbom")
    expect(asSbom.ok).toBe(true)
    const asProv = await fetchCurationBlob(deps, "mcp:blobber", "provenance")
    expect(asProv.ok).toBe(false) // 缓存键含 kind → miss → 全量校验 → SBOM 内容过不了 provenance 剖面
    if (!asProv.ok) expect(asProv.reason).toContain("failed contract validation")
    expect(calls.length).toBe(2) // 第二次真实重拉,未借缓存绕过
  })

  test("同 digest 跨 entry:A 的合法 provenance 已缓存,B 引用同 digest → 不走缓存,entry 绑定如实拒", async () => {
    const provBytes = canonicalJsonBytes(PROV_OK) // 绑定 mcp:blobber
    const entryA = makeEntry(canonicalJsonBytes(SBOM_OK), provBytes)
    const { deps: depsA } = makeDeps(entryA, () => provBytes)
    expect((await fetchCurationBlob(depsA, "mcp:blobber", "provenance")).ok).toBe(true)

    // entry B(不同 id;blob URL 依 B 的身份重推导)引用同 digest/bytes。
    const entryB: CatalogEntry = {
      ...makeEntry(canonicalJsonBytes(SBOM_OK), provBytes),
      id: "mcp:blobber2",
      name: "blobber2",
    }
    const curB = entryB.curation as { refs: { intakeProvenance: { url: string; sha256: string }; sbom: { url: string; sha256: string } } }
    curB.refs.intakeProvenance.url = curationBlobUrl("mcp:blobber2", "1.0.0", "intakeProvenance", curB.refs.intakeProvenance.sha256)
    curB.refs.sbom.url = curationBlobUrl("mcp:blobber2", "1.0.0", "sbom", curB.refs.sbom.sha256)
    const { deps: depsB, calls: callsB } = makeDeps(entryB, () => provBytes)
    const r = await fetchCurationBlob(depsB, "mcp:blobber2", "provenance")
    expect(r.ok).toBe(false) // 缓存键含 catalogId/version → miss → 全量校验 → 绑定失配
    if (!r.ok) expect(r.reason).toContain("does not match entry")
    expect(callsB.length).toBe(1) // 真实重拉发生
  })
})
