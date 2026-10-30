// alpha platform live model catalog(REQ-001 接管,原 ADR-016 阶段三 step 17 占位)。MAIN-ONLY。
// B 的 gateway `/v1/models` 是**平台代理模型清单 + 其计价倍数**的权威源(edition-scoped:cn/intl
// 双版本显隐)。REQ-127 #681 / ADR-039 起,这条路径**只解码 ModelCatalogV2**:URL 里的 `v1` 是
// HTTP namespace,不是 payload 代际;同一个用户可见 flow 里只存在一代目录,不双读、不回退 V1。
//
// 三个职责:
//   1. fetchPlatformModels —— 拉网关目录(edition + 平台模型清单 + basis + 逐行双倍数);
//   2. syncLiveAllowlist —— 成功后写 <userData>/alpha-live-models.json 的 catalog LKG(已下载;
//      严格 V2:basis 非空 + 每行可信 pair + 清单非空);失败保留 last-known,不清缓存;
//   3. getEffectiveCatalog —— picker 的目录视图:平台段读 fork 前钉住的「已应用目录」(`#1555`,
//      与 sidecar 的 buildAlphaModelConfig 同一份)经**唯一投影**装配 + liveSync 来源标注
//      (live/cache/static,降级提示 B20;picker 永不空白),并带「已下载 / 已应用」两个版本。
//
// 刷新入口只有 catalog-refresher.ts 的 requestCatalogRefresh(启动 / 身份变化 / 30 分钟 / 手动),
// 单飞、永不被 respawn 或启动 await(`#1555`)。picker 的 models-catalog 读取不刷新。
//
// REQ-109 #595(owner 裁决 2026-07-24):**BYOK 段不再受平台任何干预**。网关 wire 的
// `byok_providers` 撤销后没有任何策略消费方,本模块不再解码、缓存、记录或传递它;BYOK 目录只由本地
// alpha-models.json 决定。失败域也随之隔离:平台目录契约不兼容经 reportContractFailure 独立上报
// (renderer Banner 的 a-contract-failure 面),**不得**再让 models-catalog IPC 整体失败 ——
// 那会连本地 BYOK 一起阵亡。契约:docs/contracts/byok-availability.md。
//
// #1084(#987 CHOICE=A / DECIDE #1078):syncLiveAllowlist 的**每一条**出路都经 reportCatalogRefresh
// 落到用户可观察出口(alpha-catalog-health → renderer Banner)。此前分类码只到函数返回值为止,
// 三个刷新入口没有一个消费它 —— 「失败处理」写得再好,用户永远看不到。
import { resolveEndpoints } from "./alpha-endpoints"
import { httpErrorCode } from "./platform-error-code"
import { ContractIncompatibleError, decodeJsonContract, isContractIncompatibleError } from "@alpha-code/contracts-consumer"
import { getAccessToken, getAuthIdentityTag } from "./alpha-auth"
import { getLogger } from "./logging"
import { ALPHA_PATHS } from "../shared/alpha-config"
import type { CloudResult, PlatformLiveModel } from "../preload/types"
import type { EffectiveCatalog } from "../shared/alpha-model-types"
import { getModelCatalog } from "./alpha-models"
import {
  isTrustedPair,
  projectPlatformModels,
  readAppliedPlatformSnapshot,
  readCatalogSnapshot,
  writeCatalogSnapshot,
} from "./alpha-live-allowlist"
import { reportContractFailure } from "./alpha-contract-health"
import { reportCatalogRefresh } from "./alpha-catalog-health"

export type PlatformModelsResult = CloudResult<{
  models: PlatformLiveModel[]
  edition?: string
  /** 倍数相对的基准模型 id(平台下发的单位定义;客户端不硬编码、不校验它等于某个具体模型)。 */
  pricingBasisModelId: string
}>

let refreshSequence = 0

export async function fetchPlatformModels(): Promise<PlatformModelsResult> {
  return fetchModels(1)
}

