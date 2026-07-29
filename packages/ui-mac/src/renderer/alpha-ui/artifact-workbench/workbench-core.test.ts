// REQ-094(#186)workbench 纯核单测:卡片状态派生(诚实,不伪造 verified)、下载状态机、
// 排序/格式化、选中持久化(fake storage)。
import { describe, expect, test } from "bun:test"
import { artifactIdFor, type ArtifactDescriptor } from "../../../shared/cloud-artifact-descriptor"
import type { CloudArtifactMeta, ManifestArtifactEntry, RunArtifactUsage } from "../../../preload/types"
import {
  cardPreviewable,
  deriveCards,
  downloadBusy,
  downloadReducer,
  formatBytes,
  shortSha,
  sortRunUsages,
  type DownloadPhase,
} from "./workbench-core"
import { recallSelection, rememberSelection } from "./workbench-state"

const RUN = "job_wb12"

function descriptorOf(name: string, index = 0, size = 12): ArtifactDescriptor {
  const id = artifactIdFor(RUN, index, { name, size })
  return {
    schemaVersion: 1,
    id,
    source: "cloud",
    name,
    size,
    trust: "sandboxed",
    role: "primary",
    contentRef: { kind: "http-stream", url: `/v1/cloud/artifacts/${id}/content`, auth: "bearer" },
    verification: { status: "unverified" },
    provenance: { producer: "pipeline", jobId: RUN },
  }
}

function entryOf(name: string, state: ManifestArtifactEntry["local"]["state"], index = 0): ManifestArtifactEntry {
  const d = descriptorOf(name, index)
  return {
    descriptor: d,
    local: {
      savedPath: `artifacts/${name}`,
      downloadedAt: "2026-07-12T00:00:00.000Z",
      bytesOnDisk: 12,
      state,
      warnings: state === "mismatch" ? ["size drift: recorded 12 bytes, on disk 99"] : [],
    },
  }
}

describe("deriveCards", () => {
  test("manifest 状态逐一映射(verified/unverified/mismatch/missing),missing 可重下", () => {
    const cards = deriveCards({
      entries: [entryOf("a.md", "verified", 0), entryOf("b.csv", "unverified", 1), entryOf("c.json", "mismatch", 2), entryOf("d.png", "missing", 3)],
      legacyFiles: [],
    })
    expect(cards.map((c) => c.state)).toEqual(["verified", "unverified", "mismatch", "missing"])
    const missing = cards[3]
    expect(missing.downloadable).toBe(true)
    expect(missing.savedPath).toBeUndefined()
    expect(missing.downloadPayload).toBeDefined()
    expect(cardPreviewable(missing)).toBe(false)
    expect(cardPreviewable(cards[0])).toBe(true)
    // mismatch 的 warning 原样携带(诚实,不清洗)
    expect(cards[2].warnings.length).toBe(1)
  })
  test("legacy 盘上文件 → legacy 卡片,不可下载、可预览", () => {
    const cards = deriveCards({ entries: [], legacyFiles: [{ name: "old.txt", savedPath: "artifacts/old.txt", bytesOnDisk: 7 }] })
    expect(cards.length).toBe(1)
    expect(cards[0].state).toBe("legacy")
    expect(cards[0].downloadable).toBe(false)
    expect(cardPreviewable(cards[0])).toBe(true)
    expect(cards[0].key).toBe("legacy:artifacts/old.txt")
  })
  test("平台列表交叉:manifest 已有的不重复;新条目 = cloud-only 可下载", () => {
    const d = descriptorOf("a.md", 0)
    const cloudNew = descriptorOf("new.pdf", 1)
    const cards = deriveCards({
      entries: [entryOf("a.md", "verified", 0)],
      legacyFiles: [],
      cloudArtifacts: [d as unknown as CloudArtifactMeta, cloudNew as unknown as CloudArtifactMeta],
    })
    expect(cards.length).toBe(2)
    expect(cards[1].state).toBe("cloud-only")
    expect(cards[1].downloadable).toBe(true)
    expect(cards[1].descriptor?.id).toBe(cloudNew.id)
    expect(cardPreviewable(cards[1])).toBe(false)
  })
  test("legacy 平台 meta(非完整 descriptor)→ cloud-only 但不合成假 descriptor + 诚实 warning", () => {
    const cards = deriveCards({
      entries: [],
      legacyFiles: [],
      cloudArtifacts: [{ id: "art_job_wb1_9", name: "old-meta.bin", size: 5 }],
    })
    expect(cards[0].state).toBe("cloud-only")
    expect(cards[0].descriptor).toBeUndefined()
    expect(cards[0].warnings.length).toBe(1)
    expect(cards[0].downloadPayload).toEqual({ id: "art_job_wb1_9", name: "old-meta.bin", size: 5 })
  })
  test("detected/claimed MIME 进卡片(local.detectedMime 优先)", () => {
    const e = entryOf("a.md", "verified", 0)
    e.descriptor.claimedMime = "text/markdown"
    e.descriptor.detectedMime = "text/plain"
    e.local.detectedMime = "text/html"
    const cards = deriveCards({ entries: [e], legacyFiles: [] })
    expect(cards[0].claimedMime).toBe("text/markdown")
    expect(cards[0].detectedMime).toBe("text/html")
  })
})

