// #1563(REQ-236 #2)—— MCP 逐服务后台启动的运行期判据。每条都跑生产 `MCP.Service`(真 layer)、
// 真 stdio 子进程(test/fixture/alpha-mcp-startup-stdio.ts)或真 MCP 协议栈,断言的是进程与线上请求,
// 不是内部状态。删掉对应行为时会红的那一处,写在每条用例上方。
//
//   AC1  一台不应答 initialize 的服务在场,另一台的工具 1 秒内可用、只等被调用工具所属的服务
//        (改回「实例闭包里等全部服务」⇒ 第一次读状态就卡到 30 s 连接超时)
//   AC2  进行中报 pending(首次无 error),cwd 不存在 ⇒ workspace_missing,命令不在 PATH ⇒ dependency_missing
//   AC3  远端网络失败按 30 s 起翻倍后台重连、重连那次的 pending 带上次失败、成功后复位;auth 不重连
//        (时钟用 TestClock 注入;分类器未合入前网络失败记 transport)
//   AC4  实例销毁 / 查找未完成时换代:父进程与后代都退出,之后不写回、不发布
//   AC5  6 台同时启动,观测到的并发启动 ≤ 4
//   AC6  服务换代后定义变了的调用响亮失败、没变的走新连接(普通工具经真 SessionTools、Code Mode 经真 CodeModeTool)
//   AC7  tools/list 不吃每服务的请求超时;调用方等连接与工具调用各用各的预算
//
// 本文件 alpha 自有(`alpha-*`,ADR-043),登记在 scripts/gate-files.tsv。

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { expect } from "bun:test"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Agent } from "../../src/agent/agent"
import { GlobalBus } from "../../src/bus/global"
import { disposeInstance } from "../../src/effect/instance-registry"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { MCP } from "../../src/mcp/index"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import type { Provider } from "../../src/provider/provider"
import { MessageID, SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import type { SessionProcessor } from "../../src/session/processor"
import { SessionTools } from "../../src/session/tools"
import { CodeModeTool } from "../../src/tool/code-mode"
import { ToolRegistry } from "../../src/tool/registry"
import { Tool } from "../../src/tool/tool"
import * as Truncate from "../../src/tool/truncate"
import { inMemoryToolPolicyLayer } from "../fixture/alpha-tool-policy"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(MCP.node))
const fixture = path.join(import.meta.dir, "../fixture/alpha-mcp-startup-stdio.ts")
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-1563-"))
const file = (name: string) => path.join(scratch, `${name}-${crypto.randomUUID()}`)

const local = (environment: Record<string, string> = {}, extra: { cwd?: string; timeout?: number } = {}) => ({
  type: "local" as const,
  command: [process.execPath, fixture],
  environment,
  ...extra,
})

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const pidsOf = (pidFile: string) =>
  pollWithTimeout(
    Effect.sync(() => {
      try {
        return JSON.parse(fs.readFileSync(pidFile, "utf8")) as { parent: number; child: number }
      } catch {
        return undefined
      }
    }),
    "fixture did not publish its pids",
  )

const reaped = (pids: number[]) =>
  pollWithTimeout(
    Effect.sync(() => (pids.every((pid) => !alive(pid)) ? true : undefined)),
    `process tree survived: ${pids.join(",")}`,
    "10 seconds",
  )

const statusOf = (name: string) => MCP.Service.use((mcp) => mcp.status()).pipe(Effect.map((all) => all[name]))

const connected = (name: string) =>
  pollWithTimeout(
    statusOf(name).pipe(Effect.map((status) => (status?.status === "connected" ? status : undefined))),
    `${name} never connected`,
    "10 seconds",
  )

const failedEventually = (name: string) =>
  pollWithTimeout(
    statusOf(name).pipe(Effect.map((status) => (status?.status === "failed" ? status : undefined))),
    `${name} never failed`,
    "10 seconds",
  )

