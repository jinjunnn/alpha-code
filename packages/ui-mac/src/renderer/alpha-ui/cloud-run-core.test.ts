// B3 cloud-run watcher 纯解析核 —— 命中/忽略矩阵与 output 容错。
// #934:命中准入 = 持久化 identity (mcp, "cloud")(与时间线产物行同一枚铸币),
// `cloud_` 别名前缀不再参与;夹具默认带第一方 facade 快照(与真实事件同形状)。

import { describe, expect, test } from "bun:test"
import { extractCloudRunHit, parseRunFromOutput } from "./cloud-run-core"

/** 第一方 cloud facade 的持久化快照(引擎 mcp/index.ts 以 clientName="cloud" 为 origin)。 */
const facadeDisplay = (name = "cloud_await") => ({
  identity: { source: "mcp", origin: "cloud", name },
  technicalId: `cloud_${name}`,
  authority: { kind: "not-asserted" },
})

const partEvent = (over: Record<string, unknown> = {}, envelope: Record<string, unknown> = {}) => ({
  directory: "/Users/me/proj",
  payload: {
    type: "message.part.updated",
    properties: {
      part: {
        type: "tool",
        tool: "cloud_await",
        display: facadeDisplay(),
        state: { status: "completed", output: JSON.stringify({ job_id: "job-9", status: "completed" }) },
        ...over,
      },
    },
  },
  ...envelope,
})

describe("extractCloudRunHit", () => {
  test("终态 cloud tool part → 命中", () => {
    expect(extractCloudRunHit(partEvent())).toEqual({ directory: "/Users/me/proj", runId: "job-9", terminal: "completed" })
  })

  test("failed/cancelled 也是终态", () => {
    for (const s of ["failed", "cancelled"] as const) {
      const e = partEvent({ state: { status: "completed", output: JSON.stringify({ job_id: "j", status: s }) } })
      expect(extractCloudRunHit(e)?.terminal).toBe(s)
    }
  })

  test("dispatch 帧(queued/running)不命中", () => {
    const e = partEvent({ state: { status: "completed", output: JSON.stringify({ job_id: "j", status: "running" }) } })
    expect(extractCloudRunHit(e)).toBeNull()
  })

  test("非 cloud 工具 / 非 tool part / 流式未完成帧 / 错误帧 均不命中", () => {
    expect(extractCloudRunHit(partEvent({ tool: "bash", display: undefined }))).toBeNull()
    expect(extractCloudRunHit(partEvent({ type: "text" }))).toBeNull()
    expect(extractCloudRunHit(partEvent({ state: { status: "running" } }))).toBeNull()
    expect(extractCloudRunHit(partEvent({ state: { status: "error", error: "x" } }))).toBeNull()
  })

  test("#934 冒名 cloud_* 不命中:准入是 identity,不是别名前缀(负向夹具与真实终态帧同形)", () => {
    const spoofOutput = JSON.stringify({ job_id: "run_spoof_41", status: "completed" })
    // plugin 命名空间 `cloud`(工具 id cloud_x → 别名恰为 cloud_x)。
    const pluginSpoof = partEvent({
      tool: "cloud_x",
      display: { identity: { source: "plugin", origin: "cloud", name: "x" }, technicalId: "cloud_x", authority: { kind: "not-asserted" } },
      state: { status: "completed", output: spoofOutput },
    })
    expect(extractCloudRunHit(pluginSpoof)).toBeNull()
    // MCP 配置键 `cloud.x` sanitize 撞前缀(别名 cloud_x_await)。
    const mcpSpoof = partEvent({
      tool: "cloud_x_await",
      display: { identity: { source: "mcp", origin: "cloud.x", name: "await" }, technicalId: "cloud_x_await", authority: { kind: "not-asserted" } },
      state: { status: "completed", output: JSON.stringify({ job_id: "run_spoof_52", status: "failed" }) },
    })
    expect(extractCloudRunHit(mcpSpoof)).toBeNull()
    // 快照缺失(fail-closed):裸别名 cloud_await 不再是准入。
    expect(extractCloudRunHit(partEvent({ display: undefined }))).toBeNull()
    // 快照形状非法(identity 不是对象):同样不命中。
    expect(extractCloudRunHit(partEvent({ display: { identity: "mcp:cloud:await" } }))).toBeNull()
  })

  test("#934 对照(杀「一律不命中」的错误实现):facade identity 下别名叫什么都命中", () => {
    const hit = extractCloudRunHit(
      partEvent({
        tool: "cloud_cloud_status",
        display: facadeDisplay("cloud_status"),
        state: { status: "completed", output: JSON.stringify({ job_id: "run_real_87", status: "cancelled" }) },
      }),
    )
    expect(hit).toEqual({ directory: "/Users/me/proj", runId: "run_real_87", terminal: "cancelled" })
  })

  test("其它事件类型 / 缺 directory 不命中", () => {
    expect(extractCloudRunHit({ directory: "/p", payload: { type: "session.idle", properties: {} } })).toBeNull()
    expect(extractCloudRunHit(partEvent({}, { directory: "" }))).toBeNull()
    expect(extractCloudRunHit(null)).toBeNull()
  })
})

describe("parseRunFromOutput", () => {
  test("纯 JSON", () => {
    expect(parseRunFromOutput('{"job_id":"a","status":"completed"}')).toEqual({ runId: "a", terminal: "completed" })
  })
  test("包裹文本回退正则", () => {
    const wrapped = 'Job finished.\n```json\n{"job_id": "b-2", "status": "failed", "error": "boom"}\n```'
    expect(parseRunFromOutput(wrapped)).toEqual({ runId: "b-2", terminal: "failed" })
  })
  test("非终态/缺 job_id → null", () => {
    expect(parseRunFromOutput('{"job_id":"c","status":"running"}')).toBeNull()
    expect(parseRunFromOutput('{"status":"completed"}')).toBeNull()
    expect(parseRunFromOutput("plain text")).toBeNull()
  })
})
