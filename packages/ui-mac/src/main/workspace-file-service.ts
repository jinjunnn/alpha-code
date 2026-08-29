// REQ-108(alpha-code#244)—— 本地 workspace 文件的 main-owned descriptor / 有界读取服务。
//
// 这是右栏文件查看器唯一的取字节入口(AC4/AC5):
//   · renderer 只交 workspace 相对路径;所有解析在 main:相对性校验 → realpath 圈禁 →
//     lstat 拒 symlink → O_NOFOLLOW open → fstat 身份复核(dev+ino,替换竞态在此被拒);
//   · 读取是 fd 绑定的有界 range 读:open 之后路径被替换也只会继续读 open 时那个 inode;
//     单 chunk 与会话累计都有上限,renderer 停止拉取即停止读盘(可取消,无后台任务);
//   · 目录、越根、symlink、超限一律 fail-closed(枚举拒绝码,不外泄绝对路径)。
//
// 「在系统中打开 / 打开所在目录 / 另存副本」也走同一套守卫 —— 不安全的文件不转交任何应用。

import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import * as electronNs from "electron"
import type { IpcMainInvokeEvent, WebContents } from "electron"
import {
  FILE_VIEWER_CHUNK_BYTES,
  FILE_VIEWER_MAX_READS,
  FILE_VIEWER_READ_TOTAL_CAP,
  type FileViewerRefusal,
  type WorkspaceFileActionResult,
  type WorkspaceFileChunkResult,
  type WorkspaceFileOpenResult,
} from "../shared/file-viewer"

type ElectronFacade = Pick<typeof electronNs, "dialog" | "shell" | "ipcMain">
let electronRef: ElectronFacade = electronNs
export function __setWorkspaceFileElectron(e: ElectronFacade | null) {
  electronRef = e ?? electronNs
}

// ---- 路径守卫(main 侧;与 renderer files-core 的 isSafeRelPath 同语义)----

function isSafeRelPath(rel: string): boolean {
  if (typeof rel !== "string" || rel.length === 0) return false
  if (rel.includes("\u0000")) return false
  if (rel.includes("\\")) return false
  if (rel.startsWith("/")) return false
  if (/^[A-Za-z]:/.test(rel)) return false
  return rel.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
}

export type ResolvedWorkspaceFile = {
  abs: string
  size: number
  dev: number
  ino: number
}

export type ResolveResult = { ok: true; file: ResolvedWorkspaceFile } | { ok: false; code: FileViewerRefusal }

/**
 * 把 (workspaceDir, relPath) 解析为一个已证明的普通文件:
 * 相对性 → join → lstat(拒 symlink 叶子、拒目录)→ realpath 全路径圈禁(拒父级 symlink 逃逸)。
 * 绝不返回散文原因 —— 拒绝码是枚举,绝对路径不出本模块。
 */
export function resolveWorkspaceFile(workspaceDir: string, relPath: string): ResolveResult {
  if (typeof workspaceDir !== "string" || workspaceDir.length === 0 || !path.isAbsolute(workspaceDir))
    return { ok: false, code: "invalid-path" }
  if (!isSafeRelPath(relPath)) return { ok: false, code: "invalid-path" }
  const abs = path.resolve(workspaceDir, ...relPath.split("/"))
  // join 后仍必须在 workspaceDir 词法范围内(防御性;safe rel 已保证,再钉一道)。
  if (abs !== workspaceDir && !abs.startsWith(workspaceDir + path.sep)) return { ok: false, code: "invalid-path" }

  let st: fs.Stats
  try {
    st = fs.lstatSync(abs)
  } catch {
    return { ok: false, code: "not-found" }
  }
  if (st.isSymbolicLink()) return { ok: false, code: "symlink" }
  if (st.isDirectory()) return { ok: false, code: "not-a-file" }
  if (!st.isFile()) return { ok: false, code: "not-a-file" }

  let realRoot: string
  let real: string
  try {
    realRoot = fs.realpathSync(workspaceDir)
    real = fs.realpathSync(abs)
  } catch {
    return { ok: false, code: "not-found" }
  }
  // 叶子已证非 symlink;这一步拒的是**父目录**经 symlink 指出 workspace 之外。
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return { ok: false, code: "escapes-workspace" }

  return { ok: true, file: { abs, size: st.size, dev: st.dev, ino: st.ino } }
}

