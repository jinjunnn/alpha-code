// #594/#577 回归锁(独立进程运行:隔离仓内其他测试预先缓存的 Solid server 条件导出)。
// 锁三条「不依赖事件必达」的恢复语义:
//   1. 闩死点一:recovering 后 ready 永不到达(#577 producer 事故)且引擎实际可达
//      → 有界自探必须重建 client(旧实现唯一重建路径 = ready 事件,1s 兜底又被
//        preload 回放的 recovering 永久解除武装)。
//   2. failed 终态不得被当成 ready 盲连:执行面保持关闭,仅自探真实通过健康线后才重建
//      (live 事件与 preload 回放两条路同语义)。
//   3. 闩死点三:「立即重试」走 replayRuntimeRecoveryState 重读 generation 现值 ——
//      client 为 undefined 且现值为 ready 时必须重建出 client。
import { expect, mock, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { SidecarGenerationState } from "../src/preload/types"
import type { AlphaProjectsApi, ServerInfo } from "../src/renderer/sidebar/use-projects"

GlobalRegistrator.register()
const solid = await import("solid-js/dist/solid.js")
mock.module("solid-js", () => solid)
const solidStore = await import("solid-js/store/dist/store.js")
mock.module("solid-js/store", () => solidStore)
const { createRoot, createSignal } = solid

// —— preload 桥 stub:subscribe 捕获 runtime-recovery 的内部回调,getState 提供「现值」 ——
let bridgeCb: ((state: SidecarGenerationState) => void) | undefined
let currentState: SidecarGenerationState = { status: "recovering", generation: 0, reason: "boot" }
;(window as unknown as { api: unknown }).api = {
  sidecarGeneration: {
    getState: async () => currentState,
    subscribe: (cb: (state: SidecarGenerationState) => void) => {
      bridgeCb = cb
      return () => {}
    },
  },
}

// —— 引擎 stub:/global/health 按开关回答,其余(SDK project.list / global.event)悬挂 ——
let healthReachable = false
let healthProbes = 0
globalThis.fetch = ((input: unknown) => {
  const url = String(input instanceof URL ? input.href : ((input as { url?: string })?.url ?? input))
  if (url.includes("/global/health")) {
    healthProbes++
    return Promise.resolve(new Response("{}", { status: healthReachable ? 200 : 503 }))
  }
  return new Promise(() => {})
}) as typeof fetch

const { useAlphaProjects } = await import("../src/renderer/sidebar/use-projects")
const { replayRuntimeRecoveryState } = await import("../src/renderer/runtime-recovery")

const serverInfo: ServerInfo = { baseUrl: "http://127.0.0.1:19099", username: "u", password: "p" }
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(check: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (!check() && Date.now() < deadline) await tick(5)
}
function mount(probeDelayMs: number): { api: AlphaProjectsApi; dispose: () => void } {
  let api!: AlphaProjectsApi
  const dispose = createRoot((d: () => void) => {
    const [server] = createSignal<ServerInfo | undefined>(serverInfo)
    api = useAlphaProjects(server, { delayFor: () => probeDelayMs })
    return d
  })
  return { api, dispose }
}

test("#594 闩死点一:recovering 后 ready 永不到达、引擎实际可达 → 有界自探重建 client", async () => {
  healthReachable = true
  healthProbes = 0
  const { api, dispose } = mount(5)
  await tick()
  expect(api.sdk()).toBeUndefined()

  // 冷启动毒丸:recovering 到达(等价 preload 回放),ready 永不到达(#577)
  bridgeCb!({ status: "recovering", generation: 1, reason: "boot" })
  await waitFor(() => api.sdk() !== undefined, 2_000)

  expect(healthProbes).toBeGreaterThan(0)
  expect(api.sdk()).toBeDefined()
  dispose()
})

test("#594 回归保持:recovering → ready 正常路径重建 client,自探不抢跑", async () => {
  healthReachable = false
  healthProbes = 0
  const { api, dispose } = mount(60_000)
  await tick()

  bridgeCb!({ status: "recovering", generation: 2, reason: "token-only" })
  await tick()
  expect(api.sdk()).toBeUndefined()

  bridgeCb!({ status: "ready", generation: 2, reason: "token-only" })
  await tick()
  expect(api.sdk()).toBeDefined()
  expect(healthProbes).toBe(0)
  dispose()
})

test("#577 T-c(live):failed 终态不得当成 ready 盲连 —— 执行面关闭,自探真实通过后才重建", async () => {
  healthReachable = false
  healthProbes = 0
  const { api, dispose } = mount(5)
  await tick()

  bridgeCb!({ status: "recovering", generation: 3, reason: "boot" })
  // recovering → failed 必须穿过转换过滤器到达 consumer(shouldApplySidecarState 放行)
  bridgeCb!({ status: "failed", generation: 3, reason: "boot" })
  await tick(60)

  // 引擎不可达期间:不盲连(failed ≠ ready),但自探已武装
  expect(api.sdk()).toBeUndefined()
  expect(healthProbes).toBeGreaterThan(0)

  // 引擎迟到恢复 → 自探自证后重建
  healthReachable = true
  await waitFor(() => api.sdk() !== undefined, 2_000)
  expect(api.sdk()).toBeDefined()
  dispose()
})

test("#594 闩死点三:重试重读现值 —— failed 现值不盲连;ready 现值必须重建出 client", async () => {
  healthReachable = false
  healthProbes = 0
  const { api, dispose } = mount(60_000)
  await tick()

  bridgeCb!({ status: "recovering", generation: 4, reason: "boot" })
  await tick()
  expect(api.sdk()).toBeUndefined()

  // T-c(replay):现值为 failed → 「立即重试」不得据此重建
  currentState = { status: "failed", generation: 4, reason: "boot" }
  await replayRuntimeRecoveryState()
  await tick(20)
  expect(api.sdk()).toBeUndefined()

  // 现值为 ready → 「立即重试」(retryAll → replayRuntimeRecoveryState)必须重建出 client
  currentState = { status: "ready", generation: 4, reason: "boot" }
  await replayRuntimeRecoveryState()
  await tick(20)
  expect(api.sdk()).toBeDefined()
  dispose()
})
