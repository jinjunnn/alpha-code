// REQ-053 `#982`: spawnLocalServer refuses fork without a dangling-sweep credit.
import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import { EventEmitter } from "node:events"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createElectronStub } from "./req053-electron-stub"

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

let userDataPath = ""
mock.module("electron", () => createElectronStub({ userDataPath: () => userDataPath }))
mock.module("../src/main/store", () => ({
  getStore: () => ({ get: () => null, set: () => {}, delete: () => {} }),
}))

const { spawnLocalServer } = await import("../src/main/server")
// REQ-159 `#1321`:生产 spawnLocalServer 在 fork 前做围栏计划(真 store / 真 sandbox-exec / 真原生模块路径);
// 本文件的假子进程不跑 sidecar.ts,注入一个替身计划 —— 围栏本身的判据在 src/main/process-fence-*.test.ts。
const fakePlanFence = () => ({ profile: "(version 1)\n(allow default)\n(deny file-write*)\n", addonPath: "/nonexistent/alpha_fence.node" })
const {
  creditDanglingSweepForSpawn,
  resetDanglingSweepLatchForTests,
} = await import("../src/main/dangling-sweep-latch")

let scratch = ""
const savedEnv: Record<string, string | undefined> = {}
const ENV_KEYS = ["XDG_DATA_HOME", "ALPHA_SECRETS_DISABLE", "SHELL"] as const

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "req053-throat-")))
  userDataPath = join(scratch, "user-data")
  mkdirSync(userDataPath, { recursive: true })
  process.env.XDG_DATA_HOME = join(scratch, "xdg-data")
  mkdirSync(process.env.XDG_DATA_HOME, { recursive: true })
  process.env.ALPHA_SECRETS_DISABLE = "1"
  process.env.SHELL = "nu"
  resetDanglingSweepLatchForTests()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(scratch, { recursive: true, force: true })
})

test("spawnLocalServer throws when sweep was never credited", async () => {
  const forkCalls: string[] = []
  await expect(
    spawnLocalServer("127.0.0.1", 4096, "password", {
      userDataPath,
      healthCheck: async () => true,
      planFence: fakePlanFence,
      fork: ((file: string) => {
        forkCalls.push(file)
        return new FakeChild()
      }) as unknown as NonNullable<Parameters<typeof spawnLocalServer>[3]["fork"]>,
    }),
  ).rejects.toThrow(/req053-dangling-sweep.*refused/)
  expect(forkCalls).toHaveLength(0)
})

test("credited spawn forks once; a second spawn without re-credit is refused", async () => {
  const forkCalls: string[] = []
  const fakeFork = ((file: string) => {
    forkCalls.push(file)
    return new FakeChild()
  }) as unknown as NonNullable<Parameters<typeof spawnLocalServer>[3]["fork"]>

  creditDanglingSweepForSpawn()
  const first = await spawnLocalServer("127.0.0.1", 4096, "password", {
    userDataPath,
    healthCheck: async () => true,
    planFence: fakePlanFence,
    fork: fakeFork,
  })
  await first.health.wait
  await first.listener.stop()
  expect(forkCalls).toHaveLength(1)

  await expect(
    spawnLocalServer("127.0.0.1", 4097, "password", {
      userDataPath,
      healthCheck: async () => true,
      planFence: fakePlanFence,
      fork: fakeFork,
    }),
  ).rejects.toThrow(/req053-dangling-sweep.*refused/)
  expect(forkCalls).toHaveLength(1)
})
