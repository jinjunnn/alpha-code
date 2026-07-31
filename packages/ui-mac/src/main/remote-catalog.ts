// remote-catalog — 定制中心 catalog 的远程分发客户端(REQ-032,收编 E10;REQ-101 A 侧接线)。
//
// 端点 = alpha-web(C)静态发布:`https://alphacodeone.com/catalog/v1/catalog.json`(+ .sig)。
// 流程:ETag 条件请求(304 零成本)→ **ed25519 整体验签**(公钥内置,私钥在 C 侧发布机离线持有)
// → 形状 sanity → 落 userData 缓存。**回退链 = 远端 → last-known 缓存 → 内置**(B20:永不空白;
// 验签不过 = 拒用并 loud,绝不静默降级采信未签内容)。
//
// REQ-101 A(issue #193)增量:**channel-first** —— 先走 signed channel metadata(stable 指针,
// 见 catalog-channels.ts,合同 CONTRACT.md §5)取已验 payload。
// #314 fail-closed(裁决语义,取代"失败即回退 v1"):
//   - security 类失败(R1-R13/撤销/过期/无 trust/snapshot 缺失)→ **绝不碰 v1**,LKG 或如实 none;
//   - availability 类失败 → v1 仅可作**已验证 stable 身份的字节级镜像**(version+digest 与
//     channel LKG 精确相等,否则弃用);无已验证身份(fresh install/清态)→ 禁 v1;
//   - R11 撤销集不可验(无可验 trust)→ v1 整面拒用;v1 一切版本判断取自已签 body。
//
// 资产通道(phase 1 仅 skill/agent 文本):条目 remoteAsset.files[] 逐文件下载 + **sha256 钉死**,
// 不匹配拒装(loud);plugin(可执行 JS)不进本通道(REQ-032 非目标,仍走 vendored/npm)。

import { createPublicKey, createHash, verify as edVerify } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import {
  BUILTIN_CATALOG_PUBKEY_B64,
  catalogVersionLess,
  readRevokedTargets,
  refreshChannelCatalog,
  sha256Hex,
  type ChannelClientDeps,
  type ChannelName,
  type FailureClass,
} from "./catalog-channels"
import {
  evaluateCatalogPackagesForHost,
  validateCatalogPackageShape,
  type PackageEvaluator,
  type PackageInstallabilityDeps,
} from "./package-installability"
import type { CatalogPackageViewV1 } from "../shared/catalog-package-view"

export { catalogVersionLess } // 既有导出面保持(版本比较实现移居 catalog-channels,逐字未变)

export const CATALOG_URL = "https://alphacodeone.com/catalog/v1/catalog.json"
const SIG_URL = `${CATALOG_URL}.sig`
/** C 侧签名公钥(spki der base64;换钥 = 发版,见 alpha-web docs/runbooks/catalog-publish.md)。 */
const CATALOG_PUBKEY_B64 = BUILTIN_CATALOG_PUBKEY_B64

const FETCH_TIMEOUT_MS = 8000
const MAX_CATALOG_BYTES = 2 * 1024 * 1024 // 2MB 上限(现 ~60KB;防呆)
const MAX_ASSET_BYTES = 5 * 1024 * 1024 // 单资产文件 5MB 上限(文本技能;防呆)

export type RemoteAssetFile = { path: string; sha256: string; bytes: number; url: string }
export type RemoteCatalogResult =
  | {
      source: "remote" | "cache"
      catalog: unknown
      version: string
      fetchedAt: string
      error?: string
      /** 传输面:channel 指针链或 legacy v1(freshness/来源维度)。成功分支恒有(review #364)。 */
      via: `channel-${ChannelName}` | "v1"
      /** 内容通道(REQ-098 #302 结构化字段,不要解析 via 字符串):v1 面恒为 stable。成功分支恒有。 */
      channel: ChannelName
      /** #314:非 remote 结果的失败类(security 失败绝不借道 v1;消费方据此决定激活面,#315)。 */
      reasonClass?: FailureClass
      /** main-only compatibility projection; raw package envelopes remain inside catalog. */
      packageViews?: CatalogPackageViewV1[]
      /** 已验 coherent-set snapshot 文档的精确 SHA-256；只供 main package admission。 */
      snapshotDigest?: string
    }
  | { source: "none"; error: string; reasonClass: FailureClass }

