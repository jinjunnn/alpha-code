// Local artifact manifest — `.code-puppy/runs/<runId>/artifacts.json`(REQ-093 A 侧,alpha-code#185)。
// Main-process only, but electron-free and root-parameterized (alpha-workdir.ts style) so the whole
// surface is unit-testable against a temp dir.
//
// 职责:每个 managed run 的本地产物真相源 —— 镜像的平台 descriptor + 本地状态(savedPath 相对路径、
// downloadedAt、verifiedSha256、verification 状态、bytesOnDisk)。进程重启后可独立恢复,不依赖内存
// list 或再次请求平台(REQ-093 交付 1)。
//
// 不变量:
//   · 原子写(tmp + rename;复用 ADR-019 守卫链 safeResolveInAlpha);
//   · schemaVersion=1;未知未来版本 → 只读/报错,绝不静默重写(REQ-093 AC#8);
//   · manifest 内容不含 bearer/token、不含绝对路径 —— savedPath 是 run 目录内的 POSIX 相对路径,
//     且必须落在 `artifacts/` 子目录(保护 contract.json/status.json/artifacts.json 自身不可被登记/GC);
//   · 只有本模块写这个文件;读到结构非法的条目按篡改处理(corrupt → 只读),不丢条目继续。

import * as fs from "node:fs"
import * as path from "node:path"
import { isSafeRunId, safeResolveInAlpha } from "./alpha-workdir"
// descriptor 契约 = shared/cloud-artifact-descriptor.ts(#184 落地的平台逐字镜像;真相源在 B 仓)。
// 本模块只消费:类型 + 校验;manifest 是 A 侧扩展,按镜像纪律不进契约文件。
import { validateArtifactDescriptor, type ArtifactDescriptor } from "../shared/cloud-artifact-descriptor"

export type { ArtifactDescriptor } from "../shared/cloud-artifact-descriptor"

// ---------------------------------------------------------------------------
// Manifest v1 schema
// ---------------------------------------------------------------------------

export const ARTIFACT_MANIFEST_FILE = "artifacts.json"
export const ARTIFACT_MANIFEST_VERSION = 1 as const
/** run 目录内产物字节的唯一落点子目录;savedPath 必须以它开头。 */
export const RUN_ARTIFACTS_SUBDIR = "artifacts"

/**
 * 本地验证状态(区别于 descriptor.verification —— 那是远端结论,保留来源、可被本地降级但不被改写):
 *   verified   = 本地 digest 与产出端 sha256 复核一致;
 *   unverified = 无产出端 digest 可比(本地 pin 仅用于后续漂移检测,不冒充 verified);
 *   mismatch   = digest/size 复核不符(离线篡改/损坏)—— 一经降级持久化,不再显示旧 verified;
 *   missing    = 文件在盘上消失(reconcile 时判定)。
 */
export type LocalArtifactState = "verified" | "unverified" | "mismatch" | "missing"

export interface LocalArtifactRecord {
  /** run 目录内 POSIX 相对路径(如 "artifacts/report.pdf")。不变量见 isSafeSavedPath。 */
  savedPath: string
  /** ISO-8601 下载完成时刻。 */
  downloadedAt: string
  /** 登记时 stat 到的真实字节数(盘上真相,非调用方声明)。 */
  bytesOnDisk: number
  state: LocalArtifactState
  /** 本地算得的 sha256(#184 流式写入单遍计算,或显式 verify)。语义 = 期望值 pin;不符走 warnings。 */
  verifiedSha256?: string
  /** 本地内容鉴别结果(诚实并列,不覆盖 descriptor.detectedMime,也不改写 trust)。 */
  detectedMime?: string
  detector?: string
  warnings: string[]
}

export interface ManifestArtifactEntry {
  descriptor: ArtifactDescriptor
  local: LocalArtifactRecord
}

export interface ArtifactManifestV1 {
  schemaVersion: typeof ARTIFACT_MANIFEST_VERSION
  runId: string
  updatedAt: string
  artifacts: ManifestArtifactEntry[]
}

// ---------------------------------------------------------------------------
// 校验(手写零依赖,与平台契约模块同风格)
// ---------------------------------------------------------------------------

