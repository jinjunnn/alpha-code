// alpha platform live model catalog (ADR-016 阶段三 step 17)。MAIN-ONLY。
// B 的 gateway `/v1/models` 是模型 allowlist 的**真相源**;此处按需拉取给渲染层的模型选择器,
// 解 `alpha-models.json` 静态 `platformModels` 与 B live 目录漂移的占位问题。
// 注:fork-time 的 buildAlphaModelConfig 仍用静态 JSON 作默认(fork 不阻塞网络 / B 不可达也能起);
//     此 live 拉取供 UI 展示 + 校验(哪些 model 当前真的可用)。全量动态注入 = 后续。
import { resolveEndpoints } from "./alpha-endpoints"
import { getAccessToken } from "./alpha-auth"
import { getLogger } from "./logging"
import { ALPHA_PATHS } from "../shared/alpha-config"
import type { CloudResult, PlatformLiveModel } from "../preload/types"

export async function fetchPlatformModels(): Promise<CloudResult<{ models: PlatformLiveModel[] }>> {
  const base = resolveEndpoints().platform
  if (!base) return { error: "no-platform-endpoint" }
  const token = getAccessToken() // /v1/models 不强制鉴权,但持登录态时一并带上(一致)
  try {
    const res = await fetch(`${base}${ALPHA_PATHS.models}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(8000),
    })
    if (res.status === 401) return { error: "unauthorized" }
    if (!res.ok) return { error: `http-${res.status}` }
    const j = (await res.json()) as { data?: Array<{ id: string; provider?: string; minPlan?: string }> }
    return { models: (j.data ?? []).map((m) => ({ id: m.id, provider: m.provider, minPlan: m.minPlan })) }
  } catch (error) {
    getLogger().warn("alpha-platform-models: fetch failed", error)
    return { error: "network" }
  }
}
