// alpha cloud jobs IPC (main process). Mirrors account-ipc.ts: thin handlers dispatching/polling cloud
// jobs on the alpha-platform (B) `cloud` worker using the main-held JWT (alpha-cloud-jobs.ts). The
// renderer receives only the resolved result, never the token.
//
// 阶段二:+ artifact 列表/下载(alpha-cloud-jobs)+ SSE 进度订阅(alpha-cloud-events)。SSE 事件经
// event.sender.send("cloud-job-event", …) 推给对应 renderer;订阅按 (webContents, jobId) 记账,窗口销毁自动清。

import { ipcMain, type IpcMainInvokeEvent } from "electron"
import { execFile } from "node:child_process"
import * as fs from "node:fs"
import { dispatchCloudJob, getCloudJobStatus, cancelCloudJob, listCloudArtifacts, fetchCloudArtifact } from "./alpha-cloud-jobs"
import { isTerminalCloudEvent, subscribeCloudJobEvents } from "./alpha-cloud-events"
import { saveCloudRun } from "./alpha-workdir"
import type { CloudJobEnvelope } from "../preload/types"

// REQ-020 T4(ADR-021 §1 diff-only):hub 的 code-review dispatch 入口只送 diff,不送全库。
// 工作树有变更 → `git diff HEAD`(含 staged);干净 → 回退最近一次 commit 的 diff(e2e 常在干净树上跑)。
// 只读操作(git diff 无副作用);超 8MB 直接砍 buffer 报错 —— 上限最终由 dispatch 的 1MB 信封帽把关。
function gitDiff(directory: string): Promise<{ ok: true; diff: string; source: "worktree" | "last-commit" } | { ok: false; reason: string }> {
  const run = (args: string[]) =>
    new Promise<{ ok: boolean; out: string }>((resolve) => {
      execFile("git", args, { cwd: directory, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
        resolve({ ok: !err, out: stdout ?? "" }),
      )
    })
  return (async () => {
    try {
      if (!fs.statSync(directory).isDirectory()) return { ok: false as const, reason: "not a directory" }
    } catch {
      return { ok: false as const, reason: "not a directory" }
    }
    const worktree = await run(["diff", "HEAD"])
    if (!worktree.ok) return { ok: false as const, reason: "git diff failed(不是 git 仓库?)" }
    if (worktree.out.trim()) return { ok: true as const, diff: worktree.out, source: "worktree" as const }
    const last = await run(["diff", "HEAD~1..HEAD"])
    if (last.ok && last.out.trim()) return { ok: true as const, diff: last.out, source: "last-commit" as const }
    return { ok: false as const, reason: "no-diff" }
  })()
}

// 活跃订阅:key = `${webContentsId}:${jobId}` → unsubscribe。
const subs = new Map<string, () => void>()

export function registerCloudIpcHandlers() {
  ipcMain.handle("cloud-dispatch", (_e: IpcMainInvokeEvent, envelope: CloudJobEnvelope) => dispatchCloudJob(envelope))
  ipcMain.handle("cloud-status", (_e: IpcMainInvokeEvent, jobId: string) => getCloudJobStatus(jobId))
  ipcMain.handle("cloud-cancel", (_e: IpcMainInvokeEvent, jobId: string) => cancelCloudJob(jobId))
  ipcMain.handle("cloud-artifacts", (_e: IpcMainInvokeEvent, jobId: string) => listCloudArtifacts(jobId))
  ipcMain.handle("cloud-artifact-content", (_e: IpcMainInvokeEvent, artifactId: string) => fetchCloudArtifact(artifactId))
  ipcMain.handle("cloud-git-diff", (_e: IpcMainInvokeEvent, directory: string) =>
    typeof directory === "string" && directory ? gitDiff(directory) : { ok: false, reason: "invalid directory" })

  // B3/ADR-019:把一个终态 run 回流写进 <directory>/.alpha/runs/<runId>/(status/contract/artifacts)。
  // renderer 提供 directory(main 不知道当前项目目录);字节在 main 侧取,bearer 不进 renderer。
  ipcMain.handle("cloud-save-run", (_e: IpcMainInvokeEvent, directory: string, runId: string, contract?: CloudJobEnvelope) =>
    saveCloudRun(directory, runId, { status: getCloudJobStatus, artifacts: listCloudArtifacts, fetchArtifact: fetchCloudArtifact }, contract))

  // 订阅 job 进度(SSE)→ 推 "cloud-job-event" 给发起的 renderer。幂等(同 wc+job 只订一次)。
  ipcMain.handle("cloud-subscribe", (e: IpcMainInvokeEvent, jobId: string) => {
    const wc = e.sender
    const key = `${wc.id}:${jobId}`
    if (subs.has(key)) return { ok: true }
    const unsub = subscribeCloudJobEvents(jobId, (ev) => {
      if (!wc.isDestroyed()) wc.send("cloud-job-event", { jobId, ...ev })
      // REQ-003(C23/NEW-2 修):终态后流已自停,但账簿条目原本一直留着 → 每个跑完的 job 泄一条。
      // 终态即清账;renderer 重订已结束的 job 也不空转(新流重放到终态即自停自清)。
      if (isTerminalCloudEvent(ev)) subs.delete(key)
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