const LOCAL_STATES: readonly string[] = ["verified", "unverified", "mismatch", "missing"]
const SHA256_RE = /^[0-9a-f]{64}$/
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:/
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/

/**
 * savedPath 不变量:POSIX 相对路径、无 `..`/`.`/空段/点文件段/控制字符/反斜杠/盘符/绝对形态,
 * 且必须落在 `artifacts/` 子目录内(run 元数据 contract.json/status.json/artifacts.json 永远不可寻址)。
 * 写入端与读取端都过这一关 —— 手改 manifest 塞绝对路径/穿越路径 = corrupt(只读),不是可用数据。
 */
export function isSafeSavedPath(p: unknown): p is string {
  if (typeof p !== "string" || p.length === 0 || p.length > 512) return false
  if (p.includes("\\") || CONTROL_CHARS_RE.test(p) || WINDOWS_DRIVE_RE.test(p) || path.posix.isAbsolute(p)) return false
  const segments = p.split("/")
  if (segments.length < 2 || segments[0] !== RUN_ARTIFACTS_SUBDIR) return false
  return segments.every((s) => s.length > 0 && s !== "." && s !== ".." && !s.startsWith("."))
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

// descriptor 结构校验走契约镜像的 validateArtifactDescriptor(单一规则源);manifest 追加一条
// 落盘专属不变量:contentRef.url 必须是 server-relative 路径 —— 带 origin/凭据的绝对 URL 不入
// manifest(与部署域解耦 + 防凭据落盘,REQ-092 AC#5)。
function validateDescriptor(v: unknown, errors: string[], at: string): void {
  const res = validateArtifactDescriptor(v)
  if (!res.ok) {
    errors.push(...res.errors.map((e) => `${at}: ${e}`))
    return
  }
  if (!res.value.contentRef.url.startsWith("/"))
    errors.push(`${at}: contentRef.url must be server-relative (start with "/")`)
}

function validateLocal(v: unknown, errors: string[], at: string): void {
  if (!isRecord(v)) {
    errors.push(`${at}: local must be an object`)
    return
  }
  if (!isSafeSavedPath(v.savedPath)) errors.push(`${at}: savedPath violates the relative-path invariant`)
  if (typeof v.downloadedAt !== "string" || v.downloadedAt.length === 0) errors.push(`${at}: downloadedAt required`)
  if (typeof v.bytesOnDisk !== "number" || v.bytesOnDisk < 0 || !Number.isFinite(v.bytesOnDisk))
    errors.push(`${at}: bytesOnDisk must be a non-negative number`)
  if (typeof v.state !== "string" || !LOCAL_STATES.includes(v.state)) errors.push(`${at}: state invalid`)
  if (v.verifiedSha256 !== undefined && (typeof v.verifiedSha256 !== "string" || !SHA256_RE.test(v.verifiedSha256)))
    errors.push(`${at}: verifiedSha256 must be 64 lowercase hex chars`)
  if (!Array.isArray(v.warnings) || !(v.warnings as unknown[]).every((w) => typeof w === "string"))
    errors.push(`${at}: warnings must be a string array`)
}

export type ManifestValidateResult = { ok: true; manifest: ArtifactManifestV1 } | { ok: false; errors: string[] }

/** 结构校验(v1 语义)。schemaVersion 不匹配不在这里判 —— 读取端先分流 unsupported-version。 */
export function validateArtifactManifest(v: unknown): ManifestValidateResult {
  const errors: string[] = []
  if (!isRecord(v)) return { ok: false, errors: ["manifest must be an object"] }
  if (v.schemaVersion !== ARTIFACT_MANIFEST_VERSION)
    errors.push(`unsupported schemaVersion: ${String(v.schemaVersion)}`)
  if (typeof v.runId !== "string" || !isSafeRunId(v.runId)) errors.push("runId invalid")
  if (typeof v.updatedAt !== "string" || v.updatedAt.length === 0) errors.push("updatedAt required")
  if (!Array.isArray(v.artifacts)) {
    errors.push("artifacts must be an array")
    return { ok: false, errors }
  }
  const seenIds = new Set<string>()
  const seenPaths = new Set<string>()
  v.artifacts.forEach((entry, i) => {
    const at = `artifacts[${i}]`
    if (!isRecord(entry)) {
      errors.push(`${at}: must be an object`)
      return
    }
    validateDescriptor(entry.descriptor, errors, at)
    validateLocal(entry.local, errors, at)
    const id = isRecord(entry.descriptor) ? entry.descriptor.id : undefined
    if (typeof id === "string") {
      if (seenIds.has(id)) errors.push(`${at}: duplicate artifact id ${id}`)
      seenIds.add(id)
    }
    const sp = isRecord(entry.local) ? entry.local.savedPath : undefined
    if (typeof sp === "string") {
      if (seenPaths.has(sp)) errors.push(`${at}: duplicate savedPath ${sp}`)
      seenPaths.add(sp)
    }
  })
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, manifest: v as unknown as ArtifactManifestV1 }
}