// ── AC1 / AC2 ────────────────────────────────────────────────────────────────────────────────────────────────
// 现码上红:实例闭包里 forEach 等全部服务 ⇒ 第一次 `status()` 卡到 hang 的 30 s 连接超时。
it.instance(
  "AC1/AC2: a server that never answers initialize holds back neither status nor another server's tools",
  () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      // 首次尝试的 pending 不带 error(error 只属于后台重连)。
      expect((yield* mcp.status()).hang).toEqual({ status: "pending" })

      const tools = yield* pollWithTimeout(
        mcp.tools().pipe(Effect.map((all) => ("fast_echo" in all ? all : undefined))),
        "the fast server's tools were not available within 1 second",
        "1 second",
      )
      expect(Object.keys(tools).filter((key) => key.startsWith("hang_"))).toEqual([])
      expect((yield* mcp.status()).hang).toEqual({ status: "pending" })
      expect(yield* mcp.instructions()).toEqual([])

      // 只等被调用工具所属的服务:hang 仍在握手,fast 的调用照常完成。
      const entry = tools.fast_echo!
      const result = yield* mcp.callTool!(
        "fast",
        "echo",
        { text: "hi" },
        {
          generation: entry.generation,
          defDigest: entry.defDigest,
        },
      )
      expect(result.content).toEqual([{ type: "text", text: "hi" }])
      expect((yield* mcp.status()).hang).toEqual({ status: "pending" })
    }),
  { config: { mcp: { hang: local({ ALPHA_MCP_HANG: "1" }), fast: local() } } },
)

// 审计 F3:后台启动失败时也要发 mcp.tools.changed —— 界面靠它重读状态;不发就一直停在「准备中」。
it.instance(
  "AC2: a background startup that fails publishes the server's change and reports failed",
  () =>
    Effect.gen(function* () {
      const changed: unknown[] = []
      const listen = (event: { payload?: { type?: string; properties?: { server?: string } } }) => {
        if (event.payload?.type === "mcp.tools.changed") changed.push(event.payload.properties?.server)
      }
      GlobalBus.on("event", listen)
      yield* Effect.gen(function* () {
        const mcp = yield* MCP.Service
        expect((yield* mcp.status()).stuck).toEqual({ status: "pending" })
        yield* pollWithTimeout(
          Effect.sync(() => (changed.includes("stuck") ? true : undefined)),
          "the failed background startup published no mcp.tools.changed",
        )
        expect((yield* mcp.status()).stuck).toMatchObject({ status: "failed", code: "handshake_timeout" })
      }).pipe(Effect.ensuring(Effect.sync(() => GlobalBus.off("event", listen))))
    }),
  { config: { mcp: { stuck: local({ ALPHA_MCP_HANG: "1" }, { timeout: 500 }) } } },
)

// 删掉 connectLocal 的那一次 stat ⇒ cwd 缺失也是 `spawn … ENOENT` ⇒ 被报成 dependency_missing。
it.instance("AC2: a missing working directory and a missing command fail with their named codes", () =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    yield* mcp.add("no-cwd", local({}, { cwd: "does-not-exist" }))
    yield* mcp.add("no-cmd", { type: "local", command: ["alpha-mcp-no-such-command-1563"] })
    const status = yield* mcp.status()
    expect(status["no-cwd"]).toMatchObject({ status: "failed", code: "workspace_missing" })
    expect(status["no-cmd"]).toMatchObject({ status: "failed", code: "dependency_missing" })
  }),
)