export type RemoteCatalogDeps = ChannelClientDeps & {
  packageEvaluator?: PackageEvaluator
  packageInstallability?: PackageInstallabilityDeps
}

export const PACKAGE_DETAIL_IPC_CHANNEL = "ext-package-detail"

export function registerPackageCatalogReadIpcHandlers(
  register: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => void,
  refresh: () => Promise<RemoteCatalogResult>,
) {
  register("ext-remote-catalog", () => refresh().then(projectRemoteCatalogForRenderer))
  register(PACKAGE_DETAIL_IPC_CHANNEL, (_event, catalogId) =>
    typeof catalogId !== "string"
      ? Promise.resolve(null)
      : refresh().then((result) =>
          result.source === "none"
            ? null
            : (result.packageViews?.find((view) => view.catalogId === catalogId) ?? null),
        ),
  )
}

export function projectRemoteCatalogForRenderer(
  result: RemoteCatalogResult,
):
  | {
      source: "remote" | "cache"
      catalog: { version: string; entries: unknown[]; packages?: CatalogPackageViewV1[] }
      version: string
      fetchedAt: string
      error?: string
      via: string
      channel: ChannelName
    }
  | { source: "none"; error: string } {
  if (result.source === "none") return { source: "none", error: result.error }
  const catalog = result.catalog as { version: string; entries: unknown[] }
  return {
    source: result.source,
    catalog: {
      version: catalog.version,
      entries: catalog.entries,
      ...(result.packageViews ? { packages: result.packageViews } : {}),
    },
    version: result.version,
    fetchedAt: result.fetchedAt,
    ...(result.error ? { error: result.error } : {}),
    via: result.via,
    channel: result.channel,
  }
}

export async function evaluateRemoteCatalogPackages(
  result: RemoteCatalogResult,
  deps: Pick<RemoteCatalogDeps, "packageEvaluator" | "packageInstallability"> = {},
): Promise<RemoteCatalogResult> {
  if (result.source === "none") return result
  const evaluated = await evaluateCatalogPackagesForHost(
    result.catalog,
    deps.packageInstallability,
    deps.packageEvaluator,
  )
  if (!evaluated.ok)
    return {
      source: "none",
      error: `package consumption rejected verified catalog: ${evaluated.error}`,
      reasonClass: "security",
    }
  if (evaluated.views.length === 0) return result
  return { ...result, packageViews: evaluated.views }
}

const cachePath = (userDataPath: string) => path.join(userDataPath, "remote-catalog.json")

export function verifySignature(body: Buffer, sigB64: string, pubKeyB64: string = CATALOG_PUBKEY_B64): boolean {
  try {
    const pub = createPublicKey({ key: Buffer.from(pubKeyB64, "base64"), format: "der", type: "spki" })
    return edVerify(null, body, pub, Buffer.from(sigB64.trim(), "base64"))
  } catch {
    return false
  }
}

function saneCatalog(parsed: unknown): parsed is { version: string; entries: unknown[] } {
  const c = parsed as { version?: unknown; entries?: unknown }
  return !!c && typeof c.version === "string" && Array.isArray(c.entries) && c.entries.length > 0
}

