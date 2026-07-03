// B2:token 刷新时机的纯决策逻辑(electron-free,单测覆盖;消费方 alpha-auth.ts)。
//
// 桌面 access token 寿命 = alpha-web DESKTOP_ACCESS_TTL_SECONDS(默认 7*24h,env 可调短供测试)。
// 刷新提前量 = min(24h, 寿命/2):7d token 提前 24h 续(每日启动/整点 tick 自然命中,轮换链保活);
// 测试用短 TTL(如 60s)时提前量收缩到 30s,真实走到刷新/过期路径。

export const REFRESH_AHEAD_CAP_MS = 24 * 60 * 60 * 1000

export function refreshAheadMs(lifetimeMs?: number): number {
  if (!lifetimeMs || lifetimeMs <= 0) return REFRESH_AHEAD_CAP_MS
  return Math.min(REFRESH_AHEAD_CAP_MS, Math.floor(lifetimeMs / 2))
}

/** 该刷新了吗(还有 refresh 手段时)。expiresAt 缺失视为「立刻刷」——旧凭证无过期信息,宁可续一次。 */
export function shouldRefreshToken(expiresAt: number | undefined, lifetimeMs: number | undefined, now: number): boolean {
  if (!expiresAt) return true
  return expiresAt - now <= refreshAheadMs(lifetimeMs)
}

/** access token 已过期(fork 前必须先续,否则 fork 出来的 sidecar 带死 token)。 */
export function isTokenExpired(expiresAt: number | undefined, now: number): boolean {
  return typeof expiresAt === "number" && now >= expiresAt
}
