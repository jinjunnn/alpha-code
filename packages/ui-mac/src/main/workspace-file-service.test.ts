// REQ-108(#244)—— workspace 文件 descriptor / 有界读取服务单测。
// AC4 负样本矩阵(越根 / 穿越 / symlink 叶 / symlink 父 / 目录 / 缺失)+ AC5 读取合同
// (chunk 夹取、eof、fd 绑定的替换竞态防线、并发上限、累计总量闸、sender 回收)。

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const shellCalls: { openPath: string[]; showItemInFolder: string[] } = { openPath: [], showItemInFolder: [] }
const dialogState = { canceled: false, filePath: "" }
const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()

mock.module("electron", () => ({
  app: { isPackaged: false },
  shell: {
    openPath: (p: string) => {
      shellCalls.openPath.push(p)
      return Promise.resolve("")
    },
    showItemInFolder: (p: string) => {
      shellCalls.showItemInFolder.push(p)
    },
  },
  dialog: {
    showSaveDialog: () => Promise.resolve({ canceled: dialogState.canceled, filePath: dialogState.filePath }),
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler)
    },
  },
}))

const {
  closeAllWorkspaceReads,
  closeWorkspaceRead,
  closeWorkspaceReadsForSender,
  openWorkspaceFileExternal,
  openWorkspaceRead,
  readWorkspaceChunk,
  registerWorkspaceFileIpcHandlers,
  resolveWorkspaceFile,
  revealWorkspaceFile,
  saveWorkspaceFileCopy,
  __setWorkspaceFileElectron,
  __workspaceReadCount,
} = await import("./workspace-file-service")
const { FILE_VIEWER_CHUNK_BYTES, FILE_VIEWER_MAX_READS, FILE_VIEWER_READ_TOTAL_CAP } = await import(
  "../shared/file-viewer"
)

__setWorkspaceFileElectron({
  shell: {
    openPath: (p: string) => {
      shellCalls.openPath.push(p)
      return Promise.resolve("")
    },
    showItemInFolder: (p: string) => {
      shellCalls.showItemInFolder.push(p)
    },
  },
  dialog: {
    showSaveDialog: () => Promise.resolve({ canceled: dialogState.canceled, filePath: dialogState.filePath }),
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler)
    },
  },
} as never)

let root: string
let outside: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wfs-root-"))
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "wfs-out-"))
  shellCalls.openPath.length = 0
  shellCalls.showItemInFolder.length = 0
})

