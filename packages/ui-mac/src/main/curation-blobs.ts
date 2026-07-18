// curation-blobs — REQ-104 #397:SBOM / intake provenance blob 的按需拉取与**采信前置**(合同 §7.3)。
//
// 只读通道(详情/评审面打开才拉取;拉取失败不影响货架与启用判定 —— 摘要已内联随 payload 签名):
//   1. 身份链:renderer 只给 (catalogId, kind) —— entry 由 main 从已验 effective catalog 解析,
//      BlobRef 取自 decodeEntryCuration **采信后**的 curation,URL 由 main 从
//      (idDot, version, kind, sha256) 重推导(路径圈禁天然成立;renderer 无 URL/digest 输入权)。
//   2. 传输:HTTPS 固定生产 base;**拒绝重定向**(redirect:"error");8s 超时;流式读取硬帽
//      (期望字节 +1 即断,绝不整包吸入超限响应)。
//   3. 采信前置(全过才 parse,Codex 裁决必改③,一条不省):bytes 精确匹配 → sha256 精确匹配 →
//      canonical 字节复验(严格 UTF-8 / 递归键字节序 / 2 空格缩进 / LF / NFC / 尾随换行,
//      assertCanonicalBlobBytes)→ 剖面校验(SBOM = §4 assertSbomProfile;provenance = §5
//      全量严格结构 + entry 绑定 + per-kind canonical 语法)。
//   4. 缓存:main 内存 Map<sha256, parsed>(content-addressed 不可变;进程生命周期即失效,
//      不建盘面缓存/淘汰机制)。失败不缓存,重试 = 重新拉取。

import { createHash } from "node:crypto"
import {
  assertCanonicalBlobBytes,
  checkProvenanceContract,
  checkSbomContract,
  curationBlobUrl,
  decodeEntryCuration,
  type CurationBlobKind,
} from "../shared/catalog-curation"
import type { VerifiedCatalogEntry } from "./ext-install-planner"

/** renderer 线缆上的 blob 种类(provenance = 合同 refs.intakeProvenance)。 */
export type CurationBlobWireKind = "sbom" | "provenance"

export type CurationBlobResult =
  | { ok: true; kind: CurationBlobWireKind; sha256: string; data: unknown }
  | { ok: false; reason: string }

