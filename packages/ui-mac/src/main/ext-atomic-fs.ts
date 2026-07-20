// REQ-100(issue #192)T0 —— 扩展原子事务的 fs 原语层:tmp → fsync → rename 原子落盘 + 路径守卫。
//
// 纪律来源:
//   · 原子换名 = 仓内既有惯例(alpha-installs.writeLedger 的 tmp→rename),本模块补齐 fsync
//     (crash 一致性:rename 可原子,但不 fsync 的内容在掉电后可能是空洞文件);
//   · 路径守卫 = ADR-019 修订④「safeResolve(realpath 防逃逸)」同款态度,收紧到事务层
//     (相对路径结构校验 + 现存路径 realpath 圈禁),任何删除/改名前必须过守卫;
//   · 全模块 electron-free、root 参数化(与 alpha-installs / alpha-workdir 同测试性模式)。
//
// 目录 fsync 在个别平台/文件系统会失败(Windows EBADF 等)。既有调用默认 best-effort;
// Settings 这类严格成功边界显式使用 required 变体,父目录 fsync 失败必须阻断。

import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

/** 相对路径结构校验:拒绝绝对路径、`..`/`.` 段、反斜杠、控制字符、空段、超深/超长。 */
export function isSafeRelPath(rel: string): boolean {
  if (typeof rel !== "string" || rel.length === 0 || rel.length > 1024) return false
  if (rel.includes("\\") || rel.includes("\0")) return false
  if (path.posix.isAbsolute(rel) || path.isAbsolute(rel)) return false
  const segments = rel.split("/")
  if (segments.length > 32) return false
  for (const seg of segments) {
    if (seg.length === 0 || seg.length > 255) return false
    if (seg === "." || seg === "..") return false
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(seg)) return false
  }
  return true
}

/** root 下解析相对路径并做纯字符串圈禁(不触盘)。失败 → null。 */
export function resolveUnder(root: string, rel: string): string | null {
  if (!path.isAbsolute(root)) return null
  if (!isSafeRelPath(rel)) return null
  const target = path.resolve(root, rel)
  if (target !== root && !target.startsWith(root + path.sep)) return null
  return target
}

/**
 * 删除/改名前的现存路径圈禁:target 与 root 都取 realpath,target 必须在 root 树内。
 * 任一侧不存在或 realpath 失败 → false(fail closed)。
 */
export function confinedExistingPath(root: string, target: string): boolean {
  if (!path.isAbsolute(root) || !path.isAbsolute(target)) return false
  try {
    const realRoot = fs.realpathSync(root)
    const realTarget = fs.realpathSync(target)
    return realTarget === realRoot || realTarget.startsWith(realRoot + path.sep)
  } catch {
    return false
  }
}

/** fsync 单个文件(硬保证,失败即抛)。 */
export function fsyncFileSync(file: string): void {
  const fd = fs.openSync(file, "r")
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

/** fsync 目录项(best-effort,见文件头说明)。 */
export function fsyncDirSync(dir: string): void {
  try {
    const fd = fs.openSync(dir, "r")
    try {
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    /* best-effort:平台不支持目录 fsync 时静默(内容 fsync 已是硬保证) */
  }
}

/** fsync 目录项(硬保证,失败即抛)。仅用于不允许「内容可见但目录项未持久」的提交边界。 */
export function fsyncDirRequiredSync(dir: string): void {
  const fd = fs.openSync(dir, "r")
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

/** 原子写文件:同目录 tmp → fsync → rename → best-effort fsync 父目录。opts.mode 施加在 tmp 创建时
 *  (rename 保留权限位 —— 供 0o600 级私有状态文件复用本原语而不降权)。 */
export function writeFileAtomicSync(file: string, data: string | Buffer, opts?: { mode?: fs.Mode }): void {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`)
  fs.writeFileSync(tmp, data, { mode: opts?.mode })
  fsyncFileSync(tmp)
  fs.renameSync(tmp, file)
  fsyncDirSync(dir)
}

export type DurableAtomicWriteOptions = {
  mode?: fs.Mode
  onCommitPoint?: (point: "file-synced" | "renamed", temporaryFile: string) => void
  fileSystem: DurableAtomicFileSystem
}

/**
 * Fixed syscall surface used by the durable writer.
 * Production and test seams must expose this exact shape. Call these methods unconditionally; never
 * inspect object identity or runtime capabilities (`in`, `typeof`, extra properties) to select a path,
 * because that would let production and tested commit sequences diverge.
 */
export interface DurableAtomicFileSystem {
  mkdirSync(dir: string, options: { recursive: true }): string | undefined
  writeFileSync(file: string, data: string | Buffer, options: { flag: "wx"; mode?: fs.Mode }): void
  openSync(file: string, flags: "r"): number
  fsyncSync(fd: number): void
  closeSync(fd: number): void
  renameSync(from: string, to: string): void
  unlinkSync(file: string): void
}

/**
 * 持久原子写:Settings 等成功边界要求 tmp 内容与 rename 目录项都已落盘。
 * tmp 始终与目标同目录,不存在 EXDEV/直接覆盖 fallback;任一步失败即抛。
 * onCommitPoint 只是为了让崩溃一致性测试在两个窗口精确终止子进程。
 */
export function writeFileDurableAtomicSync(file: string, data: string | Buffer, opts: DurableAtomicWriteOptions): void {
  const dir = path.dirname(file)
  const fileSystem = opts.fileSystem
  fileSystem.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`)
  try {
    fileSystem.writeFileSync(tmp, data, { flag: "wx", mode: opts.mode })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      try {
        fileSystem.unlinkSync(tmp)
      } catch {
        // Cleanup must not replace the commit error with a secondary unlink failure.
      }
    }
    throw error
  }
  try {
    const fd = fileSystem.openSync(tmp, "r")
    try {
      fileSystem.fsyncSync(fd)
    } finally {
      fileSystem.closeSync(fd)
    }
    opts.onCommitPoint?.("file-synced", tmp)
    fileSystem.renameSync(tmp, file)
  } catch (error) {
    try {
      fileSystem.unlinkSync(tmp)
    } catch {
      // Cleanup must not replace the commit error with a secondary unlink failure.
    }
    throw error
  }
  opts.onCommitPoint?.("renamed", tmp)
  const dirFd = fileSystem.openSync(dir, "r")
  try {
    fileSystem.fsyncSync(dirFd)
  } finally {
    fileSystem.closeSync(dirFd)
  }
}

/** 原子改名(同卷保证由调用方负责:staging 与 store 同根即同卷)+ fsync 目的父目录。 */
export function renameAtomicSync(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.renameSync(from, to)
  fsyncDirSync(path.dirname(to))
}

/** 计算文件 sha256(hex)。扩展载荷有导入层体积帽(≤10MB 级),readFileSync 可接受。 */
export function sha256FileSync(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
}

/** 自底向上 fsync 目录树的全部目录项(文件 fsync 由校验遍历各自负责)。 */
export function fsyncDirTreeSync(dir: string): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) fsyncDirTreeSync(path.join(dir, entry.name))
  }
  fsyncDirSync(dir)
}