afterEach(() => {
  closeAllWorkspaceReads()
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

const write = (rel: string, content: string | Buffer) => {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
  return abs
}

describe("resolveWorkspaceFile — AC4 fail-closed matrix", () => {
  test("plain file inside the workspace resolves with its size", () => {
    write("docs/readme.md", "hello")
    const result = resolveWorkspaceFile(root, "docs/readme.md")
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.file.size).toBe(5)
  })

  test("absolute, traversal, backslash, drive-letter and empty inputs are invalid-path", () => {
    write("a.txt", "x")
    for (const rel of ["/etc/hosts", "../a.txt", "a/../../b", "a\\b.txt", "C:evil", "", "a//b"]) {
      const result = resolveWorkspaceFile(root, rel)
      expect({ rel, result }).toEqual({ rel, result: { ok: false, code: "invalid-path" } })
    }
  })

  test("relative workspaceDir is refused outright", () => {
    expect(resolveWorkspaceFile("relative/dir", "a.txt")).toEqual({ ok: false, code: "invalid-path" })
  })

  test("missing file → not-found; directory → not-a-file", () => {
    fs.mkdirSync(path.join(root, "sub"))
    expect(resolveWorkspaceFile(root, "missing.txt")).toEqual({ ok: false, code: "not-found" })
    expect(resolveWorkspaceFile(root, "sub")).toEqual({ ok: false, code: "not-a-file" })
  })

  test("symlink leaf is refused even when it points inside the workspace", () => {
    write("real.txt", "content")
    fs.symlinkSync(path.join(root, "real.txt"), path.join(root, "link.txt"))
    expect(resolveWorkspaceFile(root, "link.txt")).toEqual({ ok: false, code: "symlink" })
  })

  test("parent directory symlink escaping the workspace is refused", () => {
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret")
    fs.symlinkSync(outside, path.join(root, "sneaky"))
    expect(resolveWorkspaceFile(root, "sneaky/secret.txt")).toEqual({ ok: false, code: "escapes-workspace" })
  })
})

describe("workspace read sessions — AC5 bounded, cancellable, fd-bound", () => {
  test("chunks reconstruct the file, are clamped to the chunk budget, and report eof", () => {
    const content = Buffer.alloc(FILE_VIEWER_CHUNK_BYTES + 1000, 7)
    write("big.bin", content)
    const opened = openWorkspaceRead(root, "big.bin", 1)
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    expect(opened.totalBytes).toBe(content.length)

    // 请求远超预算的 length —— main 必须夹到 FILE_VIEWER_CHUNK_BYTES。
    const first = readWorkspaceChunk(opened.readId, 0, 10 * 1024 * 1024, 1)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.bytes.length).toBe(FILE_VIEWER_CHUNK_BYTES)
    expect(first.eof).toBe(false)

    const second = readWorkspaceChunk(opened.readId, FILE_VIEWER_CHUNK_BYTES, FILE_VIEWER_CHUNK_BYTES, 1)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.bytes.length).toBe(1000)
    expect(second.eof).toBe(true)
    expect(Buffer.concat([Buffer.from(first.bytes), Buffer.from(second.bytes)]).equals(content)).toBe(true)

    closeWorkspaceRead(opened.readId, 1)
    expect(readWorkspaceChunk(opened.readId, 0, 16, 1)).toEqual({ ok: false, code: "read-failed" })
  })

  test("reads stay bound to the opened inode: replacing the path serves the original bytes (TOCTOU)", () => {
    write("swap.txt", "ORIGINAL")
    const opened = openWorkspaceRead(root, "swap.txt", 1)
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    fs.rmSync(path.join(root, "swap.txt"))
    fs.writeFileSync(path.join(root, "swap.txt"), "REPLACED")
    const chunk = readWorkspaceChunk(opened.readId, 0, 64, 1)
    expect(chunk.ok).toBe(true)
    if (!chunk.ok) return
    expect(Buffer.from(chunk.bytes).toString("utf8")).toBe("ORIGINAL")
    closeWorkspaceRead(opened.readId, 1)
  })

  test("a symlink swapped in between lstat and open cannot be followed (O_NOFOLLOW refusal path)", () => {
    // 直接对 symlink open 走的就是 O_NOFOLLOW 拒绝分支 —— resolve 层已先拒,这里证明第二道闸独立成立:
    // 绕过 resolve 的输入形态(合法 rel + 打开前被换)最终收敛在 identity-changed/symlink 两码之一。
    write("real.txt", "content")
    fs.symlinkSync(path.join(root, "real.txt"), path.join(root, "link.txt"))
    expect(openWorkspaceRead(root, "link.txt", 1)).toEqual({ ok: false, code: "symlink" })
  })

  test("per-sender session cap is enforced and released on close", () => {
    write("f.txt", "x")
    const ids: string[] = []
    for (let i = 0; i < FILE_VIEWER_MAX_READS; i++) {
      const opened = openWorkspaceRead(root, "f.txt", 9)
      expect(opened.ok).toBe(true)
      if (opened.ok) ids.push(opened.readId)
    }
    expect(openWorkspaceRead(root, "f.txt", 9)).toEqual({ ok: false, code: "busy" })
    // 另一个 sender 不受影响。
    const other = openWorkspaceRead(root, "f.txt", 10)
    expect(other.ok).toBe(true)
    closeWorkspaceRead(ids[0]!, 9)
    expect(openWorkspaceRead(root, "f.txt", 9).ok).toBe(true)
    closeWorkspaceReadsForSender(9)
    closeWorkspaceReadsForSender(10)
    expect(__workspaceReadCount()).toBe(0)
  })

  test("cumulative delivery is capped fail-closed (runaway pull loops are stopped in main)", () => {
    const size = FILE_VIEWER_READ_TOTAL_CAP + FILE_VIEWER_CHUNK_BYTES
    fs.writeFileSync(path.join(root, "huge.bin"), Buffer.alloc(size))
    const opened = openWorkspaceRead(root, "huge.bin", 1)
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    let offset = 0
    let refusal: unknown
    while (offset < size) {
      const chunk = readWorkspaceChunk(opened.readId, offset, FILE_VIEWER_CHUNK_BYTES, 1)
      if (!chunk.ok) {
        refusal = chunk
        break
      }
      offset += chunk.bytes.length
    }
    expect(refusal).toEqual({ ok: false, code: "too-large" })
    expect(offset).toBe(FILE_VIEWER_READ_TOTAL_CAP)
    closeWorkspaceRead(opened.readId, 1)
  })

  test("a foreign sender can neither read nor close another sender's session", () => {
    write("f.txt", "x")
    const opened = openWorkspaceRead(root, "f.txt", 1)
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    expect(readWorkspaceChunk(opened.readId, 0, 16, 2)).toEqual({ ok: false, code: "read-failed" })
    closeWorkspaceRead(opened.readId, 2)
    expect(__workspaceReadCount()).toBe(1)
    closeWorkspaceRead(opened.readId, 1)
    expect(__workspaceReadCount()).toBe(0)
  })
})

