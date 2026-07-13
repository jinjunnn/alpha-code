#!/usr/bin/env node
// sync-extension-seed — REQ-102 A(#194):packaged seed 快照生成器(A 侧消费顺序 §6.1)。
//
// A 内置 extension seed = alpha-web(B)已发布 seed 产物的**交叉复核后**快照,禁手编。
// 与 sync-catalog-snapshot.mjs 同模式(REQ-046/105 先例),但 seed lock **无独立签名**
// (contracts/extension-seed CONTRACT.md §2)—— 所以本脚本必须走完整信任推导而非单文件验签:
//
//   1. trust.json(+.sig)以内置公钥(单源:src/main/catalog-channels.ts)验签,keyId↔公钥绑定核验;
//   2. channels/stable.json(+.sig)以 trust 登记钥(active/retiring、窗口内、未撤销)验签,
//      channel 自述必须是 stable,文档未过期(S1/S4);
//   3. stable target payload:sha256+bytes 钉死(R8)、版本绑定(R9)、payload 验签(R1)、
//      digest 不在 revokedTargets(R11/S2/S3);
//   4. seed.lock.json:**§2 交叉复核** —— lock.catalog == 已验签 target;逐资产逐文件与
//      payload 内 remoteAsset 清单逐字对齐(多一文件/少一字段/漂移一字节均拒);
//   5. §4 同语义门:S5 路径 allowlist、S7 许可 allowlist + redistributable、S9 平台、
//      S10 预算再执行、S11 blob 逐字节 digest、S6 symlink/realpath(--from-dir 源)、
//      S12 输出不透过 symlink 写;
//   6. 全过才写 resources/extension-seed/{seed.lock.json,NOTICE.md,blobs/**,extension-seed.snapshot.json}。
//      blob 按用户 CAS 同构布局(sha256 分片)去重落盘;输出确定性(无时间戳)——
//      **二连跑 diff 为空**(幂等门禁);过期 blob 修剪。
//
// 离线逃生:--from-dir <alpha-web checkout 根>(URL path → <root>/public/... 映射,逃生不逃验签)。
// 快照守卫:src/main/extension-seed-snapshot.test.ts(严格解码 + 逐 blob 重哈希 + 与内置
// catalog 快照互钉)—— 手编/漂移不跑本脚本即红(S13 A 侧)。

import { createHash, createPublicKey, verify as edVerify } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.resolve(here, "../resources/extension-seed")
const catalogChannelsTs = path.resolve(here, "../src/main/catalog-channels.ts")

const BASE_URL = "https://alphacodeone.com"
const SEED_LICENSE_ALLOWLIST = new Set([
  "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "CC-BY-4.0", "CC0-1.0", "ISC", "MIT", "OFL-1.1", "Unlicense",
])
const PLATFORM_ALLOWLIST = new Set(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"])
const HEX64 = /^[0-9a-f]{64}$/

const die = (msg) => {
  console.error(`✗ sync-extension-seed: ${msg}`)
  process.exit(1)
}
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex")

// ── 信任根(单源提取,不复制常量) ──────────────────────────────────────────────────────────────
function builtinPubkeyB64() {
  const src = fs.readFileSync(catalogChannelsTs, "utf8")
  const m = src.match(/BUILTIN_CATALOG_PUBKEY_B64 = "([A-Za-z0-9+/=]+)"/)
  if (!m) die(`cannot extract BUILTIN_CATALOG_PUBKEY_B64 from ${catalogChannelsTs}`)
  return m[1]
}
const verifyEd25519 = (body, sigB64, pubB64) => {
  try {
    const pub = createPublicKey({ key: Buffer.from(pubB64, "base64"), format: "der", type: "spki" })
    return edVerify(null, body, pub, Buffer.from(sigB64.trim(), "base64"))
  } catch {
    return false
  }
}

// ── 加载器:URL ↔ --from-dir 映射(逃生不逃验签;S6 门只对文件源生效) ─────────────────────────
const fromDirIdx = process.argv.indexOf("--from-dir")
const fromDir = fromDirIdx !== -1 ? path.resolve(process.argv[fromDirIdx + 1] ?? die("--from-dir requires a path")) : null
const sourceLabel = fromDir ? "alpha-web-checkout" : "remote"

/** 拒绝 symlink 逐段(S6):从 rootDir 到 target 的每一段都不得是 symlink,realpath 不得逃逸。 */
function assertNoSymlinkWithin(rootDir, target) {
  const rel = path.relative(rootDir, target)
  if (rel.startsWith("..") || path.isAbsolute(rel)) die(`S6: path escapes checkout: ${target}`)
  let cursor = rootDir
  for (const seg of rel.split(path.sep)) {
    cursor = path.join(cursor, seg)
    let st
    try {
      st = fs.lstatSync(cursor)
    } catch {
      die(`S6: missing path in checkout: ${cursor}`)
    }
    if (st.isSymbolicLink()) die(`S6: symlink refused in checkout path: ${cursor}`)
  }
  const real = fs.realpathSync(target)
  const realRoot = fs.realpathSync(rootDir)
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) die(`S6: realpath escapes checkout: ${target}`)
}