// ---- 读取会话(fd 绑定;renderer 关闭/销毁即回收)----

type ReadSession = {
  readId: string
  fd: number
  size: number
  senderId: number
  /** 累计已交付字节(fail-closed 总量闸)。 */
  delivered: number
}

const reads = new Map<string, ReadSession>()

function countReadsFor(senderId: number): number {
  let n = 0
  for (const session of reads.values()) if (session.senderId === senderId) n++
  return n
}

function closeSession(session: ReadSession) {
  reads.delete(session.readId)
  try {
    fs.closeSync(session.fd)
  } catch {
    // fd 已失效 —— 幂等
  }
}

export function openWorkspaceRead(workspaceDir: string, relPath: string, senderId: number): WorkspaceFileOpenResult {
  if (countReadsFor(senderId) >= FILE_VIEWER_MAX_READS) return { ok: false, code: "busy" }
  const resolved = resolveWorkspaceFile(workspaceDir, relPath)
  if (!resolved.ok) return { ok: false, code: resolved.code }

  let fd: number
  try {
    fd = fs.openSync(resolved.file.abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  } catch {
    // lstat 与 open 之间被换成 symlink → O_NOFOLLOW 拒;或已消失。都按替换竞态处置。
    return { ok: false, code: "identity-changed" }
  }
  let st: fs.Stats
  try {
    st = fs.fstatSync(fd)
  } catch {
    try {
      fs.closeSync(fd)
    } catch {
      /* 幂等 */
    }
    return { ok: false, code: "read-failed" }
  }
  // open/read 时重新绑定真实文件身份(票面设计要点):lstat 看到的与实际打开的必须是同一 inode。
  if (!st.isFile() || st.dev !== resolved.file.dev || st.ino !== resolved.file.ino) {
    try {
      fs.closeSync(fd)
    } catch {
      /* 幂等 */
    }
    return { ok: false, code: "identity-changed" }
  }

  const readId = `wfr_${crypto.randomBytes(8).toString("hex")}`
  reads.set(readId, { readId, fd, size: st.size, senderId, delivered: 0 })
  return { ok: true, readId, totalBytes: st.size }
}

export function readWorkspaceChunk(
  readId: string,
  offset: number,
  length: number,
  senderId: number,
): WorkspaceFileChunkResult {
  const session = reads.get(readId)
  if (!session || session.senderId !== senderId) return { ok: false, code: "read-failed" }
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0)
    return { ok: false, code: "read-failed" }
  const want = Math.min(length, FILE_VIEWER_CHUNK_BYTES)
  if (session.delivered + want > FILE_VIEWER_READ_TOTAL_CAP) return { ok: false, code: "too-large" }
  if (offset >= session.size) return { ok: true, bytes: new Uint8Array(0), eof: true }

  const buf = Buffer.alloc(Math.min(want, session.size - offset))
  let read = 0
  try {
    while (read < buf.length) {
      const n = fs.readSync(session.fd, buf, read, buf.length - read, offset + read)
      if (n <= 0) break
      read += n
    }
  } catch {
    return { ok: false, code: "read-failed" }
  }
  session.delivered += read
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, read)
  return { ok: true, bytes, eof: offset + read >= session.size }
}

export function closeWorkspaceRead(readId: string, senderId: number): void {
  const session = reads.get(readId)
  if (!session || session.senderId !== senderId) return
  closeSession(session)
}

export function closeWorkspaceReadsForSender(senderId: number): void {
  for (const session of [...reads.values()]) if (session.senderId === senderId) closeSession(session)
}

export function closeAllWorkspaceReads(): void {
  for (const session of [...reads.values()]) closeSession(session)
}

/** 测试用只读视图。 */
export function __workspaceReadCount(): number {
  return reads.size
}

