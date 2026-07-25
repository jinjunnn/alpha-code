// Token 刷新时机的纯决策逻辑(electron-free,单测覆盖;消费方 alpha-auth.ts / auth-renewal.ts)。
//
// 平台 access token 的生产 TTL 是 15 分钟。刷新提前量取签发寿命的 1/3，并封顶 5 分钟：
// 15min token 在签发后约 10min 进入续期窗口，给代理抖动、系统唤醒和一次瞬态重试留出余量；
// 测试短 TTL 仍按同一比例缩放，不再携带历史 7 天 token 的调度假设。

export const REFRESH_AHEAD_CAP_MS = 5 * 60 * 1000
export const REFRESH_AHEAD_DIVISOR = 3

// #600 B3(rev2c ③″2-6「成功必须等于结果可用」):可用寿命的下界。**唯一**能让平台 token
// 保鲜的机制是续期调度器,而它的唤醒地板就是这个值(auth-renewal 的 AUTH_RENEWAL_MIN_INTERVAL_MS
// 由本常量派生,两者不可能漂移)。整段寿命短于这个地板的凭证,调度器根本来不及醒一次 ——
// 它在定义上就不可用,不是「短但能用」。阈值依据就是这条,不是拍脑袋的数。
export const MIN_USABLE_TOKEN_LIFETIME_MS = 30_000

/** 换算出来的**绝对期限**相对 now 是否真的还有可用余量。
 *  判据落在换算结果上而不是响应字段上:`expires_in` 是有限正数(例如 Number.MIN_VALUE)
 *  并不代表 `now + expires_in*1000` 之后还有余量 —— 浮点吸收后它可能就等于 now。 */
export function hasUsableLifetime(expiresAt: number | undefined, now: number): boolean {
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return false
  return expiresAt - now >= MIN_USABLE_TOKEN_LIFETIME_MS
}

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

/** access token 已过期,或有效期未知/无效(启动宽限与 renderer 平台可用性据此 fail closed)。
 *  #602 M2:未知有效期曾判「未过期」—— renderer 拿到 platformStatus:"ready",启动也不进 A′
 *  续期宽限,sidecar 先带一个可能已过期的 token 起来。基线 ③ 明令不得为视觉目标把未验证的
 *  过期平台 token 标成可用,故这里 fail-closed:有限正数之外一律视为已过期。 */
export function isTokenExpired(expiresAt: number | undefined, now: number): boolean {
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return true
  return now >= expiresAt
}
