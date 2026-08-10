import { describe, expect, test } from "bun:test"
import { ENGINE_FETCH_TIMEOUT_MS, nextEngineRetryDelay } from "./model-picker-logic"

describe("nextEngineRetryDelay", () => {
  test("退避节奏 1s/2s/4s/8s 封顶", () => {
    expect(nextEngineRetryDelay(0)).toBe(1000)
    expect(nextEngineRetryDelay(1)).toBe(2000)
    expect(nextEngineRetryDelay(2)).toBe(4000)
    expect(nextEngineRetryDelay(3)).toBe(8000)
    expect(nextEngineRetryDelay(10)).toBe(8000)
  })
})

describe("ENGINE_FETCH_TIMEOUT_MS(2026-07-12 复验盲区:悬挂必须转成可重试失败)", () => {
  // #882 起适用面收窄:这条不变式管的是**真失败**的重试链(引擎挂了/5xx/悬挂)。首屏的目录
  // 就绪等待已经不走退避 —— 它由 catalog.updated 唤醒,屏障自己不再制造失败。所以本条对
  // 「首屏第一次读到目录要多久」不再有任何断言力,别把它当成那件事已被覆盖。
  test("超时必须严格大于任何退避间隔 —— 保证「悬挂 → 超时 → 退避 → 重试」链不重叠不空转", () => {
    for (const attempt of [0, 1, 2, 3, 10]) {
      expect(ENGINE_FETCH_TIMEOUT_MS).toBeGreaterThan(nextEngineRetryDelay(attempt))
    }
  })

  test("取值在诚实窗口内:远大于健康路径首拉(ms 级),不超过用户可忍受的提示延迟上限", () => {
    expect(ENGINE_FETCH_TIMEOUT_MS).toBeGreaterThanOrEqual(3_000)
    expect(ENGINE_FETCH_TIMEOUT_MS).toBeLessThanOrEqual(30_000)
  })
})
