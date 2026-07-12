// Main-owned ArtifactService(REQ-093 A 侧,alpha-code#185)—— run 产物的唯一权威服务层。
// Electron-free、root-parameterized(alpha-workdir.ts 风格),全表面可对临时目录单测。
//
// 职责:
//   · registerDownloadedArtifact —— #184 流式写入器(.part + 单遍 sha256 + 原子 rename)完成后调用,
//     把 descriptor + 本地状态登记进 artifacts.json(唯一集成点,见下方注释);
//   · listRunArtifacts —— manifest + 磁盘 reconcile(文件消失 ⇒ missing、尺寸漂移 ⇒ mismatch,降级持久化);
//   · resolveArtifact / verifyArtifact —— 按 id 取 descriptor;全量 sha256 复核(离线篡改检测,AC#4);
//   · removeArtifact —— 本地删除 + manifest 原子更新(ADR-019 守卫;保留策略/自动清理是平台侧
//     与 retention 专项的范围,这里只提供 GC 钩子,不做策略);
//   · run/project 字节与件数核算 —— 从 manifest 派生数字;配额**执行**(前置拒绝)属写入端(#184)
//     与平台侧闸门,本服务只诚实供数(REQ-093 §5 的基线常量集中在此供两端引用)。
//
// 内容鉴别诚实原则:claimedMime / detectedMime 并列呈现;冲突产 warning;本服务不重新推导 trust,
// 也不基于扩展名"升级"任何结论(REQ-093 交付 4 的 A 侧表面;magic 检测本体在写入端/平台)。
//
// 并发模型:main 进程单线程 + 同步 fs,read-modify-write 天然串行;写入以 tmp+rename 原子落盘。

import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { isSafeRunId, safeResolveInAlpha } from "./alpha-workdir"
import {
  ARTIFACT_MANIFEST_VERSION,
  RUN_ARTIFACTS_SUBDIR,
  isSafeSavedPath,
  readArtifactManifest,
  writeArtifactManifest,
  type ArtifactDescriptor,
  type ArtifactManifestV1,
  type LocalArtifactState,
  type ManifestArtifactEntry,
} from "./artifact-manifest"

// ---- 配额基线(REQ-093 §5)。单件/单 run 件数上限来自契约镜像(与平台同值);单 run 字节与
// managed project 字节是 A 侧基线,集中在此。执行策略(越界前置拒绝)在写入端/平台,不在本服务。----
import { ARTIFACT_MAX_BYTES, MAX_ARTIFACTS_PER_RUN } from "../shared/cloud-artifact-descriptor"
export { ARTIFACT_MAX_BYTES, MAX_ARTIFACTS_PER_RUN }
export const MAX_RUN_ARTIFACT_BYTES = 512 * 1024 * 1024
export const MAX_PROJECT_ARTIFACT_BYTES = 5 * 1024 * 1024 * 1024

// ---------------------------------------------------------------------------
// 登记(#184 集成点)
// ---------------------------------------------------------------------------

/**
 * ⚠️ #184 集成点(唯一写入入口):流式下载器在 `.part` 写完、单遍 sha256 算得、原子 rename 到
 * `artifacts/<name>` 之后,以本函数登记。字节真相取自盘上 stat(不信调用方声明);descriptor 原样
 * 镜像存入(远端结论保留来源,本地只降级不改写)。
 */
export type RegisterArtifactInput = {
  descriptor: ArtifactDescriptor
  /** run 目录内 POSIX 相对路径,必须位于 `artifacts/` 下(如 "artifacts/report.pdf")。 */
  savedPath: string
  /** 写入器单遍算得的 sha256(hex 小写)。缺省 = 写入器没算(状态只能是 unverified)。 */
  verifiedSha256?: string
  /** 写入器/平台侧 magic 检测结果与检测器标识(本服务只记录并列呈现,不自行推导)。 */
  detectedMime?: string
  detector?: string
  /** ISO-8601;缺省取当前时刻。 */
  downloadedAt?: string
}

