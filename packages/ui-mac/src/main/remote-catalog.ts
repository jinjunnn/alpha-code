// remote-catalog — 定制中心 catalog 的远程分发客户端(REQ-032,收编 E10)。
//
// 端点 = alpha-web(C)静态发布:`https://alphacodeone.com/catalog/v1/catalog.json`(+ .sig)。
// 流程:ETag 条件请求(304 零成本)→ **ed25519 整体验签**(公钥内置,私钥在 C 侧发布机离线持有)
// → 形状 sanity → 落 userData 缓存。**回退链 = 远端 → last-known 缓存 → 内置**(B20:永不空白;
// 验签不过 = 拒用并 loud,绝不静默降级采信未签内容)。
//
// 资产通道(phase 1 仅 skill/agent 文本):条目 remoteAsset.files[] 逐文件下载 + **sha256 钉死**,
// 不匹配拒装(loud);plugin(可执行 JS)不进本通道(REQ-032 非目标,仍走 vendored/npm)。

import { createPublicKey, createHash, verify as edVerify } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

export const CATALOG_URL = "https://alphacodeone.com/catalog/v1/catalog.json"
const SIG_URL = `${CATALOG_URL}.sig`
/** C 侧签名公钥(spki der base64;换钥 = 发版,见 alpha-web docs/catalog-publish.md)。 */
const CATALOG_PUBKEY_B64 = "MCowBQYDK2VwAyEAqBBmG0mbZ3tZF7Vt8VEWhgm1RQdF2boFU5uUTSmsgHI="

const FETCH_TIMEOUT_MS = 8000
const MAX_CATALOG_BYTES = 2 * 1024 * 1024 // 2MB 上限(现 ~60KB;防呆)
const MAX_ASSET_BYTES = 5 * 1024 * 1024 // 单资产文件 5MB 上限(文本技能;防呆)

export type RemoteAssetFile = { path: string; sha256: string; bytes: number; url: string }
export type RemoteCatalogResult =
  | { source: "remote" | "cache"; catalog: unknown; version: string; fetchedAt: string; error?: string }
  | { source: "none"; error: string }

const cachePath = (userDataPath: string) => path.join(userDataPath, "remote-catalog.json")

export function verifySignature(body: Buffer, sigB64: string): boolean {
  try {
    const pub = createPublicKey({ key: Buffer.from(CATALOG_PUBKEY_B64, "base64"), format: "der", type: "spki" })
    return edVerify(null, body, pub, Buffer.from(sigB64.trim(), "base64"))
  } catch {
    return false
  }
}

function saneCatalog(parsed: unknown): parsed is { version: string; entries: unknown[] } {
  const c = parsed as { version?: unknown; entries?: unknown }
  return !!c && typeof c.version === "string" && Array.isArray(c.entries) && c.entries.length > 0
}

export function readCachedCatalog(userDataPath: string): { etag?: string; version: string; fetchedAt: string; catalog: unknown } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(userDataPath), "utf8"))
    if (raw && typeof raw.version === "string" && raw.catalog && saneCatalog(raw.catalog)) return raw
  } catch {
    /* no cache */
  }
  return null
}

async function fetchWithTimeout(url: string, headers: Record<string, string> = {}): Promise<Response> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, { headers, signal: ctl.signal, redirect: "follow" })
  } finally {
    clearTimeout(timer)
  }
}

/** 拉取远程 catalog(ETag 条件请求 + 验签 + 缓存);失败按回退链返回。 */
export async function refreshRemoteCatalog(userDataPath: string): Promise<RemoteCatalogResult> {
  const cached = readCachedCatalog(userDataPath)
  const fallback = (error: string): RemoteCatalogResult =>
    cached ? { source: "cache", catalog: cached.catalog, version: cached.version, fetchedAt: cached.fetchedAt, error } : { source: "none", error }

  let resp: Response
  try {
    resp = await fetchWithTimeout(CATALOG_URL, cached?.etag ? { "if-none-match": cached.etag } : {})
  } catch (e) {
    return fallback(`fetch failed: ${e instanceof Error ? e.message : e}`)
  }
  if (resp.status === 304 && cached) return { source: "remote", catalog: cached.catalog, version: cached.version, fetchedAt: cached.fetchedAt }
  if (!resp.ok) return fallback(`catalog HTTP ${resp.status}`)

  let body: Buffer
  try {
    const ab = await resp.arrayBuffer()
    if (ab.byteLength > MAX_CATALOG_BYTES) return fallback(`catalog too large: ${ab.byteLength}B`)
    body = Buffer.from(ab)
  } catch (e) {
    return fallback(`catalog read failed: ${e instanceof Error ? e.message : e}`)
  }

  let sig: string
  try {
    const sigResp = await fetchWithTimeout(SIG_URL)
    if (!sigResp.ok) return fallback(`signature HTTP ${sigResp.status}`)
    sig = await sigResp.text()
  } catch (e) {
    return fallback(`signature fetch failed: ${e instanceof Error ? e.message : e}`)
  }
  if (!verifySignature(body, sig)) return fallback("SIGNATURE INVALID — remote catalog rejected (possible tampering)")

  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString("utf8"))
  } catch {
    return fallback("catalog is not valid JSON")
  }
  if (!saneCatalog(parsed)) return fallback("catalog shape invalid")

  const record = {
    etag: resp.headers.get("etag") ?? undefined,
    version: (parsed as { version: string }).version,
    fetchedAt: new Date().toISOString(),
    catalog: parsed,
  }
  try {
    fs.mkdirSync(userDataPath, { recursive: true })
    fs.writeFileSync(cachePath(userDataPath), JSON.stringify(record))
  } catch {
    /* 缓存写失败不阻断本次使用 */
  }
  return { source: "remote", catalog: parsed, version: record.version, fetchedAt: record.fetchedAt }
}

/** 下载远程资产清单(逐文件 https + 体积帽 + sha256 钉死;任一不符全单拒绝,不落半成品)。 */
export async function downloadRemoteAsset(files: RemoteAssetFile[]): Promise<
  { ok: true; contents: Array<{ path: string; data: Buffer }> } | { ok: false; reason: string }
> {
  if (!Array.isArray(files) || files.length === 0) return { ok: false, reason: "empty asset manifest" }
  const contents: Array<{ path: string; data: Buffer }> = []
  for (const f of files) {
    if (typeof f?.url !== "string" || !f.url.startsWith("https://")) return { ok: false, reason: `non-https asset url: ${f?.url}` }
    if (typeof f.path !== "string" || f.path.includes("..") || path.isAbsolute(f.path)) return { ok: false, reason: `unsafe asset path: ${f.path}` }
    let resp: Response
    try {
      resp = await fetchWithTimeout(f.url)
    } catch (e) {
      return { ok: false, reason: `download failed: ${f.path}: ${e instanceof Error ? e.message : e}` }
    }
    if (!resp.ok) return { ok: false, reason: `download HTTP ${resp.status}: ${f.path}` }
    const ab = await resp.arrayBuffer()
    if (ab.byteLength > MAX_ASSET_BYTES) return { ok: false, reason: `asset too large: ${f.path} (${ab.byteLength}B)` }
    const data = Buffer.from(ab)
    const digest = createHash("sha256").update(data).digest("hex")
    if (digest !== f.sha256) return { ok: false, reason: `sha256 MISMATCH: ${f.path} (expected ${f.sha256.slice(0, 12)}…, got ${digest.slice(0, 12)}…) — refusing to install` }
    contents.push({ path: f.path, data })
  }
  return { ok: true, contents }
}
