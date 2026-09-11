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
//
// `#1337`(REQ-137)在同一条线上多守三跳(darwin):策略代理先于计划起来,端口进计划器 + 整份改写进 fork 的 env
// (用户自己的 HTTP(S)_PROXY / NO_PROXY 不能存活 —— 唯一通路);代理起不来 ⇒ 拒 fork、零 fork;缺省提供者真起监听。
// 非 darwin:没有围栏就不装策略层 —— 不起代理、env 照旧。

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { EventEmitter } from "node:events"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import * as net from "node:net"
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
const { SIDECAR_EGRESS_NO_PROXY } = await import("./sidecar-env")

const darwin = process.platform === "darwin"
/** 假代理提供者:不起监听,只给端口(默认接线的真监听在末尾那条用例里验)。 */
const fakeEgress = (port = 4433) => async () => ({ port })

class RecordingChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  wire: unknown[] = []
  /** `#1322`:假 sidecar 对 write-probe 的回答;undefined = 不回(让 main 侧超时)。 */
  probeAnswer: ((directory: string) => { outcome: "writable" | "denied" | "unknown"; detail?: string }) | undefined = (directory) =>
    directory.startsWith("/inside") ? { outcome: "writable" } : { outcome: "denied", detail: "write EPERM: operation not permitted" }
  postMessage(message: unknown) {
    this.wire.push(message)
    if ((message as { type?: unknown }).type === "start") queueMicrotask(() => this.emit("message", { type: "ready" }))
    if ((message as { type?: unknown }).type === "stop") queueMicrotask(() => this.emit("exit", 0))
    if ((message as { type?: unknown }).type === "write-probe" && this.probeAnswer) {
      const { id, directory } = message as { id: number; directory: string }
      const answer = this.probeAnswer(directory)
      queueMicrotask(() => this.emit("message", { type: "write-probe-result", id, ...answer }))
    }
  }
  kill() {
    queueMicrotask(() => this.emit("exit", 0))
  }
}