export type RegisterArtifactResult = { ok: true; entry: ManifestArtifactEntry } | { ok: false; reason: string }

export function registerDownloadedArtifact(
  projectDir: string,
  runId: string,
  input: RegisterArtifactInput,
): RegisterArtifactResult {
  if (!isSafeRunId(runId)) return { ok: false, reason: "invalid run id" }
  if (!isSafeSavedPath(input.savedPath))
    return { ok: false, reason: "savedPath violates the relative-path invariant" }
  // ADR-019 守卫:realpath 防逃逸(symlink 文件解析到 .alpha 外也在此被拒)。
  const target = safeResolveInAlpha(projectDir, "runs", runId, ...input.savedPath.split("/"))
  if (!target) return { ok: false, reason: "path escapes .alpha" }
  let st: fs.Stats
  try {
    st = fs.statSync(target)
  } catch {
    return { ok: false, reason: "file not found on disk (register after atomic rename)" }
  }
  if (!st.isFile()) return { ok: false, reason: "savedPath is not a regular file" }

  const read = readArtifactManifest(projectDir, runId)
  if (!read.ok)
    return {
      ok: false,
      reason:
        read.reason === "unsupported-version"
          ? `manifest is read-only: unsupported schemaVersion ${read.version}`
          : read.reason === "corrupt"
            ? `manifest is read-only: corrupt (${read.detail})`
            : "invalid run",
    }
  const manifest: ArtifactManifestV1 =
    read.manifest ?? { schemaVersion: ARTIFACT_MANIFEST_VERSION, runId, updatedAt: "", artifacts: [] }

  const d = input.descriptor
  const warnings: string[] = []
  let state: LocalArtifactState
  if (d.sha256 && input.verifiedSha256) {
    if (d.sha256 === input.verifiedSha256) state = "verified"
    else {
      state = "mismatch"
      warnings.push(`sha256 mismatch: descriptor ${d.sha256}, downloaded ${input.verifiedSha256}`)
    }
  } else if (typeof d.size === "number" && d.size !== st.size) {
    state = "mismatch"
    warnings.push(`size mismatch: descriptor claims ${d.size} bytes, on disk ${st.size}`)
  } else {
    // 无产出端 digest 可比:诚实 unverified;本地 digest 仅作后续漂移检测的 pin,不冒充 verified。
    state = "unverified"
  }
  const claimed = d.claimedMime
  const detected = input.detectedMime ?? d.detectedMime
  if (claimed && detected && claimed.toLowerCase() !== detected.toLowerCase())
    warnings.push(`mime conflict: claimed ${claimed}, detected ${detected}`)

  const entry: ManifestArtifactEntry = {
    descriptor: d,
    local: {
      savedPath: input.savedPath,
      downloadedAt: input.downloadedAt ?? new Date().toISOString(),
      bytesOnDisk: st.size,
      state,
      ...(input.verifiedSha256 ? { verifiedSha256: input.verifiedSha256 } : {}),
      ...(input.detectedMime ? { detectedMime: input.detectedMime } : {}),
      ...(input.detector ? { detector: input.detector } : {}),
      warnings,
    },
  }

  // upsert by id;同一 savedPath 不允许被两个不同 id 占用(同名不覆盖 —— 写入器负责去重命名,AC#6)。
  const pathOwner = manifest.artifacts.find((e) => e.local.savedPath === input.savedPath && e.descriptor.id !== d.id)
  if (pathOwner) return { ok: false, reason: `savedPath already registered to artifact ${pathOwner.descriptor.id}` }
  const idx = manifest.artifacts.findIndex((e) => e.descriptor.id === d.id)
  if (idx >= 0) manifest.artifacts[idx] = entry
  else manifest.artifacts.push(entry)

  // 配额诚实供数:越过基线只 loud 记录(执行归写入端前置闸;这里不半途拒绝已落盘的文件,防"未登记 final 文件")。
  if (manifest.artifacts.length > MAX_ARTIFACTS_PER_RUN)
    warnings.push(`run artifact count ${manifest.artifacts.length} exceeds baseline ${MAX_ARTIFACTS_PER_RUN}`)
  const runBytes = manifest.artifacts.reduce((sum, e) => sum + e.local.bytesOnDisk, 0)
  if (runBytes > MAX_RUN_ARTIFACT_BYTES)
    warnings.push(`run artifact bytes ${runBytes} exceed baseline ${MAX_RUN_ARTIFACT_BYTES}`)

  manifest.updatedAt = new Date().toISOString()
  const written = writeArtifactManifest(projectDir, runId, manifest)
  if (!written.ok) return { ok: false, reason: written.reason }
  return { ok: true, entry }
}

