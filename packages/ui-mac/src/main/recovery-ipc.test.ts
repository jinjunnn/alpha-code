import { beforeEach, describe, expect, mock, test } from "bun:test"
import { RECOVERY_ACTIONS } from "../shared/recovery"
import { createRecoveryService } from "./recovery-service"

type FatalReason = "renderer-load-failed" | "preload-failed" | "renderer-process-gone"
type IpcHandler = (event: { sender: { id: number } }, ...args: unknown[]) => unknown

const handlers = new Map<string, IpcHandler>()
const windows: FakeRecoveryWindow[] = []
const logs: Array<{
  name: string
  message: string
  extra: Record<string, unknown> | undefined
  level: string | undefined
}> = []
let nextWindowID = 100

class FakeRecoveryWindow {
  readonly webContents = { id: nextWindowID++ }
  private closed: Array<() => void> = []
  destroyed = false

  constructor(private onFatal: (reason: FatalReason) => void) {}

  once(event: string, handler: () => void) {
    if (event === "closed") this.closed.push(handler)
  }

  isDestroyed() {
    return this.destroyed
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.closed.forEach((handler) => handler())
  }

  fail(reason: FatalReason) {
    this.onFatal(reason)
  }
}

mock.module("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => handlers.set(channel, handler),
  },
  // bun mock.module 跨测试文件泄漏(Linux 执行顺序下本文件的 electron mock 会覆盖他文件)。缺
  // app/BrowserWindow/dialog 导出会让后续 `import { app } from "electron"` 报「Export not found」。
  // 补全 index.ts 所需的具名导出面避免泄漏破坏(值为惰性 stub,本文件用不到)。
  app: {
    getVersion: () => "9.9.9",
    getPath: () => "/tmp",
    getName: () => "alpha-code",
    isPackaged: false,
    on: () => {},
    whenReady: () => Promise.resolve(),
  },
  BrowserWindow: class {
    static getAllWindows() {
      return []
    }
  },
  dialog: {
    showMessageBox: async () => ({ response: 0 }),
    showErrorBox: () => {},
  },
  utilityProcess: {
    fork: () => {
      throw new Error("unexpected utilityProcess.fork")
    },
  },
}))
mock.module("./windows", () => ({
  createRecoveryWindow: (onFatal: (reason: FatalReason) => void) => {
    const win = new FakeRecoveryWindow(onFatal)
    windows.push(win)
    return win
  },
  loadRecoveryWindow: () => {},
}))
mock.module("./logging", () => ({
  write: (name: string, message: string, extra?: Record<string, unknown>, level?: string) => {
    logs.push({ name, message, extra, level })
  },
  // bun mock.module 跨测试文件泄漏(Linux 执行顺序下本文件的 ./logging mock 会覆盖他文件),
  // 缺 getLogger/rotateServerLogs 等导出会让后续 import 它们的模块报「Export not found」。补全导出面避免泄漏破坏。
  getLogger: () => undefined,
  rotateServerLogs: () => {},
}))

const { registerRecoveryIpcHandlers } = await import("./recovery-ipc")

beforeEach(() => {
  handlers.clear()
  windows.length = 0
  logs.length = 0
  nextWindowID = 100
})

function createHarness() {
  let nextIncident = 0
  const service = createRecoveryService({
    log: () => {},
    createID: () => `boot-incident-${++nextIncident}`,
  })
  const controller = registerRecoveryIpcHandlers(service)
  const incident = () =>
    service.register({
      source: { kind: "engine", plan: { action: "give-up", state: { attempts: 5, lastSpawnAt: 10 } } },
      effects: { [RECOVERY_ACTIONS.retryEngine]: async () => ({ applied: true }) },
      senderID: 1,
    })!
  return { controller, incident }
}

describe("boot Recovery fatal settlement", () => {
  test("renderer load, preload, and renderer process failures all settle exit-app exactly once", async () => {
    const harness = createHarness()
    const reasons = ["renderer-load-failed", "preload-failed", "renderer-process-gone"] as const

    for (const reason of reasons) {
      const result = harness.controller.presentBoot(harness.incident())
      const win = windows.at(-1)!
      win.fail(reason)
      win.fail(reason)

      expect(await Promise.race([result, Promise.resolve("pending")])).toBe("exit-app")
      expect(win.destroyed).toBe(true)
      expect(logs.at(-1)).toEqual({
        name: "recovery",
        message: "Boot Recovery host failed",
        extra: { reason },
        level: "error",
      })
    }

    expect(logs).toHaveLength(reasons.length)
    expect(JSON.stringify(logs)).not.toMatch(/\/Users\/|https?:\/\/|preload\.js|secret|stack/)
  })

  test("recovery-boot-current rejection closes the host and settles exit-app without pending", async () => {
    const harness = createHarness()
    const incident = harness.incident()
    const result = harness.controller.presentBoot(incident)
    const win = windows.at(-1)!
    const current = handlers.get("recovery-boot-current")!

    expect(current({ sender: { id: win.webContents.id } })).toBe(incident)
    expect(() => current({ sender: { id: win.webContents.id + 1 } })).toThrow("Boot Recovery is unavailable")
    expect(await Promise.race([result, Promise.resolve("pending")])).toBe("exit-app")
    expect(win.destroyed).toBe(true)
    expect(logs).toEqual([
      {
        name: "recovery",
        message: "Boot Recovery host failed",
        extra: { reason: "current-ipc-rejected" },
        level: "error",
      },
    ])
  })
})
