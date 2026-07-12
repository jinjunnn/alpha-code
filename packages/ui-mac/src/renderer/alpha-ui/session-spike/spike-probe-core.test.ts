import { describe, expect, test } from "bun:test"
import {
  countSessionScopedCommands,
  detectMonotonicGrowth,
  formatSample,
  isSingleMount,
  summarizeSamples,
  type SpikeSample,
} from "./spike-probe-core"

const sample = (over: Partial<SpikeSample>): SpikeSample => ({
  at: 0,
  pathname: "/dir/session/abc",
  sessionID: "ses_abc",
  composersTotal: 1,
  composersVisible: 1,
  terminalPanels: 1,
  promptDocks: 1,
  commandOptions: 40,
  sessionScopedCommands: 20,
  ...over,
})

describe("REQ-087 探针口径", () => {
  test("session 作用域命令前缀计数(use-session-commands 注册面)", () => {
    expect(
      countSessionScopedCommands(["session.new", "terminal.toggle", "message.next", "sidebar.toggle", "project.open"]),
    ).toBe(3)
  })

  test("AC3 单挂载:可见 composer ≤1 且 terminal panel ===1", () => {
    expect(isSingleMount(sample({}))).toBe(true)
    // keep-alive 隐藏 timeline 允许 total >1(composer-takeover 实证),不算违规
    expect(isSingleMount(sample({ composersTotal: 3, composersVisible: 1 }))).toBe(true)
    expect(isSingleMount(sample({ composersVisible: 2 }))).toBe(false)
    expect(isSingleMount(sample({ terminalPanels: 2 }))).toBe(false)
    expect(isSingleMount(sample({ terminalPanels: 0 }))).toBe(false)
  })

  test("AC4 累积判定:单调不减且净增长超 jitter 才算累积", () => {
    expect(detectMonotonicGrowth([40, 42, 44, 46], { minSamples: 3, jitter: 2 })).toBe(true)
    expect(detectMonotonicGrowth([40, 41, 42], { minSamples: 3, jitter: 2 })).toBe(false) // 在 jitter 内
    expect(detectMonotonicGrowth([40, 44, 41], { minSamples: 3, jitter: 2 })).toBe(false) // 非单调 = 波动
    expect(detectMonotonicGrowth([40, 50], { minSamples: 3 })).toBe(false) // 样本不足不下结论
  })

  test("summary:违规样本计数 + 累积序列判定(只看 session 路由采样)", () => {
    const ok = summarizeSamples([
      sample({ commandOptions: 40 }),
      sample({ commandOptions: 41, sessionID: "ses_b" }),
      sample({ commandOptions: 40, sessionID: "ses_c" }),
      sample({ sessionID: undefined, terminalPanels: 0 }), // 非 session 路由,不参与判定
    ])
    expect(ok.sessionRouteSamples).toBe(3)
    expect(ok.singleMountViolations).toBe(0)
    expect(ok.commandAccumulation).toBe(false)
    expect(ok.terminalPanelAccumulation).toBe(false)

    const bad = summarizeSamples([
      sample({ terminalPanels: 1 }),
      sample({ terminalPanels: 2, sessionID: "ses_b" }),
      sample({ terminalPanels: 3, sessionID: "ses_c" }),
    ])
    expect(bad.singleMountViolations).toBe(2)
    expect(bad.terminalPanelAccumulation).toBe(true)
  })

  test("日志行含全部计数(取证格式稳定)", () => {
    const line = formatSample(sample({}))
    expect(line).toContain("[req087-spike]")
    expect(line).toContain("composer=1/1")
    expect(line).toContain("terminal=1")
    expect(line).toContain("cmd=40 sessionCmd=20")
  })
})