// ---------------------------------------------------------------------------
// 列表 + reconcile
// ---------------------------------------------------------------------------

/** 未入 manifest 的盘上文件(legacy run 的只读发现,或写入器/登记之间的意外残留)。绝不持久化、绝不假报 verified。 */
export type LegacyRunFile = { name: string; savedPath: string; bytesOnDisk: number }

export type RunArtifactsListResult =
  | { ok: true; runId: string; entries: ManifestArtifactEntry[]; legacyFiles: LegacyRunFile[]; warnings: string[] }
  | { ok: false; reason: string }

/** artifacts/ 子目录递归清单(相对 run 目录的 POSIX savedPath)。 */
function walkArtifactFiles(runDir: string): LegacyRunFile[] {
  const artifactsDir = path.join(runDir, RUN_ARTIFACTS_SUBDIR)
  const out: LegacyRunFile[] = []
  const walk = (dir: string, rel: string) => {
    let items: fs.Dirent[]
    try {
      items = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      const childRel = `${rel}/${item.name}`
      // symlink 不跟随(防逃逸计量/发现);只统计常规文件。
      if (item.isDirectory()) walk(path.join(dir, item.name), childRel)
      else if (item.isFile()) {
        let size = 0
        try {
          size = fs.statSync(path.join(dir, item.name)).size
        } catch {
          continue
        }
        out.push({ name: item.name, savedPath: childRel, bytesOnDisk: size })
      }
    }
  }
  walk(artifactsDir, RUN_ARTIFACTS_SUBDIR)
  return out
}

/**
 * manifest + 磁盘 reconcile:
 *   · 文件消失 ⇒ state=missing;尺寸漂移 ⇒ state=mismatch(+warning)—— 降级持久化,重启后不回显旧 verified;
 *   · 恢复(verified/unverified 的文件回来了且尺寸吻合)不自动升级 —— digest 级复核走 verifyArtifact;
 *   · manifest 之外的盘上文件 → legacyFiles(只读发现,含无 manifest 的 legacy run;不生成假 descriptor)。
 * 未知未来版本 / corrupt ⇒ ok:false(只读报错,不静默重写,REQ-093 AC#8)。
 */