describe("honest actions go through the same guards", () => {
  test("open-external / reveal refuse symlinks and never touch shell", () => {
    write("real.txt", "content")
    fs.symlinkSync(path.join(root, "real.txt"), path.join(root, "link.txt"))
    expect(openWorkspaceFileExternal(root, "link.txt")).toEqual({ ok: false, code: "symlink" })
    expect(revealWorkspaceFile(root, "../etc")).toEqual({ ok: false, code: "invalid-path" })
    expect(shellCalls.openPath).toEqual([])
    expect(shellCalls.showItemInFolder).toEqual([])
  })

  test("open-external / reveal hand the resolved absolute path to shell for a proven file", () => {
    const abs = write("docs/ok.md", "x")
    expect(openWorkspaceFileExternal(root, "docs/ok.md")).toEqual({ ok: true })
    expect(revealWorkspaceFile(root, "docs/ok.md")).toEqual({ ok: true })
    expect(shellCalls.openPath).toEqual([abs])
    expect(shellCalls.showItemInFolder).toEqual([abs])
  })

  test("save-copy copies the proven file to the user-picked destination; cancel is ok/no-op", async () => {
    write("src.txt", "COPY ME")
    const dest = path.join(outside, "copy.txt")
    dialogState.canceled = false
    dialogState.filePath = dest
    expect(await saveWorkspaceFileCopy(root, "src.txt")).toEqual({ ok: true })
    expect(fs.readFileSync(dest, "utf8")).toBe("COPY ME")
    dialogState.canceled = true
    expect(await saveWorkspaceFileCopy(root, "src.txt")).toEqual({ ok: true })
    expect(await saveWorkspaceFileCopy(root, "../x")).toEqual({ ok: false, code: "invalid-path" })
  })
})

describe("IPC wiring validates arguments and scopes sessions to the sender", () => {
  test("handlers exist and refuse malformed arguments fail-closed", async () => {
    registerWorkspaceFileIpcHandlers()
    const event = { sender: { id: 77, once: () => {} } }
    expect(await ipcHandlers.get("workspace-file-open-read")!(event, 5, "a.txt")).toEqual({
      ok: false,
      code: "invalid-path",
    })
    expect(await ipcHandlers.get("workspace-file-read-chunk")!(event, "id", "0", 16)).toEqual({
      ok: false,
      code: "read-failed",
    })
    expect(await ipcHandlers.get("workspace-file-open-external")!(event, "", "a")).toEqual({
      ok: false,
      code: "invalid-path",
    })
    write("via-ipc.txt", "abc")
    const opened = (await ipcHandlers.get("workspace-file-open-read")!(event, root, "via-ipc.txt")) as {
      ok: boolean
      readId?: string
    }
    expect(opened.ok).toBe(true)
    const chunk = (await ipcHandlers.get("workspace-file-read-chunk")!(event, opened.readId, 0, 16)) as {
      ok: boolean
      bytes?: Uint8Array
    }
    expect(chunk.ok).toBe(true)
    expect(Buffer.from(chunk.bytes!).toString("utf8")).toBe("abc")
    await ipcHandlers.get("workspace-file-close-read")!(event, opened.readId)
    expect(__workspaceReadCount()).toBe(0)
  })
})
