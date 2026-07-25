// alpha platform live model catalog(REQ-001 接管,原 ADR-016 阶段三 step 17 占位)。MAIN-ONLY。
// B 的 gateway `/v1/models` 是**平台代理模型清单**的权威源(edition-scoped:cn/intl 双版本显隐)。
// 三个职责:
//   1. fetchPlatformModels —— 拉网关目录(edition + 平台模型清单);
//   2. syncLiveAllowlist —— 成功后写 <userData>/alpha-live-models.json(文件桥,fork 期 sidecar 的
//      buildAlphaModelConfig 与本模块的 effective catalog 共同消费);失败保留 last-known,不清缓存;
//   3. getEffectiveCatalog —— picker 的目录视图:内置 snapshot 的平台段按缓存收窄/富化 + liveSync
//      来源标注(live/cache/static,降级提示 B20;picker 永不空白)。
//
// REQ-109 #595(owner 裁决 2026-07-24):**BYOK 段不再受平台任何干预**。网关 wire 的
// `byok_providers` 撤销后没有任何策略消费方,本模块不再解码、缓存、记录或传递它;BYOK 目录只由本地
// alpha-models.json 决定。失败域也随之隔离:平台目录契约不兼容经 reportContractFailure 独立上报
// (renderer Banner 的 a-contract-failure 面),**不得**再让 models-catalog IPC 整体失败 ——
// 那会连本地 BYOK 一起阵亡。契约:docs/contracts/byok-availability.md。
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
}>

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
    return {
      models: j.data.map((model) => ({ id: model.id, provider: model.provider, minPlan: model.min_plan })),
      edition: j.edition,
    }
  } catch (error) {
    if (isContractIncompatibleError(error)) {
      // 上报走独立通道(alpha-contract-health → renderer Banner);目录读取路径不受影响。
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
      models: r.models,
    })
    syncedThisSession = true
    getLogger().log("alpha-platform-models: allowlist synced", {
      edition: r.edition,
      models: r.models.length,
    })
  } catch (error) {
    getLogger().warn("alpha-platform-models: cache write failed", error)
  }
  return r
}

/** picker 的目录视图(models-catalog IPC):**平台段**按缓存清单收窄/富化;缓存缺失 → 原样 snapshot
 *  (static)。BYOK 段原样透出(#595:平台不得远程干预)。本函数不引用任何平台拉取的失败状态 ——
 *  平台侧的网络失败与契约不兼容都只损失平台段的新鲜度,绝不阻断本地目录返回。 */
export function getEffectiveCatalog(userDataPath: string): EffectiveCatalog {
  const cat = getModelCatalog()
  const live = readLiveAllowlist(userDataPath)
  if (!live) return { ...cat, liveSync: { status: "static" } }

  // 平台模型:live 清单为准(真实 registry id);已知 id 用 snapshot 的展示元数据富化,未知 id 诚实降级为 id 本名。
  const byId = new Map(cat.platformModels.map((m) => [m.id, m]))
  const platformModels: PlatformModel[] = live.models.map(
    (m) => byId.get(m.id) ?? { id: m.id, name: m.id, tier: "std" as const },
  )
  // 内置 BYOK 目录:原样透出。#595 撤销了 edition 白名单收窄 —— BYOK 走全主权,本地目录即权威。
  return {
    ...cat,
    platformModels,
    liveSync: { status: syncedThisSession ? "live" : "cache", fetchedAt: live.fetchedAt, edition: live.edition },
  }
}
