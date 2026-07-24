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

describe("REQ-125 C5 Major-3:prepend 锚元素补偿", () => {
  test("复位量只由锚偏移导出:锚下方(底部流式)增高不进入计算", () => {
    // prepend 把锚从视口偏移 120 推到 860 → 复位 +740。
    expect(anchorDelta(120, 860)).toBe(740)
    // 锚偏移未变(例如只有底部流式在增高,scrollHeight 涨了多少都无关)→ 零复位。
    expect(anchorDelta(120, 120)).toBe(0)
    // 函数签名不接受任何 scrollHeight 输入 —— 底部增高在结构上无法进入补偿计算。
    expect(anchorDelta.length).toBe(2)
  })

  test("加载期间用户主动滚动 → 放弃补偿;未滚动 → 补偿", () => {
    const guard = createPrependCoordinator()
    guard.begin("e1")
    guard.noteScroll("e1")
    expect(guard.finish("e1", "e1")).toBe("skip")

    guard.begin("e1")
    expect(guard.finish("e1", "e1")).toBe("compensate")
  })

  test("noteScroll 只影响 in-flight 的 epoch;结束后的滚动(含补偿自身触发的)不计入", () => {
    const guard = createPrependCoordinator()
    guard.noteScroll("e1") // 未 begin:no-op
    guard.begin("e1")
    expect(guard.finish("e1", "e1")).toBe("compensate")
    guard.noteScroll("e1") // 已 finish:no-op
    guard.begin("e1")
    expect(guard.finish("e1", "e1")).toBe("compensate")
  })
})

describe("REQ-125 C5 minor(I8):olderInFlight 按 epoch 分片", () => {
  test("一个会话 in-flight 不阻塞另一个会话;滞后完成不补偿", () => {
    const guard = createPrependCoordinator()
    guard.begin("session-A")
    // 切到 B:A 的 in-flight 不阻塞 B 发起加载。
    expect(guard.busy("session-B")).toBe(false)
    guard.begin("session-B")
    expect(guard.busy("session-A")).toBe(true)
    expect(guard.busy("session-B")).toBe(true)
    expect(guard.idle()).toBe(false)

    // A 的滞后完成(当前已在 B)→ skip,不产生任何补偿。
    expect(guard.finish("session-A", "session-B")).toBe("skip")
    // B 正常完成 → compensate。
    expect(guard.finish("session-B", "session-B")).toBe("compensate")
    expect(guard.idle()).toBe(true)
  })

  test("同一 epoch 重复触发被 busy 挡住,finish 后可再次发起", () => {
    const guard = createPrependCoordinator()
    guard.begin("e1")
    expect(guard.busy("e1")).toBe(true)
    guard.finish("e1", "e1")
    expect(guard.busy("e1")).toBe(false)
  })
})
