// #420(REQ-115 AC1 / AC3 / AC5 正文):云任务终态 → macOS 系统通知的**接线**闸门。
//
// 断言从生产入口出发,不是从 notify 函数出发:
//   · SSE 路 —— 真 registerCloudIpcHandlers 挂上的 cloud-subscribe handler,拿到它交给
//     subscribeCloudJobEvents 的 sink,往 sink 里灌终态帧,看 electron.Notification 有没有被 new + show;
//   · 会话事件流路 —— 真 cloud-save-run handler + **真 saveCloudRun**(alpha-workdir,写临时目录),
//     只桩掉网络(getCloudJobStatus / listCloudArtifacts),看状态查询回 completed / failed 时通不通知。
// 摘掉 cloud-ipc.ts 里任一处接线,对应那组当场红(本文件先于接线写成,红过)。
//
// 子进程运行(cloud-job-notify.test.ts spawn):mock.module("electron") 是进程级的,同进程会漏进
// `bun test src` 里别的文件。顺序纪律:`await import("./cloud-ipc")` 必须排在全部 mock.module 之后。

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { isTerminalCloudEvent } from "./alpha-cloud-events-core"
import type { CloudJobEvent, CloudJobStatus, CloudResult } from "../preload/types"

type Shown = { title: string; body?: string; shown: boolean; clicks: Array<() => void> }
const shown: Shown[] = []

/** 生产代码注册到 ipcMain 上的 handler —— 测试只能经这里拿到它。 */
const handlers = new Map<string, (...args: unknown[]) => unknown>()
/** cloud-subscribe 交给 subscribeCloudJobEvents 的 sink,按 jobId 收集(同 job 多次订阅 → 多个 sink)。 */
const sinks = new Map<string, Array<(ev: CloudJobEvent) => void>>()
/** cloud-save-run 里的状态查询桩:逐条用例改写。 */
let statusResult: CloudResult<CloudJobStatus> = { error: "unused" }

mock.module("electron", () => ({
  Notification: class {
    private record: Shown
    constructor(opts: { title: string; body?: string }) {
      this.record = { title: opts.title, body: opts.body, shown: false, clicks: [] }
      shown.push(this.record)
    }
    on(event: string, cb: () => void) {
      if (event === "click") this.record.clicks.push(cb)
      return this
    }
    show() {
      this.record.shown = true
    }
  },
  BrowserWindow: {
    getAllWindows: () => [],
    fromWebContents: () => undefined,
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    },
  },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}))
mock.module("./logging", () => ({
  getLogger: () => ({ log: () => {}, warn: () => {}, error: () => {} }),
}))
mock.module("./artifact-service", () => ({
  finalizeArtifactWithQuota: () => ({ ok: false, reason: "unused in this harness" }),
  registerDownloadedArtifact: () => ({ ok: false, reason: "unused in this harness" }),
  registeredArtifactNameOwner: () => undefined,
}))
mock.module("./alpha-cloud-jobs", () => ({
  dispatchCloudJob: async () => ({ error: "unused" }),
  dispatchExplicitCloudUpload: async () => ({ error: "unused" }),
  getCloudJobStatus: async () => statusResult,
  cancelCloudJob: async () => ({ error: "unused" }),
  listCloudArtifacts: async () => ({ error: "unused" }),
  downloadCloudArtifactTo: async () => ({ ok: false, error: "unused" }),
}))
mock.module("./alpha-cloud-events", () => ({
  isTerminalCloudEvent,
  subscribeCloudJobEvents: (jobId: string, sink: (ev: CloudJobEvent) => void) => {
    sinks.set(jobId, [...(sinks.get(jobId) ?? []), sink])
    return () => {}
  },
}))
mock.module("./alpha-auth", () => ({
  getAccessTokenIdentity: async () => ({ error: "unused" }),
}))
mock.module("./alpha-web-upload-consent", () => ({
  requestUploadConsent: async () => ({ error: "unused" }),
}))
mock.module("./alpha-upload", () => ({
  assertSafeUploadResult: (value: unknown) => value,
  createMainUploadService: () => ({
    prepare: async () => ({ status: "cancelled" }),
    confirm: async () => ({ status: "cancelled" }),
    cancel: () => ({ status: "cancelled" }),
    clear: () => {},
  }),
}))

const { registerCloudIpcHandlers } = await import("./cloud-ipc")
registerCloudIpcHandlers()
const subscribe = handlers.get("cloud-subscribe")!
const saveRun = handlers.get("cloud-save-run")!

let senderSeq = 0
const fakeSender = () => ({
  id: ++senderSeq,
  isDestroyed: () => false,
  send: () => {},
  once: () => {},
  removeListener: () => {},
})

/** 经生产 handler 订阅,再把帧灌进它交出去的 sink(第 n 个订阅者 = 第 n 个 sink)。 */
async function subscribeAndFeed(jobId: string, events: CloudJobEvent[], subscriber = 0) {
  await subscribe({ sender: fakeSender() }, jobId)
  const sink = sinks.get(jobId)?.[subscriber]
  expect(sink, `cloud-subscribe 没把 ${jobId} 的 sink 交给 subscribeCloudJobEvents`).toBeDefined()
  for (const ev of events) sink!(ev)
}

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac420-notify-"))
afterAll(() => fs.rmSync(projectDir, { recursive: true, force: true }))