// codex M1:缓存**读取时重验签**(缓存文件可被本地篡改;只信 body+sig 过 ed25519 的内容)。
// REQ-101 R11:body digest 命中撤销列表的缓存同样拒用(revocation 对已缓存内容生效)。
// #314 review M3:单次读取 —— body/digest/version/catalog 全部派生自**同一份已验字节**
// (version 取自签名 body,缓存元数据 raw.version 不进任何判断;消除两次读盘的 TOCTOU 解绑)。
export function readCachedCatalog(
  userDataPath: string,
  opts: { pubKeyB64?: string; revoked?: Map<string, string> } = {},
): { etag?: string; version: string; fetchedAt: string; catalog: unknown; body: Buffer; digest: string } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(userDataPath), "utf8"))
    if (!raw || typeof raw.body !== "string" || typeof raw.sig !== "string") return null
    const body = Buffer.from(raw.body, "utf8")
    if (!verifySignature(body, raw.sig, opts.pubKeyB64)) {
      console.error("[remote-catalog] cached catalog FAILED signature re-verification — discarding (possible local tampering)")
      return null
    }
    const digest = sha256Hex(body)
    const revokedReason = opts.revoked?.get(digest)
    if (revokedReason !== undefined) {
      console.error(`[remote-catalog] cached catalog digest is REVOKED (${revokedReason}) — discarding (R11)`)
      return null
    }
    const catalog = JSON.parse(body.toString("utf8"))
    if (saneCatalog(catalog))
      return { etag: raw.etag, version: catalog.version, fetchedAt: raw.fetchedAt, catalog, body, digest }
  } catch {
    /* no cache */
  }
  return null
}

async function fetchWithTimeout(url: string, headers: Record<string, string> = {}, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
  try {
    const resp = await fetchImpl(url, { headers, signal: ctl.signal, redirect: "follow" })
    // codex M3:redirect follow 后校验**最终** URL 仍是 https(防降级到 http/任意 scheme)
    if (resp.url && !resp.url.startsWith("https://")) throw new Error(`redirected to non-https: ${resp.url}`)
    return resp
  } finally {
    clearTimeout(timer)
  }
}

// singleflight(REQ-098 #302,Codex 裁决 E):启动预热 / IPC / planner 可能并发触发同一拉取 ——
// 按 (userDataPath, channel) 合并在途请求,防重复网络往返与旧 sequence 晚写。settle 即清。
const inflightRefresh = new Map<string, Promise<RemoteCatalogResult>>()

/**
 * 拉取远程 catalog(REQ-098 #302:channel 由冻结环境快照经 composition root 显式注入,**必填无
 * 缺省** —— 缺省值会让新调用方静默重现「恒请求 stable」缺陷):
 * - stable:channel-first(REQ-101)→ 失败 loud → 现行 v1 兼容面(v1 = stable-only 遗产,
 *   原回退链 远端 → last-known 缓存,R11 撤销同样生效)→ channel LKG。
 * - preview/dev:channel remote → 同通道 LKG → none,**绝不访问 v1**(越级降 stable 内容 =
 *   通道语义混淆,会进一步污染安装与 receipt;要复用内容应由发布侧签发指向同 payload 的
 *   channel doc)。deps 仅测试注入,缺省 = 生产。
 */
export async function refreshRemoteCatalog(
  userDataPath: string,
  channel: ChannelName,
  deps: RemoteCatalogDeps = {},
): Promise<RemoteCatalogResult> {
  const key = JSON.stringify([userDataPath, channel])
  const existing = inflightRefresh.get(key)
  if (existing) return existing
  const p = refreshRemoteCatalogUncoalesced(userDataPath, channel, deps)
    .then((result) => evaluateRemoteCatalogPackages(result, deps))
    .finally(() => inflightRefresh.delete(key))
  inflightRefresh.set(key, p)
  return p
}

