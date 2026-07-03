// REQ-003(C23):cloud SSE 消费端加固的纯逻辑单测——帧解析、终态兜底判定、退避曲线。
// 流级行为(有界重连/空转退避/90s 悬挂回收)在真机批以断网/掐半流观察。

import { describe, expect, test } from "bun:test"
import { backoffMs, isTerminalCloudEvent, parseFrame, terminalEventName } from "./alpha-cloud-events-core"

describe("parseFrame", () => {
  test("完整帧:id/event/data", () => {
    const ev = parseFrame("id:7\nevent:job.running\ndata:{\"phase\":\"exec\"}")!
    expect(ev).toEqual({ id: "7", event: "job.running", data: { phase: "exec" } })
  })
  test("非数字 id 原样保留(C23 修:旧实现 Number() 丢失)", () => {
    const ev = parseFrame("id:evt_abc\ndata:{}")!
    expect(ev.id).toBe("evt_abc")
  })
  test("无 data 行 → null;非 JSON data 保底为字符串", () => {
    expect(parseFrame("event:ping")).toBeNull()
    expect(parseFrame("data:hello")!.data).toBe("hello")
  })
})

describe("terminalEventName — 终态兜底判定(C23 修)", () => {
  test("event: 名直判", () => {
    expect(terminalEventName({ event: "job.completed", data: {} })).toBe("job.completed")
    expect(terminalEventName({ event: "job.running", data: {} })).toBeNull()
  })
  test("event: 缺失(默认 message)时从 data.type 兜底", () => {
    expect(terminalEventName({ event: "message", data: { type: "job.failed" } })).toBe("job.failed")
    expect(isTerminalCloudEvent({ event: "message", data: { type: "job.cancelled" } })).toBe(true)
    expect(terminalEventName({ event: "message", data: { type: "job.running" } })).toBeNull()
  })
})

describe("backoffMs — 指数 + 抖动(C23 修:空转关闭不再零间隔风暴)", () => {
  test("单调放大且 30s 封顶(取抖动上界 rand=1)", () => {
    expect(backoffMs(1, 1)).toBe(1000)
    expect(backoffMs(2, 1)).toBe(2000)
    expect(backoffMs(5, 1)).toBe(16000)
    expect(backoffMs(6, 1)).toBe(30000)
    expect(backoffMs(99, 1)).toBe(30000)
  })
  test("抖动范围 = [base/2, base](防齐步重连)", () => {
    expect(backoffMs(3, 0)).toBe(2000) // base 4000 → 下界 base/2
    expect(backoffMs(3, 1)).toBe(4000)
  })
})
