// alpha platform live model catalog(REQ-001 接管,原 ADR-016 阶段三 step 17 占位)。MAIN-ONLY。
// B 的 gateway `/v1/models` 是**平台代理模型清单 + 其计价倍数**的权威源(edition-scoped:cn/intl
// 双版本显隐)。REQ-127 #681 / ADR-039 起,这条路径**只解码 ModelCatalogV2**:URL 里的 `v1` 是
// HTTP namespace,不是 payload 代际;同一个用户可见 flow 里只存在一代目录,不双读、不回退 V1。
//
// 三个职责:
//   1. fetchPlatformModels —— 拉网关目录(edition + 平台模型清单 + basis + 逐行双倍数);
//   2. syncLiveAllowlist —— 成功后写 <userData>/alpha-live-models.json 的 catalog LKG
//      (严格 V2:basis 非空 + 每行可信 pair + 清单非空;文件桥,fork 期 sidecar 的
//      buildAlphaModelConfig 与本模块的 effective catalog 共同消费);失败保留 last-known,不清缓存;
//   3. getEffectiveCatalog —— picker 的目录视图:平台段经**唯一投影**装配 + liveSync 来源标注
//      (live/cache/static,降级提示 B20;picker 永不空白)。
//
// 刷新点只有两处:启动(main/index.ts,fire-and-forget)与登录后 respawn 前。**picker 打开不刷新** ——
// 那是既存缺陷,本模块不假装它已修好(见 models-ipc.ts 抬头对「为什么不加后台刷新」的记录)。
//
// REQ-109 #595(owner 裁决 2026-07-24):**BYOK 段不再受平台任何干预**。网关 wire 的
// `byok_providers` 撤销后没有任何策略消费方,本模块不再解码、缓存、记录或传递它;BYOK 目录只由本地
// alpha-models.json 决定。失败域也随之隔离:平台目录契约不兼容经 reportContractFailure 独立上报
// (renderer Banner 的 a-contract-failure 面),**不得**再让 models-catalog IPC 整体失败 ——
// 那会连本地 BYOK 一起阵亡。契约:docs/contracts/byok-availability.md。
import { resolveEndpoints } from "./alpha-endpoints"
import { httpErrorCode } from "./platform-error-code"
import { ContractIncompatibleError, decodeJsonContract, isContractIncompatibleError } from "@alpha-code/contracts-consumer"
import { getAccessToken } from "./alpha-auth"
import { getLogger } from "./logging"
import { ALPHA_PATHS } from "../shared/alpha-config"
import type { CloudResult, PlatformLiveModel } from "../preload/types"
import type { EffectiveCatalog } from "../shared/alpha-model-types"
import { getModelCatalog } from "./alpha-models"
import { isTrustedPair, projectPlatformModels, readCatalogSnapshot, writeCatalogSnapshot } from "./alpha-live-allowlist"
import { reportContractFailure } from "./alpha-contract-health"

export type PlatformModelsResult = CloudResult<{
  models: PlatformLiveModel[]
  edition?: string
  /** 倍数相对的基准模型 id(平台下发的单位定义;客户端不硬编码、不校验它等于某个具体模型)。 */
  pricingBasisModelId: string
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
    // [#940] 平台拒绝经唯一咽喉:分类码优先,无码保持 http-<status>。
    if (!res.ok) return { error: await httpErrorCode(res) }
    const j = decodeJsonContract("ModelCatalogV2", await res.text(), "model-catalog")
    // JSON Schema 表达不了的三条语义。任一不过 ⇒ **整份拒绝**,绝不逐行降级成「这几行没价格」——
    // 半真目录正是 ADR-039 §2 要消灭的东西。走的是既有 catch,所以失败仍只损失平台段。
    if (!j.pricing_basis_model_id || j.data.length === 0 || !j.data.every((m) => isTrustedPair(m.pricing_multiplier))) {
      throw new ContractIncompatibleError({
        surface: "model-catalog",
        expected_version: 2,
        received_version: j.schema_version,
        reason: "schema-validation",
      })
    }
    return {
      models: j.data.map((model) => ({
        id: model.id,
        provider: model.provider,
        minPlan: model.min_plan,
        pricing: { input: model.pricing_multiplier.input, output: model.pricing_multiplier.output },
      })),
      edition: j.edition,
      pricingBasisModelId: j.pricing_basis_model_id,
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

/** 拉网关目录并同步到本地 catalog LKG(成功才写;失败保留 last-known,fail-open),返回拉取结果本身。
 *  调用点:启动(fire-and-forget,不阻塞窗口,B1 纪律)、登录后 respawn 前。 */
let syncedThisSession = false
export async function syncLiveAllowlist(userDataPath: string): Promise<PlatformModelsResult> {
  const r = await fetchPlatformModels()
  if ("error" in r) return r
  try {
    // writeCatalogSnapshot 再校验一次同一份判据后才落盘 —— 写侧与读侧共用一个校验函数,
    // 「什么算有效缓存」在本仓只有一份定义。
    const written = writeCatalogSnapshot(userDataPath, {
      fetchedAt: new Date().toISOString(),
      edition: r.edition,
      pricingBasisModelId: r.pricingBasisModelId,
      models: r.models.map((m) => ({ id: m.id, provider: m.provider, minPlan: m.minPlan, pricing: m.pricing })),
    })
    if (!written) {
      getLogger().warn("alpha-platform-models: refusing to overwrite last-known-good with an invalid snapshot")
      return r
    }
    syncedThisSession = true
    getLogger().log("alpha-platform-models: catalog snapshot synced", {
      edition: r.edition,
      models: r.models.length,
      pricingBasisModelId: r.pricingBasisModelId,
    })
  } catch (error) {
    getLogger().warn("alpha-platform-models: cache write failed", error)
  }
  return r
}

/** picker 的目录视图(models-catalog IPC):**平台段**走与 sidecar 同一份投影;快照缺失/无效 →
 *  原样内置 snapshot 且平台段无价格(static)。BYOK 段原样透出(#595:平台不得远程干预)。
 *  本函数不引用任何平台拉取的失败状态 —— 平台侧的网络失败与契约不兼容都只损失平台段的新鲜度,
 *  绝不阻断本地目录返回。 */
export function getEffectiveCatalog(userDataPath: string): EffectiveCatalog {
  const cat = getModelCatalog()
  const snapshot = readCatalogSnapshot(userDataPath)
  // 内置 BYOK 目录:原样透出。#595 撤销了 edition 白名单收窄 —— BYOK 走全主权,本地目录即权威。
  return {
    ...cat,
    platformModels: projectPlatformModels(cat.platformModels, snapshot),
    pricingBasisModelId: snapshot?.pricingBasisModelId ?? null,
    liveSync: snapshot
      ? { status: syncedThisSession ? "live" : "cache", fetchedAt: snapshot.fetchedAt, edition: snapshot.edition }
      : { status: "static" },
  }
}
