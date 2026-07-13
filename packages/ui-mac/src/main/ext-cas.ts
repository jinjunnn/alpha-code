// REQ-102 A(issue #194)—— main-owned content-addressed store(CAS):sha256 → 不可变 blob。
//
// 定位(parent jinjunnn/alpha-work#5 / ADR-028 §6 的 REQ-102 接缝):
//   · **media-type-neutral**:blob 只是字节,按 digest 寻址,无扩展名、无格式假设;archive 格式
//     由 ManifestV2 的 artifact.mediaType 声明(ext-manifest-v2),CAS 层永不解包、永不解释内容;
//   · **共享层**:root = `<base>/cas`(base = ~/.alpha 基根,**不是** REQ-098 env mutable root)——
//     prod/beta/dev 引用相同 payload 时磁盘只有一个 blob(parent AC2);环境侧 receipt/grant/
//     current 仍在各自 env root 完全隔离(alpha-environment.ts 文件头预留的正是本层);
//   · **三层状态分离**(parent 交付③):
//       ① CAS blob(本模块,不可变内容,可随时由 digest 重建)——生命周期归 GC(ext-cas-gc);
//       ② 安装态(receipts/generations/journal,env root,ext-transaction + ext-receipt-v2);
//       ③ 用户数据(workspace/secrets/会话)——本层与 GC 的任何路径都到不了它(路径构造上
//          不可达 + realpath 圈禁,负向测试钉死);
//   · **写入原子 + fail-closed**:put = 先全量校验 digest(不符 → 零副作用拒绝)→ tmp → fsync →
//     rename(ext-atomic-fs 同款原语,与 ext-transaction staging 同纪律);读取时重验
//     (缓存/磁盘可被本地篡改 —— 同 remote-catalog codex M1 态度)。
//
// 布局:
//   <base>/cas/
//     v1/sha256/<aa>/<64hex>   不可变 blob(aa = digest 前两位分片;文件名 = 完整 digest)
//     v1/pins.json             显式 pin 账(GC mark 根之一;digest → reason)
//     ext-tx/                  CAS 级锁域(ext-bundle-lock 复用;GC 互斥,见 ext-cas-gc)
//
// electron-free、root 参数化、零 mock(仓规:可注入面走参数)。

import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { isSafeRelPath, resolveUnder, sha256FileSync, writeFileAtomicSync } from "./ext-atomic-fs"
import type { TxFileSpec } from "./ext-transaction"

export const CAS_SHA256_RE = /^[0-9a-f]{64}$/
/** 单 blob 硬帽(防呆;seed 预算 maxAssetBytes=16MiB,总 64MiB —— 帽取总预算量级)。 */
export const MAX_CAS_BLOB_BYTES = 64 * 1024 * 1024

const CAS_DIR = "cas"
const BLOBS_VERSION_DIR = "v1"

export function casPaths(baseRoot: string) {
  const root = path.join(baseRoot, CAS_DIR)
  return {
    root,
    blobsDir: path.join(root, BLOBS_VERSION_DIR, "sha256"),
    pinsPath: path.join(root, BLOBS_VERSION_DIR, "pins.json"),
  }
}

/** digest → blob 绝对路径;digest 不合法(格式即通道)→ null。 */
export function casBlobPath(baseRoot: string, sha256: string): string | null {
  if (typeof sha256 !== "string" || !CAS_SHA256_RE.test(sha256)) return null
  return path.join(casPaths(baseRoot).blobsDir, sha256.slice(0, 2), sha256)
}

/** blob 是否在店(必须是常规文件;symlink 一律不算 —— fail closed)。 */
export function hasCasBlob(baseRoot: string, sha256: string): boolean {
  const p = casBlobPath(baseRoot, sha256)
  if (!p) return false
  try {
    return fs.lstatSync(p).isFile()
  } catch {
    return false
  }
}

export type CasPutResult =
  | { ok: true; path: string; sha256: string; bytes: number; existed: boolean; warnings: string[] }
  | { ok: false; reason: string }

