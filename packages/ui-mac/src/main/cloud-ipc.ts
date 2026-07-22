// alpha cloud jobs IPC (main process). Mirrors account-ipc.ts: thin handlers dispatching/polling cloud
// jobs on the alpha-platform (B) `cloud` worker using the main-held JWT (alpha-cloud-jobs.ts). The
// renderer receives only the resolved result, never the token.
//
// 阶段二:+ artifact 列表/下载(alpha-cloud-jobs)+ SSE 进度订阅(alpha-cloud-events)。SSE 事件经
// event.sender.send("cloud-job-event", …) 推给对应 renderer;订阅按 (webContents, jobId) 记账,窗口销毁自动清。

import { finalizeArtifactWithQuota, registerDownloadedArtifact } from "./artifact-service"
import { validateArtifactDescriptor } from "../shared/cloud-artifact-descriptor"
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, type OpenDialogOptions } from "electron"
import { execFile } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { dispatchCloudJob, dispatchExplicitCloudUpload, getCloudJobStatus, cancelCloudJob, listCloudArtifacts, downloadCloudArtifactTo } from "./alpha-cloud-jobs"
import { isTerminalCloudEvent, subscribeCloudJobEvents } from "./alpha-cloud-events"
import { ensureAlphaScaffold, isSafeRunId, safeResolveInAlpha, sanitizeArtifactName, saveCloudRun } from "./alpha-workdir"
import { mirrorRunArtifacts } from "./alpha-user-workspace"
import { getLogger } from "./logging"
import type { CloudJobEnvelope, CloudUploadIntent } from "../preload/types"
import { getAccessTokenIdentity } from "./alpha-auth"
import { requestUploadConsent } from "./alpha-web-upload-consent"
import { assertSafeUploadResult, createMainUploadService } from "./alpha-upload"

// REQ-020 T4(ADR-021 §1 diff-only):hub 的 code-review dispatch 入口只送 diff,不送全库。
// 工作树有变更 → `git diff HEAD`(含 staged);干净 → 回退最近一次 commit 的 diff(e2e 常在干净树上跑)。
// 只读操作(git diff 无副作用);超 8MB 直接砍 buffer 报错 —— 上限最终由 dispatch 的 256KiB 信封帽把关。
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
// 进行中的 artifact 下载:key = `${webContentsId}:${artifactId}` → abort(取消 IPC + 窗口销毁自动清)。
const downloads = new Map<string, AbortController>()

const uploadService = createMainUploadService({
  identity: () => getAccessTokenIdentity("cloud.dispatch"),
  issue: requestUploadConsent,
  dispatch: dispatchExplicitCloudUpload,
  log: (message) => getLogger().warn(message),
})
const uploadCleanupSenders = new Set<number>()

async function pickExplicitUpload(event: IpcMainInvokeEvent) {
  const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined
  const projectOptions: OpenDialogOptions = { title: "选择项目目录", properties: ["openDirectory"] }
  const project = parent
    ? await dialog.showOpenDialog(parent, projectOptions)
    : await dialog.showOpenDialog(projectOptions)
  if (project.canceled || project.filePaths.length !== 1) return null
  const fileOptions: OpenDialogOptions = {
    title: "选择本次上传的文件",
    defaultPath: project.filePaths[0],
    properties: ["openFile", "multiSelections"],
  }
  const files = parent ? await dialog.showOpenDialog(parent, fileOptions) : await dialog.showOpenDialog(fileOptions)
  if (files.canceled || !files.filePaths.length) return null
  return { projectDirectory: project.filePaths[0], files: files.filePaths }
}

