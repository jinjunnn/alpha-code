// Artifact Workbench 纯核 — REQ-094(#186)。零 DOM、零 IPC,bun:test 可全测:
//   · 卡片派生:manifest entries(verified/unverified/mismatch/missing)+ legacy 盘上文件 +
//     平台侧 cloud 列表交叉(未落盘 → cloud-only 可下载)—— 诚实状态,不伪造 verified;
//   · 下载状态机:确定 reducer(进度帧乱序/终态后帧一律拦掉);
//   · run 摘要排序与字节格式化。

import type {
  CloudArtifactMeta,
  LegacyRunFile,
  ManifestArtifactEntry,
  RunArtifactUsage,
} from "../../../preload/types"
import type { ArtifactDescriptor } from "../../../shared/cloud-artifact-descriptor"
import { validateArtifactDescriptor } from "../../../shared/cloud-artifact-descriptor"

// ---------------------------------------------------------------------------
// 卡片派生
// ---------------------------------------------------------------------------

/** 卡片状态 = 本地验证状态 ∪ {legacy(盘上未登记), cloud-only(平台有、本地无)}。 */
export type ArtifactCardState = "verified" | "unverified" | "mismatch" | "missing" | "legacy" | "cloud-only"

export type ArtifactCard = {
  /** 稳定 key:artifact id,或 legacy 文件的 "legacy:<savedPath>"。 */
  key: string
  name: string
  state: ArtifactCardState
  /** 盘上字节(missing/cloud-only 时为 descriptor.size 或 null)。 */
  bytes: number | null
  /** run 目录内相对路径(盘上存在时)。 */
  savedPath?: string
  descriptor?: ArtifactDescriptor
  /** 路由输入(REQ-095):claimed 来自产出端声明;detected 优先本地检测,其次产出端检测。 */
  claimedMime?: string
  detectedMime?: string
  warnings: string[]
  /** 可下载:cloud-only(平台可取)或 missing(manifest 里有 descriptor 可重下)。 */
  downloadable: boolean
  /** 下载通道载荷(cloud.downloadArtifact 的 artifact 参数;descriptor 或 legacy meta)。 */
  downloadPayload?: CloudArtifactMeta | ArtifactDescriptor
}

export function deriveCards(input: {
  entries: readonly ManifestArtifactEntry[]
  legacyFiles: readonly LegacyRunFile[]
  /** 平台 cloud-artifacts 列表(可选;离线/未登录 = undefined,诚实少这一类)。 */
  cloudArtifacts?: readonly CloudArtifactMeta[]
}): ArtifactCard[] {
  const cards: ArtifactCard[] = []
  const knownIds = new Set<string>()
  for (const entry of input.entries) {
    knownIds.add(entry.descriptor.id)
    cards.push({
      key: entry.descriptor.id,
      name: entry.descriptor.name,
      state: entry.local.state,
      bytes: entry.local.state === "missing" ? (entry.descriptor.size ?? null) : entry.local.bytesOnDisk,
      savedPath: entry.local.state === "missing" ? undefined : entry.local.savedPath,
      descriptor: entry.descriptor,
      claimedMime: entry.descriptor.claimedMime,
      detectedMime: entry.local.detectedMime ?? entry.descriptor.detectedMime,
      warnings: [...entry.local.warnings],
      downloadable: entry.local.state === "missing", // descriptor 在手,可重下
      downloadPayload: entry.local.state === "missing" ? entry.descriptor : undefined,
    })
  }
  for (const meta of input.cloudArtifacts ?? []) {
    if (knownIds.has(meta.id)) continue
    // 完整 descriptor 才携带(legacy meta 不合成假 descriptor —— 与 saveCloudRun 同纪律);
    // 但 cloud-only 卡片本身仍呈现(name/size 事实),下载走原 meta。
    const check = validateArtifactDescriptor(meta)
    cards.push({
      key: meta.id,
      name: meta.name ?? meta.id,
      state: "cloud-only",
      bytes: typeof meta.size === "number" ? meta.size : null,
      descriptor: check.ok ? check.value : undefined,
      claimedMime: check.ok ? check.value.claimedMime : meta.mime,
      detectedMime: check.ok ? check.value.detectedMime : undefined,
      warnings: check.ok ? [] : ["legacy 平台条目:无完整 descriptor(下载后按 legacy 文件只读呈现)"],
      downloadable: true,
      downloadPayload: meta,
    })
  }
  for (const f of input.legacyFiles) {
    cards.push({
      key: `legacy:${f.savedPath}`,
      name: f.name,
      state: "legacy",
      bytes: f.bytesOnDisk,
      savedPath: f.savedPath,
      warnings: ["盘上文件未入 manifest(legacy 只读发现,unverified)"],
      downloadable: false,
    })
  }
  return cards
}

/** 预览可用性:盘上有文件才能读内容(cloud-only/missing → 先下载)。 */
export function cardPreviewable(card: ArtifactCard): boolean {
  return typeof card.savedPath === "string" && card.savedPath.length > 0
}

// ---------------------------------------------------------------------------
// 下载状态机(cloud.downloadArtifact + onArtifactProgress + cancel)
// ---------------------------------------------------------------------------

export type DownloadPhase =
  | { status: "idle" }
  | { status: "requesting" } // invoke 已发出,尚无进度帧
  | { status: "downloading"; bytes: number; total?: number; percent?: number }
  | { status: "done" }
  | { status: "error"; message: string }
  | { status: "cancelled" }

export type DownloadEvent =
  | { type: "start" }
  | { type: "progress"; bytes: number; total?: number; percent?: number }
  | { type: "success" }
  | { type: "failure"; message: string }
  | { type: "cancelled" }
  | { type: "reset" }

/** 确定 reducer:终态(done/error/cancelled)后到达的进度帧一律忽略;start/reset 是仅有的重入口。 */
export function downloadReducer(state: DownloadPhase, ev: DownloadEvent): DownloadPhase {
  switch (ev.type) {
    case "start":
      return state.status === "requesting" || state.status === "downloading" ? state : { status: "requesting" }
    case "progress":
      if (state.status !== "requesting" && state.status !== "downloading") return state
      return { status: "downloading", bytes: ev.bytes, total: ev.total, percent: ev.percent }
    case "success":
      if (state.status !== "requesting" && state.status !== "downloading") return state
      return { status: "done" }
    case "failure":
      if (state.status !== "requesting" && state.status !== "downloading") return state
      return { status: "error", message: ev.message }
    case "cancelled":
      if (state.status !== "requesting" && state.status !== "downloading") return state
      return { status: "cancelled" }
    case "reset":
      return { status: "idle" }
  }
}

export function downloadBusy(state: DownloadPhase): boolean {
  return state.status === "requesting" || state.status === "downloading"
}

// ---------------------------------------------------------------------------
// run 摘要 + 格式化
// ---------------------------------------------------------------------------

/** run 列表排序:runId 降序(job_<hex> 无内嵌时间戳可用;倒序≈新在前,且完全确定)。 */
export function sortRunUsages(runs: readonly RunArtifactUsage[]): RunArtifactUsage[] {
  return [...runs].sort((a, b) => (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0))
}

export function formatBytes(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "—"
  if (n < 1024) return `${n} B`
  const units = ["KiB", "MiB", "GiB"]
  let v = n
  let u = -1
  do {
    v /= 1024
    u += 1
  } while (v >= 1024 && u < units.length - 1)
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`
}

export function shortSha(sha: string | undefined): string {
  return sha ? `${sha.slice(0, 8)}…${sha.slice(-8)}` : "—"
}
