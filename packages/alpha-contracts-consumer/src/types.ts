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

export type LedgerEntryV1 = {
  schema_version: 1
  id: string
  type: "usage" | "recharge" | "bonus" | "subscription"
  title: string
  amount_fen: number
  created_at: string
  status: "success" | "failed"
  key_id?: string
}

export type LedgerPageV1 = { schema_version: 1; transactions: LedgerEntryV1[] }

export type ModelCatalogV1 = {
  schema_version: 1
  object: "list"
  data: Array<{
    id: string
    object: "model"
    provider: "deepseek" | "openai" | "openrouter" | "anthropic" | "zhipu" | "alibaba"
    min_plan: "free" | "member"
  }>
  edition: string
  byok_providers: string[] | null
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
  ModelCatalogV1: ModelCatalogV1
  CloudJobRequestV1: CloudJobRequestV1
  CloudJobAcceptedV1: CloudJobAcceptedV1
  CloudJobStatusV1: CloudJobStatusV1
  ArtifactListV1: ArtifactListV1
  ArtifactDescriptorV1: ArtifactDescriptorV1
}
