// alpha cloud jobs IPC (main process). Mirrors account-ipc.ts: thin handlers dispatching/polling cloud
// jobs on the alpha-platform (B) `cloud` worker using the main-held JWT (alpha-cloud-jobs.ts). The
// renderer receives only the resolved result, never the token.

import { ipcMain, type IpcMainInvokeEvent } from "electron"
import { dispatchCloudJob, getCloudJobStatus } from "./alpha-cloud-jobs"
import type { CloudJobEnvelope } from "../preload/types"

export function registerCloudIpcHandlers() {
  ipcMain.handle("cloud-dispatch", (_event: IpcMainInvokeEvent, envelope: CloudJobEnvelope) => dispatchCloudJob(envelope))
  ipcMain.handle("cloud-status", (_event: IpcMainInvokeEvent, jobId: string) => getCloudJobStatus(jobId))
}