export function listRunArtifacts(projectDir: string, runId: string): RunArtifactsListResult {
  if (!isSafeRunId(runId)) return { ok: false, reason: "invalid run id" }
  const runDir = safeResolveInAlpha(projectDir, "runs", runId)
  if (!runDir) return { ok: false, reason: "path escapes .alpha" }
  const read = readArtifactManifest(projectDir, runId)
  if (!read.ok) {
    if (read.reason === "unsupported-version")
      return { ok: false, reason: `manifest is read-only: unsupported schemaVersion ${read.version}` }
    if (read.reason === "corrupt") return { ok: false, reason: `manifest is read-only: corrupt (${read.detail})` }
    return { ok: false, reason: "invalid run" }
  }

  const warnings: string[] = []
  const manifest = read.manifest
  const entries = manifest?.artifacts ?? []
  let dirty = false
  for (const entry of entries) {
    const target = safeResolveInAlpha(projectDir, "runs", runId, ...entry.local.savedPath.split("/"))
    let st: fs.Stats | null = null
    try {
      st = target ? fs.statSync(target) : null
    } catch {
      st = null
    }
    if (!st || !st.isFile()) {
      if (entry.local.state !== "missing") {
        entry.local.state = "missing"
        entry.local.warnings.push("file missing on disk (reconcile)")
        dirty = true
      }
      continue
    }
    if (st.size !== entry.local.bytesOnDisk) {
      if (entry.local.state !== "mismatch") {
        entry.local.state = "mismatch"
        entry.local.warnings.push(`size drift: recorded ${entry.local.bytesOnDisk} bytes, on disk ${st.size}`)
        dirty = true
      }
      continue
    }
    // 尺寸吻合的 missing 条目 = 文件回来了:恢复为 unverified(digest 级信心须经 verifyArtifact 重建)。
    if (entry.local.state === "missing") {
      entry.local.state = "unverified"
      entry.local.warnings.push("file reappeared on disk; digest not re-verified")
      dirty = true
    }
  }
  if (dirty && manifest) {
    manifest.updatedAt = new Date().toISOString()
    const written = writeArtifactManifest(projectDir, runId, manifest)
    if (!written.ok) warnings.push(`reconcile downgrade not persisted: ${written.reason}`)
  }

  const known = new Set(entries.map((e) => e.local.savedPath))
  const legacyFiles = walkArtifactFiles(runDir).filter((f) => !known.has(f.savedPath))
  if (!manifest && legacyFiles.length > 0)
    warnings.push("legacy run: artifacts/ discovered read-only without artifacts.json (unverified)")

  return { ok: true, runId, entries, legacyFiles, warnings }
}

// ---------------------------------------------------------------------------
// 解析 / 复核
// ---------------------------------------------------------------------------

export type ArtifactInspectResult = { ok: true; entry: ManifestArtifactEntry } | { ok: false; reason: string }

/** 按 artifact id 解析 descriptor + 本地状态(经 stat 级 reconcile)。 */
export function resolveArtifact(projectDir: string, runId: string, artifactId: string): ArtifactInspectResult {
  const list = listRunArtifacts(projectDir, runId)
  if (!list.ok) return list
  const entry = list.entries.find((e) => e.descriptor.id === artifactId)
  if (!entry) return { ok: false, reason: "artifact not found" }
  return { ok: true, entry }
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256")
    const stream = fs.createReadStream(file)
    stream.on("error", reject)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("end", () => resolve(hash.digest("hex")))
  })
}

/**
 * 全量 digest 复核(REQ-093 AC#4 的"下次打开"钩子;打开/预览内容前调用):
 *   · 与 pin(verifiedSha256,否则 descriptor.sha256)比对;不符 ⇒ mismatch 降级并持久化,
 *     pin 保持期望值不被"治愈",算得的 digest 进 warning;
 *   · 之前无任何 digest:算得值记为 pin,状态保持 unverified(没有产出端结论可资升级);
 *   · descriptor.sha256 存在且吻合 ⇒ verified(含从 unverified 升级的情形)。
 */