export type CurationBlobDeps = {
  resolveEntry(catalogId: string): Promise<VerifiedCatalogEntry | null>
  /** 测试注入;缺省 = 生产 fetch。 */
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

const FETCH_TIMEOUT_MS = 8000
const sha256Hex = (buf: Uint8Array): string => createHash("sha256").update(buf).digest("hex")

/** 成功采信的 blob 内存缓存。Codex r1-6:缓存键必须携带**完整采信上下文**
 *  `kind:catalogId:version:sha256` —— 仅按 sha256 命中会让同 digest 跨 kind(SBOM↔provenance)
 *  或跨 entry 复用绕过剖面校验与 entry/version 绑定(缓存投毒面)。命中仍要求 ref.bytes 与
 *  已验长度一致(声明自相矛盾不走缓存,重拉后按 §7.3 精确匹配如实拒)。 */
const memCache = new Map<string, { bytes: number; data: unknown }>()

const cacheKeyOf = (kind: CurationBlobWireKind, catalogId: string, version: string, sha256: string): string =>
  `${kind}:${catalogId}:${version}:${sha256}`

const WIRE_TO_REF: Record<CurationBlobWireKind, CurationBlobKind> = { sbom: "sbom", provenance: "intakeProvenance" }

export async function fetchCurationBlob(deps: CurationBlobDeps, rawCatalogId: unknown, rawKind: unknown): Promise<CurationBlobResult> {
  if (typeof rawCatalogId !== "string" || rawCatalogId.length === 0) return { ok: false, reason: "curation blob: catalogId must be a non-empty string" }
  if (rawKind !== "sbom" && rawKind !== "provenance") return { ok: false, reason: `curation blob: kind ${JSON.stringify(rawKind)} not "sbom" | "provenance"` }
  const kind: CurationBlobWireKind = rawKind

  const verified = await deps.resolveEntry(rawCatalogId)
  if (!verified) return { ok: false, reason: `curation blob: entry not resolvable from the verified catalog: ${rawCatalogId}` }
  const status = decodeEntryCuration(verified.entry)
  if (status.kind === "uncurated") return { ok: false, reason: `curation blob: entry ${rawCatalogId} has no curation` }
  if (status.kind === "invalid") return { ok: false, reason: `curation blob: entry ${rawCatalogId} curation failed validation (fail closed): ${status.reason}` }

  const refKind = WIRE_TO_REF[kind]
  const ref = status.curation.refs[refKind]
  const cacheKey = cacheKeyOf(kind, verified.entry.id, verified.entry.version!, ref.sha256)
  const cached = memCache.get(cacheKey)
  if (cached !== undefined && cached.bytes === ref.bytes) return { ok: true, kind, sha256: ref.sha256, data: cached.data }

  // URL 由 main 重推导(decode 不变量保证与 ref.url 逐字相等;不采用任何外部给定 URL)。
  const url = curationBlobUrl(verified.entry.id, verified.entry.version!, refKind, ref.sha256)

  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), deps.timeoutMs ?? FETCH_TIMEOUT_MS)
  let buf: Uint8Array
  try {
    const fetchImpl = deps.fetchImpl ?? fetch
    // redirect:"error":任何重定向 = 网络错误(合同 §7.3 路径圈禁 —— 最终字节必须来自推导 URL 本身)。
    const resp = await fetchImpl(url, { redirect: "error", signal: ctl.signal })
    if (!resp.ok) return { ok: false, reason: `curation blob: HTTP ${resp.status} for ${url}` }
    const read = await readBodyCapped(resp, ref.bytes)
    if (!read.ok) return read
    buf = read.bytes
  } catch (error) {
    return { ok: false, reason: `curation blob: fetch failed for ${url}: ${error instanceof Error ? error.message : String(error)}` }
  } finally {
    clearTimeout(timer)
  }

  if (buf.length !== ref.bytes)
    return { ok: false, reason: `curation blob: size mismatch — expected exactly ${ref.bytes} bytes, got ${buf.length}` }
  const digest = sha256Hex(buf)
  if (digest !== ref.sha256)
    return { ok: false, reason: `curation blob: sha256 mismatch — expected ${ref.sha256}, got ${digest}` }

  let parsed: unknown
  try {
    parsed = assertCanonicalBlobBytes(buf, `curation ${kind} blob`)
  } catch (error) {
    return { ok: false, reason: `curation blob: ${error instanceof Error ? error.message : String(error)}` }
  }

  const profileError =
    kind === "sbom"
      ? checkSbomContract(parsed)
      : checkProvenanceContract(parsed, { catalogId: verified.entry.id, version: verified.entry.version! })
  if (profileError) return { ok: false, reason: `curation ${kind} blob failed contract validation (fail closed): ${profileError}` }

  memCache.set(cacheKey, { bytes: ref.bytes, data: parsed })
  return { ok: true, kind, sha256: ref.sha256, data: parsed }
}

/** 流式读取,硬帽 = 期望字节 +1(超出立即断;绝不整包吸入超限响应)。 */
async function readBodyCapped(resp: Response, expectedBytes: number): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: string }> {
  const cap = expectedBytes + 1
  const body = resp.body
  if (!body) {
    const all = new Uint8Array(await resp.arrayBuffer())
    return all.length > expectedBytes
      ? { ok: false, reason: `curation blob: response exceeds the expected ${expectedBytes} bytes — refusing` }
      : { ok: true, bytes: all }
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        total += value.length
        if (total > cap) {
          await reader.cancel().catch(() => {})
          return { ok: false, reason: `curation blob: response exceeds the expected ${expectedBytes} bytes — refusing` }
        }
        chunks.push(value)
      }
    }
  } finally {
    reader.releaseLock()
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return { ok: true, bytes: out }
}