let userDataPath = ""
const savedEnv: Record<string, string | undefined> = {}
const managedEnv = ["SHELL", "ALPHA_SECRETS_DISABLE", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "ALL_PROXY", "all_proxy"] as const

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
      egressProxy: fakeEgress(),
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
    // `#1322`:计划进了 start 命令 + sidecar 发了 ready ⇒ 这一代对外自报「围栏装上了」(renderer 沙箱告知的唯一信号源)。
    expect(result.fence).toBe("applied")
    await result.listener.stop()
  })

  test("#1322 写探针经 listener.probeWrite 走线上 write-probe 命令,应答按 id 对号;两个目录两种答案", async () => {
    const child = new RecordingChild()
    creditDanglingSweepForSpawn()
    const result = await spawnLocalServer("127.0.0.1", 4314, "password", {
      userDataPath,
      healthCheck: async () => true,
      fork: (() => child) as unknown as typeof import("electron").utilityProcess.fork,
      egressProxy: fakeEgress(),
      planFence: () => ({ profile: "(version 1)\n(allow default)\n(deny file-write*)\n", addonPath: "/x/alpha_fence.node" }),
    })
    await result.health.wait
    const [inside, outside] = await Promise.all([result.listener.probeWrite("/inside/ws"), result.listener.probeWrite("/outside/ws")])
    expect(inside).toEqual({ outcome: "writable" })
    expect(outside).toEqual({ outcome: "denied", detail: "write EPERM: operation not permitted" })
    const probes = child.wire.filter((m) => (m as { type?: string }).type === "write-probe") as Array<{ id: number; directory: string }>
    expect(probes.map((p) => p.directory)).toEqual(["/inside/ws", "/outside/ws"])
    expect(new Set(probes.map((p) => p.id)).size).toBe(2)
    await result.listener.stop()
    // 停了之后再问:不猜、答 unknown
    expect((await result.listener.probeWrite("/inside/ws")).outcome).toBe("unknown")
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
        egressProxy: fakeEgress(),
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
      egressProxy: fakeEgress(),
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

  test("`#1337` darwin:代理端口进计划器,且 fork 的 env 被整份改写成指向它 —— 用户自己的 HTTPS_PROXY / NO_PROXY 不存活;非 darwin 不起代理、env 照旧", async () => {
    process.env.HTTPS_PROXY = "http://127.0.0.1:7897"
    process.env.https_proxy = "http://127.0.0.1:7897"
    process.env.NO_PROXY = "github.com,.internal"
    const child = new RecordingChild()
    let forkEnv: Record<string, string> = {}
    let planned: number | undefined = -1
    let egressCalls = 0
    creditDanglingSweepForSpawn()
    const result = await spawnLocalServer("127.0.0.1", 4315, "password", {
      userDataPath,
      healthCheck: async () => true,
      fork: ((_: string, __: string[], opts: { env: Record<string, string> }) => {
        forkEnv = { ...opts.env }
        return child
      }) as unknown as typeof import("electron").utilityProcess.fork,
      egressProxy: async () => {
        egressCalls++
        return { port: 51337 }
      },
      planFence: (input) => {
        planned = input.egressProxyPort
        return darwin ? { profile: "(version 1)\n(allow default)\n(deny file-write*)\n", addonPath: "/x/alpha_fence.node" } : undefined
      },
    })
    await result.health.wait
    if (darwin) {
      expect(egressCalls).toBe(1)
      expect(planned).toBe(51337)
      for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) expect(forkEnv[key], key).toBe("http://127.0.0.1:51337")
      expect(forkEnv.NO_PROXY).toBe(SIDECAR_EGRESS_NO_PROXY)
      expect(forkEnv.no_proxy).toBe(SIDECAR_EGRESS_NO_PROXY)
      expect(JSON.stringify(forkEnv)).not.toContain("7897")
      expect(JSON.stringify(forkEnv)).not.toContain("github.com")
      // main 自己的 env 一个字都没动(main / renderer 的出网不在覆盖内)
      expect(process.env.HTTPS_PROXY).toBe("http://127.0.0.1:7897")
      expect(process.env.NO_PROXY).toBe("github.com,.internal")
    } else {
      expect(egressCalls).toBe(0)
      expect(planned).toBeUndefined()
      expect(forkEnv.HTTPS_PROXY).toBe("http://127.0.0.1:7897")
      expect(forkEnv.NO_PROXY).toBe("github.com,.internal")
    }
    await result.listener.stop()
  })

  test("`#1337` darwin:代理起不来 ⇒ spawn 拒绝、消息带原因、fork 一次都不发生(fail-closed);非 darwin 不受影响", async () => {
    let forks = 0
    let planCalls = 0
    creditDanglingSweepForSpawn()
    const attempt = spawnLocalServer("127.0.0.1", 4316, "password", {
      userDataPath,
      healthCheck: async () => true,
      fork: (() => {
        forks++
        return new RecordingChild()
      }) as unknown as typeof import("electron").utilityProcess.fork,
      egressProxy: async () => {
        throw new Error("listen EADDRINUSE: address already in use 127.0.0.1:0")
      },
      planFence: () => {
        planCalls++
        return darwin ? { profile: "(version 1)\n(allow default)\n(deny file-write*)\n", addonPath: "/x/alpha_fence.node" } : undefined
      },
    })
    if (darwin) {
      await expect(attempt).rejects.toThrow(/network egress policy proxy failed to start — sidecar fork refused: .*EADDRINUSE/)
      expect(forks).toBe(0)
      expect(planCalls).toBe(0)
    } else {
      const result = await attempt
      await result.health.wait
      expect(forks).toBe(1)
      await result.listener.stop()
    }
  })

  test("`#1337` darwin:缺省提供者真起一个策略代理 —— fork env 里那个端口在听,且它只做 CONNECT(明文 GET 405);两次 fork 同一端口(跨代复用)", async () => {
    if (!darwin) return
    const ports: number[] = []
    for (const port of [4317, 4318]) {
      const child = new RecordingChild()
      let forkEnv: Record<string, string> = {}
      creditDanglingSweepForSpawn()
      const result = await spawnLocalServer("127.0.0.1", port, "password", {
        userDataPath,
        healthCheck: async () => true,
        fork: ((_: string, __: string[], opts: { env: Record<string, string> }) => {
          forkEnv = { ...opts.env }
          return child
        }) as unknown as typeof import("electron").utilityProcess.fork,
        planFence: (input) => {
          expect(input.egressProxyPort).toBe(Number(new URL(forkEnv.HTTPS_PROXY ?? "http://127.0.0.1:0").port) || input.egressProxyPort)
          return { profile: "(version 1)\n(allow default)\n(deny file-write*)\n", addonPath: "/x/alpha_fence.node" }
        },
      })
      await result.health.wait
      ports.push(Number(new URL(forkEnv.HTTPS_PROXY).port))
      await result.listener.stop()
    }
    expect(ports[0]).toBeGreaterThan(0)
    expect(ports[1]).toBe(ports[0])
    // 读满 Content-Length 即返(bun 的 http 连接 socket 上等对端 close 不可靠,network-egress-proxy.test.ts 同一口径)
    const reply = await new Promise<string>((resolve, reject) => {
      let text = ""
      const s = net.connect(ports[0], "127.0.0.1", () => s.write("GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n"))
      const finish = () => {
        resolve(text)
        s.destroy()
      }
      s.on("data", (c) => {
        text += c.toString()
        const sep = text.indexOf("\r\n\r\n")
        if (sep < 0) return
        const length = /content-length:\s*(\d+)/i.exec(text.slice(0, sep))
        if (length && Buffer.byteLength(text.slice(sep + 4)) >= Number(length[1])) finish()
      })
      s.on("close", finish)
      s.on("error", reject)
    })
    expect(reply).toMatch(/^HTTP\/1\.1 405 /)
    expect(reply).toContain("alpha egress policy")
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