describe("downloadReducer 状态机", () => {
  const step = (s: DownloadPhase, ...evs: Parameters<typeof downloadReducer>[1][]) =>
    evs.reduce((acc, ev) => downloadReducer(acc, ev), s)
  test("happy path:idle → requesting → downloading → done", () => {
    let s: DownloadPhase = { status: "idle" }
    s = step(s, { type: "start" })
    expect(s.status).toBe("requesting")
    expect(downloadBusy(s)).toBe(true)
    s = step(s, { type: "progress", bytes: 10, total: 100, percent: 10 })
    expect(s).toEqual({ status: "downloading", bytes: 10, total: 100, percent: 10 })
    s = step(s, { type: "success" })
    expect(s.status).toBe("done")
    expect(downloadBusy(s)).toBe(false)
  })
  test("终态后到达的进度帧一律忽略(乱序/迟到帧)", () => {
    const done = step({ status: "idle" }, { type: "start" }, { type: "success" })
    expect(downloadReducer(done, { type: "progress", bytes: 99 })).toEqual(done)
    const cancelled = step({ status: "idle" }, { type: "start" }, { type: "cancelled" })
    expect(downloadReducer(cancelled, { type: "progress", bytes: 1 })).toEqual(cancelled)
  })
  test("idle 状态的进度帧忽略(别的窗口/别的 artifact 的广播)", () => {
    expect(downloadReducer({ status: "idle" }, { type: "progress", bytes: 5 })).toEqual({ status: "idle" })
  })
  test("失败/取消/重置", () => {
    const failed = step({ status: "idle" }, { type: "start" }, { type: "failure", message: "network" })
    expect(failed).toEqual({ status: "error", message: "network" })
    expect(downloadReducer(failed, { type: "cancelled" })).toEqual(failed) // 终态不迁移
    expect(downloadReducer(failed, { type: "reset" })).toEqual({ status: "idle" })
  })
  test("下载中重复 start 是 no-op(防双击)", () => {
    const downloading = step({ status: "idle" }, { type: "start" }, { type: "progress", bytes: 1 })
    expect(downloadReducer(downloading, { type: "start" })).toEqual(downloading)
  })
})

// #660 B1:真实完整对象,不再 `as RunArtifactUsage` 强转 —— cast 会让类型层对新增字段
// 的缺失保持沉默(⑦-3 点名的隐藏坑)。
function usageOf(runId: string, updatedAt: string | null): RunArtifactUsage {
  return {
    runId,
    artifactCount: 1,
    recordedBytes: 12,
    diskBytes: 12,
    legacyBytes: 0,
    missingCount: 0,
    readOnly: updatedAt === null,
    updatedAt,
  }
}

