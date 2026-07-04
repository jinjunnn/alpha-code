// B3 cloud-run watcher 纯解析核 —— 命中/忽略矩阵与 output 容错。

import { describe, expect, test } from "bun:test"
import { extractCloudRunHit, parseRunFromOutput } from "./cloud-run-core"

const partEvent = (over: Record<string, unknown> = {}, envelope: Record<string, unknown> = {}) => ({
  directory: "/Users/me/proj",
  payload: {
    type: "message.part.updated",
    properties: {
      part: {
        type: "tool",
        tool: "cloud_await",
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
    expect(extractCloudRunHit(partEvent({ tool: "bash" }))).toBeNull()
    expect(extractCloudRunHit(partEvent({ type: "text" }))).toBeNull()
    expect(extractCloudRunHit(partEvent({ state: { status: "running" } }))).toBeNull()
    expect(extractCloudRunHit(partEvent({ state: { status: "error", error: "x" } }))).toBeNull()
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