// #1564 AC6:文档工具随包的解释器不在(包被删改)⇒ 只是这台服务 failed / dependency_missing,不在后台反复重启它。
// 判据:事后把那个路径补上(一个会记下自己被启动的脚本),推过 30 s / 60 s / 10 min 也一次没被启动;用户重试(装好之后)
// 才启动并连上 —— 后一半证明「记下启动」这个探针测得到启动。把 localFailure 的 dependency_missing 改成可重连 ⇒ 记录提前出现。
it.instance(
  "#1564 AC6: a missing bundled Office interpreter fails as dependency_missing and is not respawned in the background",
  () =>
    Effect.gen(function* () {
      const resources = path.join(scratch, `Code Puppy-${crypto.randomUUID()}.app`, "Contents", "Resources")
      const python = path.join(resources, "office-runtime", "bin", "python3")
      const launches = file("bundled-python-launches")
      const mcp = yield* MCP.Service
      yield* mcp.add("alpha-word", {
        type: "local",
        command: [python, "-I", "-B", path.join(resources, "office-mcp", "server.py"), "word", "{workspace}"],
        environment: { ALPHA_MCP_STARTUP_LOG: launches },
      })
      expect(yield* statusOf("alpha-word")).toMatchObject({ status: "failed", code: "dependency_missing" })
      fs.mkdirSync(path.dirname(python), { recursive: true })
      fs.writeFileSync(python, `#!/bin/sh\nexec '${process.execPath}' '${fixture}' "$@"\n`, { mode: 0o755 })
      for (const step of ["30 seconds", "60 seconds", "10 minutes", "10 minutes"] as const) {
        yield* TestClock.adjust(step)
        yield* quiet
      }
      expect(fs.existsSync(launches)).toBe(false)
      expect(yield* statusOf("alpha-word")).toMatchObject({ status: "failed", code: "dependency_missing" })
      yield* mcp.connect("alpha-word")
      expect(yield* statusOf("alpha-word")).toEqual({ status: "connected" })
      expect(fs.readFileSync(launches, "utf8")).toStartWith("+")
    }).pipe(Effect.provide(TestClock.layer())),
)

// ── AC3 ──────────────────────────────────────────────────────────────────────────────────────────────────────
const REMOTE = "http://alpha-1563-reconnect.invalid/mcp"
const cloud = { type: "remote" as const, url: REMOTE, oauth: false as const, timeout: 5_000 }

// 真实样本:Node v22.22.3(引擎跑在 Electron utilityProcess 的 Node 里)对一个已关闭的本机端口 fetch,
// 2026-10-30 实测:`TypeError: fetch failed` ← `connect ECONNREFUSED 127.0.0.1:65067`(code/errno/syscall 同下)。
function refused() {
  const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:65067"), {
    code: "ECONNREFUSED",
    errno: -61,
    syscall: "connect",
    address: "127.0.0.1",
    port: 65067,
  })
  return new TypeError("fetch failed", { cause })
}

type Mode = "refuse" | "hold" | "serve" | "unauthorized"

/** 远端替身:替换全局 fetch(两种 SDK transport 都用它),按 mode 拒连 / 挂住 / 回 401 / 交给真 MCP server。 */
function remoteStandIn() {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const protocol = new Server({ name: "alpha-1563-remote", version: "1.0.0" }, { capabilities: { tools: {} } })
      protocol.setRequestHandler(ListToolsRequestSchema, () =>
        Promise.resolve({ tools: [{ name: "probe", inputSchema: { type: "object" as const, properties: {} } }] }),
      )
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
      })
      await protocol.connect(transport)
      const original = globalThis.fetch
      const net = { mode: "refuse" as Mode, posts: 0, release: () => {} }
      const dispatch = async (request: Request): Promise<Response> => {
        if (net.mode === "hold") {
          await new Promise<void>((resolve) => (net.release = resolve))
          return dispatch(request)
        }
        if (net.mode === "refuse") throw refused()
        if (net.mode === "unauthorized" && request.method === "POST")
          return new Response("unauthorized", { status: 401 })
        if (request.method === "GET") return new Response(null, { status: 405 })
        return transport.handleRequest(request)
      }
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        if (!request.url.startsWith(REMOTE)) return original(input, init)
        if (request.method === "POST") net.posts++
        return dispatch(request)
      }) as typeof fetch
      return { net, protocol, original }
    }),
    (s) =>
      Effect.promise(async () => {
        globalThis.fetch = s.original
        s.net.release()
        await s.protocol.close().catch(() => {})
      }),
  ).pipe(Effect.map((s) => s.net))
}

/** TestClock 只推进被注入的时钟;等后台 fiber 把真 I/O 做完要用真时间。 */
const settle = <A, R>(probe: Effect.Effect<A | undefined, never, R>, message: string) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const value = yield* probe
      if (value !== undefined) return value
      yield* Effect.promise(() => Bun.sleep(20))
    }
    return yield* Effect.die(new Error(message))
  })
const quiet = Effect.promise(() => Bun.sleep(150))

