// alpha account reads (balance / membership / token usage) from the alpha-platform (B) in-region
// account-server, authed with the JWT alpha-web (C) issued. MAIN-ONLY: the renderer never sees the
// token, only the resolved summary over IPC (account-ipc.ts).
//
// Contract: alpha-platform docs/contracts/account-billing.md —
//   GET {ACCOUNT_BASE}/v1/account/summary   Authorization: Bearer <JWT>   → AccountSummary
//   GET {ACCOUNT_BASE}/v1/billing/transactions
//   401 = JWT 失效/缺失 → main 单飞续期并经 token-generation 换血入口旋转 sidecar;
//   续期失败或重试仍 401 才向 renderer 暴露 unauthorized。
// Account reads hit the in-region account-server (PII/金融 must stay in-region), NOT the model
// gateway. Overridable via ALPHA_ACCOUNT_URL for dev/staging (consistent with ALPHA_WEB_URL /
// ALPHA_PLATFORM_URL; see shared/alpha-config.ts).

import { ALPHA_PATHS } from "../shared/alpha-config"
import { decodeJsonContract, isContractIncompatibleError } from "@alpha-code/contracts-consumer"
import { resolveEndpoints } from "./alpha-endpoints"
import { getAccessToken, refreshTokens } from "./alpha-auth"
import { getLogger } from "./logging"
import { reportContractFailure } from "./alpha-contract-health"
import type { AccountResult, AccountSummary, AccountTransaction } from "../preload/types"
import { createAuthedGet } from "./alpha-account-request"

// Resolved by alpha-endpoints (env ALPHA_ACCOUNT_URL > userData pin > login discovery > default).
const accountBase = () => resolveEndpoints().account

// B2 defense-in-depth:如果「续期后重试仍 401」,说明该 access token 确实被端点拒绝(不是过期),
// 再续也只是白烧往返。按 purpose 冷却一段时间:一个持续 401 的账户端点最多驱动约每 30s 一次续期,
// 与 UI 重拉频率无关。(alpha-auth.ts 的 publish 身份门控是断风暴的主闸;这里是本地兜底,确保未来
// 任何重拉模式都无法重新引爆循环。)
// B2:401 拦截 —— access token 失效时先续期一次再重试(单飞在 refreshTokens 内);续期失败(会话
// revoked → 那边已降级登出)才把 unauthorized 交给 renderer 触发重新登录。
const authedGet = createAuthedGet({
  accountBase,
  getAccessToken,
  refreshTokens,
  fetch,
  now: Date.now,
  warn: (message, error) => getLogger().warn(message, error),
  isContractIncompatibleError,
  reportContractFailure,
})

export const fetchAccountSummary = (): Promise<AccountResult<AccountSummary>> =>
  authedGet(ALPHA_PATHS.accountSummary, "account.read", (text) => JSON.parse(text) as AccountSummary)

export const fetchTransactions = (limit?: number): Promise<AccountResult<{ transactions: AccountTransaction[] }>> =>
  authedGet(
    limit ? `${ALPHA_PATHS.transactions}?limit=${limit}` : ALPHA_PATHS.transactions,
    "account.read",
    (text) => ({
      transactions: decodeJsonContract("LedgerPageV1", text, "account").transactions.map((entry) => ({
        id: entry.id,
        type: entry.type,
        title: entry.title,
        amountFen: entry.amount_fen,
        createdAt: entry.created_at,
        status: entry.status,
      })),
    }),
  )
