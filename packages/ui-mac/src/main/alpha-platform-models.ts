// alpha platform live model catalog(REQ-001 接管,原 ADR-016 阶段三 step 17 占位)。MAIN-ONLY。
// B 的 gateway `/v1/models` 是模型 allowlist 的**权威源**(edition-scoped:cn/intl 双版本显隐)。
// 三个职责:
//   1. fetchPlatformModels —— 拉网关目录(REQ-001 起返回 edition + byok_providers);
//   2. syncLiveAllowlist —— 成功后写 <userData>/alpha-live-models.json(文件桥,fork 期 sidecar 的
//      buildAlphaModelConfig 与本模块的 effective catalog 共同消费);失败保留 last-known,不清缓存;
//   3. getEffectiveCatalog —— picker 的目录视图:内置 snapshot 按缓存收窄/富化 + liveSync 来源标注
//      (live/cache/static,降级提示 B20;picker 永不空白)。
import { resolveEndpoints } from "./alpha-endpoints"
import { decodeJsonContract, isContractIncompatibleError } from "@alpha-code/contracts-consumer"
import { getAccessToken } from "./alpha-auth"
import { getLogger } from "./logging"
import { ALPHA_PATHS } from "../shared/alpha-config"
import type { CloudResult, PlatformLiveModel } from "../preload/types"
import type { EffectiveCatalog, PlatformModel } from "../shared/alpha-model-types"
import { getModelCatalog } from "./alpha-models"
import { readLiveAllowlist, writeLiveAllowlist } from "./alpha-live-allowlist"
import { reportContractFailure } from "./alpha-contract-health"

export type PlatformModelsResult = CloudResult<{
  models: PlatformLiveModel[]
  edition?: string
  byokProviders: string[] | null
}>

let incompatibleCatalog: Error | null = null

export async function fetchPlatformModels(): Promise<PlatformModelsResult> {
  const base = resolveEndpoints().platform
  if (!base) return { error: "no-platform-endpoint" }
  try {
    const token = getAccessToken("model.invoke") // /v1/models 不强制鉴权;持登录态带上 → 网关按租户 edition 收窄
    const res = await fetch(`${base}${ALPHA_PATHS.models}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(8000),
    })
    if (res.status === 401) return { error: "unauthorized" }
    if (!res.ok) return { error: `http-${res.status}` }
    const j = decodeJsonContract("ModelCatalogV1", await res.text(), "model-catalog")
    incompatibleCatalog = null
    return {
      models: j.data.map((model) => ({ id: model.id, provider: model.provider, minPlan: model.min_plan })),
      edition: j.edition,
      byokProviders: j.byok_providers,
    }
  } catch (error) {
    if (isContractIncompatibleError(error)) {
      incompatibleCatalog = error
      reportContractFailure(error)
      return { error: "contract-incompatible" }
    }
    getLogger().warn("alpha-platform-models: fetch failed", error)
    return { error: "network" }
  }
}

/** 拉网关白名单并同步到本地缓存(成功才写;失败保留 last-known,fail-open),返回拉取结果本身。
 *  调用点:启动(fire-and-forget,不阻塞窗口,B1 纪律)、登录后 respawn 前、picker 打开(IPC)。 */
let syncedThisSession = false
export async function syncLiveAllowlist(userDataPath: string): Promise<PlatformModelsResult> {
  const r = await fetchPlatformModels()
  if ("error" in r) return r
  try {
    writeLiveAllowlist(userDataPath, {
      fetchedAt: new Date().toISOString(),
      edition: r.edition,
      byokProviders: r.byokProviders,
      models: r.models,
    })
    syncedThisSession = true
    getLogger().log("alpha-platform-models: allowlist synced", {
      edition: r.edition,
      models: r.models.length,
      byok: r.byokProviders === null ? "unrestricted" : r.byokProviders.length,
    })
  } catch (error) {
    getLogger().warn("alpha-platform-models: cache write failed", error)
  }
  return r
}

/** picker 的目录视图(models-catalog IPC):snapshot 按缓存白名单收窄;缓存缺失 → 原样 snapshot(static)。 */
export function getEffectiveCatalog(userDataPath: string): EffectiveCatalog {
  if (incompatibleCatalog) throw incompatibleCatalog
  const cat = getModelCatalog()
  const live = readLiveAllowlist(userDataPath)
  if (!live) return { ...cat, liveSync: { status: "static" } }

  // 平台模型:live 清单为准(真实 registry id);已知 id 用 snapshot 的展示元数据富化,未知 id 诚实降级为 id 本名。
  const byId = new Map(cat.platformModels.map((m) => [m.id, m]))
  const platformModels: PlatformModel[] = live.models.map(
    (m) => byId.get(m.id) ?? { id: m.id, name: m.id, tier: "std" as const },
  )
  // 内置 BYOK 目录:按 edition 白名单收窄(null=不限)。用户自定义节点不走此目录,天然不受影响(用户拍板)。
  const byokProviders =
    live.byokProviders === null ? cat.byokProviders : cat.byokProviders.filter((p) => live.byokProviders!.includes(p.id))

  return {
    ...cat,
    platformModels,
    byokProviders,
    liveSync: { status: syncedThisSession ? "live" : "cache", fetchedAt: live.fetchedAt, edition: live.edition },
  }
}
