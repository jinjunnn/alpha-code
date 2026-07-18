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
      // REQ-102 #318(Codex 裁决 E1):复用 cold blob 时刷新 mtime —— 「promote 成功但事务尚未持锁
      // 写 journal」的窗口里,出-grace 旧 blob 会被 GC 扫掉导致安装 materialize abort。刷新把暴露
      // 从任意时长缩到 GC 单轮 lstat→unlink 的微秒级;残余竞态的后果 = fail-closed 安装失败,可
      // 重试(promote 幂等重放),无损坏。ENOENT = verify 与 touch 之间 blob 已被删(GC 竞态实锤)
      // → 不谎报复用,落到下方原子重写;其它失败 best-effort 退化为原 grace 语义 + warning 可观测。
      let vanished = false
      try {
        const nowTs = new Date()
        fs.utimesSync(dest, nowTs, nowTs)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") vanished = true
        else warnings.push(`mtime refresh failed for reused blob ${sha256.slice(0, 12)}… (${String(err)}) — grace semantics degrade to original`)
      }
      if (!vanished) return { ok: true, path: dest, sha256, bytes: data.length, existed: true, warnings }
      warnings.push(`existing blob ${sha256.slice(0, 12)}… vanished during reuse (GC race) — rewriting`)
    } else {
      warnings.push(`existing blob ${sha256.slice(0, 12)}… was CORRUPT on disk — replaced with verified bytes`)
    }
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

/** 严格读取结果:`missing`=无 pin 文件(合法空集);`valid`=文件存在且结构全部合法;
 *  `invalid`=文件存在但不可读/JSON 失败/根或任一条目非法。REQ-102(#333):pin 账是 GC 的
 *  mark 根之一,损坏时**绝不**降级为「无保护项」——否则受保护 blob 会被 GC 当垃圾清除。 */
export type CasPinsRead =
  | { status: "missing"; pins: CasPins["pins"] }
  | { status: "valid"; pins: CasPins["pins"] }
  | { status: "invalid"; reason: string }

/** 判别式解码用的「普通对象」守卫(#318):数组/null/异常原型一律不算 —— pins 账的根与
 *  `pins` 字段都必须是纯 JSON object,`{v:1,pins:[]}` 这类形状漂移绝不能被当作合法空 pin 集。 */
const isPlainRecord = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false
  const proto: unknown = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

export function readCasPinsStrict(baseRoot: string): CasPinsRead {
  const pinsPath = casPaths(baseRoot).pinsPath
  let text: string
  try {
    text = fs.readFileSync(pinsPath, "utf8")
  } catch (error) {
    // 仅「文件不存在」= 合法空集;权限/IO/是目录等其它错误一律 fail-closed。
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing", pins: {} }
    return { status: "invalid", reason: `pins unreadable: ${error instanceof Error ? error.message : String(error)}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { status: "invalid", reason: `pins JSON parse failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  // #318 严格判别式:根/`pins` 必须是普通对象、`v` 必须恰为 1。任何形状漂移({v:2,pins:{}}、
  // 缺 v、{v:1,pins:[]}、pins 非对象)都不是「合法空 pin 集」—— 当空集会让 GC 把受保护 blob
  // 当垃圾清掉。唯一合法空集来源 = 文件 ENOENT(上方 missing 分支)。
  if (!isPlainRecord(parsed)) return { status: "invalid", reason: "pins root is not a plain object" }
  if (parsed.v !== 1)
    return { status: "invalid", reason: `pins schema v must be exactly 1 — got ${parsed.v === undefined ? "missing" : JSON.stringify(parsed.v)}` }
  const raw = parsed.pins
  if (!isPlainRecord(raw)) return { status: "invalid", reason: "pins.pins missing or not a plain object" }
  const pins: CasPins["pins"] = {}
  for (const [k, v] of Object.entries(raw)) {
    if (!CAS_SHA256_RE.test(k)) return { status: "invalid", reason: `invalid pin digest key: ${k.slice(0, 16)}…` }
    if (!v || typeof v !== "object") return { status: "invalid", reason: `invalid pin entry for ${k.slice(0, 12)}…` }
    const entry = v as { reason?: unknown; pinnedAt?: unknown }
    if (typeof entry.reason !== "string" || typeof entry.pinnedAt !== "string")
      return { status: "invalid", reason: `invalid pin entry fields for ${k.slice(0, 12)}…` }
    pins[k] = { reason: entry.reason, pinnedAt: entry.pinnedAt }
  }
  return { status: "valid", pins }
}

/** 便利读取(仅 missing|valid 语义);损坏 pin 账 **抛错**,绝不静默返回空集。 */
export function readCasPins(baseRoot: string): CasPins {
  const read = readCasPinsStrict(baseRoot)
  if (read.status === "invalid") throw new Error(`refusing to treat corrupt pins ledger as empty: ${read.reason}`)
  return { v: 1, pins: read.pins }
}

export function pinCasBlob(baseRoot: string, sha256: string, reason: string, now: () => Date = () => new Date()): boolean {
  if (!CAS_SHA256_RE.test(sha256)) return false
  // 损坏 pin 账不得被「空集 + 本次一条」覆盖 —— 否则已有保护标记会永久丢失。
  const read = readCasPinsStrict(baseRoot)
  if (read.status === "invalid") return false
  const pins = read.pins
  pins[sha256] = { reason, pinnedAt: now().toISOString() }
  writeFileAtomicSync(casPaths(baseRoot).pinsPath, JSON.stringify({ v: 1, pins }, null, 2) + "\n")
  return true
}

export function unpinCasBlob(baseRoot: string, sha256: string): boolean {
  const read = readCasPinsStrict(baseRoot)
  if (read.status === "invalid") return false
  const pins = read.pins
  if (!(sha256 in pins)) return false
  delete pins[sha256]
  writeFileAtomicSync(casPaths(baseRoot).pinsPath, JSON.stringify({ v: 1, pins }, null, 2) + "\n")
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
