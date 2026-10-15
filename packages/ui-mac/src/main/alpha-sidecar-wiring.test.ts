// REQ-234 `#1529`(基线 §2.2 / §2.6,I6 的 main 半边)—— 生产 spawnLocalServer 把 parentPort 上的 `alpha.*` 交给 alphaSidecar:
//   · 子进程发来的 `alpha.*` 进 receive,应答经同一个子进程发回;write-probe 的应答**不**进 receive(两条接收者并列);
//   · ready 之后才 attach(在途重载在这一刻重发),子进程退出时断开的是**这一次**连接。
// harness 与 process-fence-wiring.test.ts 同形:mock electron / logging,假子进程记录线上消息。
import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mockElectron } from "../../test-component/electron-mock"
import type { AlphaSidecarOutbound } from "./alpha-sidecar-messages"

const appEvents = new EventEmitter()
let userDataPath = ""
mockElectron(() => ({
  app: {
    isPackaged: false,
    on: appEvents.on.bind(appEvents),
    off: appEvents.off.bind(appEvents),
    getPath: (name: string) => (name === "userData" ? userDataPath : join(userDataPath, name)),
    getVersion: () => "0.0.0-test",
  },
  utilityProcess: {
    fork: () => {
      throw new Error("unexpected utilityProcess.fork")
    },
  },
  BrowserWindow: class {},
  dialog: {},
  ipcMain: { handle: () => {}, on: () => {} },
}))
mock.module("./logging", () => ({
  getLogger: () => ({ log: () => {}, warn: () => {}, error: () => {} }),
  write: () => {},
  rotateServerLogs: () => {},
}))

const { spawnLocalServer } = await import("./server")
const { creditDanglingSweepForSpawn, resetDanglingSweepLatchForTests } = await import("./dangling-sweep-latch")

class RecordingChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  wire: unknown[] = []
  postMessage(message: unknown) {
    this.wire.push(message)
    const type = (message as { type?: unknown }).type
    if (type === "start") queueMicrotask(() => this.emit("message", { type: "ready" }))
    if (type === "stop") queueMicrotask(() => this.emit("exit", 0))
    if (type === "write-probe") {
      const { id } = message as { id: number }
      queueMicrotask(() => this.emit("message", { type: "write-probe-result", id, outcome: "writable" }))
    }
  }
  kill() {
    queueMicrotask(() => this.emit("exit", 0))
  }
}

const saved: Record<string, string | undefined> = {}
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), "alpha-sidecar-wiring-"))
  resetDanglingSweepLatchForTests()
  for (const key of ["SHELL", "ALPHA_SECRETS_DISABLE"]) saved[key] = process.env[key]
  process.env.SHELL = "nu"
  process.env.ALPHA_SECRETS_DISABLE = "1"
})
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(userDataPath, { recursive: true, force: true })
})

test("alpha.* 进 alphaSidecar、应答回同一子进程;ready 之后才 attach;退出断开这一次连接;探针应答不进 alpha", async () => {
  const child = new RecordingChild()
  const received: unknown[] = []
  const events: string[] = []
  const alphaSidecar = {
    receive(message: unknown, post: (message: AlphaSidecarOutbound) => void) {
      if (typeof (message as { type?: unknown })?.type !== "string" || !(message as { type: string }).type.startsWith("alpha.")) return false
      received.push(message)
      post({ type: "alpha.hub.request.reply", id: (message as { id: number }).id, record: null })
      return true
    },
    attach(post: (message: AlphaSidecarOutbound) => void) {
      events.push(`attach after start=${child.wire.some((m) => (m as { type?: string }).type === "start")}`)
      post({ type: "alpha.reload.request", generation: 1, scope: "global", items: [], reason: "re-sent at ready" })
      return (reason: string) => void events.push(`detach: ${reason}`)
    },
  }
  creditDanglingSweepForSpawn()
  const result = await spawnLocalServer("127.0.0.1", 4391, "password", {
    userDataPath,
    healthCheck: async () => true,
    fork: (() => child) as unknown as typeof import("electron").utilityProcess.fork,
    egressProxy: async () => ({ port: 4433 }),
    planFence: () => ({ profile: "(version 1)\n(allow default)\n(deny file-write*)\n", addonPath: "/x/alpha_fence.node" }),
    alphaSidecar,
  })
  await result.health.wait
  expect(events).toEqual(["attach after start=true"])
  expect(child.wire.at(-1)).toEqual({ type: "alpha.reload.request", generation: 1, scope: "global", items: [], reason: "re-sent at ready" })

  child.emit("message", { type: "alpha.hub.request.request", id: 9, requestId: "req_abcdef12" })
  expect(received).toEqual([{ type: "alpha.hub.request.request", id: 9, requestId: "req_abcdef12" }])
  expect(child.wire.at(-1)).toEqual({ type: "alpha.hub.request.reply", id: 9, record: null })

  expect((await result.listener.probeWrite("/ws")).outcome).toBe("writable")
  expect(received).toHaveLength(1)

  await result.listener.stop()
  expect(events).toEqual(["attach after start=true", "detach: sidecar exited with code 0"])
})

