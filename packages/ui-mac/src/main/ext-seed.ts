// REQ-102 A(issue #194)—— packaged extension seed 消费端(B→A 契约:alpha-web
// contracts/extension-seed/CONTRACT.md @ 2a4c4f7,schema alpha.extension-seed.lock.v1)。
//
// 信任面(合同 §2/§8):seed lock **无独立签名**。打包面完整性由 App 包签名承载 —— 打包前的
// §2 交叉复核(lock ↔ 已验签 stable target/remoteAsset 清单)由 scripts/sync-extension-seed.mjs
// 在快照生成期执行 + extension-seed-snapshot.test.ts 漂移守卫钉死;运行期导入面(blob 提升进
// 用户 CAS)由**逐文件 digest 重验**承载(本模块)。url 字段仅传输提示,digest 是唯一权威。
//
// 语义边界(parent AC1/AC3 + 合同 §6):
//   · readPackagedSeed = 纯读:只解码 lock + 列出可浏览资产(availability "bundled"),
//     **不安装、不启用、零配置写入、零进程、零网络**;可获得性与激活态正交;
//   · 安装仍走用户显式动作 → REQ-099 planner + REQ-100 事务 + 权限确认链;本模块只提供
//     promoteSeedAssetToCas(把所选资产的 blob 提升进用户 CAS,先全量校验后写入)与
//     seedAssetTxFiles(TxPlan 文件清单接缝)—— **不复制整个 seed**(逐资产按需);
//   · 拒绝矩阵同语义(合同 §4):S5 路径 allowlist、S6 symlink/realpath 逃逸、S7 许可
//     allowlist + redistributable、S9 平台、S10 预算按 lock 记录同值再执行、S11 digest 不符,
//     任一不过 → 拒绝(资产级两遍式:先全量验证零写入,后提升);
//   · lock 严格解码:未知顶层键/未知资产键/未知 schema 一律 loud 拒绝(§7 防降级混淆,
//     与 ext-manifest-v2 同纪律)。
//
// electron-free、路径参数化(seedDir = <process.resourcesPath>/extension-seed,由调用方注入)。

import * as fs from "node:fs"
import * as path from "node:path"
import { isSafeRelPath, sha256FileSync } from "./ext-atomic-fs"
import { putCasBlobFromFile, CAS_SHA256_RE } from "./ext-cas"
import type { TxFileSpec } from "./ext-transaction"

export const SEED_LOCK_SCHEMA = "alpha.extension-seed.lock.v1"
export const SEED_LOCK_FILENAME = "seed.lock.json"
export const SEED_NOTICE_FILENAME = "NOTICE.md"
export const SEED_BLOBS_DIR = "blobs"

/** 合同 §4 S7:SPDX 许可 allowlist(扩列 = 契约变更,必须与 B 侧同步)。 */
export const SEED_LICENSE_ALLOWLIST = new Set([
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC-BY-4.0",
  "CC0-1.0",
  "ISC",
  "MIT",
  "OFL-1.1",
  "Unlicense",
])

/** 合同 schema:平台 token allowlist(supportedPlatforms 不含 `*`;资产 platforms 可含)。 */
export const SEED_PLATFORM_ALLOWLIST = new Set([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
])

const SEED_ID_RE = /^(mcp|skill|plugin|bundle|agent|cloud):[a-z0-9][a-z0-9-]*$/
const SEED_TYPES = new Set(["mcp", "skill", "plugin", "bundle", "agent", "cloud"])
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/

export type SeedLockFileEntry = { path: string; sha256: string; bytes: number; url: string }
export type SeedAsset = {
  id: string
  type: string
  version: string
  license: string
  source: string
  redistributable: true
  platforms: string[]
  licenseFiles: string[]
  bytes: number
  files: SeedLockFileEntry[]
}
export type SeedLock = {
  schema: typeof SEED_LOCK_SCHEMA
  channel: "stable"
  catalogVersion: string
  catalog: { sha256: string; bytes: number; url: string; sigUrl: string }
  supportedPlatforms: string[]
  budget: { maxAssetBytes: number; maxTotalBytes: number; maxFilesPerAsset: number }
  totalBytes: number
  assets: SeedAsset[]
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
const onlyKeys = (o: Record<string, unknown>, allowed: string[]): string | null => {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k))
  return extra.length ? `unknown keys: ${extra.join(",")}` : null
}
const posInt = (v: unknown, min = 0): v is number => typeof v === "number" && Number.isInteger(v) && v >= min

