export type RoutePurpose = "model.invoke" | "cloud.dispatch" | "cloud.read" | "artifact.read" | "account.read"

export type TokenClaimsV1 = {
  schema_version: 1
  iss: "alpha-web"
  aud: "alpha-platform-api"
  sub: string
  token_use: "platform_access"
  purpose: RoutePurpose
  scope: string[]
  iat: number
  exp: number
  jti: string
  edition?: string
}

export type EgressDeclarationV1 =
  | { egress_class: "explicit.file-upload"; enforcement: "required" }
  | { egress_class: "input.diff"; enforcement: "grandfathered" }
  | { egress_class: "code-review"; enforcement: "grandfathered" }

export type UploadManifestV1 = {
  schema_version: 1
  manifest_id: string
  tenant_id: string
  created_at: string
  retention_class: "standard" | "short" | "none"
  consent_required: boolean
  egress: EgressDeclarationV1[]
  file_count: number
  total_bytes: number
  files: Array<{
    path: string
    size_bytes: number
    sha256: string
    media_type?: string
  }>
}

export type UploadConsentClaimsV1 = {
  schema_version: 1
  iss: "alpha-web"
  aud: "alpha-platform-upload"
  sub: string
  token_use: "upload_consent"
  purpose: "artifact.upload"
  scope: string[]
  iat: number
  exp: number
  jti: string
  manifest_id: string
  manifest_sha256: string
  egress: EgressDeclarationV1[]
}

// #640 / platform#101 Ledger V1 hard cut. A ledger entry is now an append-only *fact* from
// ledger_facts, not a mutable transaction row: facts are never amended, so there is no `status`
// and no display `title` on the wire. `amount` is signed (positive = credited, negative = debited)
// and its unit is chosen by `domain` — wallet counts fen, allowance counts credits, so the two are
// never summed. `seq` is the page cursor (descending, `before=seq` reaches all history);
// `created_at` is integer epoch milliseconds, not an ISO string.
export type LedgerFactKindV1 =
  | "payment_credited"
  | "bonus_credited"
  | "subscription_activated"
  | "reservation_created"
  | "reservation_settled"
  | "reservation_expired"
  | "usage_settled"
  | "allowance_consumed"
  | "allowance_window_rolled"
  | "allowance_expired"
  | "debt_incurred"
  | "refund_applied"
  | "correction"

export type LedgerEntryV1 = {
  schema_version: 1
  seq: number
  op_id: string
  kind: LedgerFactKindV1
  domain: "wallet" | "allowance"
  amount: number
  action_id?: string
  reservation_id?: string
  window_id?: string
  external_ref?: string
  created_at: number
}

/** One page, bounded at 500 entries upstream (LEDGER_PAGE_MAX); older facts are reached by cursor. */
export type LedgerPageV1 = { schema_version: 1; transactions: LedgerEntryV1[] }

// #681 / platform#138 / ADR-039: `GET /v1/models` hard-cut to ModelCatalogV2 — the URL's `v1` is the
// HTTP namespace, this number is the payload generation. Every model now carries both multipliers, and
// the catalog carries the reference model they are relative to. Two things the shape deliberately does
// NOT say, because they are fixed contract semantics rather than per-response data: the unit
// (uncached input/output USD-per-Mtok ratio) and the rounding (platform half-ups to one decimal).
// `pricing_basis_model_id` is that unit's definition, **not** a membership claim — an edition whose
// allowlist filters the reference model out still publishes it, so never assume it appears in `data`.
export type ModelCatalogV2 = {
  schema_version: 2
  object: "list"
  data: Array<{
    id: string
    object: "model"
    provider: "deepseek" | "openai" | "openrouter" | "anthropic" | "zhipu" | "alibaba"
    min_plan: "free" | "member"
    pricing_multiplier: { input: number; output: number }
  }>
  edition: string
  byok_providers: string[] | null
  pricing_basis_model_id: string
}

export type ArtifactDescriptorV1 = {
  schemaVersion: 1
  id: string
  source: "cloud" | "workspace" | "local" | "message" | "automation"
  name: string
  size?: number
  claimedMime?: string
  detectedMime?: string
  sha256?: string
  trust: "sandboxed" | "platform" | "external" | "unverified"
  role: "primary" | "preview" | "log" | "intermediate"
  primaryId?: string
  previewIds?: string[]
  contentRef: { kind: "http-stream"; url: string; auth: "bearer" }
  verification: { status: "verified" | "unverified" | "pending" | "mismatch"; detector?: string; verifiedAt?: string }
  provenance: {
    producer: "pipeline" | "bounded-agent"
    jobId: string
    kind?: string
    step?: string
    createdAt?: string
  }
}

export type CloudJobRequestV1 = {
  schema_version: 1
  autonomy: "pipeline" | "bounded-agent"
  kind?: string
  input?: Record<string, unknown>
  objective?: string
  capabilities?: string[]
  budget?: { max_iter?: number; max_tokens?: number; max_wall_clock_sec?: number }
  constraints?: { allowed_tools?: string[]; denied_paths?: string[]; network?: "none" | "restricted" | "open" }
  output_schema?: Record<string, unknown>
  artifact_policy?: { delivery: "descriptor_only" }
}

export type CloudJobAcceptedV1 = {
  schema_version: 1
  job_id: string
  status: "queued"
  autonomy: "pipeline" | "bounded-agent"
  kind?: string
  urls: { status: string; events: string; result: string }
}

export type CloudJobStatusV1 = {
  schema_version: 1
  job_id: string
  status: "queued" | "running" | "blocked" | "completed" | "failed" | "cancelled"
  autonomy: "pipeline" | "bounded-agent"
  kind?: string
  progress: {
    phase: "routing" | "sandbox.starting" | "agent.running" | "pipeline.running" | "completed" | "failed"
    completed_steps?: number
    total_steps?: number
  }
  counters?: { model_calls: number; tokens_in: number; tokens_out: number; cost_usd: number }
  artifact_ids: string[]
  artifacts?: ArtifactDescriptorV1[]
  result?: unknown
  error: string | null
}

export type ArtifactListV1 = {
  schema_version: 1
  job_id: string
  status: CloudJobStatusV1["status"]
  artifacts: ArtifactDescriptorV1[]
  artifact_ids: string[]
  result: unknown
}

export type ContractValues = {
  TokenClaimsV1: TokenClaimsV1
  UploadManifestV1: UploadManifestV1
  LedgerPageV1: LedgerPageV1
  ModelCatalogV2: ModelCatalogV2
  CloudJobRequestV1: CloudJobRequestV1
  CloudJobAcceptedV1: CloudJobAcceptedV1
  CloudJobStatusV1: CloudJobStatusV1
  ArtifactListV1: ArtifactListV1
  ArtifactDescriptorV1: ArtifactDescriptorV1
}
