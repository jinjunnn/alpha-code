// REQ-236 alpha-code#1551 —— 宿主交付 tracker 的行为判据。真临时目录 + 真 saveCloudRun + 真 artifact-service
// (登记 / 现盘 sha256 复核都是生产实现);只有网络(状态 / 列表 / SSE / 字节下载)与广播是注入的假件。
// 夹具形状取自平台契约 producer 夹具(vendor/alpha-platform contracts v1 cloud-job-status.json / artifact-list.json),
// 只把 size / sha256 换成本测试写盘内容的真实值。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { ArtifactDownloadOutcome } from "./alpha-artifact-download"
import type { SaveRunDeps } from "./alpha-workdir"
import { readArtifactManifest } from "./artifact-manifest"
import { recordRunOrigin, registerDownloadedArtifact, registeredArtifactNameOwner } from "./artifact-service"
import { createCloudRunTracker, DELIVERY_MAX_ATTEMPTS, type CloudRunState, type CloudRunTrackerDeps } from "./cloud-run-tracker"
import type { CloudArtifactDescriptor, CloudArtifactList, CloudJobEvent, CloudJobStatus, CloudResult } from "../preload/types"

const producer = path.join(import.meta.dir, "../../../alpha-contracts-consumer/vendor/alpha-platform/contracts/v1/fixtures/producer")
const STATUS_FIXTURE = (await Bun.file(path.join(producer, "cloud-job-status.json")).json()).value as CloudJobStatus
const LIST_FIXTURE = (await Bun.file(path.join(producer, "artifact-list.json")).json()).value as CloudArtifactList
const RUN = STATUS_FIXTURE.job_id
const CONTENT = "image-bytes!"
const sha = (data: string) => crypto.createHash("sha256").update(data).digest("hex")
const DESCRIPTOR: CloudArtifactDescriptor = { ...LIST_FIXTURE.artifacts[0]!, size: CONTENT.length, sha256: sha(CONTENT) }
const LIST: CloudArtifactList = { ...LIST_FIXTURE, artifacts: [DESCRIPTOR], artifact_ids: [DESCRIPTOR.id] }
const status = (s: CloudJobStatus["status"]): CloudJobStatus => ({ ...STATUS_FIXTURE, status: s })

let projectDir: string
beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-run-tracker-"))
})
afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true })
})

const savedFile = () => path.join(projectDir, ".code-puppy", "runs", RUN, "artifacts", DESCRIPTOR.name!)

async function until(cond: () => boolean, label: string) {
  for (let i = 0; i < 400; i++) {
    if (cond()) return
    await Bun.sleep(2)
  }
  throw new Error(`timed out waiting for ${label}`)
}

type Download = (targetPath: string, signal: AbortSignal) => Promise<ArtifactDownloadOutcome>
const writeOk =
  (content = CONTENT, claimedSha = sha(content)): Download =>
  async (targetPath) => {
    fs.writeFileSync(targetPath, content)
    return { ok: true, path: targetPath, bytes: content.length, sha256: claimedSha, verification: "verified", via: "stream" }
  }

