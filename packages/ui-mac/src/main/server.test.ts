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
    fork: (file: string, args: string[], options: Record<string, unknown>) => {
      forkCalls.push({ file, args, options })
      return new FakeChild()
    },
  },
}))
mock.module("./logging", () => ({ getLogger: () => undefined }))
mock.module("./store", () => ({ getStore: () => ({ get: () => null, set: () => {}, delete: () => {} }) }))
mock.module("./alpha-secret-files", () => ({ syncSecretFiles: () => ({ written: [], removed: [] }) }))

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
