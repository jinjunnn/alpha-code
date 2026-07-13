// alpha account reads (balance / membership / token usage) from the alpha-platform (B) in-region
// account-server, authed with the JWT alpha-web (C) issued. MAIN-ONLY: the renderer never sees the
// token, only the resolved summary over IPC (account-ipc.ts).
//
// Contract: alpha-platform docs/contracts/account-billing.md —
//   GET {ACCOUNT_BASE}/v1/account/summary   Authorization: Bearer <JWT>   → AccountSummary
//   GET {ACCOUNT_BASE}/v1/billing/transactions
//   401 = JWT 失效/缺失 → renderer should trigger re-login.
// Account reads hit the in-region account-server (PII/金融 must stay in-region), NOT the model
// gateway. Overridable via ALPHA_ACCOUNT_URL for dev/staging (consistent with ALPHA_WEB_URL /
// ALPHA_PLATFORM_URL; see shared/alpha-config.ts).

import { ALPHA_PATHS } from "../shared/alpha-config"
import { resolveEndpoints } from "./alpha-endpoints"
import { getAccessToken, refreshTokens } from "./alpha-auth"
import { getLogger } from "./logging"
import type { AccountResult, AccountSummary, AccountTransaction } from "../preload/types"

// Resolved by alpha-endpoints (env ALPHA_ACCOUNT_URL > userData pin > login discovery > default).
const accountBase = () => resolveEndpoints().account

// B2:401 拦截 —— access token 失效时先续期一次再重试(单飞在 refreshTokens 内);续期失败(会话
// revoked → 那边已降级登出)才把 unauthorized 交给 renderer 触发重新登录。
async function authedGet<T>(path: string, retried = false): Promise<AccountResult<T>> {
  const token = getAccessToken()
  if (!token) return { error: "not-authenticated" }
  try {
    const res = await fetch(`${accountBase()}${path}`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    })
    if (res.status === 401) {
      if (!retried && (await refreshTokens())) return authedGet<T>(path, true)
      return { error: "unauthorized" }
    }
    if (!res.ok) return { error: `http-${res.status}` }
    return (await res.json()) as T
  } catch (error) {
    getLogger().warn("alpha-account: fetch failed", error)
    return { error: "network" }
  }
}

export const fetchAccountSummary = (): Promise<AccountResult<AccountSummary>> =>
  authedGet<AccountSummary>(ALPHA_PATHS.accountSummary)

export const fetchTransactions = (limit?: number): Promise<AccountResult<{ transactions: AccountTransaction[] }>> =>
  authedGet<{ transactions: AccountTransaction[] }>(
    limit ? `${ALPHA_PATHS.transactions}?limit=${limit}` : ALPHA_PATHS.transactions,
  )
