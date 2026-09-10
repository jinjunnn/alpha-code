// REQ-159 (`#1322`) AC1 —— 「沙箱装上了没有」的投影规则:只认引擎在线的终态 + 引擎自报的 fence 字段。
// 缺席 / 不在线 / 字段不在 ⇒ false(没有围栏就不说有)。
import { describe, expect, test } from "bun:test"
import type { SidecarGenerationState } from "../../preload/types"
import { engineOnline, sandboxApplied, sandboxAppliedFrom, sandboxGeneration, setSandboxStateForTests } from "./sandbox-state"

const state = (partial: Partial<SidecarGenerationState>): SidecarGenerationState => ({ status: "ready", generation: 3, reason: "boot", ...partial })

describe("sandboxAppliedFrom", () => {
  test("ready + fence=applied ⇒ true;injection-failed(引擎在线但配置丢了)同样算围栏在", () => {
    expect(sandboxAppliedFrom(state({ fence: "applied" }))).toBe(true)
    expect(sandboxAppliedFrom(state({ status: "injection-failed", fence: "applied" }))).toBe(true)
  })

  test("没有 fence 字段(非 darwin / 旧 main)⇒ false —— 这就是「反向:出现条件恒 false」那一格的数据源", () => {
    expect(sandboxAppliedFrom(state({}))).toBe(false)
    expect(sandboxAppliedFrom(state({ fence: undefined }))).toBe(false)
  })

  test("引擎不在线(recovering / failed)⇒ 即便带着 fence 也 false;无状态 ⇒ false", () => {
    expect(sandboxAppliedFrom(state({ status: "recovering", fence: "applied" }))).toBe(false)
    expect(sandboxAppliedFrom(state({ status: "failed", fence: "applied" }))).toBe(false)
    expect(sandboxAppliedFrom(undefined)).toBe(false)
    expect(engineOnline(undefined)).toBe(false)
  })
})

describe("module accessors(经测试灌入,绕过 preload 桥)", () => {
  test("灌入 ready+applied 后 sandboxApplied()=true 且 generation 可读;灌入 failed 后两者都退回缺席", () => {
    setSandboxStateForTests(state({ generation: 7, fence: "applied" }))
    expect(sandboxApplied()).toBe(true)
    expect(sandboxGeneration()).toBe(7)
    setSandboxStateForTests(state({ status: "failed", generation: 8, fence: "applied" }))
    expect(sandboxApplied()).toBe(false)
    expect(sandboxGeneration()).toBeUndefined()
    setSandboxStateForTests(undefined)
    expect(sandboxApplied()).toBe(false)
  })
})