export async function verifyArtifact(projectDir: string, runId: string, artifactId: string): Promise<ArtifactInspectResult> {
  if (!isSafeRunId(runId)) return { ok: false, reason: "invalid run id" }
  const read = readArtifactManifest(projectDir, runId)
  if (!read.ok || !read.manifest)
    return { ok: false, reason: read.ok ? "no manifest for run" : `manifest unreadable (${read.reason})` }
  const manifest = read.manifest
  const entry = manifest.artifacts.find((e) => e.descriptor.id === artifactId)
  if (!entry) return { ok: false, reason: "artifact not found" }
  const target = safeResolveInAlpha(projectDir, "runs", runId, ...entry.local.savedPath.split("/"))
  if (!target) return { ok: false, reason: "path escapes .alpha" }

  const persist = (): ArtifactInspectResult => {
    manifest.updatedAt = new Date().toISOString()
    const written = writeArtifactManifest(projectDir, runId, manifest)
    if (!written.ok) return { ok: false, reason: `verify result not persisted: ${written.reason}` }
    return { ok: true, entry }
  }

  let st: fs.Stats | null = null
  try {
    st = fs.statSync(target)
  } catch {
    st = null
  }
  if (!st || !st.isFile()) {
    if (entry.local.state !== "missing") {
      entry.local.state = "missing"
      entry.local.warnings.push("file missing on disk (verify)")
      return persist()
    }
    return { ok: true, entry }
  }

  let digest: string
  try {
    digest = await sha256File(target)
  } catch (error) {
    return { ok: false, reason: `digest failed: ${error instanceof Error ? error.message : "read error"}` }
  }
  entry.local.bytesOnDisk = st.size
  const claim = entry.descriptor.sha256 // 产出端结论(优先比对对象;远端结论保留来源,本地只降级)
  const pin = entry.local.verifiedSha256 // 本地下载时算得的 digest(无 claim 时的漂移检测基准)
  if (claim) {
    if (digest === claim) {
      entry.local.state = "verified"
      entry.local.verifiedSha256 = digest
    } else {
      entry.local.state = "mismatch"
      entry.local.warnings.push(`digest mismatch on verify: expected ${claim}, computed ${digest}`)
    }
  } else if (pin) {
    if (digest === pin) {
      entry.local.state = "unverified" // 与下载所得一致,但没有产出端结论可资升级
    } else {
      entry.local.state = "mismatch"
      entry.local.warnings.push(`digest drift on verify: downloaded ${pin}, computed ${digest}`)
    }
  } else {
    entry.local.verifiedSha256 = digest // 首次 pin:仅用于将来的漂移检测,状态诚实保持 unverified
    entry.local.state = "unverified"
  }
  return persist()
}

// ---------------------------------------------------------------------------
// 删除 / GC 钩子
// ---------------------------------------------------------------------------

export type RemoveArtifactResult = { ok: true; removedFile: boolean } | { ok: false; reason: string }

/**
 * 本地删除 + manifest 原子更新(GC 钩子)。保留/清理**策略**(30 天、pinned、dry-run 审计计划)
 * 不在这里 —— REQ-093 交付 6 的策略面归 retention 专项;本函数只保证:守卫内删除、无悬挂引用。
 * 文件已消失时仍移除条目(幂等);unlink 失败(权限等)则不动 manifest,不留"账没了文件还在"。
 */
export function removeArtifact(projectDir: string, runId: string, artifactId: string): RemoveArtifactResult {
  if (!isSafeRunId(runId)) return { ok: false, reason: "invalid run id" }
  const read = readArtifactManifest(projectDir, runId)
  if (!read.ok)
    return {
      ok: false,
      reason:
        read.reason === "unsupported-version"
          ? `manifest is read-only: unsupported schemaVersion ${read.version}`
          : read.reason === "corrupt"
            ? `manifest is read-only: corrupt (${read.detail})`
            : "invalid run",
    }
  if (!read.manifest) return { ok: false, reason: "no manifest for run" }
  const manifest = read.manifest
  const idx = manifest.artifacts.findIndex((e) => e.descriptor.id === artifactId)
  if (idx < 0) return { ok: false, reason: "artifact not found" }
  const entry = manifest.artifacts[idx]
  const target = safeResolveInAlpha(projectDir, "runs", runId, ...entry.local.savedPath.split("/"))
  if (!target) return { ok: false, reason: "path escapes .alpha" }
  let removedFile = false
  try {
    fs.unlinkSync(target)
    removedFile = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      return { ok: false, reason: error instanceof Error ? error.message : "unlink failed" }
  }
  manifest.artifacts.splice(idx, 1)
  manifest.updatedAt = new Date().toISOString()
  const written = writeArtifactManifest(projectDir, runId, manifest)
  if (!written.ok) return { ok: false, reason: `file removed but manifest update failed: ${written.reason}` }
  return { ok: true, removedFile }
}

// ---------------------------------------------------------------------------
// 字节核算(quota/retention 供数;执行策略刻意不在此)
// ---------------------------------------------------------------------------