export function registerCloudIpcHandlers() {
  // The existing input.diff/code-review route is grandfathered and does not mint an upload manifest.
  ipcMain.handle("cloud-dispatch", (_event: IpcMainInvokeEvent, envelope: CloudJobEnvelope) => dispatchCloudJob(envelope))
  ipcMain.handle("cloud-upload", async (event: IpcMainInvokeEvent, intent: CloudUploadIntent) => {
    const selection = await pickExplicitUpload(event)
    if (!selection) return assertSafeUploadResult({ status: "cancelled" as const })
    if (!uploadCleanupSenders.has(event.sender.id)) {
      const senderId = event.sender.id
      uploadCleanupSenders.add(senderId)
      event.sender.once("destroyed", () => {
        uploadCleanupSenders.delete(senderId)
        uploadService.clear(senderId)
      })
    }
    return assertSafeUploadResult(await uploadService.prepare(event.sender.id, intent, selection))
  })
  ipcMain.handle("cloud-upload-confirm", async (event: IpcMainInvokeEvent, requestId: string) =>
    assertSafeUploadResult(await uploadService.confirm(event.sender.id, requestId)),
  )
  ipcMain.handle("cloud-upload-cancel", (event: IpcMainInvokeEvent, requestId: string) =>
    assertSafeUploadResult(uploadService.cancel(event.sender.id, requestId)),
  )
  ipcMain.handle("cloud-status", (_e: IpcMainInvokeEvent, jobId: string) => getCloudJobStatus(jobId))
  ipcMain.handle("cloud-cancel", (_e: IpcMainInvokeEvent, jobId: string) => cancelCloudJob(jobId))
  ipcMain.handle("cloud-artifacts", (_e: IpcMainInvokeEvent, jobId: string) => listCloudArtifacts(jobId))

  // REQ-092:descriptor-only IPC —— renderer 只送 descriptor(或旧部署 meta),main 流式写入
  // <directory>/.alpha/runs/<runId>/artifacts/(ADR-019 守卫复用:isSafeRunId + sanitizeArtifactName +
  // safeResolveInAlpha)。进度经 "cloud-artifact-progress" 推回发起窗口;字节永不过 IPC。
  ipcMain.handle("cloud-artifact-download", async (e: IpcMainInvokeEvent, directory: string, runId: string, artifact: unknown) => {
    if (typeof directory !== "string" || !directory || typeof runId !== "string" || !isSafeRunId(runId))
      return { ok: false, error: "invalid-request" }
    const a = artifact && typeof artifact === "object" ? (artifact as { id?: unknown; name?: unknown }) : null
    const artifactId = a && typeof a.id === "string" && a.id ? a.id : null
    if (!artifactId) return { ok: false, error: "invalid-artifact" }
    if (!ensureAlphaScaffold(directory)) return { ok: false, error: "invalid-directory" }
    const name = sanitizeArtifactName(typeof a?.name === "string" ? a.name : undefined, `artifact-${artifactId}`)
    const target = safeResolveInAlpha(directory, "runs", runId, "artifacts", name)
    if (!target) return { ok: false, error: "unsafe-path" }
    const wc = e.sender
    const key = `${wc.id}:${artifactId}`
    if (downloads.has(key)) return { ok: false, error: "already-downloading" }
    const ctrl = new AbortController()
    downloads.set(key, ctrl)
    const onDestroyed = () => ctrl.abort()
    wc.once("destroyed", onDestroyed)
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      const outcome = await downloadCloudArtifactTo(
        {
          artifact,
          targetPath: target,
          jobId: runId,
          signal: ctrl.signal,
          onProgress: (p) => {
            if (!wc.isDestroyed()) wc.send("cloud-artifact-progress", { runId, artifactId, ...p })
          },
        },
        (input) => finalizeArtifactWithQuota(directory, runId, input),
      )
      // REQ-093/#186:单件下载与 saveRun 同纪律 —— 完整 descriptor 才入 manifest(legacy meta 不合成
      // 假 descriptor,盘上文件由 legacyFiles 只读发现兜底);登记失败只留痕,不推翻已落盘的下载结果。
      if (outcome.ok) {
        const check = validateArtifactDescriptor(artifact)
        if (check.ok) {
          const reg = registerDownloadedArtifact(directory, runId, {
            descriptor: check.value,
            savedPath: `artifacts/${name}`,
            verifiedSha256: outcome.sha256,
          })
          if (!reg.ok) getLogger().warn(`cloud: artifact ${artifactId} downloaded but manifest register failed: ${reg.reason}`)
        }
      }
      return outcome
    } catch (error) {
      // downloadCloudArtifactTo 自身不抛;这里兜底 mkdir 等本地失败(错误文案不含 token)。
      return { ok: false, error: "disk", detail: error instanceof Error ? error.message : "local failure" }
    } finally {
      downloads.delete(key)
      wc.removeListener("destroyed", onDestroyed)
    }
  })
  ipcMain.handle("cloud-artifact-download-cancel", (e: IpcMainInvokeEvent, artifactId: string) => {
    const ctrl = typeof artifactId === "string" ? downloads.get(`${e.sender.id}:${artifactId}`) : undefined
    if (ctrl) ctrl.abort()
    return { ok: !!ctrl }
  })

  ipcMain.handle("cloud-git-diff", (_e: IpcMainInvokeEvent, directory: string) =>
    typeof directory === "string" && directory ? gitDiff(directory) : { ok: false, reason: "invalid directory" })

  // B3/ADR-019:把一个终态 run 回流写进 <directory>/.alpha/runs/<runId>/(status/contract/artifacts)。
  // renderer 提供 directory(main 不知道当前项目目录);字节在 main 侧取,bearer 不进 renderer。
  ipcMain.handle("cloud-save-run", async (_e: IpcMainInvokeEvent, directory: string, runId: string, contract?: CloudJobEnvelope) => {
    const saved = await saveCloudRun(
      directory,
      runId,
      {
        status: getCloudJobStatus,
        artifacts: listCloudArtifacts,
        download: (artifact, targetPath, jobId) =>
          downloadCloudArtifactTo(
            { artifact, targetPath, jobId },
            (input) => finalizeArtifactWithQuota(directory, runId, input),
          ),
        // REQ-093:下载成功即入 manifest(依赖注入,见 SaveRunDeps.register)。
        register: (input) => registerDownloadedArtifact(directory, runId, input),
      },
      contract,
    )
    // REQ-071/ADR-025:目标项目 = ~/Alpha 时,交付物镜像到可见区 Outputs(best-effort,真源不变)。
    if (saved.ok) {
      const mirrored = mirrorRunArtifacts(directory, runId, saved)
      if (!mirrored.ok && mirrored.reason !== "not the user workspace" && mirrored.reason !== "no files")
        getLogger().warn(`cloud: outputs mirror failed for ${runId}: ${mirrored.reason}`)
    }
    return saved
  })

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
