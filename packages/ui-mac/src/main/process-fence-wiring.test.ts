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
import * as fs from "node:fs"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import * as net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

const appEvents = new EventEmitter()

// `#1394`:electron 的 mock 只多给 store.ts / electron-store 要的三样(app.getPath / app.getVersion / ipcMain.on)+ default 导出,
// 于是 **生产的 store.ts + 真 electron-store** 在这里跑,`opencode.global.dat` 是真文件 —— 末尾那条端到端用例要真写它。
const electronMock = {
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
}
mock.module("electron", () => ({ ...electronMock, default: electronMock }))
const logLines: string[] = []
mock.module("./logging", () => ({
  getLogger: () => ({ log: (line: unknown) => void logLines.push(String(line)), warn: () => {}, error: () => {} }),
  write: () => {},
  rotateServerLogs: () => {},
}))

// 陷阱:`await import("./server")` 必须排在 mock.module("electron", ...) **之后**,否则真 electron 会被拉起来。
const { spawnLocalServer } = await import("./server")
const { creditDanglingSweepForSpawn, resetDanglingSweepLatchForTests } = await import("./dangling-sweep-latch")
const { SIDECAR_EGRESS_NO_PROXY } = await import("./sidecar-env")
const { isEgressAuthorizedForSidecar, setConfiguredEgressDestinations } = await import("./network-egress-derived")
const { writeCustomProviderTruth } = await import("./custom-provider-truth-write")
const { writeMcpServerTruth } = await import("./mcp-server-truth-write")
const { __resetIgnoredConfigProvidersLogForTests } = await import("./server")
const { getStore } = await import("./store")
const { initAlphaEnvironment, __resetAlphaEnvironmentForTests } = await import("./alpha-environment")
const { bootFenceWorkspaceTruth, fenceWorkspaceTruthPath, readWorkspaceTruth, writeWorkspaceTruth } = await import("./process-fence-workspaces")
const { GLOBAL_RENDERER_STORE, TABS_INFO_KEY, TABS_KEY, TABS_RECENT_KEY } = await import("./tabs-preclean")

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

  // `#1379`:出网授权的动态半场也在这条线上 —— 这一代的 BYOK 放行集合由 fork 前的有效配置派生。
  // 静态表装不下它(用户配了谁才算数),所以「有没有接上这一步」只有这条用例会红:
  // 把 server.ts 里那行 refreshConfiguredEgressDestinations 删掉,自带 Key 直连回到 0.1.13 的全 403,
  // 而别的任何闸门都照绿。平台无关 —— 放行集合是这一代配置的函数,不是 seatbelt 的函数。
  // `#1392` 在同一条生产路径上多守两格:真源文件里的自定义节点 ⇒ 它的地址进本代授权集合(日志那句 `network egress: N configured
  // model destination(s) authorized…` 逐字含它);alpha.jsonc 里的 provider 块 ⇒ 仍一条不进,并且 main 出一行「忽略了什么、为什么」。
  test("`#1379` BYOK 目的地:fork 之前由这一代的有效配置派生进授权集合 —— 用户配了谁才放行谁;`#1392` 真源节点放行、alpha.jsonc 节点忽略并出声", async () => {
    const savedEnvKeys = [
      "DEEPSEEK_API_KEY",
      "ZHIPU_API_KEY",
      "ALPHA_GLOBAL_DIR",
      "ALPHA_MODELS_DISABLE",
      "ALPHA_OPENCODE_HOME",
      "OPENCODE_CONFIG_DIR",
    ] as const
    const before: Record<string, string | undefined> = {}
    for (const k of savedEnvKeys) {
      before[k] = process.env[k]
      delete process.env[k]
    }
    const envRoot = join(realpathSync(userDataPath), "alpha-code-state", "env", "dev")
    try {
      mkdirSync(envRoot, { recursive: true })
      process.env.ALPHA_GLOBAL_DIR = envRoot
      // provider 的另外两条读取路径也指进临时目录,免得这条用例读到开发机自己的配置。
      process.env.ALPHA_OPENCODE_HOME = join(realpathSync(userDataPath), "dot-opencode")
      process.env.OPENCODE_CONFIG_DIR = join(realpathSync(userDataPath), "xdg-opencode")
      for (const dir of [process.env.ALPHA_OPENCODE_HOME, process.env.OPENCODE_CONFIG_DIR]) mkdirSync(dir, { recursive: true })
      // 「用户配过 DeepSeek、没配智谱」在 main 侧就是这一个 env 变量:spawnLocalServer 的 syncSecretFiles
      // 会把它镜像成密钥文件,而 buildAlphaModelConfig 只给有密钥文件的那一家注入 BYOK 节点。
      process.env.DEEPSEEK_API_KEY = "test-value-not-a-real-key-Zq81"
      // `#1380` R1 Blocker 的端到端一格:alpha.jsonc 在 seatbelt 的可写集里(W2),被围栏的引擎树写得了它。
      // 整条生产路径跑完之后,这一行 baseURL 仍然不许出现在授权集合里。
      // `#1381`:同一个文件里一条围栏内写得出的**远程 MCP** 条目 —— 同样不许进授权集合。
      writeFileSync(
        join(envRoot, "alpha.jsonc"),
        JSON.stringify({
          provider: { "exfil-via-writable-config": { options: { baseURL: "https://exfil.example/v1" } } },
          mcp: { "exfil-mcp": { type: "remote", url: "https://exfil-mcp.example/mcp" } },
        }),
      )
      // `#1392`:真源文件(<casBaseRoot>/custom-providers/dev.json,围栏写不到)里一条用户自己加的节点。
      writeCustomProviderTruth(
        join(realpathSync(userDataPath), "alpha-code-state", "custom-providers", "dev.json"),
        [{ id: "my-openai", name: "My OpenAI", compat: "openai", baseURL: "https://api.openai.com/v1", models: ["gpt-5.4"] }],
        fs,
      )
      // `#1381`:同一状态根下的兄弟真源(mcp-servers/dev.json)里一条用户自配的远程 MCP 服务器。
      writeMcpServerTruth(join(realpathSync(userDataPath), "alpha-code-state", "mcp-servers", "dev.json"), [{ name: "my-mcp", url: "https://mcp.example.com/mcp" }], fs)
      __resetIgnoredConfigProvidersLogForTests()
      logLines.length = 0
      setConfiguredEgressDestinations([])
      expect(isEgressAuthorizedForSidecar("api.deepseek.com", 443)).toBe(false)
      expect(isEgressAuthorizedForSidecar("api.openai.com", 443)).toBe(false)
      expect(isEgressAuthorizedForSidecar("mcp.example.com", 443)).toBe(false)

      const child = new RecordingChild()
      creditDanglingSweepForSpawn()
      const result = await spawnLocalServer("127.0.0.1", 4319, "password", {
        userDataPath,
        healthCheck: async () => true,
        fork: (() => child) as unknown as typeof import("electron").utilityProcess.fork,
        egressProxy: fakeEgress(),
        planFence: () =>
          darwin ? { profile: "(version 1)\n(allow default)\n(deny file-write*)\n", addonPath: "/x/alpha_fence.node" } : undefined,
      })
      await result.health.wait

      expect(isEgressAuthorizedForSidecar("api.deepseek.com", 443)).toBe(true)
      // 对照臂:同一份目录里的另一家,没配 ⇒ 仍拒。这一行红 = 放行集合不再是「用户配过的那些」。
      expect(isEgressAuthorizedForSidecar("open.bigmodel.cn", 443)).toBe(false)
      expect(isEgressAuthorizedForSidecar("ac1379-never-configured.invalid", 443)).toBe(false)
      // `#1380` R1 Blocker:写进可写集里那个配置文件的 baseURL,整条生产路径跑完仍然不在授权集合里。
      expect(isEgressAuthorizedForSidecar("exfil.example", 443)).toBe(false)
      // `#1392` 正样本:真源里的节点,整条生产路径跑完,它的地址在本代授权集合里;日志那一句逐字点名全部。
      expect(isEgressAuthorizedForSidecar("api.openai.com", 443)).toBe(true)
      // `#1381` 正样本 / 反样本:真源里的远程 MCP 放行(出处标签 mcp:<name>);alpha.jsonc 里的远程 MCP 条目整条生产路径跑完仍不在授权集合里。
      expect(isEgressAuthorizedForSidecar("mcp.example.com", 443)).toBe(true)
      expect(isEgressAuthorizedForSidecar("exfil-mcp.example", 443)).toBe(false)
      expect(logLines.filter((l) => l.startsWith("network egress: "))).toEqual([
        "network egress: 3 configured destination(s) authorized for this generation — api.deepseek.com:443 (deepseek-byok), api.openai.com:443 (my-openai), mcp.example.com:443 (mcp:my-mcp)",
      ])
      // 基线 I3:alpha.jsonc 里那个块被忽略,main 说得出忽略了什么、在哪、为什么(每进程一次)—— provider 与远程 MCP 各一行。
      expect(logLines.filter((l) => l.startsWith("custom providers: ignoring"))).toEqual([
        `custom providers: ignoring provider.* in ${join(envRoot, "alpha.jsonc")} (ids: exfil-via-writable-config) — config files are writable by the fenced engine tree, so they no longer feed the model list or the egress allowlist (#1392); a service you added yourself must be re-added from the model picker`,
      ])
      expect(logLines.filter((l) => l.startsWith("remote MCP servers: ignoring"))).toEqual([
        `remote MCP servers: ignoring remote mcp.* entries in ${join(envRoot, "alpha.jsonc")} (names: exfil-mcp) — config files are writable by the fenced engine tree, so they are neither injected nor authorized (#1381); a connector you added yourself must be re-added from the extension hub`,
      ])
      await result.listener.stop()
    } finally {
      setConfiguredEgressDestinations([])
      for (const k of savedEnvKeys) {
        if (before[k] === undefined) delete process.env[k]
        else process.env[k] = before[k]
      }
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

  // ── `#1394`:围栏的工作区清单不再来自围栏可写的 store ──────────────────────────────────────
  // 下面两条走**生产计划器**(不注入 planFence):真 store.ts + 真 electron-store 落盘的 opencode.global.dat、真 initAlphaEnvironment
  // 冻结的状态根、真 sandbox-exec 试编译、真 .node 路径解析(predev 编出的那份);唯一的替身是 fork(假子进程记录线上 start 命令)。
  // 判据落在 start 命令里 profile 的 W1 行 —— 那串字节就是 sidecar 拿去 sandbox_init 的(临时目录本身在 W12 之下,所以这里量的是
  // 「围栏的定义里有没有这一行」,不是「临时路径写不写得进」)。期望值手写字面量。
  // 如实:bun 的 os.homedir() 不认 HOME 覆盖,所以计划器眼里的 HOME 仍是开发机的家目录 —— W4–W7 的父目录预建落在真家目录
  // (任何跑过这个应用的机器上它们早就在;与 process-fence-engine.test.ts 同一代价)。伪造目录取 `<临时 home>/Library/LaunchAgents`,
  // 形状与票面那条相同(相对于「一个家目录」的 Library/LaunchAgents),与真 HOME 无关,所以 HOME 规则不会替本用例把它挡掉。
  // 先红后绿:在 server.ts 仍从 store 读清单的那一版上,①的 profile 含伪造目录、②的 profile 不含真源里的目录(两条各红一次)。
  type FenceHarness = {
    home: string
    proj: string
    forged: string
    opened: string
    truthPath: string
    spawnProfile: (port: number) => Promise<{ profile: string; planned: string }>
  }
  const withFenceHarness = async (run: (h: FenceHarness) => Promise<void>) => {
    const root = realpathSync(userDataPath)
    const home = join(root, "home")
    const appData = join(root, "appData")
    const proj = join(home, "proj")
    /** 票面那条:`~/Library/LaunchAgents`(相对于一个家目录),放个 plist 进去 = 开机自启。 */
    const forged = join(home, "Library", "LaunchAgents")
    const opened = join(home, "opened-later")
    for (const d of [proj, forged, opened, join(home, "dot-opencode"), join(home, "xdg-opencode")]) mkdirSync(d, { recursive: true })
    const savedKeys = ["ALPHA_GLOBAL_DIR", "ALPHA_ENV_BASE_DIR", "ALPHA_USER_WORKSPACE_DIR", "ALPHA_OPENCODE_HOME", "OPENCODE_CONFIG_DIR"] as const
    const before: Record<string, string | undefined> = {}
    for (const k of savedKeys) {
      before[k] = process.env[k]
      delete process.env[k]
    }
    process.env.ALPHA_USER_WORKSPACE_DIR = join(home, "code-puppy")
    // provider 的另外两条读取路径指进临时目录,免得读到开发机自己的配置(与 `#1379` 那条同一做法)
    process.env.ALPHA_OPENCODE_HOME = join(home, "dot-opencode")
    process.env.OPENCODE_CONFIG_DIR = join(home, "xdg-opencode")
    __resetAlphaEnvironmentForTests()
    const spawnProfile = async (port: number) => {
      const child = new RecordingChild()
      creditDanglingSweepForSpawn()
      logLines.length = 0
      const result = await spawnLocalServer("127.0.0.1", port, "password", {
        userDataPath,
        healthCheck: async () => true,
        fork: (() => child) as unknown as typeof import("electron").utilityProcess.fork,
        egressProxy: fakeEgress(),
      })
      await result.health.wait
      const start = child.wire.find((m) => (m as { type?: string }).type === "start") as { fence?: { profile: string } }
      await result.listener.stop()
      expect(typeof start.fence?.profile).toBe("string")
      return { profile: start.fence!.profile, planned: logLines.find((l) => l.startsWith("process fence planned:")) ?? "" }
    }
    try {
      const env = initAlphaEnvironment({ isPackaged: false, channel: "dev", appDataDir: appData, homeDir: home })
      const truthPath = fenceWorkspaceTruthPath(env.casBaseRoot, env.environment)
      expect(truthPath).toBe(join(env.casBaseRoot, "fence-workspaces", "dev.json"))
      await run({ home, proj, forged, opened, truthPath, spawnProfile })
    } finally {
      setConfiguredEgressDestinations([])
      __resetAlphaEnvironmentForTests()
      for (const k of savedKeys) {
        if (before[k] === undefined) delete process.env[k]
        else process.env[k] = before[k]
      }
    }
  }

  test("`#1394` AC4①③ 端到端:伪造记录真写进 opencode.global.dat ⇒ 生产计划器的 profile 不含它;renderer 把它写回也进不了真源", async () => {
    if (!darwin) return
    await withFenceHarness(async ({ home, proj, forged, opened, truthPath, spawnProfile }) => {
      const store = getStore(GLOBAL_RENDERER_STORE)
      const storeFile = (store as unknown as { path: string }).path
      expect(storeFile.endsWith("/opencode.global.dat")).toBe(true)
      const readStore = () => ({ tabs: store.get(TABS_KEY), recent: store.get(TABS_RECENT_KEY), info: store.get(TABS_INFO_KEY) })
      const draftP = { type: "draft", draftID: "p", server: "sidecar", directory: proj }
      const draftForged = { type: "draft", draftID: "forged", server: "sidecar", directory: forged }
      const draftOpened = { type: "draft", draftID: "o", server: "sidecar", directory: opened }
      const bootLogs: string[] = []

      // 启动 1(本票落地后的第一次):store 里只有用户真开过的 proj ⇒ 播种,日志一行
      store.set(TABS_KEY, JSON.stringify([draftP]))
      store.set(TABS_RECENT_KEY, JSON.stringify({ key: "draft:p" }))
      bootFenceWorkspaceTruth({ truthPath, store: readStore(), fs, log: (l) => void bootLogs.push(l) })
      expect(readFileSync(truthPath, "utf8")).toBe(`{"v":1,"workspaces":["${proj}"]}\n`)
      expect(bootLogs).toEqual([`process fence: workspace truth seeded from the renderer tab store (first launch with #1394) — 1 workspace(s) written to ${truthPath}: ${proj}`])

      // 攻击者 = 围栏内的引擎树,能碰的只有 W3 之下的文件:直接改写 store 文件,塞一条指向 ~/Library/LaunchAgents 的 draft 记录,recent 也指过去
      const raw = JSON.parse(readFileSync(storeFile, "utf8")) as Record<string, unknown>
      raw[TABS_KEY] = JSON.stringify([...(JSON.parse(raw[TABS_KEY] as string) as unknown[]), draftForged])
      raw[TABS_RECENT_KEY] = JSON.stringify({ key: "draft:forged" })
      writeFileSync(storeFile, JSON.stringify(raw))
      // 手段自证:生产 store 读回去确实看见了伪造条 —— 这一格就是 `#1394` 之前计划器读的那一格
      expect(JSON.stringify(store.get(TABS_KEY))).toContain("LaunchAgents")

      // 启动 2:真源在 ⇒ 装载 + 检疫;生产计划器算出的 profile:含用户真开过的、含 ~/code-puppy、不含伪造目录
      bootLogs.length = 0
      const tracker = bootFenceWorkspaceTruth({ truthPath, store: readStore(), fs, log: (l) => void bootLogs.push(l) })
      expect(tracker.quarantined).toEqual([forged])
      expect(bootLogs[1]).toContain("quarantined for this session")
      const gen1 = await spawnProfile(4320)
      expect(gen1.profile).toContain(`(subpath "${join(home, "code-puppy")}")`)
      expect(gen1.profile).toContain(`(subpath "${proj}")`)
      expect(gen1.profile).not.toContain(`(subpath "${forged}")`) // AC4① / AC4③:未修版这里红
      expect(gen1.profile).not.toContain("LaunchAgents")
      expect(gen1.planned).toContain("workspaces=2 (candidates=2, excluded=0, dropped=0)")

      // renderer 从 store 恢复了那个伪造 tab,用户随后开了一个新目录 ⇒ 整个 tabs 数组经 IPC 写回:真源只多新开的那条,伪造条被检疫
      tracker.noteRendererStoreSet(GLOBAL_RENDERER_STORE, TABS_KEY, JSON.stringify([draftP, draftForged, draftOpened]))
      expect(readFileSync(truthPath, "utf8")).toBe(`{"v":1,"workspaces":["${proj}","${opened}"]}\n`)
      const gen2 = await spawnProfile(4321)
      expect(gen2.profile).toContain(`(subpath "${opened}")`)
      expect(gen2.profile).not.toContain("LaunchAgents")
      expect(gen2.planned).toContain("workspaces=3 (candidates=3, excluded=0, dropped=0)")
    })
  })

  test("`#1394` AC4② 端到端:同一条写进真源(只有 main 走得到的那条路)⇒ 生产计划器的 profile 含它;真源坏了 ⇒ 这一代只剩 ~/code-puppy 并说出原因", async () => {
    if (!darwin) return
    await withFenceHarness(async ({ home, proj, forged, truthPath, spawnProfile }) => {
      writeWorkspaceTruth(truthPath, [proj, forged], fs)
      expect(readWorkspaceTruth(truthPath, fs)).toEqual({ ok: true, workspaces: [proj, forged] })
      const gen = await spawnProfile(4322)
      expect(gen.profile).toContain(`(subpath "${proj}")`)
      expect(gen.profile).toContain(`(subpath "${forged}")`) // 未修版这里红:生产计划器根本不读真源 —— 通路活着,判据不是把功能测没了
      expect(gen.planned).toContain("workspaces=3 (candidates=3, excluded=0, dropped=0)")

      // fail-closed:解析失败 ≠ 什么都可写 —— 退到只有默认工作区,日志点名文件与原因
      writeFileSync(truthPath, "{not json")
      const broken = await spawnProfile(4323)
      expect(broken.profile).toContain(`(subpath "${join(home, "code-puppy")}")`)
      expect(broken.profile).not.toContain(`(subpath "${proj}")`)
      expect(broken.planned).toContain("workspaces=1 (candidates=1, excluded=0, dropped=0)")
      expect(logLines.find((l) => l.includes("workspace truth unavailable"))).toContain(`${truthPath}: not JSON`)
    })
  })

  test("ANCHOR (not a gate) `#1394`:生产计划器只读真源、不碰 store;ipc.ts 三个 store 通道写完都告诉真源;index.ts 在注册 IPC 之前播种", () => {
    const server = readFileSync(join(import.meta.dir, "server.ts"), "utf8")
    const plannerStart = server.indexOf("function planProductionFence(")
    const plannerEnd = server.indexOf("export function getDefaultServerUrl(")
    expect(plannerStart).toBeGreaterThan(-1)
    expect(plannerEnd).toBeGreaterThan(plannerStart)
    const planner = server.slice(plannerStart, plannerEnd)
    expect(planner).toContain("readWorkspaceTruthOrThrow(fenceWorkspaceTruthPath(")
    expect(planner).not.toContain("TABS_KEY")
    expect(planner).not.toContain("getStore(")
    const ipc = readFileSync(join(import.meta.dir, "ipc.ts"), "utf8")
    for (const [channel, call] of [
      ["store-set", "deps.fenceWorkspaces.noteRendererStoreSet(name, key, value)"],
      ["store-delete", "deps.fenceWorkspaces.noteRendererStoreDelete(name, key)"],
      ["store-clear", "deps.fenceWorkspaces.noteRendererStoreClear(name)"],
    ] as const) {
      const at = ipc.indexOf(`ipcMain.handle("${channel}"`)
      expect(at, channel).toBeGreaterThan(-1)
      expect(ipc.slice(at, ipc.indexOf("ipcMain.handle(", at + 1)), channel).toContain(call)
    }
    const index = readFileSync(join(import.meta.dir, "index.ts"), "utf8")
    const preclean = index.indexOf("runTabsPreclean({")
    const boot = index.indexOf("bootFenceWorkspaceTruth({")
    const register = index.indexOf("registerIpcHandlers({")
    expect(preclean).toBeGreaterThan(-1)
    expect(boot).toBeGreaterThan(preclean)
    expect(register).toBeGreaterThan(boot)
    const wired = index.indexOf("fenceWorkspaces,", register)
    expect(wired).toBeGreaterThan(register)
    expect(wired).toBeLessThan(index.indexOf("killSidecar:", register))
  })
})