async function load(url) {
  if (!url.startsWith(`${BASE_URL}/`)) die(`unexpected origin (refusing): ${url}`)
  if (fromDir) {
    const target = path.join(fromDir, "public", url.slice(BASE_URL.length + 1))
    assertNoSymlinkWithin(fromDir, target)
    return fs.readFileSync(target)
  }
  const res = await fetch(url)
  if (!res.ok) die(`fetch ${url} → ${res.status}`)
  if (res.url && !res.url.startsWith("https://")) die(`redirected to non-https: ${res.url}`)
  return Buffer.from(await res.arrayBuffer())
}
const loadText = async (url) => (await load(url)).toString("utf8")

// ── 1) trust ────────────────────────────────────────────────────────────────────────────────────
const builtinKey = builtinPubkeyB64()
const nowMs = Date.now()
const trustBody = await load(`${BASE_URL}/catalog/v1/channels/trust.json`)
const trustSig = await loadText(`${BASE_URL}/catalog/v1/channels/trust.json.sig`)
if (!verifyEd25519(trustBody, trustSig, builtinKey)) die("S1: trust.json signature INVALID under built-in key")
const trust = JSON.parse(trustBody.toString("utf8"))
if (trust.schema !== "alpha.catalog.trust.v1") die(`S1: trust schema ${trust.schema}`)
if (Date.parse(trust.expires) <= nowMs) die(`S4: trust EXPIRED at ${trust.expires} (generation gate)`)
const keyIdOf = (pubB64) => sha256(Buffer.from(pubB64, "base64"))
const usableKeys = new Map()
for (const k of trust.keys ?? []) {
  if (k.status === "revoked") continue
  if (keyIdOf(k.publicKey) !== k.keyId) die(`S1: trust keyId↔publicKey binding mismatch for ${k.keyId}`)
  const nb = Date.parse(k.notBefore)
  const na = k.notAfter === undefined ? Infinity : Date.parse(k.notAfter)
  if (!(nb <= nowMs && nowMs < na)) continue
  usableKeys.set(k.keyId, k.publicKey)
}
if (usableKeys.size === 0) die("S1: no usable trust key")
const revokedTargets = new Map((trust.revokedTargets ?? []).map((r) => [r.sha256, r.reason]))

// ── 2) stable 指针 ──────────────────────────────────────────────────────────────────────────────
const stableBody = await load(`${BASE_URL}/catalog/v1/channels/stable.json`)
const stableSig = await loadText(`${BASE_URL}/catalog/v1/channels/stable.json.sig`)
const stable = JSON.parse(stableBody.toString("utf8"))
if (stable.schema !== "alpha.catalog.channel-metadata.v1") die(`S1: stable schema ${stable.schema}`)
if (stable.channel !== "stable") die(`S1: mix-and-match — channel doc says "${stable.channel}"`)
const stableKey = usableKeys.get(stable.keyId)
if (!stableKey) die(`S1: stable.json keyId ${stable.keyId} not usable in trust`)
if (!verifyEd25519(stableBody, stableSig, stableKey)) die("S1: stable.json signature INVALID")
if (Date.parse(stable.expires) <= nowMs) die(`S4: stable pointer EXPIRED at ${stable.expires} (generation gate)`)
const target = stable.target
if (revokedTargets.has(target.sha256)) die(`S2: stable target digest REVOKED (${revokedTargets.get(target.sha256)})`)

// ── 3) payload(已签名 release) ────────────────────────────────────────────────────────────────
const payloadBody = await load(target.url)
const payloadSig = await loadText(target.sigUrl)
if (sha256(payloadBody) !== target.sha256) die("S3: payload sha256 MISMATCH vs signed stable target")
if (payloadBody.length !== target.bytes) die(`S3: payload bytes MISMATCH (${payloadBody.length} ≠ ${target.bytes})`)
if (![...usableKeys.values()].some((k) => verifyEd25519(payloadBody, payloadSig, k))) die("S3: payload signature INVALID")
const payload = JSON.parse(payloadBody.toString("utf8"))
if (payload.version !== target.catalogVersion) die(`S3: payload version ${payload.version} ≠ target ${target.catalogVersion}`)
const entryById = new Map((payload.entries ?? []).map((e) => [e.id, e]))