const status = (jobId: string, state: CloudJobStatus["status"], extra: Partial<CloudJobStatus> = {}): CloudJobStatus => ({
  schema_version: 1,
  job_id: jobId,
  status: state,
  autonomy: "bounded-agent",
  progress: { phase: "done" },
  artifact_ids: [],
  error: null,
  ...extra,
})

beforeEach(() => {
  shown.length = 0
  statusResult = { error: "unused" }
})

describe("#420 SSE 终态帧 → 系统通知(cloud-subscribe 的 sink 是生产入口)", () => {
  test("job.completed → 恰一条通知,标题写完成,正文 = 种类 · job id", async () => {
    await subscribeAndFeed("job_sse_ok", [
      { event: "job.running", data: { phase: "exec" }, id: "1" },
      { event: "job.completed", data: { kind: "code-review" }, id: "2" },
    ])
    expect(shown.length).toBe(1)
    expect(shown[0]!.shown).toBe(true)
    expect(shown[0]!.title).toBe("云任务已完成")
    expect(shown[0]!.body).toBe("code-review · job_sse_ok")
  })

  test("job.failed → 恰一条通知,标题写失败;event: 缺失时从 data.type 兜底同样命中", async () => {
    await subscribeAndFeed("job_sse_fail", [{ event: "job.failed", data: { reason: "harness exploded" }, id: "1" }])
    expect(shown.length).toBe(1)
    expect(shown[0]!.title).toBe("云任务失败")
    expect(shown[0]!.body).toBe("job_sse_fail")
    // 正文不带平台的 reason 文案。
    expect(shown[0]!.body).not.toContain("harness exploded")

    await subscribeAndFeed("job_sse_msg", [{ event: "message", data: { type: "job.completed" }, id: "1" }])
    expect(shown.length).toBe(2)
    expect(shown[1]!.title).toBe("云任务已完成")
  })

  test("job.cancelled(用户主动取消)与非终态帧都不通知", async () => {
    await subscribeAndFeed("job_sse_cancel", [
      { event: "job.snapshot", data: { status: "running" }, id: "1" },
      { event: "workflow.step.completed", data: { step: 1 }, id: "2" },
      { event: "job.cancelled", data: { reason: "cancelled by user" }, id: "3" },
    ])
    expect(shown.length).toBe(0)
  })

  test("同一 job 同一终态重复到达 —— SSE 重连重放 / 第二个窗口各自订阅 —— 只通知一次", async () => {
    const terminal: CloudJobEvent = { event: "job.completed", data: { kind: "docs" }, id: "9" }
    await subscribeAndFeed("job_sse_dup", [terminal, terminal])
    // 第二个窗口订阅同一个 job:生产 key = `${wc.id}:${jobId}`,不同窗口各自持一个 sink。
    await subscribeAndFeed("job_sse_dup", [terminal], 1)
    expect(sinks.get("job_sse_dup")!.length).toBe(2)
    expect(shown.length).toBe(1)
  })
})

describe("#420 会话事件流发现的终态 → 经 cloud-save-run 的状态查询通知(真 saveCloudRun,临时目录)", () => {
  test("status=failed → 恰一条通知;正文不含 error 文案 / result 内容 / 本地路径", async () => {
    statusResult = status("job_run_fail", "failed", {
      kind: "research",
      error: "SECRET-ERROR-TEXT",
      result: { text: "SECRET-RESULT" },
    })
    const saved = (await saveRun({ sender: fakeSender() }, projectDir, "job_run_fail")) as { ok: boolean; reason?: string }
    expect(saved.ok, saved.reason).toBe(true)
    expect(shown.length).toBe(1)
    expect(shown[0]!.title).toBe("云任务失败")
    expect(shown[0]!.body).toBe("research · job_run_fail")
    const text = `${shown[0]!.title}\n${shown[0]!.body}`
    expect(text).not.toContain("SECRET")
    expect(text).not.toContain(projectDir)
  })

  test("status=completed → 恰一条通知;status=cancelled → 不通知", async () => {
    statusResult = status("job_run_ok", "completed")
    expect(((await saveRun({ sender: fakeSender() }, projectDir, "job_run_ok")) as { ok: boolean }).ok).toBe(true)
    expect(shown.length).toBe(1)
    expect(shown[0]!.title).toBe("云任务已完成")
    expect(shown[0]!.body).toBe("job_run_ok")

    statusResult = status("job_run_cancel", "cancelled")
    expect(((await saveRun({ sender: fakeSender() }, projectDir, "job_run_cancel")) as { ok: boolean }).ok).toBe(true)
    expect(shown.length).toBe(1)
  })

  test("状态查询失败(传输错误信封)→ 不通知,saveRun 照旧报失败", async () => {
    statusResult = { error: "network" }
    const saved = (await saveRun({ sender: fakeSender() }, projectDir, "job_run_neterr")) as { ok: boolean }
    expect(saved.ok).toBe(false)
    expect(shown.length).toBe(0)
  })

  test("界面派发的任务两路都到 —— SSE 终态先弹,随后 finish → saveRun 的状态查询不再弹", async () => {
    await subscribeAndFeed("job_both", [{ event: "job.completed", data: { kind: "code-review" }, id: "3" }])
    expect(shown.length).toBe(1)
    statusResult = status("job_both", "completed", { kind: "code-review" })
    expect(((await saveRun({ sender: fakeSender() }, projectDir, "job_both")) as { ok: boolean }).ok).toBe(true)
    expect(shown.length).toBe(1)
  })
})
