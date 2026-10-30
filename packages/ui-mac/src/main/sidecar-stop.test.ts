// #858 —— main → sidecar 的停止合同。REQ-236 `#1562` 起停止只有一种:排空(令牌续期不再重启引擎,#858 为
// token-only 换血加的「强关活动连接」一档没有生产者,已删除)。这里钉三件事:
//   ① 生产 spawnLocalServer 线上只发 `{ type: "stop" }`;
//   ② sidecar 侧(生产 parseSidecarStopCommand + stopSidecarListener)把它翻成引擎 listener 的 `stop()`(不传强关);
//   ③ 无响应的 sidecar 由 6s 兜底预算收口(到期才 SIGTERM)。
//
// harness 说明:sidecar.ts 顶层有 registerHooks 与 getParentPort(),结构上无法被 import
// (与 #607 同因)。所以这里让假子进程用**生产的** parseSidecarStopCommand +
// stopSidecarListener 消费消息 —— main→线上形状→sidecar 执行这一整条是真的在跑,
// 只有「sidecar.ts 确实调用了这两个函数」这一跳靠文末的接线锚守。

import { afterEach, beforeEach, describe, expect, mock, test, vi } from "bun:test"
import { EventEmitter } from "node:events"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parseSidecarStopCommand, stopSidecarListener } from "./sidecar-stop"
import { mockElectron } from "../../test-component/electron-mock"

const appEvents = new EventEmitter()

mockElectron(() => ({
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

// 陷阱:`await import("./server")` 必须排在 mock.module("electron", ...) **之后**,否则真 electron
// 会被拉起来。
const { spawnLocalServer } = await import("./server")
const { creditDanglingSweepForSpawn, resetDanglingSweepLatchForTests } = await import("./dangling-sweep-latch")

/**
 * 假 sidecar 子进程。stop 分支就是 sidecar.ts 的那两行(parse → 交给共享执行器),
 * 引擎 listener 换成记录器(记下每次 `stop` 收到的参数)。
 */
class SidecarChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kills = 0
  wire: unknown[] = []
  listenerStopArgs: Array<boolean | undefined> = []

  private listener = {
    stop: (close?: boolean) => {
      this.listenerStopArgs.push(close)
      return Promise.resolve()
    },
  }

  postMessage(message: unknown) {
    this.wire.push(message)
    if ((message as { type?: unknown }).type === "start") {
      queueMicrotask(() => this.emit("message", { type: "ready" }))
      return
    }
    const command = parseSidecarStopCommand(message)
    if (!command) return
    // sidecar.ts 的 finally:关完就自己退(那里是 process.exit(0))。
    void stopSidecarListener(this.listener).then(() => this.emit("exit", 0))
  }

  kill() {
    this.kills++
    queueMicrotask(() => this.emit("exit", 0))
  }
}

/** 完全无响应的 sidecar —— 只有它才能观察到两个兜底预算本身。 */
class DeafChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kills = 0

  postMessage(message: unknown) {
    if ((message as { type?: unknown }).type === "start") queueMicrotask(() => this.emit("message", { type: "ready" }))
  }

  kill() {
    this.kills++
    queueMicrotask(() => this.emit("exit", 0))
  }
}

let userDataPath = ""
const savedEnv: Record<string, string | undefined> = {}
const managedEnv = ["SHELL", "ALPHA_SECRETS_DISABLE", "ALPHA_CLOUD_MCP_URL", "ALPHA_CLOUD_TOKEN"] as const

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), "sidecar-stop-"))
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

async function spawn(child: SidecarChild | DeafChild, port: number) {
  creditDanglingSweepForSpawn()
  const result = await spawnLocalServer("127.0.0.1", port, "password", {
    userDataPath,
    healthCheck: async () => true,
    fork: (() => child) as unknown as typeof import("electron").utilityProcess.fork,
    // REQ-159 `#1321`:围栏计划替身(本文件的假子进程不跑 sidecar.ts;围栏判据在 process-fence-*.test.ts)。
    planFence: () => ({ profile: "(version 1)\n(allow default)\n(deny file-write*)\n", addonPath: "/nonexistent/alpha_fence.node" }),
  })
  await result.health.wait
  return result
}

describe("#858 停止合同:一律排空", () => {
  test("线上只发 { type: \"stop\" },引擎 listener 收到不带强关的 stop(),进程自己退出(一次 kill 都没有)", async () => {
    const child = new SidecarChild()
    const result = await spawn(child, 4310)

    await result.listener.stop()

    expect(child.wire.at(-1)).toEqual({ type: "stop" })
    expect(child.listenerStopArgs).toEqual([undefined])
    expect(child.kills).toBe(0)
  })

  test("无响应的 sidecar 由 6s 兜底预算收口:到期之前不 kill,到期恰好 kill 一次", async () => {
    vi.useFakeTimers()
    try {
      const child = new DeafChild()
      const result = await spawn(child, 4321)

      const stopping = result.listener.stop()
      vi.advanceTimersByTime(5_999)
      await Promise.resolve()
      expect(child.kills).toBe(0)
      vi.advanceTimersByTime(1)
      await stopping
      expect(child.kills).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  test("只认 type:\"stop\";附加字段(含已删除的 closeActiveConnections)一律忽略,不是 stop 的形状一律拒", () => {
    for (const value of [true, "1", 1, false, null, undefined])
      expect(parseSidecarStopCommand({ type: "stop", closeActiveConnections: value })).toEqual({ type: "stop" })
    for (const value of [{ type: "start" }, { type: "stopped" }, "stop", null, 7])
      expect(parseSidecarStopCommand(value)).toBeUndefined()
  })

  // 分类与「这处锚守不住什么」登记在 ./source-text-anchors.ts(`#968` 第 ⑤ 层机械校验)。
  test("ANCHOR (not a gate): sidecar.ts 的 stop 走共享执行器,不再自己决定关不关连接", () => {
    // sidecar.ts 顶层的 registerHooks / getParentPort() 让它无法被 import,所以这一跳只能锚源码。
    // 上面三条才是行为判据 —— 这一条只保证生产真的接在那上面。
    const source = readFileSync(join(import.meta.dir, "sidecar.ts"), "utf8")
    expect(source).toContain("await stopSidecarListener(listener)")
    expect(source).toContain("return parseSidecarStopCommand(value)")
    // 本地再决定一次 = 合同有两个真源,迟早漂移。
    expect(source).not.toMatch(/listener\??\.stop\(/)
  })
})
