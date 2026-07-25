// B2:刷新时机决策单测(纯逻辑;网络/存储路径在真机批验证)。

import { describe, expect, test } from "bun:test"
import {
  hasUsableLifetime,
  isTokenExpired,
  MIN_USABLE_TOKEN_LIFETIME_MS,
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
  })
  // #602 M2:本条原先断言「缺 expiresAt → 未过期」,把 fail-open 锁成了正确行为 ——
  // renderer 因此拿到 platformStatus:"ready",启动也不进 A′ 续期宽限,sidecar 先带一个
  // 未知(可能已过期)的 token 起来。基线 ③:不得为视觉目标把未验证的过期 token 标成可用。
  test("有效期未知或无效 → fail-closed 视为已过期", () => {
    expect(isTokenExpired(undefined, NOW)).toBe(true)
    expect(isTokenExpired(Number.NaN, NOW)).toBe(true)
    expect(isTokenExpired(Number.POSITIVE_INFINITY, NOW)).toBe(true)
  })
})

// #600 B3(rev2c ③″2-6):判据必须落在**换算出来的绝对期限**上。`expires_in` 是有限正数
// 不代表换算后还有余量 —— Number.MIN_VALUE 被浮点吸收后 expiresAt 就等于 now,
// 旧判据放它过关 ⇒ 提交、推进代际、换血,然后每 30 秒重来一次。
describe("hasUsableLifetime", () => {
  test("只有真的留出可用余量才算可用", () => {
    expect(hasUsableLifetime(NOW + MIN_USABLE_TOKEN_LIFETIME_MS, NOW)).toBe(true)
    expect(hasUsableLifetime(NOW + MIN_USABLE_TOKEN_LIFETIME_MS - 1, NOW)).toBe(false)
    expect(hasUsableLifetime(NOW, NOW)).toBe(false)
    expect(hasUsableLifetime(NOW - 1, NOW)).toBe(false)
    expect(hasUsableLifetime(undefined, NOW)).toBe(false)
    expect(hasUsableLifetime(Number.NaN, NOW)).toBe(false)
    expect(hasUsableLifetime(Number.POSITIVE_INFINITY, NOW)).toBe(false)
  })

  test("极小有限正数换算后没有余量 —— 按值挡不住,按换算结果才挡得住", () => {
    for (const expiresIn of [Number.MIN_VALUE, 1e-9, 0.001, 29.999]) {
      expect(hasUsableLifetime(NOW + expiresIn * 1000, NOW)).toBe(false)
    }
    expect(hasUsableLifetime(NOW + 30 * 1000, NOW)).toBe(true)
  })
})