/**
 * seed lock v1 严格解码 + §4 同语义门(S5/S7/S9/S10 + 确定性排序 + 总量一致性)。
 * 任一不过 → 拒绝整个 lock(不是跳过单资产),错误可定位。
 */
export function decodeSeedLock(text: string): { ok: true; lock: SeedLock } | { ok: false; error: string } {
  const bad = (error: string): { ok: false; error: string } => ({ ok: false, error: `seed lock: ${error}` })
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return bad("not valid JSON")
  }
  if (!isObj(v)) return bad("not an object")
  // §7 防降级混淆:未知顶层键必须拒绝(加字段 = schema v2)。
  const extra = onlyKeys(v, ["schema", "channel", "catalogVersion", "catalog", "supportedPlatforms", "budget", "totalBytes", "assets"])
  if (extra) return bad(extra)
  if (v.schema !== SEED_LOCK_SCHEMA) return bad(`schema=${String(v.schema)} (expected ${SEED_LOCK_SCHEMA})`)
  if (v.channel !== "stable") return bad(`channel=${String(v.channel)} (seed derives from stable only)`)
  if (typeof v.catalogVersion !== "string" || !VERSION_RE.test(v.catalogVersion)) return bad("catalogVersion")

  if (!isObj(v.catalog)) return bad("catalog")
  const ce = onlyKeys(v.catalog, ["sha256", "bytes", "url", "sigUrl"])
  if (ce) return bad(`catalog ${ce}`)
  if (typeof v.catalog.sha256 !== "string" || !CAS_SHA256_RE.test(v.catalog.sha256)) return bad("catalog.sha256")
  if (!posInt(v.catalog.bytes, 1)) return bad("catalog.bytes")
  if (typeof v.catalog.url !== "string" || !v.catalog.url.startsWith("https://")) return bad("catalog.url")
  if (typeof v.catalog.sigUrl !== "string" || !v.catalog.sigUrl.startsWith("https://")) return bad("catalog.sigUrl")

  if (!Array.isArray(v.supportedPlatforms) || v.supportedPlatforms.length < 1) return bad("supportedPlatforms")
  const seenPlat = new Set<string>()
  for (const p of v.supportedPlatforms) {
    if (typeof p !== "string" || !SEED_PLATFORM_ALLOWLIST.has(p)) return bad(`supportedPlatforms token: ${String(p)}`)
    if (seenPlat.has(p)) return bad(`supportedPlatforms duplicate: ${p}`)
    seenPlat.add(p)
  }

  if (!isObj(v.budget)) return bad("budget")
  const be = onlyKeys(v.budget, ["maxAssetBytes", "maxTotalBytes", "maxFilesPerAsset"])
  if (be) return bad(`budget ${be}`)
  if (!posInt(v.budget.maxAssetBytes, 1) || !posInt(v.budget.maxTotalBytes, 1) || !posInt(v.budget.maxFilesPerAsset, 1))
    return bad("budget values")
  const budget = v.budget as SeedLock["budget"]
  if (!posInt(v.totalBytes, 0)) return bad("totalBytes")

  if (!Array.isArray(v.assets)) return bad("assets")
  let sumTotal = 0
  const seenIds = new Set<string>()
  let prevId: string | null = null
  for (const a of v.assets) {
    if (!isObj(a)) return bad("assets[] not object")
    const ae = onlyKeys(a, ["id", "type", "version", "license", "source", "redistributable", "platforms", "licenseFiles", "bytes", "files"])
    if (ae) return bad(`assets[] ${ae}`)
    if (typeof a.id !== "string" || !SEED_ID_RE.test(a.id)) return bad(`assets[].id: ${String(a.id)}`)
    const id = a.id
    if (seenIds.has(id)) return bad(`duplicate asset id: ${id}`)
    seenIds.add(id)
    if (prevId !== null && !(prevId < id)) return bad(`assets not sorted by id: ${prevId} !< ${id}`)
    prevId = id
    if (typeof a.type !== "string" || !SEED_TYPES.has(a.type) || !id.startsWith(`${a.type}:`))
      return bad(`asset "${id}": type ${String(a.type)} inconsistent with id`)
    if (typeof a.version !== "string" || !VERSION_RE.test(a.version)) return bad(`asset "${id}": version`)
    // S7:许可 allowlist + redistributable 恒 true(fail closed;扩列 = 契约变更)。
    if (typeof a.license !== "string" || !SEED_LICENSE_ALLOWLIST.has(a.license))
      return bad(`asset "${id}": license ${String(a.license)} not in allowlist (S7)`)
    if (a.redistributable !== true) return bad(`asset "${id}": redistributable must be true (S7)`)
    if (typeof a.source !== "string" || a.source.length < 1) return bad(`asset "${id}": source`)
    // S8:第三方资产必须随许可文本(B 侧已执行;A 侧同语义再执行)。
    if (!Array.isArray(a.licenseFiles) || a.licenseFiles.some((p) => typeof p !== "string" || p.length < 1))
      return bad(`asset "${id}": licenseFiles`)
    if (a.source !== "alpha" && a.licenseFiles.length === 0)
      return bad(`asset "${id}": third-party asset without license text files (S8)`)
    // S9:platforms = ["*"](平台中立)或具体 token 升序,不混用、不重复、不为空。
    if (!Array.isArray(a.platforms) || a.platforms.length < 1) return bad(`asset "${id}": platforms empty (S9)`)
    const plats = a.platforms
    if (plats.includes("*")) {
      if (plats.length !== 1) return bad(`asset "${id}": "*" must be the sole platforms entry (S9)`)
    } else {
      const seen = new Set<string>()
      let prev: string | null = null
      for (const p of plats) {
        if (typeof p !== "string" || !SEED_PLATFORM_ALLOWLIST.has(p)) return bad(`asset "${id}": platform token ${String(p)} (S9)`)
        if (seen.has(p)) return bad(`asset "${id}": duplicate platform ${p} (S9)`)
        if (prev !== null && !(prev < p)) return bad(`asset "${id}": platforms not sorted (S9)`)
        seen.add(p)
        prev = p
      }
      // 与 supportedPlatforms 无交集 = 死资产(S9)。
      if (!plats.some((p) => seenPlat.has(p as string))) return bad(`asset "${id}": platforms disjoint from supportedPlatforms (S9)`)
    }
    if (!Array.isArray(a.files) || a.files.length < 1) return bad(`asset "${id}": empty file manifest (S10)`)
    // S10:预算按 lock 记录同值再执行。
    if (a.files.length > budget.maxFilesPerAsset)
      return bad(`asset "${id}": ${a.files.length} files > maxFilesPerAsset ${budget.maxFilesPerAsset} (S10)`)
    let sumAsset = 0
    const seenPaths = new Set<string>()
    let prevPath: string | null = null
    for (const f of a.files) {
      if (!isObj(f)) return bad(`asset "${id}": files[] not object`)
      const fe = onlyKeys(f, ["path", "sha256", "bytes", "url"])
      if (fe) return bad(`asset "${id}": files[] ${fe}`)
      // S5:严格相对路径 allowlist(traversal/绝对路径/点段/控制字符全拒)。
      if (typeof f.path !== "string" || !isSafeRelPath(f.path)) return bad(`asset "${id}": unsafe path ${String(f.path)} (S5)`)
      if (seenPaths.has(f.path)) return bad(`asset "${id}": duplicate path ${f.path}`)
      if (prevPath !== null && !(prevPath < f.path)) return bad(`asset "${id}": files not sorted by path`)
      seenPaths.add(f.path)
      prevPath = f.path
      if (typeof f.sha256 !== "string" || !CAS_SHA256_RE.test(f.sha256)) return bad(`asset "${id}": sha256 for ${f.path}`)
      if (!posInt(f.bytes, 0)) return bad(`asset "${id}": bytes for ${f.path}`)
      if (typeof f.url !== "string" || !f.url.startsWith("https://")) return bad(`asset "${id}": url for ${f.path}`)
      sumAsset += f.bytes
    }
    if (!posInt(a.bytes, 0) || a.bytes !== sumAsset) return bad(`asset "${id}": bytes ${String(a.bytes)} != sum of files ${sumAsset}`)
    if (a.bytes > budget.maxAssetBytes) return bad(`asset "${id}": ${a.bytes}B > maxAssetBytes ${budget.maxAssetBytes} (S10)`)
    sumTotal += sumAsset
  }
  if (v.totalBytes !== sumTotal) return bad(`totalBytes ${v.totalBytes} != sum of assets ${sumTotal}`)
  if (sumTotal > budget.maxTotalBytes) return bad(`totalBytes ${sumTotal} > maxTotalBytes ${budget.maxTotalBytes} (S10)`)
  return { ok: true, lock: v as unknown as SeedLock }
}