async function refreshRemoteCatalogUncoalesced(
  userDataPath: string,
  channel: ChannelName,
  deps: RemoteCatalogDeps,
): Promise<RemoteCatalogResult> {
  const via = `channel-${channel}` as const
  const ch = await refreshChannelCatalog(userDataPath, channel, deps, (catalog) => {
    const validation = validateCatalogPackageShape(catalog)
    return validation.ok ? { ok: true } : validation
  })
  if (ch.source === "remote")
    return { source: "remote", catalog: ch.catalog, version: ch.version, fetchedAt: ch.fetchedAt, via, channel, ...(ch.snapshotDigest ? { snapshotDigest: ch.snapshotDigest } : {}), ...(ch.error ? { error: ch.error } : {}) }

  const cls: FailureClass = ch.reasonClass ?? "security" // 未分类按最严处理
  const serveLkg = (): RemoteCatalogResult =>
    ch.source === "cache"
      ? { source: "cache", catalog: ch.catalog, version: ch.version, fetchedAt: ch.fetchedAt, via, channel, ...(ch.snapshotDigest ? { snapshotDigest: ch.snapshotDigest } : {}), error: ch.error, reasonClass: cls }
      : { source: "none", error: ch.error ?? `channel ${channel} unavailable`, reasonClass: cls }

  if (channel !== "stable") {
    // fail-closed:非 stable 通道没有 v1 等价物 —— 同通道 LKG(已全量重验 + R11)或如实 none。
    console.error(`[remote-catalog] ${channel} channel unavailable (${ch.error ?? "?"}) [${cls}] — no v1 fallback for non-stable channels (fail closed)`)
    return serveLkg()
  }

  // #314 fail-closed before legacy v1(裁决):
  //   security 失败(R1-R13/撤销/过期/无 trust/snapshot 缺失)→ **绝不碰 v1**,LKG 或如实 none;
  //   availability 失败 → v1 仅可作为**已验证 stable 身份的字节级镜像**(version+digest 精确相等,
  //   身份来自本轮 LKG);无已验证身份(fresh install / 状态被清)→ 禁 v1,如实 none。
  if (cls === "security") {
    console.error(`[remote-catalog] stable channel SECURITY failure (${ch.error ?? "?"}) — legacy v1 fallback FORBIDDEN (fail closed)`)
    return serveLkg()
  }
  if (ch.source !== "cache") {
    console.error(`[remote-catalog] stable channel unavailable with NO verified identity (${ch.error ?? "?"}) — legacy v1 forbidden without a verified stable identity`)
    return serveLkg()
  }
  // availability + 已验证身份:v1 允许作可用性镜像(内容身份必须与 LKG 精确相等,否则弃用)。
  console.error(`[remote-catalog] stable channel unavailable (${ch.error ?? "?"}) [availability] — trying legacy v1 as identity-pinned mirror`)
  const legacy = await refreshRemoteCatalogV1(userDataPath, deps, {
    version: ch.version,
    sha256: ch.sha256,
    snapshotDigest: ch.snapshotDigest,
  })
  if (legacy.source !== "none") return legacy // v1 面已带 via=v1 + channel=stable(身份已钉死)
  return serveLkg()
}

/**
 * 现行 v1 兼容面 —— #314 起收紧为**身份钉死的可用性镜像**:调用方必须传入已验证的 stable
 * 身份(version + payload sha256,来自 channel LKG),v1 内容(远端或缓存)与之不精确相等
 * 一律拒用;R11 撤销集不可验(无可验 trust)时整面拒用。版本一律从**已签 body** 解析
 * (缓存元数据 raw.version 不进入任何安全判断)。
 */