// 删掉 reconnect 的调度 ⇒ 30 s 处没有新 POST;把 retries 的复位删掉 ⇒ 成功后的下一次等 240 s 而不是 30 s。
it.instance("AC3: a remote network failure reconnects in the background — 30 s, doubling, reset after success", () =>
  Effect.gen(function* () {
    const net = yield* remoteStandIn()
    const mcp = yield* MCP.Service
    const posts = () => net.posts

    yield* mcp.add("cloud", cloud)
    const first = yield* statusOf("cloud")
    expect(first).toMatchObject({ status: "failed", code: "transport" })
    const firstError = first?.status === "failed" ? first.error : ""
    const n1 = posts()

    yield* TestClock.adjust("29 seconds")
    yield* quiet
    expect(posts()).toBe(n1)

    // 30 s:重连。挂住这次请求,看它进行中报的 pending 带上一次失败的原因。
    net.mode = "hold"
    yield* TestClock.adjust("1 second")
    const retrying = yield* settle(
      statusOf("cloud").pipe(Effect.map((status) => (status?.status === "pending" ? status : undefined))),
      "no reconnect at 30 s",
    )
    expect(retrying).toEqual({ status: "pending", error: firstError })
    net.mode = "refuse"
    net.release()
    yield* settle(
      statusOf("cloud").pipe(Effect.map((status) => (status?.status === "failed" ? status : undefined))),
      "the 30 s reconnect did not settle",
    )
    const n2 = posts()
    expect(n2).toBeGreaterThan(n1)

    // 第二次失败后等 60 s。
    yield* TestClock.adjust("59 seconds")
    yield* quiet
    expect(posts()).toBe(n2)
    yield* TestClock.adjust("1 second")
    yield* settle(
      Effect.sync(() => (posts() > n2 ? true : undefined)),
      "no reconnect at 60 s",
    )

    // 第三次失败后等 120 s;这一次网络恢复 ⇒ 回到 connected。
    net.mode = "serve"
    yield* TestClock.adjust("120 seconds")
    yield* settle(
      statusOf("cloud").pipe(Effect.map((status) => (status?.status === "connected" ? status : undefined))),
      "did not reconnect after the network came back",
    )
    expect(Object.keys(yield* mcp.tools())).toEqual(["cloud_probe"])

    // 成功后复位:再失败一次(用户发起的连接),下一次后台重连又是 30 s。
    net.mode = "refuse"
    yield* mcp.connect("cloud")
    expect(yield* statusOf("cloud")).toMatchObject({ status: "failed", code: "transport" })
    const n3 = posts()
    yield* TestClock.adjust("29 seconds")
    yield* quiet
    expect(posts()).toBe(n3)
    yield* TestClock.adjust("1 second")
    yield* settle(
      Effect.sync(() => (posts() > n3 ? true : undefined)),
      "backoff did not reset after the success",
    )
  }).pipe(Effect.provide(TestClock.layer())),
)

// auth 是确定性失败:把 remoteFailure 里 auth 的 reconnect 改成 true ⇒ 30 s 后多出 POST。
// (`policy` 臂要靠网络方案的分层分类器认出 `Proxy response (403)`;分类器未合入前它记 transport。)
it.instance("AC3: an auth failure does not reconnect", () =>
  Effect.gen(function* () {
    const net = yield* remoteStandIn()
    net.mode = "unauthorized"
    const mcp = yield* MCP.Service
    yield* mcp.add("cloud", cloud)
    expect(yield* statusOf("cloud")).toMatchObject({ status: "failed", code: "auth" })
    const n = net.posts
    expect(n).toBe(1)
    for (const step of ["30 seconds", "60 seconds", "10 minutes", "10 minutes"] as const) {
      yield* TestClock.adjust(step)
      yield* quiet
    }
    expect(net.posts).toBe(n)
    expect(yield* statusOf("cloud")).toMatchObject({ status: "failed", code: "auth" })
  }).pipe(Effect.provide(TestClock.layer())),
)

// ── AC4 ──────────────────────────────────────────────────────────────────────────────────────────────────────
const hangPids = file("hang-pids")
const livePids = file("live-pids")

