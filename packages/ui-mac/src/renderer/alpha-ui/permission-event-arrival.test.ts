// #1214 AC1 —— 审批事件「到达/就绪」层闸门。
//
// 真机 4/4 复现(2026-09-02,#1214 票面):引擎 `asking` → `/global/event` wire 送达
// renderer 自己的响应流(tee 实测 3 条流各收到一次 `permission.asked`),但审批 UI 零呈现,
// 5 分钟后 fail-closed。既有 permission-dual-channel 闸门(12 pass)替身掉 `@/context/sdk`,
// 只证明「事件已送到订阅回调之后」的世界;它绿而真机不工作 ⇒ 缺的判据在 wire → server-sdk
// 分发 → dir emitter → adapter 订阅 → feed 就绪这一段。本文件用生产真身把这一段全接起来
// (替身只有宿主上下文与脚本化传输;见 permission-event-arrival-test-runtime.tsx 头注)。
//
// 判据纪律(《本机验证陷阱》总纪律):先证明手段能测出已知的坏 ——
//   · 「变异:断开订阅 → 零到达」用例证明记录器不会假阳;
//   · 「v2 快照失败 → ready 恒 false + 有界重试」用例证明 feed 探针能看见已知失效态。

import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import appPlugin from "@opencode-ai/app/vite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { build, type PluginOption } from "vite"
import type * as RuntimeModule from "./permission-event-arrival-test-runtime"

const appSrc = resolve(import.meta.dir, "../../../../app/src")
const stub = join(import.meta.dir, "permission-event-arrival-stub.ts")
const runtimeDirectory = mkdtempSync(join(tmpdir(), "alpha-permission-event-arrival-"))

// server-sdk.tsx / platform.tsx 以**相对路径**引宿主上下文(./language ./server ./global),
// 普通 alias(按 specifier 匹配)接不住,只能按 importer 精确改道。被测模块本体不在此列。
const hostContextStub: PluginOption = {
  name: "arrival-host-context-stub",
  enforce: "pre",
  resolveId(source, importer) {
    if (!importer || !importer.startsWith(join(appSrc, "context"))) return null
    if (source === "./language" || source === "./server" || source === "./global") return stub
    return null
  },
}