async function refreshRemoteCatalogV1(
  userDataPath: string,
  deps: RemoteCatalogDeps,
  identity: { version: string; sha256: string; snapshotDigest?: string },
): Promise<RemoteCatalogResult> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const pubKeyB64 = deps.builtinKeyB64 ?? CATALOG_PUBKEY_B64
  // R11 撤销视图来自缓存 trust(内置钥重验;离线生效)。#314:无可验 trust → 撤销状态未知,拒用 v1。
  const revoked = readRevokedTargets(userDataPath, deps)
  if (revoked === null) return { source: "none", error: "v1 refused: revocation state unverifiable (no verifiable trust)", reasonClass: "security" }
  const matchesIdentity = (body: Buffer): { ok: true; version: string } | { ok: false; error: string } => {
    const digest = sha256Hex(body)
    if (digest !== identity.sha256)
      return { ok: false, error: `v1 identity MISMATCH: payload sha256 ${digest.slice(0, 12)}… != verified stable ${identity.sha256.slice(0, 12)}…` }
    let version = ""
    try {
      version = String((JSON.parse(body.toString("utf8")) as { version?: unknown }).version ?? "")
    } catch {
      return { ok: false, error: "v1 payload is not valid JSON" }
    }
    if (version !== identity.version)
      return { ok: false, error: `v1 identity MISMATCH: version ${version} != verified stable ${identity.version}` }
    return { ok: true, version }
  }
  const cached = readCachedCatalog(userDataPath, { pubKeyB64, revoked })
  type V1Partial = { source: "remote" | "cache"; catalog: unknown; version: string; fetchedAt: string; error?: string } | { source: "none"; error: string }
  // v1 面 = stable-only 遗产:传输 via=v1,内容通道恒 stable(成功分支必带,review #364 类型收紧)。
  const withVia = (r: V1Partial): RemoteCatalogResult =>
    r.source === "none"
      ? { ...r, reasonClass: "availability" }
      : { ...r, via: "v1", channel: "stable", ...(identity.snapshotDigest ? { snapshotDigest: identity.snapshotDigest } : {}) }
  const fallback = (error: string): RemoteCatalogResult => {
    if (!cached) return withVia({ source: "none", error })
    // 身份校验针对 readCachedCatalog 返回的**同一份已验 body**(单次读取,无 TOCTOU)。
    const idv = matchesIdentity(cached.body)
    if (!idv.ok) return withVia({ source: "none", error: `${error}; ${idv.error}` })
    return { source: "cache", catalog: cached.catalog, version: idv.version, fetchedAt: cached.fetchedAt, error, via: "v1", channel: "stable", ...(identity.snapshotDigest ? { snapshotDigest: identity.snapshotDigest } : {}), reasonClass: "availability" }
  }

  let resp: Response
  try {
    resp = await fetchWithTimeout(CATALOG_URL, cached?.etag ? { "if-none-match": cached.etag } : {}, fetchImpl)
  } catch (e) {
    return fallback(`fetch failed: ${e instanceof Error ? e.message : e}`)
  }
  if (resp.status === 304 && cached) {
    const idv = matchesIdentity(cached.body) // 同一份已验 body(单次读取)
    if (!idv.ok) return withVia({ source: "none", error: idv.error })
    return withVia({ source: "remote", catalog: cached.catalog, version: idv.version, fetchedAt: cached.fetchedAt })
  }
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
    const sigResp = await fetchWithTimeout(SIG_URL, {}, fetchImpl)
    if (!sigResp.ok) return fallback(`signature HTTP ${sigResp.status}`)
    sig = await sigResp.text()
  } catch (e) {
    return fallback(`signature fetch failed: ${e instanceof Error ? e.message : e}`)
  }
  if (!verifySignature(body, sig, pubKeyB64)) return fallback("SIGNATURE INVALID — remote catalog rejected (possible tampering)")

  // REQ-101 R11:v1 兼容面与 releases payload 逐字节一致(合同 §7),digest 命中撤销列表 → 拒用。
  const digest = sha256Hex(body)
  const revokedReason = revoked.get(digest)
  if (revokedReason !== undefined) return fallback(`R11 REVOKED target digest ${digest.slice(0, 12)}… (${revokedReason}) — remote catalog rejected`)

  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString("utf8"))
  } catch {
    return fallback("catalog is not valid JSON")
  }
  if (!saneCatalog(parsed)) return fallback("catalog shape invalid")

  // #314:身份钉死(取代此前的版本回滚比较 —— 精确相等是更强的约束):v1 只可作已验证
  // stable 身份的字节级镜像;版本取自已签 body(matchesIdentity 内解析,不信缓存元数据)。
  const idv = matchesIdentity(body)
  if (!idv.ok) return fallback(idv.error)
  const version = idv.version

  const record = {
    etag: resp.headers.get("etag") ?? undefined,
    version,
    fetchedAt: new Date().toISOString(),
    body: body.toString("utf8"),
    sig: sig.trim(),
  }
  try {
    fs.mkdirSync(userDataPath, { recursive: true })
    fs.writeFileSync(cachePath(userDataPath), JSON.stringify(record))
  } catch {
    /* 缓存写失败不阻断本次使用 */
  }
  return withVia({ source: "remote", catalog: parsed, version, fetchedAt: record.fetchedAt })
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
