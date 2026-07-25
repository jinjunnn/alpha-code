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

  const authedGet = async <T>(
    path: string,
    purpose: RoutePurpose,
    decode: (text: string) => T,
    retried = false,
    chainEpoch?: number,
  ): Promise<AccountResult<T>> => {
    // R1 Major1:锁必须绑定「这条读取链发起时」的身份代,并原样传给续期后的重试 ——
    // 读落地时的当前代会让账号 A 的迟到 401 把刚登录的账号 B 锁住,反向抵消
    // #601 的「auth 变化解锁」。
    const epoch = chainEpoch ?? deps.authIdentityEpoch()
    try {
      const token = deps.getAccessToken(purpose)
      if (!token) return { error: "not-authenticated" }
      const res = await deps.fetch(`${deps.accountBase()}${path}`, {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      })
      if (res.status === 401) {
        if (!retried && refreshLockedAtEpoch.get(purpose) !== epoch) {
          const renewal = await deps.refreshTokens()
          if (renewal.outcome === "refreshed") return authedGet(path, purpose, decode, true, epoch)
          // 续期本身「成功但结果不可用」(签发端给不出可用有效期)⇒ 再驱动只会重复白烧,
          // 且消费方的封顶退避会把它变成高频重刷。与「续期后仍 401」同等对待:锁住。
          if (renewal.outcome === "unusable-response") refreshLockedAtEpoch.set(purpose, epoch)
        }
        if (retried) refreshLockedAtEpoch.set(purpose, epoch)
        return { error: "unauthorized" }
      }
      if (!res.ok) return { error: `http-${res.status}` }
      // R1 Major2:「非 401 成功」必须包含 decode 成功 —— 否则 malformed 200 也解锁,
      // 服务在 malformed 200 与 401 之间抖动时仍能周期性驱动 refresh+换血。
      const decoded = decode(await res.text())
      refreshLockedAtEpoch.delete(purpose)
      return decoded
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