// ── 打包面读取(纯读;可获得性 bundled,与激活态正交) ────────────────────────────────────────

/** 当前平台 token(`${platform}-${arch}`;测试注入)。 */
export function currentPlatformToken(platform: string = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`
}

export type PackagedSeedView = {
  lock: SeedLock
  /** 逐资产:platformCompatible = platforms 含 "*" 或当前平台 token。availability 恒 "bundled"。 */
  assets: Array<SeedAsset & { availability: "bundled"; platformCompatible: boolean }>
  noticePath: string | null
}

/**
 * 读取打包 seed(`<resourcesPath>/extension-seed`):严格解码 + 平台门。**零副作用**——
 * 不写配置、不起进程、不打网络;不合法/平台不支持 → 拒绝整个 seed(fail closed),loud。
 */
export function readPackagedSeed(
  seedDir: string,
  opts: { platformToken?: string } = {},
): { ok: true; seed: PackagedSeedView } | { ok: false; error: string } {
  const bad = (error: string): { ok: false; error: string } => ({ ok: false, error })
  if (!path.isAbsolute(seedDir)) return bad(`seed dir must be absolute: ${seedDir}`)
  const lockPath = path.join(seedDir, SEED_LOCK_FILENAME)
  let st: fs.Stats
  try {
    st = fs.lstatSync(lockPath)
  } catch {
    return bad(`no packaged seed (missing ${SEED_LOCK_FILENAME})`)
  }
  if (st.isSymbolicLink() || !st.isFile()) return bad(`seed lock is not a regular file (refusing): ${lockPath}`)
  let text: string
  try {
    text = fs.readFileSync(lockPath, "utf8")
  } catch (error) {
    return bad(`seed lock unreadable: ${error instanceof Error ? error.message : String(error)}`)
  }
  const decoded = decodeSeedLock(text)
  if (!decoded.ok) return bad(decoded.error)
  const lock = decoded.lock
  const platform = opts.platformToken ?? currentPlatformToken()
  // S9(App 级):当前平台不在 lock 生成时校验的支持集 → 整个 seed 拒绝(fail closed)。
  if (!lock.supportedPlatforms.includes(platform))
    return bad(`platform ${platform} not in seed supportedPlatforms [${lock.supportedPlatforms.join(", ")}] (S9)`)
  const noticePath = path.join(seedDir, SEED_NOTICE_FILENAME)
  let hasNotice = false
  try {
    hasNotice = fs.lstatSync(noticePath).isFile()
  } catch {
    /* NOTICE 缺失如实为 null(打包门会挡;运行期不因此拒浏览) */
  }
  return {
    ok: true,
    seed: {
      lock,
      assets: lock.assets.map((a) => ({
        ...a,
        availability: "bundled" as const,
        platformCompatible: a.platforms.includes("*") || a.platforms.includes(platform),
      })),
      noticePath: hasNotice ? noticePath : null,
    },
  }
}

// ── 导入面:blob 提升进用户 CAS(用户显式选装时;逐资产,两遍式先验后写) ─────────────────────

/** 打包 seed 的 blob 布局(与用户 CAS 同构:sha256 分片寻址,媒体类型中立)。 */
export function seedBlobPath(seedDir: string, sha256: string): string | null {
  if (!CAS_SHA256_RE.test(sha256)) return null
  return path.join(seedDir, SEED_BLOBS_DIR, "sha256", sha256.slice(0, 2), sha256)
}

type VerifiedSeedFile = { path: string; sha256: string; bytes: number; blobPath: string }

/**
 * 资产级验证(零写入):平台兼容 → 预算再执行 → 逐 blob S6 symlink/realpath 门 + 尺寸 +
 * sha256 重验。任一不过 → 拒绝整个资产(不跳过单文件)。
 */
export function verifySeedAsset(
  seedDir: string,
  lock: SeedLock,
  assetId: string,
  opts: { platformToken?: string } = {},
): { ok: true; files: VerifiedSeedFile[] } | { ok: false; reason: string } {
  const bad = (reason: string): { ok: false; reason: string } => ({ ok: false, reason: `seed asset "${assetId}": ${reason}` })
  const asset = lock.assets.find((a) => a.id === assetId)
  if (!asset) return bad("not in seed lock")
  const platform = opts.platformToken ?? currentPlatformToken()
  if (!asset.platforms.includes("*") && !asset.platforms.includes(platform))
    return bad(`not compatible with platform ${platform} (S9)`)
  // S10 再执行(decode 已执行一次;这里按提升时的真实字节再执行一次)。
  if (asset.files.length > lock.budget.maxFilesPerAsset)
    return bad(`${asset.files.length} files > maxFilesPerAsset ${lock.budget.maxFilesPerAsset} (S10)`)
  let realSeedRoot: string
  try {
    realSeedRoot = fs.realpathSync(seedDir)
  } catch {
    return bad(`seed dir missing: ${seedDir}`)
  }
  const files: VerifiedSeedFile[] = []
  let total = 0
  for (const f of asset.files) {
    const blob = seedBlobPath(seedDir, f.sha256)
    if (!blob) return bad(`invalid digest for ${f.path}`)
    // S6:blob 缺失 / blob 或任一父目录是 symlink / realpath 逃逸 seed 根 → 拒绝。
    let rel = path.relative(seedDir, blob)
    let cursor = seedDir
    for (const seg of rel.split(path.sep)) {
      cursor = path.join(cursor, seg)
      let st: fs.Stats
      try {
        st = fs.lstatSync(cursor)
      } catch {
        return bad(`blob missing for ${f.path} (${f.sha256.slice(0, 12)}…) (S6)`)
      }
      if (st.isSymbolicLink()) return bad(`symlink in blob path (refusing): ${cursor} (S6)`)
    }
    let real: string
    try {
      real = fs.realpathSync(blob)
    } catch {
      return bad(`blob missing for ${f.path} (S6)`)
    }
    if (real !== realSeedRoot && !real.startsWith(realSeedRoot + path.sep)) return bad(`blob escapes seed dir: ${f.path} (S6)`)
    const st = fs.lstatSync(blob)
    if (!st.isFile()) return bad(`blob is not a regular file: ${f.path} (S6)`)
    if (st.size !== f.bytes) return bad(`size MISMATCH for ${f.path}: ${st.size} ≠ ${f.bytes} (S11)`)
    total += st.size
    if (total > lock.budget.maxAssetBytes) return bad(`asset exceeds maxAssetBytes ${lock.budget.maxAssetBytes} (S10)`)
    if (sha256FileSync(blob) !== f.sha256) return bad(`sha256 MISMATCH for ${f.path} — refusing before any write (S11)`)
    files.push({ path: f.path, sha256: f.sha256, bytes: f.bytes, blobPath: blob })
  }
  return { ok: true, files }
}

/**
 * 用户选装的提升动作:verifySeedAsset 全过(展开前拒绝,parent AC3)→ 逐 blob 原子提升进
 * 用户 CAS(putCasBlobFromFile 再验一次,纵深)。只动所选资产的 blob(不复制整个 seed);
 * **不安装、不启用**——安装由调用方走 planner/事务(populateFromCas + seedAssetTxFiles 接缝)。
 */
export function promoteSeedAssetToCas(
  seedDir: string,
  lock: SeedLock,
  assetId: string,
  casBaseRoot: string,
  opts: { platformToken?: string } = {},
): { ok: true; files: TxFileSpec[]; promoted: number; alreadyPresent: number; warnings: string[] } | { ok: false; reason: string } {
  const verified = verifySeedAsset(seedDir, lock, assetId, opts)
  if (!verified.ok) return verified
  const warnings: string[] = []
  let promoted = 0
  let alreadyPresent = 0
  for (const f of verified.files) {
    const put = putCasBlobFromFile(casBaseRoot, f.blobPath, { sha256: f.sha256, bytes: f.bytes })
    if (!put.ok) return { ok: false, reason: `seed asset "${assetId}": CAS promotion failed for ${f.path}: ${put.reason}` }
    warnings.push(...put.warnings)
    if (put.existed) alreadyPresent++
    else promoted++
  }
  return {
    ok: true,
    files: verified.files.map((f) => ({ path: f.path, sha256: f.sha256, size: f.bytes })),
    promoted,
    alreadyPresent,
    warnings,
  }
}

/** TxPlan 接缝:资产的期望文件清单(REQ-100 事务引擎的结构精确校验输入)。 */
export function seedAssetTxFiles(lock: SeedLock, assetId: string): TxFileSpec[] | null {
  const asset = lock.assets.find((a) => a.id === assetId)
  if (!asset) return null
  return asset.files.map((f) => ({ path: f.path, sha256: f.sha256, size: f.bytes }))
}