function harness(over: {
  statuses?: CloudResult<CloudJobStatus>[]
  status?: (runId: string) => Promise<CloudResult<CloudJobStatus>>
  lists?: CloudResult<CloudArtifactList>[]
  downloads?: Download[]
  register?: SaveRunDeps["register"]
  wait?: (attempt: number) => Promise<void>
} = {}) {
  const states: CloudRunState[] = []
  const calls: string[] = []
  const waits: number[] = []
  const signals: AbortSignal[] = []
  const sinks: ((ev: CloudJobEvent) => void)[] = []
  const statuses = [...(over.statuses ?? [status("completed")])]
  const lists = [...(over.lists ?? [LIST])]
  const downloads = [...(over.downloads ?? [writeOk()])]
  const ref = { identity: "1:acct-a" }
  const deps: CloudRunTrackerDeps = {
    identity: () => ref.identity,
    status:
      over.status ??
      (async (runId) => {
        calls.push(`status:${runId}`)
        return statuses.length > 1 ? statuses.shift()! : statuses[0]!
      }),
    artifacts: async (runId) => {
      calls.push(`list:${runId}`)
      return lists.length > 1 ? lists.shift()! : lists[0]!
    },
    subscribe: (runId, sink) => {
      calls.push(`subscribe:${runId}`)
      sinks.push(sink)
      return () => calls.push(`unsubscribe:${runId}`)
    },
    saveDeps: (directory, runId, signal) => ({
      download: (_artifact, targetPath) => {
        calls.push("download")
        signals.push(signal)
        const next = downloads.length > 1 ? downloads.shift()! : downloads[0]!
        return next(targetPath, signal)
      },
      register: over.register ?? ((input) => registerDownloadedArtifact(directory, runId, input)),
      artifactNameOwner: (name) => registeredArtifactNameOwner(directory, runId, name),
    }),
    afterSave: () => calls.push("afterSave"),
    broadcast: (state) => states.push(structuredClone(state)),
    wait:
      over.wait ??
      (async (attempt) => {
        waits.push(attempt)
      }),
    log: () => {},
  }
  const tracker = createCloudRunTracker(deps)
  const last = () => states.at(-1)
  const settled = () => until(() => !tracker.isDelivering(projectDir, RUN), "delivery to settle")
  const emit = (ev: CloudJobEvent) => sinks.at(-1)?.(ev)
  return { tracker, states, calls, waits, signals, ref, last, settled, emit, sinks }
}

describe("AC1 the host follows an accepted dispatch to disk without the model awaiting", () => {
  test("受理后不 await 也落盘:queued → SSE 终态 → 列表 → 下载 → 现盘复核 → saved", async () => {
    const h = harness({ statuses: [status("queued"), status("completed")] })
    h.tracker.track({ directory: projectDir, runId: RUN, origin: { sessionID: "ses_a", messageID: "msg_1", partID: "prt_1" } })
    await until(() => h.sinks.length === 1, "SSE subscription")
    h.emit({ event: "job.running", data: {} })
    h.emit({ event: "job.completed", data: { kind: "image-generation" } })
    await h.settled()

    expect(h.last()).toEqual({
      directory: projectDir,
      runId: RUN,
      sessionID: "ses_a",
      job: { status: "completed" },
      delivery: { status: "saved" },
    })
    expect(h.states.map((s) => `${s.job.status}/${s.delivery.status}`)).toEqual([
      "unknown/pending",
      "queued/pending",
      "running/pending",
      "completed/downloading",
      "completed/saved",
    ])
    expect(fs.readFileSync(savedFile(), "utf8")).toBe(CONTENT)
    const manifest = readArtifactManifest(projectDir, RUN)
    expect(manifest.ok && manifest.manifest?.artifacts.map((e) => [e.descriptor.id, e.local.state])).toEqual([[DESCRIPTOR.id, "verified"]])
    expect(h.calls).toContain(`unsubscribe:${RUN}`)
  })
})