export type RunArtifactUsage = {
  runId: string
  artifactCount: number
  /** manifest 记录的字节合计(账面)。 */
  recordedBytes: number
  /** 盘上 stat 真相合计(artifacts/ 全部常规文件,含未登记者)。 */
  diskBytes: number
  /** 未入 manifest 的盘上字节(legacy/残留)。 */
  legacyBytes: number
  missingCount: number
  /** manifest 未知版本/corrupt(数字只来自盘上 stat)。 */
  readOnly: boolean
}

export type RunUsageResult = { ok: true; usage: RunArtifactUsage } | { ok: false; reason: string }

export function runArtifactUsage(projectDir: string, runId: string): RunUsageResult {
  if (!isSafeRunId(runId)) return { ok: false, reason: "invalid run id" }
  const runDir = safeResolveInAlpha(projectDir, "runs", runId)
  if (!runDir) return { ok: false, reason: "path escapes .alpha" }
  const files = walkArtifactFiles(runDir)
  const diskBytes = files.reduce((sum, f) => sum + f.bytesOnDisk, 0)
  const read = readArtifactManifest(projectDir, runId)
  if (!read.ok) {
    if (read.reason === "invalid-run") return { ok: false, reason: "invalid run" }
    return {
      ok: true,
      usage: { runId, artifactCount: 0, recordedBytes: 0, diskBytes, legacyBytes: diskBytes, missingCount: 0, readOnly: true },
    }
  }
  const entries = read.manifest?.artifacts ?? []
  const known = new Set(entries.map((e) => e.local.savedPath))
  const legacyBytes = files.filter((f) => !known.has(f.savedPath)).reduce((sum, f) => sum + f.bytesOnDisk, 0)
  const onDisk = new Set(files.map((f) => f.savedPath))
  return {
    ok: true,
    usage: {
      runId,
      artifactCount: entries.length,
      recordedBytes: entries.reduce((sum, e) => sum + e.local.bytesOnDisk, 0),
      diskBytes,
      legacyBytes,
      missingCount: entries.filter((e) => !onDisk.has(e.local.savedPath)).length,
      readOnly: false,
    },
  }
}

export type ProjectArtifactUsage = {
  totalRecordedBytes: number
  totalDiskBytes: number
  totalArtifacts: number
  runs: RunArtifactUsage[]
  /** 基线(REQ-093 §5;集中可见,UI/错误提示引用这里,不散落魔数)。 */
  limits: { artifactMaxBytes: number; runMaxBytes: number; runMaxCount: number; projectMaxBytes: number }
}

export type ProjectUsageResult = { ok: true; usage: ProjectArtifactUsage } | { ok: false; reason: string }

/** 项目级(managed project)核算:遍历 `.alpha/runs/*` 逐 run 汇总。 */
export function projectArtifactUsage(projectDir: string): ProjectUsageResult {
  const runsDir = safeResolveInAlpha(projectDir, "runs")
  if (!runsDir) return { ok: false, reason: "invalid project dir" }
  let ids: string[] = []
  try {
    ids = fs
      .readdirSync(runsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && isSafeRunId(d.name))
      .map((d) => d.name)
  } catch {
    ids = [] // runs/ 尚不存在 = 零用量
  }
  const runs: RunArtifactUsage[] = []
  for (const id of ids) {
    const res = runArtifactUsage(projectDir, id)
    if (res.ok) runs.push(res.usage)
  }
  return {
    ok: true,
    usage: {
      totalRecordedBytes: runs.reduce((sum, r) => sum + r.recordedBytes, 0),
      totalDiskBytes: runs.reduce((sum, r) => sum + r.diskBytes, 0),
      totalArtifacts: runs.reduce((sum, r) => sum + r.artifactCount, 0),
      runs,
      limits: {
        artifactMaxBytes: ARTIFACT_MAX_BYTES,
        runMaxBytes: MAX_RUN_ARTIFACT_BYTES,
        runMaxCount: MAX_ARTIFACTS_PER_RUN,
        projectMaxBytes: MAX_PROJECT_ARTIFACT_BYTES,
      },
    },
  }
}