// `#1531`(#1529 审计 Minor ④):同一条接线,接上**生产** host + 重载协调器(不是假 alphaSidecar)——
// 子进程发来的阶段查询经 hub-view 的分发得到应答;子进程退出之后,在途重载的原因如实变成「sidecar 退出了」。
test("真 host + 真协调器:阶段查询经子进程往返;退出 ⇒ pendingFor 的原因是 sidecar exited", async () => {
  const { createAlphaSidecarHost, createHubRequestStages } = await import("./hub-view")
  const { createReloadCoordinator } = await import("./reload-coordinator")
  const child = new RecordingChild()
  const reloads = createReloadCoordinator({ log: () => {}, onChange: () => {} })
  const requests = createHubRequestStages({ log: () => {} })
  expect(requests.record({ requestId: "req_abcdef12", stage: "confirming", catalogId: "mcp:github" })).toEqual({ ok: true })
  const host = createAlphaSidecarHost({
    view: { view: async () => ({ directory: "/w", rows: [], warnings: [] }), viewForAgent: async () => ({ directory: "/w", rows: [], warnings: [] }) },
    requests,
    reloads,
    log: () => {},
  })
  reloads.request({ scope: "global", items: [], reason: "installed skill writer" })
  creditDanglingSweepForSpawn()
  const result = await spawnLocalServer("127.0.0.1", 4392, "password", {
    userDataPath,
    healthCheck: async () => true,
    fork: (() => child) as unknown as typeof import("electron").utilityProcess.fork,
    egressProxy: async () => ({ port: 4433 }),
    planFence: () => ({ profile: "(version 1)\n(allow default)\n(deny file-write*)\n", addonPath: "/x/alpha_fence.node" }),
    alphaSidecar: host,
  })
  await result.health.wait
  // ready 时在途的那一代被重发给子进程
  expect(child.wire.at(-1)).toMatchObject({ type: "alpha.reload.request", generation: 1, scope: "global" })
  child.emit("message", { type: "alpha.hub.request.request", id: 5, requestId: "req_abcdef12" })
  expect(child.wire.at(-1)).toEqual({
    type: "alpha.hub.request.reply",
    id: 5,
    record: { requestId: "req_abcdef12", catalogId: "mcp:github", stage: "confirming" },
  })
  expect(reloads.pendingFor("/w")).toEqual({ code: "reload-waiting", detail: "queued" })
  await result.listener.stop()
  expect(reloads.pendingFor("/w")).toEqual({ code: "reload-waiting", detail: "sidecar exited with code 0" })
})

// `#1531`:ext 的 parentPort 监听必须在 ready **之前**挂上(main 只在 ready 那一刻重发在途代际)。sidecar.ts 顶层的 registerHooks /
// getParentPort() 让它不能被 import,接线只能锚源码:ext 预载在引擎 import 之后开始、在 ready 上报之前 await 完;
// 预载的 URL 形状与引擎解析路径插件的形状逐字相同(上游 plugin/shared.ts 的 resolvePathPluginTarget),否则会装出第二份模块。
test("sidecar.ts:ready 之前预载 ext 的同一个 URL", async () => {
  const source = await Bun.file(join(import.meta.dir, "sidecar.ts")).text()
  const engine = source.indexOf('const { Server } = await import("virtual:opencode-server")')
  const preload = source.indexOf("import(pathToFileURL(command.extPluginPath).href)")
  const awaited = source.indexOf("await extPreload")
  const ready = source.indexOf("parentPort.postMessage(buildReadyMessage(injection, prewarmResult))")
  expect(engine).toBeGreaterThan(0)
  expect(preload).toBeGreaterThan(engine)
  expect(awaited).toBeGreaterThan(preload)
  expect(ready).toBeGreaterThan(awaited)
  const shared = await Bun.file(join(import.meta.dir, "../../../opencode/src/plugin/shared.ts")).text()
  const resolver = shared.slice(shared.indexOf("export async function resolvePathPluginTarget"), shared.indexOf("export async function checkPluginCompatibility"))
  expect(resolver).toContain("return pathToFileURL(file).href")
})
