import { describe, expect, test } from "bun:test"
import {
  anchorDelta,
  createPrependCoordinator,
  distanceFromBottom,
  FOLLOW_SLACK_PX,
  isAtBottom,
  LOAD_OLDER_THRESHOLD_PX,
  shouldLoadOlder,
} from "./timeline-scroll"

describe("REQ-125 C5 滚动锚定合同", () => {
  test("贴底判定:距底不超过 slack 才算贴底(决定是否跟随流式)", () => {
    expect(distanceFromBottom(952, 600, 1600)).toBe(48)
    expect(isAtBottom(1000, 600, 1600)).toBe(true)
    expect(isAtBottom(1600 - 600 - FOLLOW_SLACK_PX, 600, 1600)).toBe(true)
    expect(isAtBottom(1600 - 600 - FOLLOW_SLACK_PX - 1, 600, 1600)).toBe(false)
    // 内容不足一屏(scrollHeight <= clientHeight)恒为贴底。
    expect(isAtBottom(0, 600, 400)).toBe(true)
  })

  test("向上翻历史:接近顶部、有更早分页且不在加载中才触发", () => {
    expect(shouldLoadOlder({ scrollTop: LOAD_OLDER_THRESHOLD_PX, more: true, loading: false })).toBe(true)
    expect(shouldLoadOlder({ scrollTop: LOAD_OLDER_THRESHOLD_PX + 1, more: true, loading: false })).toBe(false)
    expect(shouldLoadOlder({ scrollTop: 0, more: false, loading: false })).toBe(false)
    expect(shouldLoadOlder({ scrollTop: 0, more: true, loading: true })).toBe(false)
    expect(shouldLoadOlder({ scrollTop: 500, more: true, loading: false, threshold: 500 })).toBe(true)
  })
})

describe("REQ-125 C5 Major-3:锚定复位量的纯合同", () => {
  test("复位量只由锚偏移导出:锚下方(底部流式)增高不进入计算", () => {
    // prepend 把锚从视口偏移 120 推到 860 → 复位 +740。
    expect(anchorDelta(120, 860)).toBe(740)
    // 锚偏移未变(例如只有底部流式在增高,scrollHeight 涨了多少都无关)→ 零复位。
    expect(anchorDelta(120, 120)).toBe(0)
    // 函数签名不接受任何 scrollHeight 输入 —— 底部增高在结构上无法进入补偿计算。
    expect(anchorDelta.length).toBe(2)
  })
})

describe("REQ-125 C5 minor(I8):olderInFlight 按 epoch 分片", () => {
  test("busy 只回答被问的 epoch:A in-flight 不使 B busy;finish 后可再次发起", () => {
    const guard = createPrependCoordinator()
    guard.begin("session-A")
    expect(guard.busy("session-A")).toBe(true)
    // 切到 B:A 的 in-flight 不阻塞 B(触发加载与贴底跟随都以 busy(currentEpoch) 判定)。
    expect(guard.busy("session-B")).toBe(false)
    guard.begin("session-B")
    expect(guard.busy("session-A")).toBe(true)
    expect(guard.busy("session-B")).toBe(true)

    guard.finish("session-A")
    expect(guard.busy("session-A")).toBe(false)
    expect(guard.busy("session-B")).toBe(true)
    guard.finish("session-B")
    expect(guard.busy("session-B")).toBe(false)
  })
})
