export type RoutePurpose = "model.invoke" | "cloud.dispatch" | "cloud.read" | "artifact.read" | "account.read"

export type TokenClaimsV1 = {
  schema_version: 1
  iss: "codepuppy-web"
  aud: "codepuppy-platform-api"
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
  iss: "codepuppy-web"
  aud: "codepuppy-platform-upload"
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

// #681 / platform#138 / ADR-039: `GET /v1/models` hard-cut to a versioned catalog — the URL's `v1` is the
// HTTP namespace, this number is the payload generation. Every model carries both multipliers, and the
// catalog carries the reference model they are relative to. Two things the shape deliberately does NOT
// say, because they are fixed contract semantics rather than per-response data: the unit (uncached
// input/output USD-per-Mtok ratio) and the rounding (platform half-ups to one decimal).
// `pricing_basis_model_id` is that unit's definition, **not** a membership claim — an edition whose
// allowlist filters the reference model out still publishes it, so never assume it appears in `data`.
// `#1556` / platform#559: V3 adds the required `display` (name / brand / capabilities, owned by the
// gateway registry) and drops `byok_providers`.
export type ModelVariants = Record<string, { reasoningEffort?: string; reasoning?: Record<string, unknown>; thinking?: Record<string, unknown> }>
export type ModelBrandV1 = "anthropic" | "openai" | "deepseek" | "zhipu" | "qwen" | "moonshot" | "minimax"
export type ModelCatalogV3 = {
  schema_version: 3
  object: "list"
  data: Array<{
    id: string
    object: "model"
    provider: "deepseek" | "openai" | "openrouter" | "anthropic" | "zhipu" | "alibaba"
    min_plan: "free" | "member"
    pricing_multiplier: { input: number; output: number }
    display: { name: string; brand: ModelBrandV1; reasoning?: boolean; web?: boolean; variants?: ModelVariants }
  }>
  edition: string
  pricing_basis_model_id: string
}

// `#1556` / platform#559: `GET /v1/byok-catalog` — the BYOK preset catalog. Data only: no endpoint, key
// name or protocol adapter (those are the App's built-in adapter table); `catalog_version` is monotonic.
export type ByokCatalogV1 = {
  schema_version: 1
  catalog_version: number
  published_at: string
  providers: Array<{
    id: string
    name: string
    brand: ModelBrandV1
    preset: boolean
    models: Array<{ id: string; name: string; reasoning?: boolean; variants?: ModelVariants; image_input: boolean }>
  }>
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

// #400 / platform#255 (REQ-109): `idempotency_key` is REQUIRED on both request branches —
// `^[A-Za-z0-9._-]{8,128}$`, full-string anchors. It lives in the envelope, not an HTTP header,
// because the MCP facade has no header carrier and `cloud_dispatch`'s inputSchema references
// CloudJobRequestV1Schema directly: one definition, both faces. `network` is narrowed to the only
// real execution shape "restricted" (platform#262) — "none"/"open" were schema-accepted promises
// the executor never kept, and the upstream schema now rejects them.
export type CloudJobRequestV1 = {
  schema_version: 1
  idempotency_key: string
  autonomy: "pipeline" | "bounded-agent"
  kind?: string
  input?: Record<string, unknown>
  objective?: string
  capabilities?: string[]
  budget?: { max_iter?: number; max_tokens?: number; max_wall_clock_sec?: number }
  constraints?: { allowed_tools?: string[]; denied_paths?: string[]; network?: "restricted" }
  output_schema?: Record<string, unknown>
  artifact_policy?: { delivery: "descriptor_only" }
}

export type CloudJobAcceptedV1 = {
  schema_version: 1
  job_id: string
  status: "queued"
  autonomy: "pipeline" | "bounded-agent"
  kind?: string
  /** platform#255: same key + same payload hit an existing admission row — the original job_id
   *  came back instead of a second job. Informational for the desktop; the identity is job_id. */
  idempotent_replay?: boolean
  urls: { status: string; events: string; result: string }
}

/** platform#255: the shared seventh-value public status enum. `cancelling` = cancel accepted but
 *  the stop protocol has not closed — it is NOT `cancelled` and must never be shown as such. */
export type CloudJobPublicStatusV1 =
  | "queued"
  | "running"
  | "blocked"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"

export type CloudJobStatusV1 = {
  schema_version: 1
  job_id: string
  status: CloudJobPublicStatusV1
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
  /** platform#255: "dispatch never succeeded" projected as `failed` + this discriminator, instead
   *  of an eighth enum value. */
  reason?: "dispatch_dead"
  error: string | null
}

/** platform#255: server-side decidable cancel outcome (new). `accepted=false` means the job was
 *  already in a non-cancellable state; `status` is the server's current truth either way. */
export type CloudJobCancelResultV1 = {
  schema_version: 1
  job_id: string
  status: CloudJobPublicStatusV1
  accepted: boolean
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
  ModelCatalogV3: ModelCatalogV3
  ByokCatalogV1: ByokCatalogV1
  CloudJobRequestV1: CloudJobRequestV1
  CloudJobAcceptedV1: CloudJobAcceptedV1
  CloudJobStatusV1: CloudJobStatusV1
  CloudJobCancelResultV1: CloudJobCancelResultV1
  ArtifactListV1: ArtifactListV1
  ArtifactDescriptorV1: ArtifactDescriptorV1
}
