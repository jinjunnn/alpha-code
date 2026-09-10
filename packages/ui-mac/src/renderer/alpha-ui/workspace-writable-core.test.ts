// REQ-159 (`#1322`) AC2 —— 「当前工作区写得进去吗」的四态状态机:探针未答 / 可写 / 未知 ⇒ 无标记;
// 只有引擎明确回报 denied ⇒ 标记。还有三条纪律:沙箱没装不探、按引擎代分开缓存、同代同目录只探一次。
import { describe, expect, test } from "bun:test"
import type { WorkspaceWriteProbeResult } from "../../preload/types"
import { createWorkspaceWritableTracker } from "./workspace-writable-core"

const deferredProbe = () => {
  const calls: string[] = []
  const pending = new Map<string, (result: WorkspaceWriteProbeResult) => void>()
  const rejecters = new Map<string, (error: unknown) => void>()
  const probe = (directory: string) => {
    calls.push(directory)
    return new Promise<WorkspaceWriteProbeResult>((resolve, reject) => {
      pending.set(directory, resolve)
      rejecters.set(directory, reject)
    })
  }
  const answer = async (directory: string, outcome: WorkspaceWriteProbeResult["outcome"]) => {
    pending.get(directory)!({ outcome })
    await Promise.resolve()
    await Promise.resolve()
  }
  const fail = async (directory: string) => {
    rejecters.get(directory)!(new Error("bridge down"))
    await Promise.resolve()
    await Promise.resolve()
  }
  return { probe, calls, answer, fail }
}

const on = (directory: string | undefined, generation: number | undefined = 1, sandbox = true) => ({ generation, directory, sandbox })

describe("workspace writable tracker —— 四态与标记", () => {
  test("集合外工作区:探针答 denied ⇒ 只读;答之前是 pending(无标记)", async () => {
    const fake = deferredProbe()
    const tracker = createWorkspaceWritableTracker(fake.probe)
    tracker.observe(on("/ws/outside"))
    expect(tracker.answer(on("/ws/outside"))).toBe("pending")
    expect(tracker.readonly(on("/ws/outside"))).toBe(false)
    await fake.answer("/ws/outside", "denied")
    expect(tracker.answer(on("/ws/outside"))).toBe("denied")
    expect(tracker.readonly(on("/ws/outside"))).toBe(true)
  })

  test("集合内工作区:探针答 writable ⇒ 无标记;答 unknown / 探针出错 ⇒ 同样无标记(未知 ≠ 只读)", async () => {
    const fake = deferredProbe()
    const tracker = createWorkspaceWritableTracker(fake.probe)
    tracker.observe(on("/ws/inside"))
    tracker.observe(on("/ws/odd"))
    tracker.observe(on("/ws/broken"))
    await fake.answer("/ws/inside", "writable")
    await fake.answer("/ws/odd", "unknown")
    await fake.fail("/ws/broken")
    expect(tracker.answer(on("/ws/inside"))).toBe("writable")
    expect(tracker.answer(on("/ws/odd"))).toBe("unknown")
    expect(tracker.answer(on("/ws/broken"))).toBe("unknown")
    for (const dir of ["/ws/inside", "/ws/odd", "/ws/broken"]) expect(tracker.readonly(on(dir)), dir).toBe(false)
  })

  test("形状不对的应答(outcome 不是三种之一)按 unknown 收,不抛、不标", async () => {
    const tracker = createWorkspaceWritableTracker(() => Promise.resolve({ outcome: "yes" } as unknown as WorkspaceWriteProbeResult))
    tracker.observe(on("/ws/a"))
    await Promise.resolve()
    await Promise.resolve()
    expect(tracker.answer(on("/ws/a"))).toBe("unknown")
  })

  test("沙箱没装 / 引擎不在 / 没有目录 ⇒ 不探(探针一次都不调),答 unknown", () => {
    const fake = deferredProbe()
    const tracker = createWorkspaceWritableTracker(fake.probe)
    tracker.observe(on("/ws/a", 1, false))
    // 显式写对象:`on()` 的默认参数会把显式 undefined 换成 1(JS 默认参语义),那不是这一格要测的形状
    tracker.observe({ generation: undefined, directory: "/ws/a", sandbox: true })
    tracker.observe(on(undefined, 1, true))
    tracker.observe(on("", 1, true))
    expect(fake.calls).toEqual([])
    expect(tracker.answer(on("/ws/a", 1, false))).toBe("unknown")
    expect(tracker.readonly(on("/ws/a", 1, false))).toBe(false)
  })

  test("同代同目录只探一次;换代之后同一目录重新探,旧代的 denied 不带到新代", async () => {
    const fake = deferredProbe()
    const tracker = createWorkspaceWritableTracker(fake.probe)
    tracker.observe(on("/ws/a", 1))
    tracker.observe(on("/ws/a", 1))
    tracker.observe(on("/ws/a", 1))
    expect(fake.calls).toEqual(["/ws/a"])
    await fake.answer("/ws/a", "denied")
    expect(tracker.readonly(on("/ws/a", 1))).toBe(true)
    // respawn ⇒ 新代:可写集重新取并集,答案必须重问
    expect(tracker.readonly(on("/ws/a", 2))).toBe(false)
    expect(tracker.answer(on("/ws/a", 2))).toBe("unknown")
    tracker.observe(on("/ws/a", 2))
    expect(fake.calls).toEqual(["/ws/a", "/ws/a"])
    await fake.answer("/ws/a", "writable")
    expect(tracker.readonly(on("/ws/a", 2))).toBe(false)
    expect(tracker.readonly(on("/ws/a", 1))).toBe(true)
  })

  test("onChange 在 pending 与落定时各响一次;reset 之后迟到的应答不得复活旧格", async () => {
    const fake = deferredProbe()
    let changes = 0
    const tracker = createWorkspaceWritableTracker(fake.probe, () => changes++)
    tracker.observe(on("/ws/a"))
    expect(changes).toBe(1)
    tracker.reset()
    expect(changes).toBe(2)
    await fake.answer("/ws/a", "denied")
    expect(changes).toBe(2)
    expect(tracker.answer(on("/ws/a"))).toBe("unknown")
    expect(tracker.readonly(on("/ws/a"))).toBe(false)
  })

  test("探针同步抛出(桥坏了)⇒ 该格 unknown,不炸调用方", () => {
    const tracker = createWorkspaceWritableTracker(() => {
      throw new Error("no bridge")
    })
    expect(() => tracker.observe(on("/ws/a"))).not.toThrow()
    expect(tracker.answer(on("/ws/a"))).toBe("unknown")
  })
})
