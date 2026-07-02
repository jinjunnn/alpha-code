// alpha cloud jobs IPC (main process). Mirrors account-ipc.ts: thin handlers dispatching/polling cloud
// jobs on the alpha-platform (B) `cloud` worker using the main-held JWT (alpha-cloud-jobs.ts). The
// renderer receives only the resolved result, never the token.
//
// 阶段二:+ artifact 列表/下载(alpha-cloud-jobs)+ SSE 进度订阅(alpha-cloud-events)。SSE 事件经
// event.sender.send("cloud-job-event", …) 推给对应 renderer;订阅按 (webContents, jobId) 记账,窗口销毁自动清。

import { ipcMain, type IpcMainInvokeEvent } from "electron"
import { dispatchCloudJob, getCloudJobStatus, cancelCloudJob, listCloudArtifacts, fetchCloudArtifact } from "./alpha-cloud-jobs"
import { subscribeCloudJobEvents } from "./alpha-cloud-events"
import type { CloudJobEnvelope } from "../preload/types"

// 活跃订阅:key = `${webContentsId}:${jobId}` → unsubscribe。
const subs = new Map<string, () => void>()

export function registerCloudIpcHandlers() {
  ipcMain.handle("cloud-dispatch", (_e: IpcMainInvokeEvent, envelope: CloudJobEnvelope) => dispatchCloudJob(envelope))
  ipcMain.handle("cloud-status", (_e: IpcMainInvokeEvent, jobId: string) => getCloudJobStatus(jobId))
  ipcMain.handle("cloud-cancel", (_e: IpcMainInvokeEvent, jobId: string) => cancelCloudJob(jobId))
  ipcMain.handle("cloud-artifacts", (_e: IpcMainInvokeEvent, jobId: string) => listCloudArtifacts(jobId))
  ipcMain.handle("cloud-artifact-content", (_e: IpcMainInvokeEvent, artifactId: string) => fetchCloudArtifact(artifactId))

  // 订阅 job 进度(SSE)→ 推 "cloud-job-event" 给发起的 renderer。幂等(同 wc+job 只订一次)。
  ipcMain.handle("cloud-subscribe", (e: IpcMainInvokeEvent, jobId: string) => {
    const wc = e.sender
    const key = `${wc.id}:${jobId}`
    if (subs.has(key)) return { ok: true }
    const unsub = subscribeCloudJobEvents(jobId, (ev) => {
      if (!wc.isDestroyed()) wc.send("cloud-job-event", { jobId, ...ev })
    })
    subs.set(key, unsub)
    wc.once("destroyed", () => { unsub(); subs.delete(key) })
    return { ok: true }
  })

  ipcMain.handle("cloud-unsubscribe", (e: IpcMainInvokeEvent, jobId: string) => {
    const key = `${e.sender.id}:${jobId}`
    const unsub = subs.get(key)
    if (unsub) { unsub(); subs.delete(key) }
    return { ok: true }
  })
}