// ---- 应用自有的诚实动作(全部走同一套守卫;拒绝即不转交)----

export function openWorkspaceFileExternal(workspaceDir: string, relPath: string): WorkspaceFileActionResult {
  const resolved = resolveWorkspaceFile(workspaceDir, relPath)
  if (!resolved.ok) return { ok: false, code: resolved.code }
  void electronRef.shell.openPath(resolved.file.abs)
  return { ok: true }
}

export function revealWorkspaceFile(workspaceDir: string, relPath: string): WorkspaceFileActionResult {
  const resolved = resolveWorkspaceFile(workspaceDir, relPath)
  if (!resolved.ok) return { ok: false, code: resolved.code }
  electronRef.shell.showItemInFolder(resolved.file.abs)
  return { ok: true }
}

export async function saveWorkspaceFileCopy(
  workspaceDir: string,
  relPath: string,
): Promise<WorkspaceFileActionResult> {
  const resolved = resolveWorkspaceFile(workspaceDir, relPath)
  if (!resolved.ok) return { ok: false, code: resolved.code }
  const result = await electronRef.dialog.showSaveDialog({
    defaultPath: path.basename(resolved.file.abs),
  })
  if (result.canceled || !result.filePath) return { ok: true }
  try {
    // COPYFILE_EXCL 不用:系统保存对话框已经替用户确认过覆盖。
    fs.copyFileSync(resolved.file.abs, result.filePath)
  } catch {
    return { ok: false, code: "read-failed" }
  }
  return { ok: true }
}

// ---- IPC(薄 wiring;sender 销毁即回收其全部会话)----

const trackedSenders = new WeakSet<WebContents>()

function trackSender(sender: WebContents) {
  if (trackedSenders.has(sender)) return
  trackedSenders.add(sender)
  sender.once("destroyed", () => closeWorkspaceReadsForSender(sender.id))
}

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)

export function registerWorkspaceFileIpcHandlers() {
  electronRef.ipcMain.handle("workspace-file-open-read", (e: IpcMainInvokeEvent, dir: unknown, rel: unknown) => {
    if (!str(dir) || !str(rel)) return { ok: false, code: "invalid-path" } satisfies WorkspaceFileOpenResult
    trackSender(e.sender)
    return openWorkspaceRead(dir, rel, e.sender.id)
  })
  electronRef.ipcMain.handle(
    "workspace-file-read-chunk",
    (e: IpcMainInvokeEvent, readId: unknown, offset: unknown, length: unknown) =>
      str(readId) && num(offset) && num(length)
        ? readWorkspaceChunk(readId, offset, length, e.sender.id)
        : ({ ok: false, code: "read-failed" } satisfies WorkspaceFileChunkResult),
  )
  electronRef.ipcMain.handle("workspace-file-close-read", (e: IpcMainInvokeEvent, readId: unknown) => {
    if (str(readId)) closeWorkspaceRead(readId, e.sender.id)
  })
  electronRef.ipcMain.handle("workspace-file-open-external", (_e: IpcMainInvokeEvent, dir: unknown, rel: unknown) =>
    str(dir) && str(rel)
      ? openWorkspaceFileExternal(dir, rel)
      : ({ ok: false, code: "invalid-path" } satisfies WorkspaceFileActionResult),
  )
  electronRef.ipcMain.handle("workspace-file-reveal", (_e: IpcMainInvokeEvent, dir: unknown, rel: unknown) =>
    str(dir) && str(rel)
      ? revealWorkspaceFile(dir, rel)
      : ({ ok: false, code: "invalid-path" } satisfies WorkspaceFileActionResult),
  )
  electronRef.ipcMain.handle("workspace-file-save-copy", (_e: IpcMainInvokeEvent, dir: unknown, rel: unknown) =>
    str(dir) && str(rel)
      ? saveWorkspaceFileCopy(dir, rel)
      : Promise.resolve({ ok: false, code: "invalid-path" } satisfies WorkspaceFileActionResult),
  )
}
