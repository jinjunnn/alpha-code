// Single source of truth for alpha's backend endpoint defaults. Change a domain HERE — not in
// individual pages/modules. Main-process callers layer env overrides on top (ALPHA_WEB_URL /
// ALPHA_PLATFORM_URL) for dev/staging; the renderer imports these defaults directly (it has no
// process.env). Pure constants only — NO electron/node imports — so both the main and renderer
// bundles can import this module.

/** Resolved alpha backend endpoints. `mcp` optional (callers derive `${platform}/mcp` when absent).
 *  The constants below are bootstrap DEFAULTS only — main resolves env > userData pin > login discovery
 *  > default (see main/alpha-endpoints.ts), and the renderer reads the resolved set over IPC
 *  (window.api.endpoints). Change a domain HERE only to move the default. */
export type AlphaEndpoints = { web: string; platform: string; account: string; cloud: string; mcp?: string }

export const ALPHA_ENDPOINTS = {
  /** alpha-web (C): identity / login / token / billing portal. */
  web: "https://auth.tidelabs.click",
  /** alpha-platform (B): model proxy (/v1). The gateway has NO custom domain (unlike account./auth.) —
   *  it's the raw Worker URL `alpha-gateway.jinjunnm.workers.dev`, confirmed against alpha-platform docs
   *  (M4-next-steps / design.md / ADR-014) AND a live probe (/health 200, /v1/models 200, /v1/chat
   *  /completions 401). The previous `api.tidelabs.click` 404'd every /v1 route (no gateway routed
   *  there). Override per-deploy with ALPHA_PLATFORM_URL once a custom domain is set up. */
  platform: "https://alpha-gateway.jinjunnm.workers.dev",
  /** alpha-platform (B) account-server (境内 PII/金融): balance / membership / usage ledger. */
  account: "https://account.tidelabs.click",
  /** alpha-platform (B) cloud jobs API (ADR-016): unified dispatch/status + MCP facade (/mcp). A
   *  SEPARATE worker from the model gateway (the gateway 404s /mcp) — `alpha-cloud`. Override per-deploy
   *  with ALPHA_CLOUD_URL; alpha-web may also discover it via the token response endpoints{cloud,mcp}. */
  cloud: "https://alpha-cloud.jinjunnm.workers.dev",
} as const

// Path segments appended to the hosts above — the full alpha↔backend URL contract in one place.
// Change a route here (e.g. /v1 → /openai/v1) instead of editing inline template strings.
export const ALPHA_PATHS = {
  /** web: OAuth authorize page. */
  authorize: "/auth/authorize",
  /** web: PKCE code → token exchange. */
  token: "/auth/token",
  /** web: billing portal(用量 + 流水账单页). */
  billing: "/billing",
  /** web: 钱包购买页 —— ?tab=recharge(钱包充值)| subscription(会员月卡). */
  wallet: "/wallet",
  /** platform: model proxy base → ALPHA_BASE_URL. */
  modelProxy: "/v1",
  /** cloud: MCP facade → ALPHA_CLOUD_MCP_URL (on the `cloud` worker, NOT the model gateway). */
  mcpGateway: "/mcp",
  /** cloud: unified cloud jobs API (ADR-016) → dispatch POST, status GET {cloudJobs}/{id}. */
  cloudJobs: "/v1/cloud/jobs",
  /** account-server: balance / membership / token-usage summary. */
  accountSummary: "/v1/account/summary",
  /** account-server: billing transaction history. */
  transactions: "/v1/billing/transactions",
} as const