describe("排序 / 格式化", () => {
  test("run 按 updatedAt 时间倒序 —— fixture 的编号序与时间序互相矛盾(B1 缺陷修复)", () => {
    // 编号最小的 job_a 时间最新、编号最大的 job_z 时间最旧:
    // 字典序倒序(旧缺陷)给 [job_z, job_m, job_a],按时间必须给 [job_a, job_m, job_z]。
    const runs = [
      usageOf("job_z", "2026-07-26T10:00:00.000Z"),
      usageOf("job_a", "2026-07-28T10:00:00.000Z"),
      usageOf("job_m", "2026-07-27T10:00:00.000Z"),
    ]
    expect(sortRunUsages(runs).map((r) => r.runId)).toEqual(["job_a", "job_m", "job_z"])
  })

  test("updatedAt 缺失/不可解析 → 沉到有真实时间的 run 之后;组内编号倒序(确定,不消失)", () => {
    // 全 null:纯编号倒序。
    expect(
      sortRunUsages([usageOf("job_a", null), usageOf("job_c", null), usageOf("job_b", null)]).map((r) => r.runId),
    ).toEqual(["job_c", "job_b", "job_a"])
    // 不可解析的时间字符串 = 缺失(失败关闭),不得被 Date.parse 的 NaN 搅乱顺序。
    expect(
      sortRunUsages([usageOf("job_a", "not-a-timestamp"), usageOf("job_b", null)]).map((r) => r.runId),
    ).toEqual(["job_b", "job_a"])
    // 时间完全相同 → 编号倒序垫底裁决,输出仍完全确定。
    const same = "2026-07-28T10:00:00.000Z"
    expect(sortRunUsages([usageOf("job_a", same), usageOf("job_b", same)]).map((r) => r.runId)).toEqual([
      "job_b",
      "job_a",
    ])
  })

  // #660 审计 Major-1 的回归 fixture:坏 manifest 的 run 拿着**最大的编号**。
  // 「任一为 null 就回落编号比较」的旧写法在这里把 job_z 排到最前、抢走「最近一次」,
  // 真正最新的 job_a 被压下去;正确结果 = 有真实时间的按时间在前,corrupt 沉底。
  test("混合场:corrupt run 编号最大也不得反超真实最新的 run", () => {
    const runs = [
      usageOf("job_z", null), // corrupt manifest,编号最大
      usageOf("job_a", "2026-07-28T10:00:00.000Z"), // 真实最新
      usageOf("job_m", "2026-07-27T10:00:00.000Z"),
    ]
    expect(sortRunUsages(runs).map((r) => r.runId)).toEqual(["job_a", "job_m", "job_z"])
    // 顺序对输入排列不敏感(全序、传递 —— 混合比较不再产生排列相关的结果)。
    const shuffled = [runs[1]!, runs[2]!, runs[0]!]
    expect(sortRunUsages(shuffled).map((r) => r.runId)).toEqual(["job_a", "job_m", "job_z"])
  })
  test("formatBytes", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(1024)).toBe("1.0 KiB")
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe("5.0 GiB")
    expect(formatBytes(null)).toBe("—")
    expect(formatBytes(-1)).toBe("—")
  })
  test("shortSha", () => {
    expect(shortSha("a".repeat(64))).toBe("aaaaaaaa…aaaaaaaa")
    expect(shortSha(undefined)).toBe("—")
  })
})

describe("选中持久化(REQ-094 AC#3;fake storage)", () => {
  function fakeStorage(): Pick<Storage, "getItem" | "setItem"> & { data: Map<string, string> } {
    const data = new Map<string, string>()
    return {
      data,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    }
  }
  test("remember → recall 闭环;删除 = null", () => {
    const s = fakeStorage()
    rememberSelection("/proj/a", { runId: "job_1", artifactKey: "art_job_1_0_deadbeef" }, s)
    rememberSelection("/proj/b", { runId: "job_2", artifactKey: null }, s)
    expect(recallSelection("/proj/a", s)).toEqual({ runId: "job_1", artifactKey: "art_job_1_0_deadbeef" })
    expect(recallSelection("/proj/b", s)).toEqual({ runId: "job_2", artifactKey: null })
    rememberSelection("/proj/a", null, s)
    expect(recallSelection("/proj/a", s)).toBeNull()
  })
  test("损坏的存储内容 → 安全空档(不抛)", () => {
    const s = fakeStorage()
    s.data.set("alpha-workbench-selection-v1", "{not json")
    expect(recallSelection("/proj/a", s)).toBeNull()
    s.data.set("alpha-workbench-selection-v1", JSON.stringify({ "/proj/a": { runId: 42 } }))
    expect(recallSelection("/proj/a", s)).toBeNull()
  })
})
