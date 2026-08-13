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
import {
  decodeJsonContract,
  isContractIncompatibleError,
  type RoutePurpose,
} from "@alpha-code/contracts-consumer"
import { resolveEndpoints } from "./alpha-endpoints"
import { getAccessToken } from "./alpha-auth"
// [#918→#940] 平台拒绝 → 错误字符串的唯一咽喉(分类码优先,无码保持 http-<status> 不猜)。
import { httpErrorCode } from "./platform-error-code"
import { guardCloudEnvelope } from "./cloud-envelope-guard"
import {
  downloadArtifactToFile,
  type ArtifactDownloadOutcome,
  type ArtifactDownloadRequest,
  type ArtifactFinalizer,
} from "./alpha-artifact-download"
import { getLogger } from "./logging"
import { reportContractFailure } from "./alpha-contract-health"
import type {
  CloudResult,
  CloudJobEnvelope,
  CloudDispatchResult,
  CloudJobCancelResult,
  CloudJobStatus,
  CloudArtifactList,
} from "../preload/types"
import type { createExplicitUploadRequest } from "./alpha-upload-manifest"

// Resolved by alpha-endpoints (env ALPHA_CLOUD_URL > userData pin > login discovery > default).
const cloudBase = () => resolveEndpoints().cloud

// #400(REQ-109 AC5 桌面半场):submit 的有界客户端重试。上限是硬的 —— 恰好 3 次尝试,之后把
// 分类错误原样交给调用方,绝不无界自旋。只有「响应根本没形成」(fetch 抛:超时/断连/DNS)和
// 网关侧瞬态 502/503/504 可重试;能重试的**前提**是 platform#255 的必填 idempotency_key ——
// 同一个 guarded envelope 逐字节重发,首发其实已落地时服务端按键去重回原 job(idempotent_replay),
// 不产生第二个 job。401/403/4xx/429 一律不重试:那是判权/契约/限流的回答,重发只会把同一个回答
// 再要一遍(429 还会跟限流器对撞)。
export const DISPATCH_MAX_ATTEMPTS = 3
const RETRYABLE_HTTP = new Set([502, 503, 504])
const RETRY_BASE_DELAY_MS = 250
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 跑一个「产生 Response」的动作,带硬上限的瞬态重试。非瞬态结果第一时间原样返回。 */
async function fetchWithBoundedRetry(run: () => Promise<Response>, maxAttempts: number): Promise<Response> {
  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) await sleep(RETRY_BASE_DELAY_MS * (attempt - 1))
    try {
      const res = await run()
      if (RETRYABLE_HTTP.has(res.status) && attempt < maxAttempts) continue
      return res
    } catch (error) {
      lastError = error
      if (attempt < maxAttempts) continue
      throw error
    }
  }
  throw lastError ?? new Error("unreachable: bounded retry exhausted without a result")
}

async function authed<T>(
  path: string,
  purpose: RoutePurpose,
  init: { method?: string; body?: unknown; maxAttempts?: number } | undefined,
  decode: (text: string) => T,
): Promise<CloudResult<T>> {
  try {
    const token = getAccessToken(purpose)
    if (!token) return { error: "not-authenticated" }
    const base = cloudBase()
    if (!base) return { error: "no-cloud-endpoint" }
    const res = await fetchWithBoundedRetry(
      () =>
        fetch(`${base}${path}`, {
          method: init?.method ?? "GET",
          headers: {
            authorization: `Bearer ${token}`,
            ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
          },
          body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
          signal: AbortSignal.timeout(15000),
        }),
      init?.maxAttempts ?? 1,
    )
    if (res.status === 401) return { error: "unauthorized" }
    if (!res.ok) return { error: await httpErrorCode(res) }
    return decode(await res.text())
  } catch (error) {
    if (isContractIncompatibleError(error)) {
      reportContractFailure(error)
      return { error: "contract-incompatible" }
    }
    getLogger().warn("alpha-cloud-jobs: fetch failed", error)
    return { error: "network" }
  }
}

// ADR-021 §2(REQ-020 T1):上行硬校验单点 —— 工具集合必须显式 / 256KiB 帽 / secrets 拒发,
// 全部 loud(错误原样回 renderer 行内呈现)。MCP facade 路径由 B 侧 schema 校验兜底(双层)。
// #400:guard 在这里恰好跑一次 = 幂等键在这里恰好 mint 一次;下面的有界重试序列化的始终是
// 同一个 guarded.envelope 对象 —— 「同一次意图的第 N 次重试带同一个键」由此成为结构性质。
export const dispatchCloudJob = (envelope: CloudJobEnvelope): Promise<CloudResult<CloudDispatchResult>> => {
  const guarded = guardCloudEnvelope(envelope)
  if (!guarded.ok) {
    getLogger().warn("alpha-cloud-jobs: envelope rejected by ADR-021 guard", guarded.error)
    return Promise.resolve({ error: guarded.error })
  }
  return authed(
    ALPHA_PATHS.cloudJobs,
    "cloud.dispatch",
    { method: "POST", body: guarded.envelope, maxAttempts: DISPATCH_MAX_ATTEMPTS },
    (text) => decodeJsonContract("CloudJobAcceptedV1", text, "cloud-http"),
  )
}

