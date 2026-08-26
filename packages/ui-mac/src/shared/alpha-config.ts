// Single source of truth for alpha's backend endpoint defaults. Change a domain HERE — not in
// individual pages/modules. Main-process callers layer env overrides on top (ALPHA_WEB_URL /
// ALPHA_PLATFORM_URL) for dev/staging; the renderer imports these defaults directly (it has no
// process.env). Pure constants only — NO electron/node imports — so both the main and renderer
// bundles can import this module.

/** Resolved alpha backend endpoints. `mcp` is optional; callers derive `${cloud}/mcp` when absent.
 *  The constants below are bootstrap DEFAULTS only — main resolves env > userData pin > login discovery
 *  > default (see main/alpha-endpoints.ts), and the renderer reads the resolved set over IPC
 *  (window.api.endpoints). Change a domain HERE only to move the default. */
export type AlphaEndpoints = { web: string; platform: string; account: string; cloud: string; mcp?: string }

/**
 * Alpha-owned V2 config marker. It has no models and an empty env integration, so it is never an
 * available provider. The mechanically derived governed ModelsDev base materializes it in the same
 * early batch as the exact provider/model identities; the ordinary ConfigProvider projection keeps
 * the same marker for the conservative user/file-provider fallback. Renderer model consumers can
 * therefore wait for it without an account or network dependency before issuing the first list.
 */
export const ALPHA_V2_CATALOG_READY_PROVIDER_ID = "alpha-internal-catalog-ready"

export const ALPHA_ENDPOINTS = {
  /** alpha-web (C): identity / login / token / billing portal. */
  web: "https://codepuppy.cn",
  /** alpha-platform (B): model proxy (/v1). Custom domain since B PR #20 (REQ-070) — `*.workers.dev`
   *  is widely DNS-poisoned/TLS-reset in mainland China, and the zone domain unlocks B-side WAF/rate
   *  limits. Live-probed 2026-07-08: /health 200, /v1/models 200. The old
   *  `alpha-gateway.jinjunnm.workers.dev` stays online during the migration window (B keeps it until
   *  A confirms rollout). Override per-deploy with ALPHA_PLATFORM_URL. */
  platform: "https://alpha-gateway.tidelabs.click",
  /** alpha-platform (B) account-server (境内 PII/金融): balance / membership / usage ledger. */
  account: "https://account.codepuppy.cn",
  /** alpha-platform (B) cloud jobs API (ADR-016): unified dispatch/status + MCP facade (/mcp). A
   *  SEPARATE worker from the model gateway (the gateway 404s /mcp) — `alpha-cloud`. Custom domain
   *  since B PR #20 (REQ-070; old workers.dev URL online during the migration window). Override
   *  per-deploy with ALPHA_CLOUD_URL; alpha-web may also discover it via the token response
   *  endpoints{cloud,mcp}. */
  cloud: "https://alpha-cloud.tidelabs.click",
} as const

// Path segments appended to the hosts above — the full alpha↔backend URL contract in one place.
// Change a route here (e.g. /v1 → /openai/v1) instead of editing inline template strings.
export const ALPHA_PATHS = {
  /** web: OAuth authorize page. */
  authorize: "/auth/authorize",
  /** web: PKCE code → token exchange. */
  token: "/auth/token",
  /** web: issue a manifest-bound upload_consent token after main-owned user consent. */
  uploadConsent: "/auth/upload-consent",
  /** web: billing portal(用量 + 流水账单页). */
  billing: "/billing",
  /** web: 钱包购买页 —— ?tab=recharge(钱包充值)| subscription(会员月卡). */
  wallet: "/wallet",
  /** platform: model proxy base → ALPHA_BASE_URL. */
  modelProxy: "/v1",
  /** platform: live model allowlist (B gateway 真相源;A 用于同步/校验模型目录,解 alpha-models.json 占位漂移)。 */
  models: "/v1/models",
  /** cloud: MCP facade → ALPHA_CLOUD_MCP_URL (on the `cloud` worker, NOT the model gateway). */
  mcpGateway: "/mcp",
  /** cloud: unified cloud jobs API (ADR-016) → dispatch POST, status GET {cloudJobs}/{id}, SSE {cloudJobs}/{id}/events, list {cloudJobs}/{id}/artifacts. */
  cloudJobs: "/v1/cloud/jobs",
  /** cloud: authenticated artifact content download → {cloudArtifacts}/{artifactId}/content. */
  cloudArtifacts: "/v1/cloud/artifacts",
  /** account-server: balance / membership / token-usage summary. */
  accountSummary: "/v1/account/summary",
  /** account-server: billing transaction history. */
  transactions: "/v1/billing/transactions",
} as const
