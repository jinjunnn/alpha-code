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
import { getAccessToken, getAuthIdentityEpoch, refreshTokens } from "./alpha-auth"
import { getLogger } from "./logging"
import { reportContractFailure } from "./alpha-contract-health"
import type { AccountResult, AccountSummary, AccountTransaction } from "../preload/types"
import { createAuthedGet } from "./alpha-account-request"
import { decodeAccountSummary } from "./alpha-account-contract"

// Resolved by alpha-endpoints (env ALPHA_ACCOUNT_URL > userData pin > login discovery > default).
const accountBase = () => resolveEndpoints().account

// B2 defense-in-depth:如果「续期后重试仍 401」,说明该 access token 确实被端点拒绝(不是过期),
// 再续也只是白烧往返 —— 而每次成功续期都会驱动一次 token-only 换血。#601:该 purpose 的账户驱动
// 刷新就此锁住,直到该端点出现非 401 成功或用户登入/登出,不再用有限冷却窗口当终局(那会自激成
// 每 30 秒中断一次会话的 respawn 循环)。
// B2:401 拦截 —— access token 失效时先续期一次再重试(单飞在 refreshTokens 内);续期失败(会话
// revoked → 那边已降级登出)才把 unauthorized 交给 renderer 触发重新登录。
const authedGet = createAuthedGet({
  accountBase,
  getAccessToken,
  refreshTokens,
  authIdentityEpoch: getAuthIdentityEpoch,
  fetch,
  warn: (message, error) => getLogger().warn(message, error),
  isContractIncompatibleError,
  reportContractFailure,
})

// #631: decoded, not cast — an account-server response the published contract does not describe
// becomes `contract-incompatible` (reported to the renderer's contract-health alert) instead of a
// structurally broken AccountSummary. See alpha-account-contract.ts.
export const fetchAccountSummary = (): Promise<AccountResult<AccountSummary>> =>
  authedGet(ALPHA_PATHS.accountSummary, "account.read", decodeAccountSummary)

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
