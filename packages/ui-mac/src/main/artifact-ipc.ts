// run artifact manifest IPC(REQ-093 A 侧,alpha-code#185)—— renderer 的只读查询面。
// 薄 wiring:参数字符串校验后直调 artifact-service(全部业务/守卫逻辑在那里,electron-free 可单测)。
//
// 边界(与 cloud-ipc.ts 同风格):
//   · 只读 —— list / inspect / usage;不下载字节(下载归 #184 云 artifact 通道)、不删除
//     (GC 钩子是 main 内部服务面,策略未定前不给 renderer 写面);
//   · 响应内无 bearer、无绝对路径 —— entry.local.savedPath 是 run 目录内相对路径,
//     descriptor.contentRef.url 是 server-relative 路径(manifest 写入时已强制)。

import { ipcMain, type IpcMainInvokeEvent } from "electron"
import { listRunArtifacts, projectArtifactUsage, resolveArtifact, runArtifactUsage } from "./artifact-service"

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0

export function registerArtifactIpcHandlers() {
  ipcMain.handle("run-artifacts-list", (_e: IpcMainInvokeEvent, directory: unknown, runId: unknown) =>
    str(directory) && str(runId) ? listRunArtifacts(directory, runId) : { ok: false as const, reason: "invalid arguments" },
  )
  ipcMain.handle("run-artifact-inspect", (_e: IpcMainInvokeEvent, directory: unknown, runId: unknown, artifactId: unknown) =>
    str(directory) && str(runId) && str(artifactId)
      ? resolveArtifact(directory, runId, artifactId)
      : { ok: false as const, reason: "invalid arguments" },
  )
  ipcMain.handle("run-artifacts-usage", (_e: IpcMainInvokeEvent, directory: unknown, runId?: unknown) => {
    if (!str(directory)) return { ok: false as const, reason: "invalid arguments" }
    if (runId === undefined || runId === null) return projectArtifactUsage(directory)
    return str(runId) ? runArtifactUsage(directory, runId) : { ok: false as const, reason: "invalid arguments" }
  })
}