function putVerifiedBytes(baseRoot: string, data: Buffer, sha256: string, warnings: string[]): CasPutResult {
  const dest = casBlobPath(baseRoot, sha256)
  if (!dest) return { ok: false, reason: `invalid sha256: ${String(sha256)}` }
  // 已在店:重验现存字节(不可变性自检)。一致 → 幂等成功;不一致 = 本地损坏/篡改 → 原子替换 + loud。
  try {
    const st = fs.lstatSync(dest)
    if (st.isSymbolicLink() || !st.isFile()) {
      return { ok: false, reason: `existing CAS entry is not a regular file (refusing): ${dest}` }
    }
    if (sha256FileSync(dest) === sha256) {
      return { ok: true, path: dest, sha256, bytes: data.length, existed: true, warnings }
    }
    warnings.push(`existing blob ${sha256.slice(0, 12)}… was CORRUPT on disk — replaced with verified bytes`)
  } catch {
    /* 不在店 → 正常写入 */
  }
  try {
    writeFileAtomicSync(dest, data) // tmp → fsync → rename → fsync 父目录(ext-atomic-fs)
  } catch (error) {
    return { ok: false, reason: `CAS write failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  return { ok: true, path: dest, sha256, bytes: data.length, existed: false, warnings }
}

/** 从内存字节写入:先验 digest(不符 → 零副作用拒绝,fail closed),再原子落盘。幂等。 */
export function putCasBlobFromBuffer(baseRoot: string, data: Buffer, expectedSha256: string): CasPutResult {
  if (typeof expectedSha256 !== "string" || !CAS_SHA256_RE.test(expectedSha256))
    return { ok: false, reason: `invalid sha256: ${String(expectedSha256)}` }
  if (data.length > MAX_CAS_BLOB_BYTES) return { ok: false, reason: `blob too large: ${data.length}B > ${MAX_CAS_BLOB_BYTES}B` }
  const actual = crypto.createHash("sha256").update(data).digest("hex")
  if (actual !== expectedSha256)
    return {
      ok: false,
      reason: `sha256 MISMATCH (expected ${expectedSha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…) — refusing to store`,
    }
  return putVerifiedBytes(baseRoot, data, expectedSha256, [])
}

/**
 * 从磁盘文件写入(seed 提升 / 下载暂存的导入面)。源必须是常规文件(symlink 拒绝 —— 上层
 * 还有 realpath 圈禁,这里是纵深防御);字节读入后按 expected digest 校验,不符零副作用拒绝。
 */
export function putCasBlobFromFile(
  baseRoot: string,
  sourceFile: string,
  expected: { sha256: string; bytes?: number },
): CasPutResult {
  let st: fs.Stats
  try {
    st = fs.lstatSync(sourceFile)
  } catch {
    return { ok: false, reason: `source blob missing: ${sourceFile}` }
  }
  if (st.isSymbolicLink() || !st.isFile()) return { ok: false, reason: `source blob is not a regular file (symlink refused): ${sourceFile}` }
  if (st.size > MAX_CAS_BLOB_BYTES) return { ok: false, reason: `blob too large: ${st.size}B > ${MAX_CAS_BLOB_BYTES}B` }
  if (expected.bytes !== undefined && st.size !== expected.bytes)
    return { ok: false, reason: `size MISMATCH for ${sourceFile}: ${st.size} ≠ ${expected.bytes}` }
  let data: Buffer
  try {
    data = fs.readFileSync(sourceFile)
  } catch (error) {
    return { ok: false, reason: `source blob unreadable: ${error instanceof Error ? error.message : String(error)}` }
  }
  return putCasBlobFromBuffer(baseRoot, data, expected.sha256)
}

/** 读取并**重验**(磁盘内容可被篡改;digest 不符 → fail closed,绝不把坏字节交给消费方)。 */
export function readCasBlobVerified(
  baseRoot: string,
  sha256: string,
): { ok: true; data: Buffer } | { ok: false; reason: string } {
  const p = casBlobPath(baseRoot, sha256)
  if (!p) return { ok: false, reason: `invalid sha256: ${String(sha256)}` }
  let st: fs.Stats
  try {
    st = fs.lstatSync(p)
  } catch {
    return { ok: false, reason: `blob not in store: ${sha256.slice(0, 12)}…` }
  }
  if (st.isSymbolicLink() || !st.isFile()) return { ok: false, reason: `CAS entry is not a regular file (refusing): ${p}` }
  let data: Buffer
  try {
    data = fs.readFileSync(p)
  } catch (error) {
    return { ok: false, reason: `blob unreadable: ${error instanceof Error ? error.message : String(error)}` }
  }
  const actual = crypto.createHash("sha256").update(data).digest("hex")
  if (actual !== sha256)
    return { ok: false, reason: `blob CORRUPT: sha256 MISMATCH (expected ${sha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…)` }
  return { ok: true, data }
}

// ── 显式 pin 账(GC mark 根之一;parent scope⑥ "pinned 保留") ─────────────────────────────────

export type CasPins = { v: 1; pins: Record<string, { reason: string; pinnedAt: string }> }

export function readCasPins(baseRoot: string): CasPins {
  try {
    const parsed = JSON.parse(fs.readFileSync(casPaths(baseRoot).pinsPath, "utf8")) as CasPins
    if (parsed && typeof parsed === "object" && parsed.pins && typeof parsed.pins === "object") {
      const pins: CasPins["pins"] = {}
      for (const [k, v] of Object.entries(parsed.pins)) {
        if (CAS_SHA256_RE.test(k) && v && typeof v === "object" && typeof v.reason === "string") pins[k] = v
      }
      return { v: 1, pins }
    }
  } catch {
    /* 无 pin 账 = 空集 */
  }
  return { v: 1, pins: {} }
}

export function pinCasBlob(baseRoot: string, sha256: string, reason: string, now: () => Date = () => new Date()): boolean {
  if (!CAS_SHA256_RE.test(sha256)) return false
  const pins = readCasPins(baseRoot)
  pins.pins[sha256] = { reason, pinnedAt: now().toISOString() }
  writeFileAtomicSync(casPaths(baseRoot).pinsPath, JSON.stringify(pins, null, 2) + "\n")
  return true
}

export function unpinCasBlob(baseRoot: string, sha256: string): boolean {
  const pins = readCasPins(baseRoot)
  if (!(sha256 in pins.pins)) return false
  delete pins.pins[sha256]
  writeFileAtomicSync(casPaths(baseRoot).pinsPath, JSON.stringify(pins, null, 2) + "\n")
  return true
}

// ── materialization 接缝(REQ-100 populate hook 的 CAS 实现) ─────────────────────────────────

/**
 * 把文件清单从 CAS 物化到目标目录(ext-transaction populate hook 用):逐文件安全相对路径 +
 * 目录圈禁 + 读取重验;任一文件缺失/digest 不符 → 整单拒绝(半成品由事务引擎的 staging
 * 语义负责清理 —— 本函数抛错即 abort)。事务引擎随后还会对 staging 做结构精确校验(纵深)。
 */
export function materializeFilesFromCas(baseRoot: string, files: TxFileSpec[], destDir: string): void {
  if (!path.isAbsolute(destDir)) throw new Error(`destDir must be absolute: ${destDir}`)
  for (const f of files) {
    if (!isSafeRelPath(f.path)) throw new Error(`unsafe file path: ${String(f.path)}`)
    const dest = resolveUnder(destDir, f.path)
    if (!dest) throw new Error(`path escapes destination: ${f.path}`)
    const read = readCasBlobVerified(baseRoot, f.sha256)
    if (!read.ok) throw new Error(`CAS materialize failed for ${f.path}: ${read.reason}`)
    if (f.size !== undefined && read.data.length !== f.size)
      throw new Error(`size MISMATCH for ${f.path}: ${read.data.length} ≠ ${f.size}`)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, read.data)
  }
}

/** ext-transaction TxHooks.populate 的 CAS 工厂(REQ-103 安装链直接可用的接缝)。 */
export function populateFromCas(baseRoot: string): (item: { files: TxFileSpec[] }, stagingDir: string) => void {
  return (item, stagingDir) => materializeFilesFromCas(baseRoot, item.files, stagingDir)
}