// 把 `disposed` 的 finalizer 去掉(或注册在缓存之前)⇒ 关闭连接时 onclose 照常写回并发布 mcp.tools.changed;
// 把 transport 的 finalizer 改成「只在握手成功后注册」⇒ 握手中的那棵进程树活到 30 s 连接超时。
it.instance(
  "AC4: disposing the instance reaps every process tree, mid-handshake or connected, and publishes nothing after",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const mcp = yield* MCP.Service
      yield* mcp.status()
      const hang = yield* pidsOf(hangPids)
      yield* connected("live")
      const live = yield* pidsOf(livePids)
      expect([hang.parent, hang.child, live.parent, live.child].every(alive)).toBe(true)

      const late: unknown[] = []
      const listen = (event: { payload?: { type?: string; properties?: unknown } }) => {
        if (event.payload?.type === "mcp.tools.changed") late.push(event.payload.properties)
      }
      GlobalBus.on("event", listen)
      yield* Effect.promise(() => disposeInstance(test.directory)).pipe(
        Effect.andThen(reaped([hang.parent, hang.child, live.parent, live.child])),
        Effect.ensuring(Effect.sync(() => GlobalBus.off("event", listen))),
      )
      expect(late).toEqual([])
    }),
  {
    config: () => ({
      mcp: {
        hang: local({ ALPHA_MCP_HANG: "1", ALPHA_MCP_CHILD: "1", ALPHA_MCP_PID_FILE: hangPids }),
        live: local({ ALPHA_MCP_CHILD: "1", ALPHA_MCP_PID_FILE: livePids }),
      },
    }),
  },
)

const stalePids = file("stale-pids")

// 写回只认当前代:isCurrent 不核代号 ⇒ 被掐死的旧查找把 failed 写回到新一代(disabled)头上。
it.instance(
  "AC4: replacing a server while its lookup is unfinished reaps that attempt's tree; the stale attempt never writes back",
  () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      expect((yield* mcp.status()).hang).toEqual({ status: "pending" })
      const first = yield* pidsOf(stalePids)

      yield* mcp.disconnect("hang")
      expect((yield* mcp.status()).hang).toEqual({ status: "disabled" })
      yield* reaped([first.parent, first.child])
      yield* Effect.promise(() => Bun.sleep(300))
      expect((yield* mcp.status()).hang).toEqual({ status: "disabled" })
    }),
  {
    config: () => ({
      mcp: { hang: local({ ALPHA_MCP_HANG: "1", ALPHA_MCP_CHILD: "1", ALPHA_MCP_PID_FILE: stalePids }) },
    }),
  },
)

const queuedPids = file("queued-pids")

// 审计 F1:排队等名额(或卡在 cwd 的 stat)时被换代的查找,scope 已关、finalizer 挂上即空跑 ——
// 不先核当前代就照常 spawn、握手成功、成功分支只跳过写回 ⇒ 第 5 台的进程无人收。
it.instance(
  "AC4/AC5: a server replaced while it queues for a startup slot never leaves a process behind",
  () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      // h1–h4 占满四个名额(各自握手到 1 s 超时才放手),queued 排在第五个。
      expect((yield* mcp.status()).queued).toEqual({ status: "pending" })
      yield* mcp.disconnect("queued")
      for (const name of ["h1", "h2", "h3", "h4"]) yield* failedEventually(name)
      // 名额已放开;没守住的话第 5 台此刻已经起进程并连上(fixture 起来约 0.2 s)。
      yield* Effect.promise(() => Bun.sleep(1_500))
      const started = fs.existsSync(queuedPids)
        ? (JSON.parse(fs.readFileSync(queuedPids, "utf8")) as { parent: number })
        : undefined
      expect(started === undefined || !alive(started.parent)).toBe(true)
      expect((yield* mcp.status()).queued).toEqual({ status: "disabled" })
      // 名额照常释放:之后的服务还能起来。
      yield* mcp.add("after", local())
      expect((yield* mcp.status()).after).toEqual({ status: "connected" })
    }),
  {
    config: () => ({
      mcp: {
        h1: local({ ALPHA_MCP_HANG: "1" }, { timeout: 1_000 }),
        h2: local({ ALPHA_MCP_HANG: "1" }, { timeout: 1_000 }),
        h3: local({ ALPHA_MCP_HANG: "1" }, { timeout: 1_000 }),
        h4: local({ ALPHA_MCP_HANG: "1" }, { timeout: 1_000 }),
        queued: local({ ALPHA_MCP_PID_FILE: queuedPids }),
      },
    }),
  },
  30_000,
)

