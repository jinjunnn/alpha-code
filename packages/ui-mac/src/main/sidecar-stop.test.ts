// #858 —— token-only 换血的停止路径:活动连接被**主动关掉**,而不是等超时自然断。
//
// 为什么不用「停止耗时 < X ms」当判据(本仓的老账):那条断言被机器快慢左右,而且它对
// 「等满预算然后 SIGTERM」和「主动关连接后自己干净退出」给出同一个答案 —— 也就是说,
// 它测不出这张票要修的那件事。这里断的是行为:
//   ① 线上那条 stop 命令**带着**强关指令(生产 spawnLocalServer 真发的那一条);
//   ② sidecar 侧真的把它翻译成引擎 listener 的 `stop(true)`(= http/websocket closeAll);
//   ③ 因此进程是自己退的 —— `kill()` 一次都没发生。
// ③ 尤其重要:它把「兜底 timer 到期」和「修好了」区分开。
//
// 反向同样要钉(不然「把超时全局改小」这个错误实现也能满足上面三条):
//   · 结构性 respawn 与应用退出仍走排空,`stop()` 不传强关参数;
//   · 两个兜底预算(500ms / 6s)各自不变 —— 本票只收紧 token-only 这一种停止原因。
//
// harness 说明:sidecar.ts 顶层有 registerHooks 与 getParentPort(),结构上无法被 import
// (与 #607 同因)。所以这里让假子进程用**生产的** parseSidecarStopCommand +
// stopSidecarListener 消费消息 —— main→线上形状→sidecar 决策这一整条是真的在跑,
// 只有「sidecar.ts 确实调用了这两个函数」这一跳靠文末的接线锚守。

import { afterEach, beforeEach, describe, expect, mock, test, vi } from "bun:test"
import { EventEmitter } from "node:events"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parseSidecarStopCommand, stopSidecarListener } from "./sidecar-stop"

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

// 陷阱:`await import("./server")` 必须排在 mock.module("electron", ...) **之后**,否则真 electron
// 会被拉起来。
const { spawnLocalServer } = await import("./server")

/**
 * 假 sidecar 子进程。stop 分支就是 sidecar.ts 的那两行(parse → 交给共享执行器),
 * 引擎 listener 换成记录器:
 * - `stop(true)`  → 强关,立刻 resolve(真实现:http.closeAll + websockets.closeAll);
 * - `stop()`      → 排空;`hasActiveConnections` 为真时**永不 resolve** —— 这正是打包现场
 *                   (旧请求挂着,排空吃满 main 的整个停止预算)。
 */
class SidecarChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kills = 0
  wire: unknown[] = []
  listenerStopArgs: Array<boolean | undefined> = []
  hasActiveConnections = false

  private listener = {
    stop: (close?: boolean) => {
      this.listenerStopArgs.push(close)
      if (!close && this.hasActiveConnections) return new Promise<void>(() => {})
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
    void stopSidecarListener(this.listener, command).then(() => this.emit("exit", 0))
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
  const result = await spawnLocalServer("127.0.0.1", port, "password", {
    userDataPath,
    healthCheck: async () => true,
    fork: (() => child) as unknown as typeof import("electron").utilityProcess.fork,
  })
  await result.health.wait
  return result
}

describe("#858 token-only 换血:主动关活动连接,而不是等超时", () => {
  test("token-rotation 停止会强关活动连接,进程自己退出(一次 kill 都没有)", async () => {
    const child = new SidecarChild()
    child.hasActiveConnections = true // 旧请求挂着:排空永远等不到
    const result = await spawn(child, 4301)

    await result.listener.stop("token-rotation")

    // ① 线上命令带强关指令(生产 server.ts 真发的那一条)
    expect(child.wire.at(-1)).toEqual({ type: "stop", closeActiveConnections: true })
    // ② sidecar 侧真的把它翻成了引擎的 forceClose
    expect(child.listenerStopArgs).toEqual([true])
    // ③ 因此进程是自己退的 —— 不是兜底 timer 到期把它 SIGTERM 掉的
    expect(child.kills).toBe(0)
  })

  test("结构性停止与应用退出仍走排空:不强关、清理语义不变", async () => {
    for (const [index, stop] of [
      (result: { listener: { stop: (mode?: "graceful" | "token-rotation") => Promise<void> } }) =>
        result.listener.stop("graceful"),
      (result: { listener: { stop: (mode?: "graceful" | "token-rotation") => Promise<void> } }) => result.listener.stop(),
    ].entries()) {
      const child = new SidecarChild() // 无活动连接:排空正常收口
      const result = await spawn(child, 4310 + index)

      await stop(result)

      expect(child.wire.at(-1)).toEqual({ type: "stop" })
      expect(child.listenerStopArgs).toEqual([undefined])
      expect(child.kills).toBe(0)
    }
  })

  test("两个兜底预算各自不变:token-rotation 500ms、结构/退出 6s", async () => {
    const run = async (mode: "token-rotation" | "graceful", port: number, beforeKillMs: number) => {
      const child = new DeafChild()
      const result = await spawn(child, port)

      const stopping = result.listener.stop(mode)
      vi.advanceTimersByTime(beforeKillMs)
      await Promise.resolve()
      expect(child.kills).toBe(0)
      vi.advanceTimersByTime(1)
      await stopping
      expect(child.kills).toBe(1)
    }

    vi.useFakeTimers()
    try {
      await run("token-rotation", 4320, 499)
      await run("graceful", 4321, 5_999)
    } finally {
      vi.useRealTimers()
    }
  })

  test("强关只认显式 true —— 其它取值一律回落排空(fail-closed)", () => {
    expect(parseSidecarStopCommand({ type: "stop", closeActiveConnections: true })).toEqual({
      type: "stop",
      closeActiveConnections: true,
    })
    for (const value of ["1", "true", 1, false, null, undefined])
      expect(parseSidecarStopCommand({ type: "stop", closeActiveConnections: value })).toEqual({ type: "stop" })
    for (const value of [{ type: "start" }, { type: "stopped" }, "stop", null, 7])
      expect(parseSidecarStopCommand(value)).toBeUndefined()
  })

  test("接线锚:sidecar.ts 的 stop 走共享执行器,不再自己决定关不关连接", () => {
    // sidecar.ts 顶层的 registerHooks / getParentPort() 让它无法被 import,所以这一跳只能锚源码。
    // 上面四条才是行为判据 —— 这一条只保证生产真的接在那上面。
    const source = readFileSync(join(import.meta.dir, "sidecar.ts"), "utf8")
    expect(source).toContain("await stopSidecarListener(listener, command)")
    expect(source).toContain("return parseSidecarStopCommand(value)")
    // 本地再决定一次 = 合同有两个真源,迟早漂移。
    expect(source).not.toMatch(/listener\??\.stop\(/)
  })
})
