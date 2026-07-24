import { describe, expect, test } from "bun:test"
import {
  distanceFromBottom,
  FOLLOW_SLACK_PX,
  isAtBottom,
  LOAD_OLDER_THRESHOLD_PX,
  restoreAfterPrepend,
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

  test("prepend 补偿:视口位置 = 原位置 + 新增高度,高度未变时原样保持", () => {
    expect(restoreAfterPrepend(120, 2000, 3400)).toBe(1520)
    expect(restoreAfterPrepend(120, 2000, 2000)).toBe(120)
    // 高度异常收缩不产生负向跳动。
    expect(restoreAfterPrepend(120, 2000, 1500)).toBe(120)
  })
})