// #400:body 在 upload prepare 时经 guard 构造一次(createExplicitUploadRequest),幂等键随之
// 冻结 —— 同意对话框前后、以及这里的每次瞬态重试,发的都是同一个键。首发已落地时服务端按键
// 去重回原 job,重发文件字节不产生第二个 job。
export async function dispatchExplicitCloudUpload(input: {
  accessToken: string
  body: ReturnType<typeof createExplicitUploadRequest>
  uploadConsent?: string
}): Promise<CloudResult<CloudDispatchResult>> {
  try {
    const base = cloudBase()
    if (!base) return { error: "no-cloud-endpoint" }
    const response = await fetchWithBoundedRetry(
      () =>
        fetch(`${base}${ALPHA_PATHS.cloudJobs}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${input.accessToken}`,
            "content-type": "application/json",
            ...(input.uploadConsent ? { "x-alpha-upload-consent": input.uploadConsent } : {}),
          },
          body: JSON.stringify(input.body),
          signal: AbortSignal.timeout(15000),
        }),
      DISPATCH_MAX_ATTEMPTS,
    )
    if (response.status === 401) return { error: "unauthorized" }
    // [#940] 上传路径恰恰最容易撞上分类拒绝(upload_reserved_input / consent 类)——
    // 与 authed() 同一咽喉,绝不压成裸数字。
    if (!response.ok) return { error: await httpErrorCode(response) }
    return decodeJsonContract("CloudJobAcceptedV1", await response.text(), "cloud-http")
  } catch (error) {
    if (isContractIncompatibleError(error)) {
      reportContractFailure(error)
      return { error: "contract-incompatible" }
    }
    getLogger().warn("alpha-cloud-jobs: explicit upload failed code=network")
    return { error: "network" }
  }
}

export const getCloudJobStatus = (jobId: string): Promise<CloudResult<CloudJobStatus>> =>
  authed(
    `${ALPHA_PATHS.cloudJobs}/${encodeURIComponent(jobId)}`,
    "cloud.read",
    undefined,
    (text) => decodeJsonContract("CloudJobStatusV1", text, "cloud-http"),
  )

// 取消 job。#400 / platform#255:响应是版本化的 CloudJobCancelResultV1 —— 服务端可判定结果
// (accepted + 当前 status,可能是 `cancelling` 中间态),经严格 decode 才回 renderer;裸 JSON.parse
// 正是「乐观状态覆盖」那条被票面禁掉的路。旧的无版本 `{job_id,status}` 形状在这里 fail closed
// 成 contract-incompatible,不设兼容分支。
export const cancelCloudJob = (jobId: string): Promise<CloudResult<CloudJobCancelResult>> =>
  authed(
    `${ALPHA_PATHS.cloudJobs}/${encodeURIComponent(jobId)}/cancel`,
    "cloud.dispatch",
    { method: "POST" },
    (text) => decodeJsonContract("CloudJobCancelResultV1", text, "cloud-http"),
  )

// #727:artifact 列表端点要求的 action 是 artifact.read,不是 cloud.read
// (alpha-platform packages/gateway/src/routes/cloud-jobs.ts 的 `/artifacts` 路由)。
// 判权是 `claims.purpose !== request.action → 403`,而 token 按 purpose 分张签发 ⇒
// 拿 cloud.read 那张来列产物,是每个有效登录用户都吃的结构性 403,不是权益不足。
// 内容字节仍走 downloadCloudArtifactTo 的独立传输契约(同样 artifact.read)。
export const listCloudArtifacts = (jobId: string): Promise<CloudResult<CloudArtifactList>> =>
  authed(
    `${ALPHA_PATHS.cloudJobs}/${encodeURIComponent(jobId)}/artifacts`,
    "artifact.read",
    undefined,
    (text) => decodeJsonContract("ArtifactListV1", text, "artifact"),
  )

// REQ-092:artifact 内容唯一入口 —— pinned descriptor.contentRef 流式下载到磁盘
// (bearer 仅 main,renderer 零字节);legacy inline metadata and fallback are rejected.
// 失败只回分类码 + 净化 detail;此处日志也只落分类码(token 卫生,REQ-092 AC#5)。
export async function downloadCloudArtifactTo(
  req: ArtifactDownloadRequest,
  finalize: ArtifactFinalizer,
): Promise<ArtifactDownloadOutcome> {
  let token: string | undefined
  try {
    token = getAccessToken("artifact.read")
  } catch {
    return { ok: false, error: "contract-incompatible" }
  }
  if (!token) return { ok: false, error: "not-authenticated" }
  const base = cloudBase()
  if (!base) return { ok: false, error: "no-cloud-endpoint" }
  const outcome = await downloadArtifactToFile(req, { token, base, finalize })
  if (!outcome.ok && outcome.error !== "cancelled") {
    getLogger().warn(`alpha-cloud-jobs: artifact download failed (${outcome.error})`)
  }
  return outcome
}
