// REQ-159 (`#1321`) —— main 侧接线:生产 spawnLocalServer 在 fork 前做围栏计划,把它放进线上的 start 命令;
// 计划做不出来 ⇒ **这一代 fork 被拒**(fail-closed,原因可读),fork 一次都不发生。
//
// harness 与 sidecar-stop.test.ts 同形(mock electron / logging / store,假子进程记录线上消息)。
// 围栏本身(真 .node / 真 seatbelt)的判据在 process-fence-apply.test.ts;计划器的判据在
// process-fence-plan.test.ts;这里只守「计划 → 线上命令 → 拒 fork」这三跳。
//
// sidecar.ts 顶层的 registerHooks / getParentPort() 让它结构上无法被 import,所以「sidecar 收到命令后
// 第一件事就是 apply、缺席即拒」这一跳只能锚源码(文末 ANCHOR,不是闸门;行为判据是 apply 测试里的
// C1–C5 —— 那五种失败都是 installProcessFence 抛出去、经 start() 的 catch 变成 error IPC + exit(1))。

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { EventEmitter } from "node:events"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const appEvents = new EventEmitter()

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
mock.module("./logging", () => ({
  getLogger: () => ({ log: () => {}, warn: () => {}, error: () => {} }),
  write: () => {},
  rotateServerLogs: () => {},
}))
mock.module("./store", () => ({ getStore: () => ({ get: () => null, set: () => {}, delete: () => {} }) }))

// 陷阱:`await import("./server")` 必须排在 mock.module("electron", ...) **之后**,否则真 electron 会被拉起来。
const { spawnLocalServer } = await import("./server")
const { creditDanglingSweepForSpawn, resetDanglingSweepLatchForTests } = await import("./dangling-sweep-latch")

class RecordingChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  wire: unknown[] = []
  postMessage(message: unknown) {
    this.wire.push(message)
    if ((message as { type?: unknown }).type === "start") queueMicrotask(() => this.emit("message", { type: "ready" }))
    if ((message as { type?: unknown }).type === "stop") queueMicrotask(() => this.emit("exit", 0))
  }
  kill() {
    queueMicrotask(() => this.emit("exit", 0))
  }
}

let userDataPath = ""
const savedEnv: Record<string, string | undefined> = {}
const managedEnv = ["SHELL", "ALPHA_SECRETS_DISABLE"] as const

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), "fence-wiring-"))
  resetDanglingSweepLatchForTests()
  for (const key of managedEnv) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  process.env.SHELL = "nu"
  process.env.ALPHA_SECRETS_DISABLE = "1"
})

afterEach(() => {
  for (const key of managedEnv) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(userDataPath, { recursive: true, force: true })
})

describe("REQ-159 main 侧接线:计划 → start 命令 → 拒 fork", () => {
  test("start 命令逐字带上计划给出的 profile 与 addonPath(sidecar 就是拿这两样去 apply 的)", async () => {
    const child = new RecordingChild()
    let forks = 0
    creditDanglingSweepForSpawn()
    const plan = { profile: "(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* (subpath \"/x\"))\n", addonPath: "/App/Contents/Resources/alpha-fence/alpha_fence.node" }
    const result = await spawnLocalServer("127.0.0.1", 4311, "password", {
      userDataPath,
      healthCheck: async () => true,
      fork: (() => {
        forks++
        return child
      }) as unknown as typeof import("electron").utilityProcess.fork,
      planFence: (input) => {
        // 计划拿到的是 sidecar 将拿到的 env(白名单之后),不是 main 的 process.env
        expect(input.userDataPath).toBe(userDataPath)
        expect(Object.keys(input.sidecarEnv)).toContain("HOME")
        return plan
      },
    })
    await result.health.wait
    expect(forks).toBe(1)
    const start = child.wire.find((m) => (m as { type?: string }).type === "start") as { fence?: unknown }
    expect(start.fence).toEqual(plan)
    await result.listener.stop()
  })

  test("计划器抛出 ⇒ spawn 拒绝,消息带原因,fork 一次都不发生", async () => {
    let forks = 0
    creditDanglingSweepForSpawn()
    await expect(
      spawnLocalServer("127.0.0.1", 4312, "password", {
        userDataPath,
        healthCheck: async () => true,
        fork: (() => {
          forks++
          return new RecordingChild()
        }) as unknown as typeof import("electron").utilityProcess.fork,
        planFence: () => {
          throw new Error("process fence profile does not compile even with the minimum writable set (1 workspace, 0 dropped, 1 attempts): profile compilation failed")
        },
      }),
    ).rejects.toThrow(/process fence plan failed — sidecar fork refused: .*profile compilation failed/)
    expect(forks).toBe(0)
  })

  test("计划器回 undefined:darwin 上拒 fork(没有围栏的引擎不许起);别的平台没有 seatbelt,照常 fork 且 start 命令不带 fence", async () => {
    let forks = 0
    const child = new RecordingChild()
    creditDanglingSweepForSpawn()
    const attempt = spawnLocalServer("127.0.0.1", 4313, "password", {
      userDataPath,
      healthCheck: async () => true,
      fork: (() => {
        forks++
        return child
      }) as unknown as typeof import("electron").utilityProcess.fork,
      planFence: () => undefined,
    })
    if (process.platform === "darwin") {
      await expect(attempt).rejects.toThrow(/process fence plan returned nothing on darwin — sidecar fork refused/)
      expect(forks).toBe(0)
    } else {
      const result = await attempt
      await result.health.wait
      expect(forks).toBe(1)
      const start = child.wire.find((m) => (m as { type?: string }).type === "start") as { fence?: unknown }
      expect(start.fence).toBeUndefined()
      await result.listener.stop()
    }
  })

  test("ANCHOR (not a gate): sidecar.ts 收到 start 后第一件事是 installProcessFence,早于注入与 import 引擎;darwin 缺席即抛", () => {
    const source = readFileSync(join(import.meta.dir, "sidecar.ts"), "utf8")
    const fence = source.indexOf("installProcessFence(command)")
    const inject = source.indexOf("const injection = prepareSidecarEnv(")
    const engine = source.indexOf('await import("virtual:opencode-server")')
    expect(fence).toBeGreaterThan(-1)
    expect(fence).toBeLessThan(inject)
    expect(inject).toBeLessThan(engine)
    expect(source).toContain("refusing to start the engine unfenced")
    expect(source).toContain("const applied = applyProcessFence(command.fence)")
  })
})