describe("AC2 saved means the full listed set is registered and re-verified on disk", () => {
  test("列表失败判 failed(范围 list),不说 saved", async () => {
    const h = harness({ lists: [{ error: "forbidden" }] })
    h.tracker.track({ directory: projectDir, runId: RUN })
    await h.settled()
    expect(h.last()?.delivery).toEqual({ status: "failed", failure: { scope: "list", code: "forbidden" } })
    expect(h.states.some((s) => s.delivery.status === "saved")).toBe(false)
  })

  test("下载失败判 failed(范围 download,带产物 id)", async () => {
    const h = harness({ downloads: [async () => ({ ok: false, error: "not-found" })] })
    h.tracker.track({ directory: projectDir, runId: RUN })
    await h.settled()
    expect(h.last()?.delivery).toEqual({ status: "failed", failure: { scope: "download", artifactId: DESCRIPTOR.id, code: "not-found" } })
  })

  test("登记失败判 failed(范围 register),即使字节已在盘上", async () => {
    const h = harness({ register: () => ({ ok: false, reason: "manifest is read-only: corrupt (x)" }) })
    h.tracker.track({ directory: projectDir, runId: RUN })
    await h.settled()
    expect(fs.existsSync(savedFile())).toBe(true)
    expect(h.last()?.delivery).toEqual({ status: "failed", failure: { scope: "register", artifactId: DESCRIPTOR.id, code: "register-failed" } })
  })

  test("本地文件改坏后不判 saved:落盘内容与声称的摘要不符 → 现盘复核失败", async () => {
    // 下载器声称写下了 descriptor 的摘要,盘上实际是另一份同长度内容 —— 只有现盘 sha256 复核能拦住。
    const h = harness({ downloads: [writeOk("image-bytes?", DESCRIPTOR.sha256)] })
    h.tracker.track({ directory: projectDir, runId: RUN })
    await h.settled()
    expect(h.last()?.delivery).toEqual({ status: "failed", failure: { scope: "verify", artifactId: DESCRIPTOR.id, code: "sha256-mismatch" } })
  })

  test("本地文件改坏后不判 saved:已 saved 的 run 文件被改,重新核验即翻成 failed", async () => {
    const h = harness()
    h.tracker.track({ directory: projectDir, runId: RUN })
    await h.settled()
    expect(h.last()?.delivery.status).toBe("saved")
    fs.writeFileSync(savedFile(), "image-bytes?") // 同长度改内容(stat 级 reconcile 看不出来)
    await h.tracker.reverify(projectDir, RUN)
    expect(h.last()?.delivery).toEqual({ status: "failed", failure: { scope: "verify", artifactId: DESCRIPTOR.id, code: "sha256-mismatch" } })
  })
})

describe("AC3 transient failures retry (bounded), deterministic ones do not, and nothing is re-dispatched", () => {
  test("瞬态重试:network 两次后成功,共 3 次尝试;重试只重取与重下,不调用派发", async () => {
    const network = async (): Promise<ArtifactDownloadOutcome> => ({ ok: false, error: "network", detail: "reset" })
    const h = harness({ downloads: [network, network, writeOk()] })
    h.tracker.track({ directory: projectDir, runId: RUN })
    await h.settled()
    expect(h.last()?.delivery.status).toBe("saved")
    expect(h.waits).toEqual([1, 2])
    expect(h.calls.filter((c) => c === "download")).toHaveLength(3)
    // 交付只走注入的状态 / 列表 / 下载三条通道;没有任何派发入口可调。
    expect(h.calls.every((c) => /^(status|list|download|afterSave)/.test(c))).toBe(true)
  })

  test("瞬态上限:http-503 连续失败在第 3 次尝试后判 failed", async () => {
    const h = harness({ downloads: [async () => ({ ok: false, error: "http-503" })] })
    h.tracker.track({ directory: projectDir, runId: RUN })
    await h.settled()
    expect(DELIVERY_MAX_ATTEMPTS).toBe(3)
    expect(h.calls.filter((c) => c === "download")).toHaveLength(3)
    expect(h.last()?.delivery).toEqual({ status: "failed", failure: { scope: "download", artifactId: DESCRIPTOR.id, code: "http-503" } })
  })

  test.each(["sha256-mismatch", "unverifiable", "over-limit", "not-found", "forbidden", "unauthorized"])(
    "确定性不重试:%s 只尝试一次",
    async (code) => {
      const h = harness({ downloads: [async () => ({ ok: false, error: code })] })
      h.tracker.track({ directory: projectDir, runId: RUN })
      await h.settled()
      expect(h.calls.filter((c) => c === "download")).toHaveLength(1)
      expect(h.waits).toEqual([])
      expect(h.last()?.delivery.failure?.code).toBe(code)
    },
  )

  test("列表的瞬态失败同样重试(retryable → 成功)", async () => {
    const h = harness({ lists: [{ error: "retryable" }, LIST] })
    h.tracker.track({ directory: projectDir, runId: RUN })
    await h.settled()
    expect(h.waits).toEqual([1])
    expect(h.last()?.delivery.status).toBe("saved")
  })
})

