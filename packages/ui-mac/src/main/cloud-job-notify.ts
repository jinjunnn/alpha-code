// #420(REQ-115 收窄):owner 的云任务在桌面运行期间进入 completed / failed 终态 → 一条 macOS 系统通知。
//
// main 进程的唯一咽喉;桌面既有的两条终态发现通路都汇到这里(接线在 cloud-ipc.ts):
//   · SSE 订阅的 sink —— 界面派发的任务(cloud-dispatch-box)订阅 /events,alpha-cloud-events 识别终态帧;
//   · cloud-save-run 里的状态查询 —— 助手经 MCP 调的任务由 renderer CloudRunWatcher 从会话事件流发现,
//     它没有 SSE 订阅,saveRun 时的 GET /v1/cloud/jobs/:id 是 main 侧唯一看得见终态的地方。
// 去重:jobId + 终态,进程级 —— SSE 重连重放、两个窗口各自订阅、SSE 与 saveRun 双路到达,只弹一次。
// 不通知:job.cancelled(用户主动取消)、非终态、状态查询的传输错误信封。桌面未运行期间结束的任务
// 没有推送来源,不在范围 —— alpha-cloud-schedules 的开机拉回直接调 saveCloudRun,不经本咽喉。
// 正文只含任务种类 + job id + 结果;刻意不读 objective / input / result / error 文案 / 本地路径。
// 开关:票面要的设置项在已批设计稿(docs/design/current/settings)里没有对应行 —— 本次默认开启、
// 不建界面(PR 正文有说明)。
import { BrowserWindow, Notification } from "electron"
import { terminalEventName } from "./alpha-cloud-events-core"
import type { CloudJobEvent, CloudJobStatus, CloudResult } from "../preload/types"

export type CloudJobFinishedNotice = { jobId: string; outcome: "completed" | "failed"; kind?: string }

/** SSE 帧 → 通知意图;取消 / 非终态 → null。kind 来自平台 pipelines 终态帧的 data({ kind }),agent 任务不带。 */
export function noticeFromCloudEvent(jobId: string, ev: CloudJobEvent): CloudJobFinishedNotice | null {
  const name = terminalEventName(ev)
  if (name !== "job.completed" && name !== "job.failed") return null
  const kind = ev.data && typeof ev.data === "object" ? (ev.data as { kind?: unknown }).kind : undefined
  return {
    jobId,
    outcome: name === "job.completed" ? "completed" : "failed",
    ...(typeof kind === "string" && kind ? { kind } : {}),
  }
}

/** 状态查询结果 → 通知意图;传输错误信封 / 非终态 / cancelled → null。 */
export function noticeFromCloudStatus(status: CloudResult<CloudJobStatus>): CloudJobFinishedNotice | null {
  if (!status || typeof status !== "object" || !("job_id" in status)) return null
  if (status.status !== "completed" && status.status !== "failed") return null
  return { jobId: status.job_id, outcome: status.status, ...(status.kind ? { kind: status.kind } : {}) }
}

/** 通知文案:标题 = 结果,正文 = 任务种类 + job id。 */
export function cloudJobNoticeText(notice: CloudJobFinishedNotice): { title: string; body: string } {
  return {
    title: notice.outcome === "completed" ? "云任务已完成" : "云任务失败",
    body: notice.kind ? `${notice.kind} · ${notice.jobId}` : notice.jobId,
  }
}

const notified = new Set<string>()

/** 去重后弹系统通知;返回本次是否真的弹了。 */
export function notifyCloudJobFinished(notice: CloudJobFinishedNotice | null): boolean {
  if (!notice) return false
  const key = `${notice.jobId}:${notice.outcome}`
  if (notified.has(key)) return false
  notified.add(key)
  const n = new Notification(cloudJobNoticeText(notice))
  // 与 automation-scheduler 同款:点通知把窗口带到前台。
  n.on("click", () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      win.show()
      win.focus()
    }
  })
  n.show()
  return true
}