// ── AC5 ──────────────────────────────────────────────────────────────────────────────────────────────────────
const startupLog = file("startups")

// 去掉 layer 级 Semaphore ⇒ 6 台一起起,峰值 6。
it.instance(
  "AC5: six servers starting together never have more than four startups in flight",
  () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      yield* mcp.status()
      for (let index = 1; index <= 6; index++) yield* connected(`s${index}`)
      const marks = fs.readFileSync(startupLog, "utf8")
      let running = 0
      let peak = 0
      for (const mark of marks) {
        running += mark === "+" ? 1 : -1
        peak = Math.max(peak, running)
      }
      expect(marks.length).toBe(12)
      expect(peak).toBe(4)
    }),
  {
    config: () => ({
      mcp: Object.fromEntries(
        [1, 2, 3, 4, 5, 6].map((index) => [
          `s${index}`,
          // 每台握手至少 800 ms:前四台的启动窗口必然重叠,峰值恰为 4 证明闸门在限流而不是被串行掩盖。
          local({ ALPHA_MCP_INIT_DELAY_MS: "800", ALPHA_MCP_STARTUP_LOG: startupLog }),
        ]),
      ),
    }),
  },
  20_000,
)

// ── AC6 ──────────────────────────────────────────────────────────────────────────────────────────────────────
const CHANGED = /changed after this request was prepared/

const passThrough = Layer.mergeAll(
  Layer.mock(Plugin.Service, {
    trigger: ((_name: unknown, _input: unknown, output: unknown) =>
      Effect.succeed(output)) as Plugin.Interface["trigger"],
  }),
  Layer.mock(Permission.Service, { ask: (() => Effect.void) as Permission.Interface["ask"] }),
  Layer.mock(Truncate.Service, {
    output: (text: string) => Effect.succeed({ content: text, truncated: false as const }),
  }),
  inMemoryToolPolicyLayer(),
)

const sessionRig = Layer.mergeAll(
  passThrough,
  Layer.mock(ToolRegistry.Service, { tools: () => Effect.succeed([]) }),
  RuntimeFlags.layer({ experimentalCodeMode: false }),
)

const codeModeRig = Layer.mergeAll(
  passThrough,
  Layer.mock(Agent.Service, { get: () => Effect.succeed({ name: "build", permission: [] } as never) }),
  Layer.mock(Session.Service, { get: () => Effect.succeed({ permission: [] } as never) }),
)

/** 普通工具的生产咽喉:真 `SessionTools.resolve`(一次模型请求的工具集合在这里固定)。 */
const resolveSessionTools = SessionTools.resolve({
  agent: {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  },
  model: { providerID: ProviderV2.ID.make("test"), api: { id: "test-model" } } as Provider.Model,
  session: { id: SessionID.make("ses_alpha_1563"), permission: [] } as unknown as Session.Info,
  processor: {
    message: { id: MessageID.ascending() },
    updateToolCall: () => Effect.void,
    completeToolCall: () => Effect.void,
    registerToolDisplay: () => {},
  } as unknown as Pick<
    SessionProcessor.Handle,
    "message" | "updateToolCall" | "completeToolCall" | "registerToolDisplay"
  >,
  bypassAgentCheck: false,
  messages: [],
  promptOps: {} as never,
})

const runTool = (tool: { execute?: (...args: never[]) => unknown }, args: Record<string, unknown>) =>
  Effect.tryPromise({
    try: () =>
      Promise.resolve(tool.execute!(args as never, { toolCallId: "call_1563", messages: [] } as never)) as Promise<{
        output: string
      }>,
    catch: (error) => error as Error,
  })

