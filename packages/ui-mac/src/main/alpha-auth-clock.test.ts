// B2:刷新时机决策单测(纯逻辑;网络/存储路径在真机批验证)。

import { describe, expect, test } from "bun:test"
import { isTokenExpired, refreshAheadMs, REFRESH_AHEAD_CAP_MS, shouldRefreshToken } from "./alpha-auth-clock"

const H = 60 * 60 * 1000
const NOW = 1_800_000_000_000

describe("refreshAheadMs", () => {
  test("7d 寿命 → 提前量封顶 24h", () => {
    expect(refreshAheadMs(7 * 24 * H)).toBe(REFRESH_AHEAD_CAP_MS)
  })
  test("短寿命(测试 TTL)→ 寿命的一半", () => {
    expect(refreshAheadMs(60_000)).toBe(30_000)
  })
  test("未知寿命(旧凭证)→ 24h 兜底", () => {
    expect(refreshAheadMs(undefined)).toBe(REFRESH_AHEAD_CAP_MS)
  })
})

describe("shouldRefreshToken", () => {
  test("7d token 刚签发 → 不刷", () => {
    expect(shouldRefreshToken(NOW + 7 * 24 * H, 7 * 24 * H, NOW)).toBe(false)
  })
  test("7d token 只剩 23h → 刷", () => {
    expect(shouldRefreshToken(NOW + 23 * H, 7 * 24 * H, NOW)).toBe(true)
  })
  test("短 TTL(60s)剩 45s → 不刷;剩 20s → 刷", () => {
    expect(shouldRefreshToken(NOW + 45_000, 60_000, NOW)).toBe(false)
    expect(shouldRefreshToken(NOW + 20_000, 60_000, NOW)).toBe(true)
  })
  test("无 expiresAt(旧凭证)→ 立刻刷一次补齐元数据", () => {
    expect(shouldRefreshToken(undefined, undefined, NOW)).toBe(true)
  })
})

describe("isTokenExpired", () => {
  test("过期判定含边界(=expiresAt 即过期)", () => {
    expect(isTokenExpired(NOW, NOW)).toBe(true)
    expect(isTokenExpired(NOW + 1, NOW)).toBe(false)
    expect(isTokenExpired(undefined, NOW)).toBe(false)
  })
})
