import type { ModelRef, ModelV2Info, createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { ALPHA_V2_CATALOG_READY_PROVIDER_ID } from "../../shared/alpha-config"
import { subscribeCatalogUpdated } from "../runtime-recovery"
import { ENGINE_FETCH_TIMEOUT_MS } from "./model-picker-logic"

type Client = ReturnType<typeof createOpencodeClient>

type ModelContractOptions = {
  catalogReadyPollMs?: number
  wait?: (delayMs: number, signal?: AbortSignal) => Promise<void>
}

/**
 * #882:目录就绪的**兜底**轮询间隔。主路径是 `catalog.updated` 唤醒后立刻重探;这一条只在
 * 事件到不了时接住 —— 在 renderer 订阅 `/global/event` 之前就已收敛的 directory 再也不会
 * 发事件(实跑记录见 docs/architecture/2026-08-10-catalog-readiness-signals.md),事件唯一化
 * 就是新的死信道。
 *
 * 从 10ms 放宽到 250ms:首启收敛实测约 16s,10ms 一档意味着约 1600 次进程内 HTTP —— 兜底
 * 自己会拖慢它要观测的那件事(#881 归因面)。报数时事件路径与兜底路径必须分开说,不能混成
 * 一个 P95:事件路径的「事件到达 → 请求发起」是 0 个计时器 tick,兜底路径最坏是一个周期。
 */
const CATALOG_READY_POLL_MS = 250

const wait = (delayMs: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal?.reason)
      return
    }
    const timer = setTimeout(done, delayMs)
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      reject(signal?.reason)
    }
    function done() {
      signal?.removeEventListener("abort", abort)
      resolve()
    }
    signal?.addEventListener("abort", abort, { once: true })
  })

export class ModelContractError extends Error {
  constructor(
    readonly operation: "list" | "get" | "switch",
    readonly cause?: unknown,
  ) {
    super(`model contract ${operation} failed`)
    this.name = "ModelContractError"
  }
}

/** 单次网络往返的悬挂防御(2026-07-12 复验盲区)。屏障的**等待**不受它约束,只有请求受。 */
const requestBudget = (signal?: AbortSignal) => {
  const budget = AbortSignal.timeout(ENGINE_FETCH_TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, budget]) : budget
}

/** The renderer-facing model contract. All calls go through the generated SDK v2 Model.Ref API. */
export function createModelContract(sdk: () => Client | undefined, options: ModelContractOptions = {}) {
  const catalogReadyPollMs = options.catalogReadyPollMs ?? CATALOG_READY_POLL_MS
  const waitForNextProbe = options.wait ?? wait

  /**
   * 目录就绪屏障。#857 的保证一字不动:marker 探针是**唯一**的就绪证明,绕过它会把未治理的
   * 中间集(6,132 行)当成首屏目录返回。
   *
   * #882 改的是**等待方式**。旧实现给屏障配了一个 1.5s 的独立 deadline,超时就把「目录还没
   * 收敛」当成一次**请求失败**抛出去,交给通用的 1/2/4/8s 指数退避 —— 而退避窗口内一个探针
   * 都不发。真机实测:sidecar ready 在 1913ms、四次探测全部在 1501ms 整点自超时、最终成功
   * 那次只用了 5.1ms。等待方与被等待方之间没有任何信号,全靠固定计时器猜。
   *
   * 现在等待由引擎既有的 `catalog.updated` 唤醒(经 /global/event → use-projects →
   * notifyCatalogUpdated),事件到达即重探,兜底轮询只在事件到不了时接住。退出条件只剩两个:
   * marker 答了,或调用方取消 —— 屏障自己不再制造失败,也就不再喂退避。
   */
  const waitForCatalogReady = async (client: Client, directory: string, signal?: AbortSignal) => {
    while (true) {
      if (signal?.aborted) throw new ModelContractError("list", signal.reason)
      // 先武装唤醒、再发探针:提交若落在探针在途期间,事件不能丢 —— 否则屏障会白等一个兜底
      // 周期。实测事件与就绪之间只隔几毫秒,这一格丢不起。
      let landed = false
      let wake: (() => void) | undefined
      const unsubscribe = subscribeCatalogUpdated(directory, () => {
        landed = true
        wake?.()
      })
      try {
        try {
          const result = await client.v2.provider.get(
            { providerID: ALPHA_V2_CATALOG_READY_PROVIDER_ID, location: { directory } },
            { signal: requestBudget(signal) },
          )
          // The generated client returns fetch aborts as `{ error }` when throwOnError is false.
          // Preserve the caller's request-abort classification before anything else.
          if (signal?.aborted) throw new ModelContractError("list", signal.reason)
          if (!result.error && result.data?.data.id === ALPHA_V2_CATALOG_READY_PROVIDER_ID) return
        } catch (error) {
          if (signal?.aborted) throw new ModelContractError("list", signal.reason)
          if (error instanceof ModelContractError) throw error
          // 探针失败或悬挂都不是终态 —— 它说明目录还没收敛,继续等下一次唤醒。
        }
        if (landed) continue
        const woken = new Promise<void>((resolve) => {
          wake = resolve
        })
        const fallback = waitForNextProbe(catalogReadyPollMs, signal)
        // 事件先到时,兜底定时器仍可能在之后因 abort 而拒绝 —— 先接住,避免未处理拒绝。
        fallback.catch(() => {})
        await Promise.race([woken, fallback])
      } catch (error) {
        if (signal?.aborted && !(error instanceof ModelContractError))
          throw new ModelContractError("list", signal.reason)
        throw error
      } finally {
        unsubscribe()
      }
    }
  }

  return {
    async list(directory: string, signal?: AbortSignal): Promise<ModelV2Info[]> {
      const client = sdk()
      if (!client) throw new ModelContractError("list")
      // #857:PluginInternal boots per directory in a background fiber. A first model.list could
      // serialize the 6,132-model models.dev intermediate state before Alpha's config transforms
      // committed, then settle to 37 models on the hot path. The injected, unavailable provider
      // marker appears only in that same local batched commit, so this probe prevents the oversized
      // first response without waiting on account summary, bearer state, or any remote service.
      await waitForCatalogReady(client, directory, signal)
      // #882:请求预算与就绪屏障是两件事,不能共用一个 signal。屏障等的是「目录还没收敛」
      // (冷启动实测十几秒,那不是故障);请求等的是「引擎该答了」(悬挂防御)。旧实现让调用方
      // 的 10s 预算同时管住两者 —— 那正是本票的数据模型病灶,别在别处复制它。
      const result = await client.v2.model
        .list({ location: { directory } }, { signal: requestBudget(signal) })
        .catch((cause) => {
          throw new ModelContractError("list", cause)
        })
      if (result.error || !result.data) throw new ModelContractError("list", result.error)
      return result.data.data
    },

    async current(sessionID: string): Promise<ModelRef | undefined> {
      const client = sdk()
      if (!client) throw new ModelContractError("get")
      const result = await client.v2.session.get({ sessionID }).catch((cause) => {
        throw new ModelContractError("get", cause)
      })
      if (result.error || !result.data) throw new ModelContractError("get", result.error)
      return result.data.data.model
    },

    async switch(sessionID: string, model: ModelRef): Promise<void> {
      const client = sdk()
      if (!client) throw new ModelContractError("switch")
      const result = await client.v2.session.switchModel({ sessionID, model }).catch((cause) => {
        throw new ModelContractError("switch", cause)
      })
      if (result.error) throw new ModelContractError("switch", result.error)
    },
  }
}

export type ModelContract = ReturnType<typeof createModelContract>