// ── 4) seed lock + NOTICE:§2 交叉复核 ─────────────────────────────────────────────────────────
const lockBytes = await load(`${BASE_URL}/catalog/v1/seed/seed.lock.json`)
const noticeBytes = await load(`${BASE_URL}/catalog/v1/seed/NOTICE.md`)
const lock = JSON.parse(lockBytes.toString("utf8"))
if (lock.schema !== "alpha.extension-seed.lock.v1") die(`lock schema ${lock.schema} (unknown = downgrade confusion, refuse)`)
if (lock.channel !== "stable") die(`lock channel ${lock.channel}`)
if (lock.catalog.sha256 !== target.sha256 || lock.catalog.bytes !== target.bytes)
  die(`§2 cross-check FAILED: lock.catalog (${lock.catalog.sha256.slice(0, 12)}…/${lock.catalog.bytes}B) ≠ signed stable target (${target.sha256.slice(0, 12)}…/${target.bytes}B) — rejecting the whole seed`)
if (lock.catalogVersion !== target.catalogVersion) die(`§2 cross-check FAILED: lock.catalogVersion ${lock.catalogVersion} ≠ ${target.catalogVersion}`)

const isSafeRelPath = (rel) => {
  if (typeof rel !== "string" || rel.length === 0 || rel.length > 1024) return false
  if (rel.includes("\\") || rel.includes("\0") || rel.startsWith("/")) return false
  return rel.split("/").every((seg) => seg.length > 0 && seg !== "." && seg !== ".." && !/[\x00-\x1f\x7f]/.test(seg))
}

const budget = lock.budget
if (!budget || !Number.isInteger(budget.maxAssetBytes) || !Number.isInteger(budget.maxTotalBytes) || !Number.isInteger(budget.maxFilesPerAsset))
  die("lock budget malformed")
let totalBytes = 0
const supported = new Set(lock.supportedPlatforms ?? [])
for (const p of supported) if (!PLATFORM_ALLOWLIST.has(p)) die(`S9: supportedPlatforms token ${p}`)
if (supported.size === 0) die("S9: empty supportedPlatforms")

for (const asset of lock.assets ?? []) {
  const entry = entryById.get(asset.id)
  if (!entry) die(`§2 cross-check FAILED: lock asset "${asset.id}" not in signed payload`)
  if (!entry.remoteAsset || !Array.isArray(entry.remoteAsset.files))
    die(`§2 cross-check FAILED: payload entry "${asset.id}" has no remoteAsset manifest`)
  if (asset.version !== entry.version) die(`§2: "${asset.id}" version ${asset.version} ≠ payload ${entry.version}`)
  if (asset.license !== entry.license) die(`§2: "${asset.id}" license ${asset.license} ≠ payload ${entry.license}`)
  if (asset.source !== entry.source) die(`§2: "${asset.id}" source ${asset.source} ≠ payload ${entry.source}`)
  if (asset.redistributable !== true || entry.redistributable !== true) die(`S7: "${asset.id}" redistributable must be true`)
  const entryPlatforms = Array.isArray(entry.platforms) && entry.platforms.length ? [...entry.platforms].sort() : ["*"]
  const lockPlatforms = [...(asset.platforms ?? [])].sort()
  if (JSON.stringify(entryPlatforms) !== JSON.stringify(lockPlatforms))
    die(`§2: "${asset.id}" platforms ${JSON.stringify(lockPlatforms)} ≠ payload ${JSON.stringify(entryPlatforms)}`)
  if (!SEED_LICENSE_ALLOWLIST.has(asset.license)) die(`S7: "${asset.id}" license ${asset.license} not in allowlist`)
  if (asset.source !== "alpha" && (!Array.isArray(asset.licenseFiles) || asset.licenseFiles.length === 0))
    die(`S8: third-party "${asset.id}" without license text files`)
  if (!lockPlatforms.includes("*") && !lockPlatforms.some((p) => supported.has(p)))
    die(`S9: "${asset.id}" platforms disjoint from supportedPlatforms`)

  // 文件清单逐字对齐(两个方向:缺一 / 多一 / 任一字段漂移均拒)。
  const manifest = new Map(entry.remoteAsset.files.map((f) => [f.path, f]))
  if (asset.files.length !== manifest.size)
    die(`§2: "${asset.id}" file count ${asset.files.length} ≠ signed manifest ${manifest.size}`)
  if (asset.files.length > budget.maxFilesPerAsset) die(`S10: "${asset.id}" exceeds maxFilesPerAsset`)
  let assetBytes = 0
  for (const f of asset.files) {
    if (!isSafeRelPath(f.path)) die(`S5: "${asset.id}" unsafe path ${f.path}`)
    const m = manifest.get(f.path)
    if (!m) die(`§2: "${asset.id}" file ${f.path} not in signed manifest`)
    if (f.sha256 !== m.sha256 || f.bytes !== m.bytes || f.url !== m.url)
      die(`§2: "${asset.id}" file ${f.path} drifted from signed manifest`)
    if (!HEX64.test(f.sha256)) die(`"${asset.id}" bad digest for ${f.path}`)
    assetBytes += f.bytes
  }
  if (assetBytes !== asset.bytes) die(`"${asset.id}" bytes ${asset.bytes} ≠ sum ${assetBytes}`)
  if (assetBytes > budget.maxAssetBytes) die(`S10: "${asset.id}" ${assetBytes}B > maxAssetBytes`)
  totalBytes += assetBytes
}
if (totalBytes !== lock.totalBytes) die(`lock totalBytes ${lock.totalBytes} ≠ sum ${totalBytes}`)
if (totalBytes > budget.maxTotalBytes) die(`S10: total ${totalBytes}B > maxTotalBytes`)