await build({
  configFile: false,
  logLevel: "silent",
  plugins: [hostContextStub, appPlugin.at(0)!, appPlugin.at(-1)!],
  build: {
    emptyOutDir: true,
    outDir: runtimeDirectory,
    lib: {
      entry: join(import.meta.dir, "permission-event-arrival-test-runtime.tsx"),
      formats: ["es"],
      fileName: () => "permission-event-arrival-test-runtime.js",
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
})

GlobalRegistrator.register()

const runtime = (await import(
  pathToFileURL(join(runtimeDirectory, "permission-event-arrival-test-runtime.js")).href
)) as typeof RuntimeModule

const DIRECTORY = "/Users/someone/project"
const SESSION = "ses_arrival_1"

/** v1 引擎在 wire 上真实发出的请求形状(engine `PermissionV1.Request`)。 */
function v1Request(id: string) {
  return {
    id,
    sessionID: SESSION,
    permission: "mcp:cloud:cloud_web_search",
    patterns: ["*"],
    tool: { messageID: "msg_arrival_1", callID: "call_arrival_1" },
  }
}

/** 与 handlers/global.ts 逐字段一致的 wire 信封(EventV2Bridge → GlobalBus → Sse.encode)。 */
function askedEnvelope(id: string, directory: string = DIRECTORY) {
  return {
    directory,
    project: "proj_arrival",
    workspace: undefined,
    payload: { id: `evt_${id}`, type: "permission.asked", properties: v1Request(id) },
  }
}

/** 引擎在每条 /global/event 流开头发出的 server.connected(**不带** directory 信封)。 */
const CONNECTED_FRAME = { payload: { type: "server.connected", properties: {} } }

type ScriptedEngine = ReturnType<typeof createScriptedEngine>

/** 脚本化引擎:/global/event(SSE)+ v1 /permission + v2 /api/session/:id/permission。 */
function createScriptedEngine() {
  const encoder = new TextEncoder()
  const state = {
    connects: 0,
    lists: { v1: 0, v2: 0 },
    v1Pending: [] as unknown[],
    v2Pending: [] as unknown[],
    v2Status: 200,
    streams: [] as Array<{ push: (frame: unknown) => void }>,
  }
  const fetchImpl = (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    if (url.pathname === "/global/event") {
      state.connects++
      let controller!: ReadableStreamDefaultController<Uint8Array>
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c
          c.enqueue(encoder.encode(`data: ${JSON.stringify(CONNECTED_FRAME)}\n\n`))
        },
        cancel() {},
      })
      state.streams.push({
        push: (frame) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`)),
      })
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
    }
    if (url.pathname === "/permission") {
      state.lists.v1++
      return Response.json(state.v1Pending)
    }
    if (/^\/api\/session\/[^/]+\/permission$/.test(url.pathname)) {
      state.lists.v2++
      if (state.v2Status !== 200) return new Response("scripted v2 failure", { status: state.v2Status })
      return Response.json({ data: state.v2Pending })
    }
    return new Response("scripted engine: unknown path " + url.pathname, { status: 404 })
  }) as typeof fetch
  return { state, fetchImpl }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(check: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await sleep(10)
  }
  return check()
}

const realFetch = globalThis.fetch
const disposers: Array<() => void> = []

function bootHarness(engine: ScriptedEngine) {
  // server-sdk 的 event 流对 loopback http 用**全局 fetch**(eventFetch 为 undefined),
  // client 用 platform.fetch —— 两条都指到脚本化引擎。
  globalThis.fetch = engine.fetchImpl
  const harness = runtime.bootArrivalHarness({ url: "http://127.0.0.1:1", fetchImpl: engine.fetchImpl })
  disposers.push(() => harness.dispose())
  return harness
}

afterEach(() => {
  while (disposers.length) disposers.pop()?.()
  globalThis.fetch = realFetch
})

afterAll(() => {
  GlobalRegistrator.unregister()
  rmSync(runtimeDirectory, { recursive: true, force: true })
})

describe("#1214 AC1 事件到达层(wire → server-sdk 分发 → adapter → feed)", () => {
  test("正样本:wire 上的 v1 permission.asked 到达订阅回调,feed 就绪且呈现该请求", async () => {
    const engine = createScriptedEngine()
    const harness = bootHarness(engine)
    const dir = harness.acquireDir(DIRECTORY)
    const probe = harness.attachAdapter(dir, SESSION)
    harness.start()
    expect(await until(() => engine.state.connects >= 1)).toBe(true)
    await until(() => probe.feed.state.ready)

    engine.state.streams.at(-1)!.push(askedEnvelope("per_arrival_1"))
    expect(await until(() => probe.recorded.asked.length === 1)).toBe(true)
    expect(await until(() => probe.feed.state.ready && probe.feed.state.requests.length === 1)).toBe(true)
    expect((probe.feed.state.requests[0] as { id: string }).id).toBe("per_arrival_1")
  })

  test("变异自证:断开订阅后,同一 wire 事件零到达(记录器不会假阳)", async () => {
    const engine = createScriptedEngine()
    const harness = bootHarness(engine)
    const dir = harness.acquireDir(DIRECTORY)
    const probe = harness.attachAdapter(dir, SESSION)
    harness.start()
    expect(await until(() => engine.state.connects >= 1)).toBe(true)
    probe.unsubscribe()

    engine.state.streams.at(-1)!.push(askedEnvelope("per_arrival_mut"))
    await sleep(150)
    expect(probe.recorded.asked.length).toBe(0)
  })

  test("重连兜底:wire 上的 server.connected 必须到达 dir 订阅者并触发 feed 重拉", async () => {
    // 真机 SSE 每 ~10 分钟自然重连一次;#668 的兜底语义 = 重连时 listeners.connected →
    // feed.load() 重拉快照,接住流切换间隙丢失的事件。server.connected 在 wire 上**没有**
    // directory 信封(handlers/global.ts 直接发裸 payload),按 `event.directory ?? "global"`
    // 只会落到 "global" 键 —— 而 adapter 订阅在会话目录的 dir emitter 上。本用例断言
    // 兜底真的会触达;它红 = 生产里每次重连的快照兜底都是死的。
    const engine = createScriptedEngine()
    const harness = bootHarness(engine)
    const dir = harness.acquireDir(DIRECTORY)
    const probe = harness.attachAdapter(dir, SESSION)
    harness.start()
    expect(await until(() => engine.state.connects >= 1)).toBe(true)
    const listsBefore = engine.state.lists.v1

    // 流开头的 server.connected 已在 bootHarness 的首连里发过;这里再推一条,模拟重连帧。
    engine.state.streams.at(-1)!.push(CONNECTED_FRAME)
    expect(await until(() => probe.recorded.connected >= 1)).toBe(true)
    expect(await until(() => engine.state.lists.v1 > listsBefore)).toBe(true)
  })

  test("首建作用域销毁后,其余持有者的订阅必须继续收到事件(refcount 生命周期)", async () => {
    // createRefCountMap 的失聪面:dir ctx 对 server emitter 的订阅清理若绑在**首建者**的
    // reactive 作用域上,首建者先销毁(页面切换/面板开合)而其他消费者仍持有时,
    // 缓存里发给所有人的就是一个永远不再发事件的 emitter —— client(list)照常工作,
    // 症状与真机 4/4 复现同形:传输通、快照通、订阅死。
    const engine = createScriptedEngine()
    const harness = bootHarness(engine)
    const first = harness.acquireDir(DIRECTORY) // 首建者(短命作用域)
    const second = harness.acquireDir(DIRECTORY) // 幸存消费者(如会话页)
    const probe = harness.attachAdapter(second, SESSION)
    harness.start()
    expect(await until(() => engine.state.connects >= 1)).toBe(true)

    first.dispose()
    engine.state.streams.at(-1)!.push(askedEnvelope("per_arrival_2"))
    expect(await until(() => probe.recorded.asked.length === 1)).toBe(true)
  })

  test("已知失效态可见:v2 快照失败 ⇒ ready 恒 false 且有界重试(候选 d 的网络指纹)", async () => {
    const engine = createScriptedEngine()
    engine.state.v2Status = 500
    const harness = bootHarness(engine)
    const dir = harness.acquireDir(DIRECTORY)
    const probe = harness.attachAdapter(dir, SESSION)
    harness.start()
    expect(await until(() => engine.state.connects >= 1)).toBe(true)

    // 合并 list 任一通道失败 = 整体失败(#668 fail-closed);feed 每 1s 重试 ⇒ v2 计数增长。
    expect(await until(() => engine.state.lists.v2 >= 2, 3_000)).toBe(true)
    expect(probe.feed.state.ready).toBe(false)

    // 即便事件到达并被并入本地列表,not-ready 期零呈现语义仍然成立(requests 有、ready 无)。
    engine.state.streams.at(-1)!.push(askedEnvelope("per_arrival_3"))
    await until(() => probe.recorded.asked.length === 1)
    expect(probe.feed.state.ready).toBe(false)
  })
})