describe("AC4 attribution comes only from an accepted dispatch", () => {
  test("status/await 命中不写归属:不带 origin 的 track 不建归属,也不改已有归属", async () => {
    const h = harness()
    h.tracker.track({ directory: projectDir, runId: RUN })
    await h.settled()
    const plain = readArtifactManifest(projectDir, RUN)
    expect(plain.ok && plain.manifest && "origin" in plain.manifest).toBe(false)
    expect(h.last()?.sessionID).toBeNull()

    const other = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-run-tracker-origin-"))
    try {
      expect(recordRunOrigin(other, RUN, { sessionID: "ses_dispatcher" }).ok).toBe(true)
      const h2 = harness()
      h2.tracker.track({ directory: other, runId: RUN })
      await until(() => !h2.tracker.isDelivering(other, RUN), "second delivery")
      const read = readArtifactManifest(other, RUN)
      expect(read.ok && read.manifest?.origin?.sessionID).toBe("ses_dispatcher")
      expect(h2.last()?.sessionID).toBe("ses_dispatcher")
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  })

  test("dispatch 的 origin 先写者胜:另一会话的 origin 不覆盖", async () => {
    const h = harness()
    h.tracker.track({ directory: projectDir, runId: RUN, origin: { sessionID: "ses_first" } })
    h.tracker.track({ directory: projectDir, runId: RUN, origin: { sessionID: "ses_second" } })
    await h.settled()
    const read = readArtifactManifest(projectDir, RUN)
    expect(read.ok && read.manifest?.origin?.sessionID).toBe("ses_first")
  })
})

describe("AC5 one coordinator per run", () => {
  test("单飞:在途时再次 track / retry 不另起交付", async () => {
    let release: (value: CloudResult<CloudJobStatus>) => void = () => {}
    let statusCalls = 0
    const h = harness({
      status: () => {
        statusCalls++
        return new Promise((resolve) => (release = resolve))
      },
    })
    h.tracker.track({ directory: projectDir, runId: RUN })
    h.tracker.track({ directory: projectDir, runId: RUN })
    h.tracker.retry(projectDir, RUN)
    expect(h.tracker.isDelivering(projectDir, RUN)).toBe(true)
    expect(statusCalls).toBe(1)
    release(status("completed"))
    await h.settled()
    expect(statusCalls).toBe(1)
    expect(h.calls.filter((c) => c === "download")).toHaveLength(1)
    expect(h.last()?.delivery.status).toBe("saved")
  })

  test("单件下载成功后 reverify 广播 saved", async () => {
    const h = harness({ downloads: [async () => ({ ok: false, error: "not-found" })] })
    h.tracker.track({ directory: projectDir, runId: RUN })
    await h.settled()
    expect(h.last()?.delivery.status).toBe("failed")
    // 面板单件下载(cloud-ipc 的 cloud-artifact-download)落盘并登记成功之后:
    fs.mkdirSync(path.dirname(savedFile()), { recursive: true })
    fs.writeFileSync(savedFile(), CONTENT)
    expect(
      registerDownloadedArtifact(projectDir, RUN, { descriptor: DESCRIPTOR, savedPath: `artifacts/${DESCRIPTOR.name}`, verifiedSha256: sha(CONTENT) }).ok,
    ).toBe(true)
    await h.tracker.reverify(projectDir, RUN)
    expect(h.last()).toMatchObject({ runId: RUN, job: { status: "completed" }, delivery: { status: "saved" } })
    expect(h.tracker.get(projectDir, RUN)?.delivery.status).toBe("saved")
  })

  test("retry 在交付落定之后另起一轮(时间线「重新下载」)", async () => {
    const h = harness({ downloads: [async () => ({ ok: false, error: "not-found" }), writeOk()] })
    h.tracker.track({ directory: projectDir, runId: RUN })
    await h.settled()
    expect(h.last()?.delivery.status).toBe("failed")
    h.tracker.retry(projectDir, RUN)
    await h.settled()
    expect(h.last()?.delivery.status).toBe("saved")
  })
})

describe("AC6 every delivery is bound to the login identity it started under", () => {
  test("换代后迟到帧被丢弃:换号后到达的 SSE 终态不再推进、不再广播", async () => {
    const h = harness({ statuses: [status("queued"), status("completed")] })
    h.tracker.track({ directory: projectDir, runId: RUN })
    await until(() => h.sinks.length === 1, "SSE subscription")
    const before = h.states.length
    h.ref.identity = "2:acct-b"
    h.tracker.onAuthChanged()
    h.emit({ event: "job.completed", data: {} })
    await Bun.sleep(20)
    expect(h.states.length).toBe(before)
    expect(h.calls.filter((c) => c.startsWith("status"))).toHaveLength(1)
    expect(h.calls).toContain(`unsubscribe:${RUN}`)
    expect(h.tracker.isDelivering(projectDir, RUN)).toBe(false)
    expect(h.tracker.get(projectDir, RUN)).toBeNull()
  })

  test("每个回调点自己比对身份代:换代通知还没到,迟到的 SSE 终态也不推进", async () => {
    const h = harness({ statuses: [status("queued"), status("completed")] })
    h.tracker.track({ directory: projectDir, runId: RUN })
    await until(() => h.sinks.length === 1, "SSE subscription")
    const before = h.states.length
    h.ref.identity = "2:acct-b" // 身份已变,onAuthChanged 尚未调用
    h.emit({ event: "job.completed", data: {} })
    await Bun.sleep(20)
    expect(h.states.length).toBe(before)
    expect(h.calls.filter((c) => c.startsWith("status"))).toHaveLength(1)
  })

  test("换代后迟到的状态回包被丢弃", async () => {
    let release: (value: CloudResult<CloudJobStatus>) => void = () => {}
    const h = harness({ status: () => new Promise((resolve) => (release = resolve)) })
    h.tracker.track({ directory: projectDir, runId: RUN })
    const before = h.states.length
    h.ref.identity = "2:acct-b"
    h.tracker.onAuthChanged()
    release(status("completed"))
    await Bun.sleep(20)
    expect(h.states.length).toBe(before)
    expect(h.calls.some((c) => c.startsWith("list") || c === "download")).toBe(false)
  })

  test("换代后待醒的重试被丢弃", async () => {
    let wake: () => void = () => {}
    const h = harness({
      downloads: [async () => ({ ok: false, error: "network" }), writeOk()],
      wait: () => new Promise<void>((resolve) => (wake = resolve)),
    })
    h.tracker.track({ directory: projectDir, runId: RUN })
    await until(() => h.calls.includes("download"), "first download")
    await Bun.sleep(5)
    const before = h.states.length
    h.ref.identity = "2:acct-b"
    h.tracker.onAuthChanged()
    wake()
    await Bun.sleep(20)
    expect(h.calls.filter((c) => c === "download")).toHaveLength(1)
    expect(h.states.length).toBe(before)
  })

  test("换代时在途下载被 abort", async () => {
    let aborted = false
    const h = harness({
      downloads: [
        (_target, signal) =>
          new Promise((resolve) =>
            signal.addEventListener("abort", () => {
              aborted = true
              resolve({ ok: false, error: "cancelled", cancelled: true })
            }),
          ),
      ],
    })
    h.tracker.track({ directory: projectDir, runId: RUN })
    await until(() => h.calls.includes("download"), "download start")
    h.ref.identity = "2:acct-b"
    h.tracker.onAuthChanged()
    await until(() => aborted, "abort")
    expect(h.signals[0]?.aborted).toBe(true)
    await Bun.sleep(10)
    expect(h.states.some((s) => s.delivery.status === "failed" || s.delivery.status === "saved")).toBe(false)
  })

  test("同账户续期不打断:身份代不变时 onAuthChanged 不 abort,交付照常 saved", async () => {
    let finish: () => void = () => {}
    const h = harness({
      downloads: [
        async (targetPath, signal) => {
          await new Promise<void>((resolve) => (finish = resolve))
          if (signal.aborted) return { ok: false, error: "cancelled", cancelled: true }
          return writeOk()(targetPath, signal)
        },
      ],
    })
    h.tracker.track({ directory: projectDir, runId: RUN })
    await until(() => h.calls.includes("download"), "download start")
    h.tracker.onAuthChanged() // 续期:epoch 与账户标签都没变
    finish()
    await h.settled()
    expect(h.signals[0]?.aborted).toBe(false)
    expect(h.last()?.delivery.status).toBe("saved")
  })
})
