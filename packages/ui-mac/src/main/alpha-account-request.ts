import type { RoutePurpose } from "@alpha-code/contracts-consumer"
import type { AccountResult } from "../preload/types"
import type { RenewalResult } from "./alpha-auth"

export function createAuthedGet(deps: {
  accountBase: () => string
  getAccessToken: (purpose: RoutePurpose) => string | undefined
  refreshTokens: () => Promise<RenewalResult>
  /** 登入/登出才推进的身份代(alpha-auth.getAuthIdentityEpoch)。锁按身份代作废。 */
  authIdentityEpoch: () => number
  fetch: typeof fetch
  warn: (message: string, error: unknown) => void
  isContractIncompatibleError: (error: unknown) => boolean
  reportContractFailure: (error: unknown) => void
}) {
  // #601:续期后仍 401 ⇒ 该 access token 确实被端点拒绝(不是过期),再续只会白烧往返 ——
  // 而每次续期成功都会驱动一次 token-only 换血。旧实现用 30s cooldown 当终局:窗口一过
  // 又允许 account 驱动刷新,于是「持续 401」自激成每 30 秒中断一次 sidecar/会话的循环
  // (基线 ③ 明令 transient 降级保持、禁循环 respawn)。改为锁住该 purpose 的账户驱动刷新,
  // 直到 ① 该端点出现非 401 成功,或 ② 外部 auth 身份变化(登入/登出)。有限 cooldown 不是终局。
  const refreshLockedAtEpoch = new Map<RoutePurpose, number>()
  const isRefreshLocked = (purpose: RoutePurpose) => refreshLockedAtEpoch.get(purpose) === deps.authIdentityEpoch()

  const authedGet = async <T>(
    path: string,
    purpose: RoutePurpose,
    decode: (text: string) => T,
    retried = false,
  ): Promise<AccountResult<T>> => {
    try {
      const token = deps.getAccessToken(purpose)
      if (!token) return { error: "not-authenticated" }
      const res = await deps.fetch(`${deps.accountBase()}${path}`, {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      })
      if (res.status === 401) {
        if (!retried && !isRefreshLocked(purpose)) {
          const renewal = await deps.refreshTokens()
          if (renewal.outcome === "refreshed") return authedGet(path, purpose, decode, true)
        }
        if (retried) refreshLockedAtEpoch.set(purpose, deps.authIdentityEpoch())
        return { error: "unauthorized" }
      }
      if (!res.ok) return { error: `http-${res.status}` }
      // 非 401 成功 = 该端点真的恢复了,解锁(HTTP 层的失败不算恢复,锁保持)。
      refreshLockedAtEpoch.delete(purpose)
      return decode(await res.text())
    } catch (error) {
      if (deps.isContractIncompatibleError(error)) {
        deps.reportContractFailure(error)
        return { error: "contract-incompatible" }
      }
      deps.warn("alpha-account: fetch failed", error)
      return { error: "network" }
    }
  }

  return authedGet
}
