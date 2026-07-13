// alpha cloud jobs (ADR-016) — dispatch a cloud job + poll status against the alpha-platform (B)
// `cloud` worker, authed with the JWT alpha-web (C) issued. MAIN-ONLY: the renderer never sees the
// token, only the resolved result over IPC (cloud-ipc.ts). This is the "sidecar HTTP" seam (ADR-016 §3)
// for app-driven dispatch/status; the MCP facade (agent-triggered cloud.* tools) is wired separately in
// sidecar.ts (mcp.servers.cloud). Both front the SAME bearer + SAME B cloud jobs API (single truth source).
//
// Contract: alpha-platform docs/contracts/cloud-jobs-v1.md —
//   POST {CLOUD_BASE}/v1/cloud/jobs        Authorization: Bearer <JWT>   → 202 { job_id, urls, status }
//   GET  {CLOUD_BASE}/v1/cloud/jobs/{id}                                 → public status (tier-invisible)
//   401 = JWT 失效/缺失 → renderer should trigger re-login.
// tier (T1/T2/T3) is invisible; autonomy (pipeline|bounded-agent) discriminates. Overridable via
// ALPHA_CLOUD_URL for dev/staging (consistent with ALPHA_ACCOUNT_URL; see shared/alpha-config.ts).

import { ALPHA_PATHS } from "../shared/alpha-config"
import { resolveEndpoints } from "./alpha-endpoints"
import { getAccessToken } from "./alpha-auth"
import { guardCloudEnvelope } from "./cloud-envelope-guard"
import { downloadArtifactToFile, type ArtifactDownloadOutcome, type ArtifactDownloadRequest } from "./alpha-artifact-download"
import { getLogger } from "./logging"
import type { CloudResult, CloudJobEnvelope, CloudDispatchResult, CloudJobStatus, CloudArtifactList } from "../preload/types"

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

// REQ-092:artifact 内容唯一入口 —— descriptor.contentRef 流式下载到磁盘(bearer 仅 main,renderer 零字节)。
// 旧「arrayBuffer→Buffer→编码→Buffer」全缓冲链已删除;窗口期 legacy 内联回退在 alpha-artifact-download 内部
// (同 .part 写入器 + 同限额 + 同 sha256 校验,⏰ 2026-08-15 随平台 compat flag 一并移除)。
// 失败只回分类码 + 净化 detail;此处日志也只落分类码(token 卫生,REQ-092 AC#5)。
export async function downloadCloudArtifactTo(req: ArtifactDownloadRequest): Promise<ArtifactDownloadOutcome> {
  const token = getAccessToken()
  if (!token) return { ok: false, error: "not-authenticated" }
  const base = cloudBase()
  if (!base) return { ok: false, error: "no-cloud-endpoint" }
  const outcome = await downloadArtifactToFile(req, { token, base })
  if (!outcome.ok && outcome.error !== "cancelled") {
    getLogger().warn(`alpha-cloud-jobs: artifact download failed (${outcome.error})`)
  }
  return outcome
}
