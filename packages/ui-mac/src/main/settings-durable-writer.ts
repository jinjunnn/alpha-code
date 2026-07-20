import { randomBytes } from "node:crypto"
import { basename, dirname, join } from "node:path"

export type DurableAtomicWriteOptions = {
  mode?: string | number
  onCommitPoint?: (point: "file-synced" | "renamed", temporaryFile: string) => void
  fileSystem: DurableAtomicFileSystem
}

/**
 * Fixed syscall surface used by the durable Settings writer.
 * Production and test seams must expose this exact shape. Call these methods unconditionally; never
 * inspect object identity or runtime capabilities (`in`, `typeof`, extra properties) to select a path,
 * because that would let production and tested commit sequences diverge.
 */
export interface DurableAtomicFileSystem {
  mkdirSync(dir: string, options: { recursive: true }): string | undefined
  writeFileSync(file: string, data: string | Buffer, options: { flag: "wx"; mode?: string | number }): void
  openSync(file: string, flags: "r"): number
  fsyncSync(fd: number): void
  closeSync(fd: number): void
  renameSync(from: string, to: string): void
  unlinkSync(file: string): void
}

/**
 * 持久原子写:Settings 成功边界要求 tmp 内容与 rename 目录项都已落盘。
 * tmp 始终与目标同目录,不存在 EXDEV/直接覆盖 fallback;任一步失败即抛。
 * onCommitPoint 只是为了让崩溃一致性测试在两个窗口精确终止子进程。
 */
export function writeFileDurableAtomicSync(file: string, data: string | Buffer, opts: DurableAtomicWriteOptions): void {
  const dir = dirname(file)
  const fileSystem = opts.fileSystem
  fileSystem.mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.${basename(file)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`)
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
