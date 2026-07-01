// alpha cloud jobs (ADR-016) — dispatch a cloud job + poll status against the alpha-platform (B)
// `cloud` worker, authed with the JWT alpha-web (C) issued. MAIN-ONLY: the renderer never sees the
// token, only the resolved result over IPC (cloud-ipc.ts). This is the "sidecar HTTP" seam (ADR-016 §3)
// for app-driven dispatch/status; the MCP facade (agent-triggered cloud.* tools) is wired separately in
// sidecar.ts (mcp.servers.cloud). Both front the SAME bearer + SAME B cloud jobs API (single truth source).
//
// Contract: alpha-platform docs/alpha-code-cloud-integration.md —
//   POST {CLOUD_BASE}/v1/cloud/jobs        Authorization: Bearer <JWT>   → 202 { job_id, urls, status }
//   GET  {CLOUD_BASE}/v1/cloud/jobs/{id}                                 → public status (tier-invisible)
//   401 = JWT 失效/缺失 → renderer should trigger re-login.
// tier (T1/T2/T3) is invisible; autonomy (pipeline|bounded-agent) discriminates. Overridable via
// ALPHA_CLOUD_URL for dev/staging (consistent with ALPHA_ACCOUNT_URL; see shared/alpha-config.ts).

import { ALPHA_PATHS } from "../shared/alpha-config"
import { resolveEndpoints } from "./alpha-endpoints"
import { getAccessToken } from "./alpha-auth"
import { getLogger } from "./logging"
import type { CloudResult, CloudJobEnvelope, CloudDispatchResult, CloudJobStatus } from "../preload/types"

// Resolved by alpha-endpoints (env ALPHA_CLOUD_URL > userData pin > login discovery > default).
const cloudBase = () => resolveEndpoints().cloud

async function authed<T>(path: string, init?: { method?: string; body?: unknown }): Promise<CloudResult<T>> {
  const token = getAccessToken()
  if (!token) return { error: "not-authenticated" }
  const base = cloudBase()
  if (!base) return { error: "no-cloud-endpoint" }
  try {
    const res = await fetch(`${base}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(15000),
    })
    if (res.status === 401) return { error: "unauthorized" }
    if (!res.ok) return { error: `http-${res.status}` }
    return (await res.json()) as T
  } catch (error) {
    getLogger().warn("alpha-cloud-jobs: fetch failed", error)
    return { error: "network" }
  }
}

export const dispatchCloudJob = (envelope: CloudJobEnvelope): Promise<CloudResult<CloudDispatchResult>> =>
  authed<CloudDispatchResult>(ALPHA_PATHS.cloudJobs, { method: "POST", body: envelope })

export const getCloudJobStatus = (jobId: string): Promise<CloudResult<CloudJobStatus>> =>
  authed<CloudJobStatus>(`${ALPHA_PATHS.cloudJobs}/${encodeURIComponent(jobId)}`)
