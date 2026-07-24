// Token 刷新时机的纯决策逻辑(electron-free,单测覆盖;消费方 alpha-auth.ts / auth-renewal.ts)。
//
// 平台 access token 的生产 TTL 是 15 分钟。刷新提前量取签发寿命的 1/3，并封顶 5 分钟：
// 15min token 在签发后约 10min 进入续期窗口，给代理抖动、系统唤醒和一次瞬态重试留出余量；
// 测试短 TTL 仍按同一比例缩放，不再携带历史 7 天 token 的调度假设。

export const REFRESH_AHEAD_CAP_MS = 5 * 60 * 1000
export const REFRESH_AHEAD_DIVISOR = 3

export function refreshAheadMs(lifetimeMs?: number): number {
  if (!lifetimeMs || lifetimeMs <= 0) return REFRESH_AHEAD_CAP_MS
  return Math.min(REFRESH_AHEAD_CAP_MS, Math.floor(lifetimeMs / REFRESH_AHEAD_DIVISOR))
}

/** 该刷新了吗(还有 refresh 手段时)。expiresAt 缺失视为「立刻刷」——旧凭证无过期信息,宁可续一次。 */
export function shouldRefreshToken(expiresAt: number | undefined, lifetimeMs: number | undefined, now: number): boolean {
  if (!expiresAt) return true
  return expiresAt - now <= refreshAheadMs(lifetimeMs)
}

/** 下一次续期的绝对时刻；旧凭证缺 expiresAt 时立即到期。 */
export function refreshDueAt(expiresAt: number | undefined, lifetimeMs: number | undefined, now: number): number {
  if (!expiresAt) return now
  return expiresAt - refreshAheadMs(lifetimeMs)
}

/** access token 已过期(启动宽限与 renderer 平台可用性据此 fail closed)。 */
export function isTokenExpired(expiresAt: number | undefined, now: number): boolean {
  return typeof expiresAt === "number" && now >= expiresAt
}
