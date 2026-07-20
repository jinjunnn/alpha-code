// run artifact manifest IPC(REQ-093 A 侧,alpha-code#185)—— renderer 的只读查询面。
// 薄 wiring:参数字符串校验后直调 artifact-service(全部业务/守卫逻辑在那里,electron-free 可单测)。
//
// 边界(与 cloud-ipc.ts 同风格):
//   · identity-bound —— list / inspect / usage / verify / read + external-open;不下载字节(下载归 #184 云 artifact 通道)、
//     不删除(GC 钩子是 main 内部服务面,策略未定前不给 renderer 写面);
//   · read(REQ-094/095,#186/#187)是唯一内容出口:只可寻址 run artifacts/ 内文件、text 2 MiB
//     截断 + 诚实标记、bytes 20 MiB 超限拒绝 —— 决策记录见 artifact-service.readArtifactContent;
//   · external-open 只接 directory/runId/artifactId,main 自行解析并复验受控字节;
//   · 响应内无 bearer、无绝对路径 —— entry.local.savedPath 是 run 目录内相对路径,
//     descriptor.contentRef.url 是 server-relative 路径(manifest 写入时已强制)。

import { ipcMain, shell, type IpcMainInvokeEvent } from "electron"
import {
  listRunArtifacts,
  projectArtifactUsage,
  readArtifactContent,
  resolveArtifact,
  runArtifactUsage,
  verifyArtifact,
  type ArtifactReadRef,
} from "./artifact-service"
import { openRunArtifactExternal } from "./artifact-external-open"

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
  // REQ-093 AC#4 的「打开前复核」钩子(Workbench 打开 artifact 即调用):全量 sha256 比对,
  // 不符降级持久化 —— 结果就是 inspect 同形状(descriptor + 降级后的本地状态)。
  ipcMain.handle("run-artifact-verify", (_e: IpcMainInvokeEvent, directory: unknown, runId: unknown, artifactId: unknown) =>
    str(directory) && str(runId) && str(artifactId)
      ? verifyArtifact(directory, runId, artifactId)
      : { ok: false as const, reason: "invalid arguments" },
  )
  // REQ-094/095(#186/#187):受控内容读取(text 截断 / bytes 限额;守卫与决策见 artifact-service)。
  ipcMain.handle("run-artifact-read", (_e: IpcMainInvokeEvent, directory: unknown, runId: unknown, ref: unknown, opts?: unknown) => {
    if (!str(directory) || !str(runId)) return { ok: false as const, reason: "invalid arguments" }
    const r = ref as { artifactId?: unknown; savedPath?: unknown } | null
    let readRef: ArtifactReadRef
    if (r && typeof r === "object" && str(r.artifactId)) readRef = { artifactId: r.artifactId }
    else if (r && typeof r === "object" && str(r.savedPath)) readRef = { savedPath: r.savedPath }
    else return { ok: false as const, reason: "invalid arguments" }
    const o = opts as { mode?: unknown; maxBytes?: unknown } | undefined
    const mode = o?.mode === "bytes" ? ("bytes" as const) : ("text" as const)
    const maxBytes = typeof o?.maxBytes === "number" && Number.isFinite(o.maxBytes) ? o.maxBytes : undefined
    return readArtifactContent(directory, runId, readRef, { mode, maxBytes })
  })
  // REQ-093(#281):external open crosses the renderer/main trust boundary by identity only. Main
  // re-resolves the manifest entry, pins/copies its bytes, and independently re-runs the OOXML gate.
  ipcMain.handle("run-artifact-open-external", (_e: IpcMainInvokeEvent, directory: unknown, runId: unknown, artifactId: unknown) =>
    str(directory) && str(runId) && str(artifactId)
      ? openRunArtifactExternal(directory, runId, artifactId, (path) => shell.openPath(path))
      : { ok: false as const, code: "INVALID_ARGUMENTS" as const, reason: "INVALID_ARGUMENTS" },
  )
}
