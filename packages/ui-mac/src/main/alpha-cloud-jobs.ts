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
import { guardCloudEnvelope } from "./cloud-envelope-guard"
import { getLogger } from "./logging"
import type { CloudResult, CloudJobEnvelope, CloudDispatchResult, CloudJobStatus, CloudArtifactList, CloudArtifactContent } from "../preload/types"

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

// ADR-021 §2(REQ-020 T1):上行硬校验单点 —— denied_paths 缺省注入 / 1MB 帽 / secrets 拒发,
// 全部 loud(错误原样回 renderer 行内呈现)。MCP facade 路径由 B 侧 schema 校验兜底(双层)。
export const dispatchCloudJob = (envelope: CloudJobEnvelope): Promise<CloudResult<CloudDispatchResult>> => {
  const guarded = guardCloudEnvelope(envelope)
  if (!guarded.ok) {
    getLogger().warn("alpha-cloud-jobs: envelope rejected by ADR-021 guard", guarded.error)
    return Promise.resolve({ error: guarded.error })
  }
  return authed<CloudDispatchResult>(ALPHA_PATHS.cloudJobs, { method: "POST", body: guarded.envelope })
}

export const getCloudJobStatus = (jobId: string): Promise<CloudResult<CloudJobStatus>> =>
  authed<CloudJobStatus>(`${ALPHA_PATHS.cloudJobs}/${encodeURIComponent(jobId)}`)

// 取消 job(消费 B 的 AR-17 soft-cancel:标记 cancelled + emit 终态事件;status/SSE 随后报 cancelled)。
export const cancelCloudJob = (jobId: string): Promise<CloudResult<{ job_id: string; status: string }>> =>
  authed<{ job_id: string; status: string }>(`${ALPHA_PATHS.cloudJobs}/${encodeURIComponent(jobId)}/cancel`, { method: "POST" })

export const listCloudArtifacts = (jobId: string): Promise<CloudResult<CloudArtifactList>> =>
  authed<CloudArtifactList>(`${ALPHA_PATHS.cloudJobs}/${encodeURIComponent(jobId)}/artifacts`)

// 下载单个 artifact 的二进制内容 → base64(main 取回,bearer 不进 renderer;仿 account 读取)。
// 大文件经 base64/IPC 传给 renderer 存盘;真部署可改 main 侧 save dialog 直写盘。
export async function fetchCloudArtifact(artifactId: string): Promise<CloudResult<CloudArtifactContent>> {
  const token = getAccessToken()
  if (!token) return { error: "not-authenticated" }
  const base = cloudBase()
  if (!base) return { error: "no-cloud-endpoint" }
  try {
    const res = await fetch(`${base}${ALPHA_PATHS.cloudArtifacts}/${encodeURIComponent(artifactId)}/content`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30000),
    })
    if (res.status === 401) return { error: "unauthorized" }
    if (!res.ok) return { error: `http-${res.status}` }
    const mime = res.headers.get("content-type") ?? "application/octet-stream"
    const cd = res.headers.get("content-disposition") ?? ""
    const name = /filename="?([^"]+)"?/.exec(cd)?.[1] ?? "artifact"
    const base64 = Buffer.from(await res.arrayBuffer()).toString("base64")
    return { name, mime, base64 }
  } catch (error) {
    getLogger().warn("alpha-cloud-jobs: artifact fetch failed", error)
    return { error: "network" }
  }
}
