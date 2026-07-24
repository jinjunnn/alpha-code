// B2:刷新时机决策单测(纯逻辑;网络/存储路径在真机批验证)。

import { describe, expect, test } from "bun:test"
import {
  isTokenExpired,
  refreshAheadMs,
  refreshDueAt,
  REFRESH_AHEAD_CAP_MS,
  shouldRefreshToken,
} from "./alpha-auth-clock"

const NOW = 1_800_000_000_000
const MIN = 60_000

describe("refreshAheadMs", () => {
  test("15min 生产 TTL → 提前 5min", () => {
    expect(refreshAheadMs(15 * MIN)).toBe(5 * MIN)
    expect(refreshAheadMs(15 * MIN)).toBe(REFRESH_AHEAD_CAP_MS)
  })
  test("短寿命(测试 TTL)→ 寿命的三分之一", () => {
    expect(refreshAheadMs(MIN)).toBe(20_000)
  })
  test("未知寿命(旧凭证)→ 5min 兜底", () => {
    expect(refreshAheadMs(undefined)).toBe(REFRESH_AHEAD_CAP_MS)
  })
})

describe("shouldRefreshToken", () => {
  test("15min token 刚签发 → 不刷", () => {
    expect(shouldRefreshToken(NOW + 15 * MIN, 15 * MIN, NOW)).toBe(false)
  })
  test("15min token 只剩 5min → 刷", () => {
    expect(shouldRefreshToken(NOW + 5 * MIN, 15 * MIN, NOW)).toBe(true)
  })
  test("短 TTL(60s)剩 30s → 不刷;剩 20s → 刷", () => {
    expect(shouldRefreshToken(NOW + 30_000, MIN, NOW)).toBe(false)
    expect(shouldRefreshToken(NOW + 20_000, MIN, NOW)).toBe(true)
  })
  test("无 expiresAt(旧凭证)→ 立刻刷一次补齐元数据", () => {
    expect(shouldRefreshToken(undefined, undefined, NOW)).toBe(true)
  })
})

describe("refreshDueAt", () => {
  test("15min TTL 从签发起 10min 到期续期", () => {
    expect(refreshDueAt(NOW + 15 * MIN, 15 * MIN, NOW)).toBe(NOW + 10 * MIN)
  })
  test("缺少 expiresAt 的旧凭证立即到期续期", () => {
    expect(refreshDueAt(undefined, undefined, NOW)).toBe(NOW)
  })
})

describe("isTokenExpired", () => {
  test("过期判定含边界(=expiresAt 即过期)", () => {
    expect(isTokenExpired(NOW, NOW)).toBe(true)
    expect(isTokenExpired(NOW + 1, NOW)).toBe(false)
    expect(isTokenExpired(undefined, NOW)).toBe(false)
  })
})
