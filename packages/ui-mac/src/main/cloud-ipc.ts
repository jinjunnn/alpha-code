// alpha cloud jobs IPC (main process). Mirrors account-ipc.ts: thin handlers dispatching/polling cloud
// jobs on the alpha-platform (B) `cloud` worker using the main-held JWT (alpha-cloud-jobs.ts). The
// renderer receives only the resolved result, never the token.
//
// 阶段二:+ artifact 列表/下载(alpha-cloud-jobs)+ SSE 进度订阅(alpha-cloud-events)。SSE 事件经
// event.sender.send("cloud-job-event", …) 推给对应 renderer;订阅按 (webContents, jobId) 记账,窗口销毁自动清。

import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron"
import { execFile } from "node:child_process"
import * as fs from "node:fs"
import { dispatchCloudJob, getCloudJobStatus, cancelCloudJob, listCloudArtifacts, fetchCloudArtifact } from "./alpha-cloud-jobs"
import { isTerminalCloudEvent, subscribeCloudJobEvents } from "./alpha-cloud-events"
import { readProjectPrefs, saveCloudRun, writeProjectPrefs } from "./alpha-workdir"
import { hasCloudConsent, withCloudConsent } from "./alpha-cloud-consent"
import { getLogger } from "./logging"
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

// B16(ADR-021 §4 显式通道):首次云派发 per 项目弹一次 PIPL 同意门。文案中文硬编码(main 无 i18n,
// ADR-022 先例)。诚实告知:出境内容(diff/任务文本)、去向(平台云)、可拒绝、per-项目记录。
// 同意即写 .alpha/prefs.json;拒绝返回 false → 调用方回 consent-declined,不派发。
async function ensureCloudConsent(event: IpcMainInvokeEvent, directory: string): Promise<boolean> {
  if (hasCloudConsent(readProjectPrefs(directory))) return true
  const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined
  const opts = {
    type: "warning" as const,
    title: "云执行数据出境告知(首次派发)",
    message: "此操作会把本项目的内容发送到 alpha 平台云执行。",
    detail:
      "将出境的内容:本次派发的代码差异(git diff)或任务文本 —— 用于在云端执行并返回结果。\n" +
      "· 仅本次选择的内容出境,不上传整个项目;密钥/大文件由本机校验拦截(体积上限 + 密钥扫描)。\n" +
      "· 登录为平台代付模式时,对话内容本就经平台代理(详见登录时的隐私告知与官网隐私说明)。\n" +
      "· 本同意按项目记录一次(存于本项目 .alpha/prefs.json),可随时不再使用云派发。\n\n" +
      "同意后本项目将不再重复询问。",
    buttons: ["同意并派发", "取消"],
    defaultId: 1,
    cancelId: 1,
    checkboxLabel: "我已知悉上述内容出境",
    checkboxChecked: false,
  }
  const res = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts)
  if (res.response !== 0 || !res.checkboxChecked) {
    getLogger().log(`[b16-consent] declined for project (response=${res.response}, ack=${res.checkboxChecked})`)
    return false
  }
  const written = writeProjectPrefs(directory, withCloudConsent(readProjectPrefs(directory), new Date().toISOString()))
  if (!written.ok) {
    // 写失败不静默放行:无法留痕的同意等于没同意(反 placebo)。loud 报错,本次拒绝。
    getLogger().error(`[b16-consent] failed to persist consent: ${written.reason}`)
    return false
  }
  getLogger().log("[b16-consent] granted + persisted for project")
  return true
}

export function registerCloudIpcHandlers() {
  ipcMain.handle("cloud-dispatch", async (e: IpcMainInvokeEvent, envelope: CloudJobEnvelope, directory?: string) => {
    // B16:有项目上下文(hub 派发)→ per-项目同意门;无 directory(无项目上下文的调用)→ 跳过
    // per-项目门(无可记录的项目同意),隐式通道告知由登录流承担。
    if (typeof directory === "string" && directory) {
      if (!(await ensureCloudConsent(e, directory))) return { error: "consent-declined" }
    }
    return dispatchCloudJob(envelope)
  })
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
