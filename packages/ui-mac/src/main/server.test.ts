import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, parse, resolve } from "node:path"

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()

  postMessage(message: { type: string }) {
    if (message.type === "start") queueMicrotask(() => this.emit("message", { type: "ready" }))
    if (message.type === "stop") queueMicrotask(() => this.emit("exit", 0))
  }

  kill() {
    queueMicrotask(() => this.emit("exit", 0))
  }
}

const appEvents = new EventEmitter()
const forkCalls: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = []

mock.module("electron", () => ({
  app: {
    isPackaged: false,
    on: appEvents.on.bind(appEvents),
    off: appEvents.off.bind(appEvents),
  },
  utilityProcess: {
    fork: () => {
      throw new Error("unexpected utilityProcess.fork")
    },
  },
  BrowserWindow: class {},
  dialog: {},
  ipcMain: { handle: () => {} },
}))
mock.module("./logging", () => ({ getLogger: () => undefined, write: () => {}, rotateServerLogs: () => {} }))
mock.module("./store", () => ({ getStore: () => ({ get: () => null, set: () => {}, delete: () => {} }) }))
// 不 mock ./alpha-secret-files:真 syncSecretFiles 对 test 的临时 userDataPath 是 temp-scoped(写
// <tempdir>/alpha-secrets,无 ALPHA 密钥环境变量时 no-op,afterEach 清理)。全局 mock.module 会跨文件
// 泄漏残缺导出面,撞坏 alpha-secret-files.test.ts 的 `import { secretFileRef, ... }`(2026-07-21 Linux CI 实锤)。

const { spawnLocalServer } = await import("./server")

let userDataPath = ""

beforeEach(() => {
  forkCalls.length = 0
  userDataPath = mkdtempSync(join(tmpdir(), "server-scratch-cwd-"))
})

afterEach(() => rmSync(userDataPath, { recursive: true, force: true }))

describe("spawnLocalServer", () => {
  test("forks the sidecar in the userData scratch directory", async () => {
    const result = await spawnLocalServer("127.0.0.1", 4096, "password", {
      userDataPath,
      healthCheck: async () => true,
      fork: ((file: string, args: string[], options: Record<string, unknown>) => {
        forkCalls.push({ file, args, options })
        return new FakeChild()
      }) as unknown as typeof import("electron").utilityProcess.fork,
    })
    await result.health.wait

    expect(forkCalls).toHaveLength(1)
    const cwd = forkCalls[0]?.options.cwd
    expect(cwd).toBe(join(userDataPath, "engine-scratch-cwd"))
    expect(cwd).not.toBe(process.cwd())
    expect(cwd).not.toBe(resolve(homedir()))
    expect(cwd).not.toBe(parse(resolve(userDataPath)).root)

    await result.listener.stop()
  })
})