async function fetchModels(attempt: number): Promise<PlatformModelsResult> {
  const base = resolveEndpoints().platform
  if (!base) return { error: "no-platform-endpoint" }
  const url = new URL(`${base}${ALPHA_PATHS.models}`)
  const sequence = refreshSequence
  const identity = getAuthIdentityTag()
  const started = Date.now()
  let status: number | undefined
  let exception: string | undefined
  try {
    const token = getAccessToken("model.invoke") // /v1/models 不强制鉴权;持登录态带上 → 网关按租户 edition 收窄
    const res = await fetch(`${base}${ALPHA_PATHS.models}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(8000),
    })
    status = res.status
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
    exception = error instanceof Error ? error.name : "unknown"
    if (isContractIncompatibleError(error)) {
      // 上报走独立通道(alpha-contract-health → renderer Banner);目录读取路径不受影响。
      if (sequence === refreshSequence && identity === getAuthIdentityTag()) reportContractFailure(error)
      return { error: "contract-incompatible" }
    }
    return { error: exception === "TimeoutError" ? "timeout" : "network" }
  } finally {
    // 只记录完成字段;URL 查询、凭据和错误消息可能含秘密,不进入日志。
    getLogger().log("alpha-platform-models: request completed", {
      origin: url.origin,
      path: url.pathname,
      method: "GET",
      attempt,
      durationMs: Date.now() - started,
      ...(status === undefined ? {} : { status }),
      ...(exception === undefined ? {} : { exception }),
    })
  }
}

/** 一轮刷新:拉网关目录并同步到本地 catalog LKG(成功才写;失败保留 last-known,fail-open),返回本轮
 *  最后一次拉取的结果。唯一调用方是 catalog-refresher.ts(单飞)。首试最多 8 秒;timeout 约 1 秒后补试
 *  一次(补试也最多 8 秒),补试计入本轮 —— 返回的 Promise 覆盖整轮,刷新器据此保证同一时刻至多一个
 *  在途请求。新刷新或账号身份变化使旧轮失效,包括旧轮的写盘与契约/目录 health 上报。 */
let syncedThisSession = false
export async function syncLiveAllowlist(userDataPath: string): Promise<PlatformModelsResult> {
  const sequence = ++refreshSequence
  const identity = getAuthIdentityTag()
  const current = () => sequence === refreshSequence && identity === getAuthIdentityTag()
  const refresh = async (attempt: number) => {
    const r = await fetchModels(attempt)
    if (!current()) return r
    // #1084(#987 CHOICE=A):刷新结局在**这里**落到用户可观察出口 —— 刷新器的每个触发点共用本函数,
    // 所以调用点吞不掉分类码。成功走到末尾清空出口;下面每一条提前返回都必须先上报,否则那条路径又变回静默。
    if ("error" in r) {
      reportCatalogRefresh(r.error)
      return r
    }
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
        // 拉到了,但那份快照过不了落盘侧的同一份判据 ⇒ 用户看到的目录仍是旧的。这也是刷新失败。
        reportCatalogRefresh("snapshot-rejected")
        return r
      }
      syncedThisSession = true
      getLogger().log("alpha-platform-models: catalog snapshot synced", {
        edition: r.edition,
        models: r.models.length,
        pricingBasisModelId: r.pricingBasisModelId,
      })
      reportCatalogRefresh(null)
    } catch (error) {
      getLogger().warn("alpha-platform-models: cache write failed", error)
      reportCatalogRefresh("cache-write-failed")
    }
    return r
  }
  const r = await refresh(1)
  if ("error" in r && r.error === "timeout" && current()) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    if (current()) return refresh(2)
  }
  return r
}

/** picker 的目录视图(models-catalog IPC):**平台段**读 fork 前钉住的已应用目录、走与 sidecar 同一份
 *  投影;已应用快照缺失/无效 → 原样内置 snapshot 且平台段无价格(static)。刷新成功只改「已下载」,
 *  picker 在下一次引擎换代前仍显示已应用版本(`#1555` AC5)。BYOK 段原样透出(#595:平台不得远程干预)。
 *  本函数不引用任何平台拉取的失败状态 —— 平台侧的网络失败与契约不兼容都只损失平台段的新鲜度,
 *  绝不阻断本地目录返回。 */
export function getEffectiveCatalog(userDataPath: string): EffectiveCatalog {
  const cat = getModelCatalog()
  const snapshot = readAppliedPlatformSnapshot(userDataPath)
  // 「已下载」只取版本字段,不拿它拼目录(方案 I2)。BYOK 远程文档未上线前两边都是随包目录版本。
  const downloaded = readCatalogSnapshot(userDataPath)
  // 内置 BYOK 目录:原样透出。#595 撤销了 edition 白名单收窄 —— BYOK 走全主权,本地目录即权威。
  return {
    ...cat,
    platformModels: projectPlatformModels(cat.platformModels, snapshot),
    pricingBasisModelId: snapshot?.pricingBasisModelId ?? null,
    liveSync: snapshot
      ? { status: syncedThisSession ? "live" : "cache", fetchedAt: snapshot.fetchedAt, edition: snapshot.edition }
      : { status: "static" },
    applied: { platformFetchedAt: snapshot?.fetchedAt ?? null, byokVersion: cat.version },
    downloaded: { platformFetchedAt: downloaded?.fetchedAt ?? null, byokVersion: cat.version },
  }
}