// ── 5) blob 取回 + S11 逐字节钉死 ──────────────────────────────────────────────────────────────
const wanted = new Map() // sha256 → { bytes, url }
for (const asset of lock.assets) {
  for (const f of asset.files) {
    const prev = wanted.get(f.sha256)
    if (prev && prev.bytes !== f.bytes) die(`digest collision with differing bytes: ${f.sha256}`)
    if (!prev) wanted.set(f.sha256, { bytes: f.bytes, url: f.url })
  }
}
const blobData = new Map()
for (const [digest, { bytes, url }] of wanted) {
  const data = await load(url)
  if (data.length !== bytes) die(`S11: blob ${digest.slice(0, 12)}… bytes ${data.length} ≠ manifest ${bytes} (${url})`)
  if (sha256(data) !== digest) die(`S11: blob CONTENT DRIFT for ${url} — sha256 mismatch, rejecting the whole seed`)
  blobData.set(digest, data)
}

// ── 6) 确定性写出(S12 输出守卫 + 幂等 + 修剪) ────────────────────────────────────────────────
const assertWritable = (file) => {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) die(`S12: refusing to write through symlink: ${file}`)
  } catch {
    /* 不存在 = 可写 */
  }
}
fs.mkdirSync(outDir, { recursive: true })
for (const name of ["seed.lock.json", "NOTICE.md", "extension-seed.snapshot.json"]) assertWritable(path.join(outDir, name))
fs.writeFileSync(path.join(outDir, "seed.lock.json"), lockBytes) // 字节原样(快照 == 已发布产物)
fs.writeFileSync(path.join(outDir, "NOTICE.md"), noticeBytes)

const blobsRoot = path.join(outDir, "blobs", "sha256")
const expectedRel = new Set()
for (const [digest, data] of blobData) {
  const dest = path.join(blobsRoot, digest.slice(0, 2), digest)
  expectedRel.add(path.relative(blobsRoot, dest))
  assertWritable(dest)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, data)
}
// 修剪:不在本次 lock 的旧 blob / 异物全部移除(快照目录整体由脚本拥有,禁手编)。
if (fs.existsSync(blobsRoot)) {
  for (const shard of fs.readdirSync(blobsRoot)) {
    const shardAbs = path.join(blobsRoot, shard)
    for (const name of fs.statSync(shardAbs).isDirectory() ? fs.readdirSync(shardAbs) : []) {
      if (!expectedRel.has(path.join(shard, name))) fs.rmSync(path.join(shardAbs, name), { recursive: true, force: true })
    }
    if (fs.statSync(shardAbs).isDirectory() && fs.readdirSync(shardAbs).length === 0) fs.rmdirSync(shardAbs)
    else if (!fs.statSync(shardAbs).isDirectory()) fs.rmSync(shardAbs, { force: true })
  }
}

// 快照 meta:纯内容派生,零时间戳(幂等门禁:二连跑 diff 为空)。
const meta = {
  v: 1,
  catalogVersion: lock.catalogVersion,
  lockSha256: sha256(lockBytes),
  noticeSha256: sha256(noticeBytes),
  blobCount: blobData.size,
  blobBytes: [...blobData.values()].reduce((s, d) => s + d.length, 0),
  source: sourceLabel,
  _note:
    "由 scripts/sync-extension-seed.mjs 生成;resources/extension-seed 禁手编(REQ-102 #194)。" +
    "stable 晋级后必须重跑本脚本 + sync-catalog-snapshot.mjs(extension-seed-snapshot.test.ts 互钉守卫)。",
}
fs.writeFileSync(path.join(outDir, "extension-seed.snapshot.json"), JSON.stringify(meta, null, 2) + "\n")
console.log(
  `✓ extension seed ${lock.catalogVersion}: ${lock.assets.length} assets, ${blobData.size} blobs (${meta.blobBytes}B) ← ${sourceLabel}`,
)