// 回到 convertTool 捕获的 client(或 callTool 不核代号与摘要)⇒ 换代后旧 client 已关,未变那臂也红 / 变了那臂不红。
it.instance(
  "AC6: an ordinary tool offered before a reconnect runs on the new connection only while its definition holds",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const description = path.join(test.directory, "description.txt")
      fs.writeFileSync(description, "v1")
      const mcp = yield* MCP.Service
      yield* mcp.add("svc", local({ ALPHA_MCP_DESCRIPTION_FILE: description }))
      const tools = yield* resolveSessionTools

      yield* mcp.connect("svc") // 换代,定义未变
      expect((yield* runTool(tools.svc_echo!, { text: "same definition" })).output).toBe("same definition")

      fs.writeFileSync(description, "v2")
      yield* mcp.connect("svc") // 换代,定义变了
      const exit = yield* runTool(tools.svc_echo!, { text: "stale" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toMatch(CHANGED)
    }).pipe(Effect.provide(sessionRig)),
)

const codeModeContext = (): Tool.Context => ({
  sessionID: SessionID.make("ses_alpha_1563"),
  messageID: MessageID.ascending(),
  agent: "build",
  abort: new AbortController().signal,
  callID: "call_1563_code",
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

/** Code Mode 的目录在 execute 开头固定:程序先在另一台服务上慢调用,其间 svc 换代,再调 svc。 */
const codeModeAcrossReconnect = (changeDefinition: boolean) =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const description = path.join(test.directory, "description.txt")
    const calls = path.join(test.directory, "calls.log")
    fs.writeFileSync(description, "v1")
    fs.writeFileSync(calls, "")
    const mcp = yield* MCP.Service
    yield* mcp.add("svc", local({ ALPHA_MCP_DESCRIPTION_FILE: description }))
    yield* mcp.add("other", local({ ALPHA_MCP_CALL_LOG: calls }))

    const tool = yield* Tool.init(yield* CodeModeTool)
    const program = yield* tool
      .execute(
        {
          code: "await tools.other.slow({ ms: 2500 }); return await tools.svc.echo({ text: 'after reconnect' })",
        },
        codeModeContext(),
      )
      .pipe(Effect.exit, Effect.forkScoped)
    yield* pollWithTimeout(
      Effect.sync(() => (fs.readFileSync(calls, "utf8").includes("slow") ? true : undefined)),
      "the program never reached its first child call",
    )
    if (changeDefinition) fs.writeFileSync(description, "v2")
    yield* mcp.connect("svc")
    return yield* Fiber.join(program)
  }).pipe(Effect.provide(codeModeRig))

it.instance("AC6: a Code Mode child call after a reconnect with the same definition uses the new connection", () =>
  Effect.gen(function* () {
    const exit = yield* codeModeAcrossReconnect(false)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) expect(exit.value.output).toBe("after reconnect")
  }),
)

it.instance("AC6: a Code Mode child call after a reconnect that changed its definition fails loudly", () =>
  Effect.gen(function* () {
    const exit = yield* codeModeAcrossReconnect(true)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toMatch(CHANGED)
  }),
)

// ── AC7 ──────────────────────────────────────────────────────────────────────────────────────────────────────
// 把 tools/list 改回吃 `mcp.timeout` ⇒ 1000 ms 预算下 1500 ms 的 tools/list 失败(tools_list_failed)。
it.instance("AC7: tools/list runs on its own budget, not the server's request timeout", () =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    yield* mcp.add("slow-list", local({ ALPHA_MCP_LIST_DELAY_MS: "1500" }, { timeout: 1_000 }))
    expect((yield* mcp.status())["slow-list"]).toEqual({ status: "connected" })
  }),
)

// 调用方等连接(≥ 0.6 s)与工具调用(1 s)各在 1.5 s 预算内,合计超过 1.5 s:把两段包进同一个预算 ⇒ 失败。
it.instance(
  "AC7: a call that waits for its server's handshake is not cut by the connection budget",
  () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      const started = Date.now()
      const result = yield* mcp.callTool!("slow-start", "slow", { ms: 1_000 }, { generation: 0, timeout: 1_500 })
      expect(result.content).toEqual([{ type: "text", text: "slow" }])
      expect(Date.now() - started).toBeGreaterThan(1_500)
    }),
  { config: { mcp: { "slow-start": local({ ALPHA_MCP_INIT_DELAY_MS: "600" }, { timeout: 1_500 }) } } },
)