// ---------------------------------------------------------------------------
// 读 / 原子写
// ---------------------------------------------------------------------------

export type ManifestReadResult =
  | { ok: true; manifest: ArtifactManifestV1 | null } // null = 尚无 manifest(合法、可写)
  | { ok: false; reason: "unsupported-version"; version: string }
  | { ok: false; reason: "corrupt"; detail: string }
  | { ok: false; reason: "invalid-run" }

export function readArtifactManifest(projectDir: string, runId: string): ManifestReadResult {
  if (!isSafeRunId(runId)) return { ok: false, reason: "invalid-run" }
  const file = safeResolveInAlpha(projectDir, "runs", runId, ARTIFACT_MANIFEST_FILE)
  if (!file) return { ok: false, reason: "invalid-run" }
  let raw: string
  try {
    raw = fs.readFileSync(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, manifest: null }
    return { ok: false, reason: "corrupt", detail: error instanceof Error ? error.message : "unreadable" }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: "corrupt", detail: "not valid JSON" }
  }
  if (!isRecord(parsed)) return { ok: false, reason: "corrupt", detail: "not an object" }
  // 未知未来版本 → 只读/报错;绝不按 v1 猜测解释,也绝不重写(REQ-093 AC#8)。
  if (parsed.schemaVersion !== ARTIFACT_MANIFEST_VERSION)
    return { ok: false, reason: "unsupported-version", version: String(parsed.schemaVersion) }
  const validated = validateArtifactManifest(parsed)
  if (!validated.ok) return { ok: false, reason: "corrupt", detail: validated.errors.join("; ") }
  // runId 与所在目录必须一致 —— 整目录被拷贝/manifest 被移植视为篡改。
  if (validated.manifest.runId !== runId)
    return { ok: false, reason: "corrupt", detail: `runId mismatch: manifest says ${validated.manifest.runId}` }
  return { ok: true, manifest: validated.manifest }
}

export type ManifestWriteResult = { ok: true; file: string } | { ok: false; reason: string }

/**
 * 原子写(tmp + rename,同 alpha-workdir.writeFileAtomic 语义;tmp 名含 pid+随机段,崩溃遗留的
 * tmp 文件不会被读取端认作 manifest,下次写入也不受其影响)。写前全量校验 —— 非法结构 loud 拒绝,
 * 绝不落半成品。调用方负责 run 目录已存在(register 前 run 目录必然已由写入器创建)。
 */
export function writeArtifactManifest(projectDir: string, runId: string, manifest: ArtifactManifestV1): ManifestWriteResult {
  if (!isSafeRunId(runId)) return { ok: false, reason: "invalid run id" }
  if (manifest.runId !== runId) return { ok: false, reason: "manifest runId does not match target run" }
  const validated = validateArtifactManifest(manifest)
  if (!validated.ok) return { ok: false, reason: `invalid manifest: ${validated.errors.join("; ")}` }
  const file = safeResolveInAlpha(projectDir, "runs", runId, ARTIFACT_MANIFEST_FILE)
  if (!file) return { ok: false, reason: "path escapes .code-puppy" }
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n")
    fs.renameSync(tmp, file)
    return { ok: true, file }
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      // best-effort tmp cleanup
    }
    return { ok: false, reason: error instanceof Error ? error.message : "write failed" }
  }
}
