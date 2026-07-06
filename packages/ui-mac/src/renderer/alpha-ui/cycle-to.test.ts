import { describe, expect, test } from "bun:test"
import { cycleTo } from "./cycle-to"

// REQ-043:cycle 判停等待原语 —— 核心回归 = DOM observer 滞后超过原固定 90ms 时不再假报「切换失败」。
// 测试用注入的 read/step 模拟上游触发器文本;pollMs 调小使用真实定时器也毫秒级完成。

/** 模拟上游触发器:step 后经 applyDelayMs 才把新文本落到 DOM(= MutationObserver 滞后)。 */
function fakeTrigger(labels: string[], applyDelayMs: number) {
  let index = 0
  let dom: string | undefined = labels[0]
  return {
    read: () => dom,
    step: () => {
      index = (index + 1) % labels.length
      const next = labels[index]
      if (applyDelayMs === 0) dom = next
      else setTimeout(() => (dom = next), applyDelayMs)
    },
  }
}

describe("cycleTo", () => {
  test("起点已命中 → true,零步", async () => {
    const t = fakeTrigger(["低", "中", "高"], 0)
    let steps = 0
    const ok = await cycleTo({
      read: t.read,
      step: () => {
        steps++
        t.step()
      },
      match: (l) => l === "低",
      maxSteps: 12,
      pollMs: 1,
    })
    expect(ok).toBe(true)
    expect(steps).toBe(0)
  })

  test("控件未渲染 → false", async () => {
    const ok = await cycleTo({
      read: () => undefined,
      step: () => {},
      match: () => true,
      maxSteps: 12,
      pollMs: 1,
    })
    expect(ok).toBe(false)
  })

  test("N 步后命中(DOM 即时更新)→ true", async () => {
    const t = fakeTrigger(["low", "medium", "high"], 0)
    const ok = await cycleTo({
      read: t.read,
      step: t.step,
      match: (l) => l === "high",
      maxSteps: 12,
      pollMs: 1,
    })
    expect(ok).toBe(true)
  })

  test("REQ-043 核心:DOM 更新滞后(> 原固定 90ms 语义)仍命中,不假报失败", async () => {
    // 每步文本 60ms 后才落 DOM;pollMs=10 → 原「固定单次读」语义会读到旧值误判,现等到变化为止。
    const t = fakeTrigger(["低", "中", "高"], 60)
    const ok = await cycleTo({
      read: t.read,
      step: t.step,
      match: (l) => l === "高",
      maxSteps: 12,
      stepTimeoutMs: 500,
      pollMs: 10,
    })
    expect(ok).toBe(true)
  })

  test("转满一圈未命中 → false(目标档不存在)", async () => {
    const t = fakeTrigger(["low", "high"], 0)
    const ok = await cycleTo({
      read: t.read,
      step: t.step,
      match: (l) => l === "medium",
      maxSteps: 12,
      pollMs: 1,
    })
    expect(ok).toBe(false)
  })

  test("step 抛错 → false", async () => {
    const t = fakeTrigger(["低", "中"], 0)
    const ok = await cycleTo({
      read: t.read,
      step: () => {
        throw new Error("command unavailable")
      },
      match: (l) => l === "中",
      maxSteps: 12,
      pollMs: 1,
    })
    expect(ok).toBe(false)
  })

  test("DOM 恒不变(单档模型/控件无响应)→ 单步超时 false,不无限等", async () => {
    let dom = "只有这档"
    const ok = await cycleTo({
      read: () => dom,
      step: () => {}, // cycle 不改文本
      match: (l) => l === "别的档",
      maxSteps: 12,
      stepTimeoutMs: 50,
      pollMs: 5,
    })
    expect(ok).toBe(false)
  })
})
