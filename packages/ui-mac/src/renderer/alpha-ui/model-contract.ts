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
const requestBudget = (...signals: Array<AbortSignal | undefined>) => {
  const budget = AbortSignal.timeout(ENGINE_FETCH_TIMEOUT_MS)
  const present = signals.filter((candidate): candidate is AbortSignal => candidate !== undefined)
  return present.length === 0 ? budget : AbortSignal.any([...present, budget])
}

/**
 * 引擎在 marker provider 尚未提交时的**真实**回答:HTTP `404`,body 是 `ProviderNotFoundError`
 * (`packages/server/src/handlers/provider.ts`;实跑记录见
 * `docs/architecture/2026-08-10-catalog-readiness-signals.md`,marker probe #1/#2 都是 404)。
 *
 * #882 R1 Major:屏障原本把**任何**失败都读成「目录尚未收敛」继续等 —— 401 / 503 / 网络错 /
 * 单次超时于是被吞成一个永不结束的等待:sidecar 仍被认为 ready,`list()` 永不 reject,
 * `alpha-composer.tsx` 一直 await ⇒ **用户永久停在 loading、发送禁用**,失败回调一次都不执行。
 * 那比本票原本要修的「20 秒后能用」更糟。只有这一种回答算「还没收敛」;其余一律抛出去,
 * 交给既有的 recovering + 1/2/4/8s 恢复链(`model-recovery.ts` 的 `loadEngineModelsWithRetry`)。
 *
 * 两条判别轴各自单独钉住(`model-contract.test.ts` 用两种夹具分别只带一条),否则删掉其中一半
 * 不会红 —— 本仓点名过的「闸门被替换掉一半也可以不红」。
 */
const catalogNotReady = (error: unknown, status: number | undefined) =>
  status === 404 ||
  (typeof error === "object" && error !== null && "_tag" in error && error._tag === "ProviderNotFoundError")

/**
 * 「本轮这次失败,是**我们自己**为了立刻重探而发的取消」——只有这一种失败不算故障。
 *
 * #882 R2:原实现用「`catalog.updated` 落地了」来代替这个判断,那是两件不同的事。事件落地
 * 是**事件到达**的事实,取消归属是**这次失败从哪来**的事实;把前者当后者用,同一轮里已经
 * 形成的真实 503 就会跟着走「目录尚未收敛,继续等」那条路被吞掉(审计用真实生成客户端复现:
 * `markerProbes=2`、首个 signal 已 abort,而 `list()` 最终 resolved,503 从未进 recovering)。
 *
 * 判据来自实跑,不是推断(`packages/sdk/js/src/v2/gen/client/client.gen.ts` 的 result-tuple
 * 路径,`throwOnError` 未开):fetch 的拒绝被**原样**回成 `{ error, response: undefined }`,
 * 而 `AbortSignal.any` 保留 abort reason 的**对象身份** ⇒ `error === round.reason`。身份是主
 * 判据;`name === "AbortError"` 是备判据(平台在 `abort()` 未带 reason 时自造的那一个)。两条
 * 都必须发生在 `round.aborted` 之后 —— 我们没取消过,就不存在「自己取消」这回事。
 *
 * 落不进来的:401/503(引擎真的答了,带 HTTP `response`)、网络错(`TypeError`)、单次往返
 * 预算到期(`TimeoutError`,名字不是 `AbortError`)。它们照旧抛 `ModelContractError`,**哪怕
 * `catalog.updated` 恰好在同一轮到达** —— 那正是 R2 点名的那条窄竞态。
 */
const cancelledByUs = (error: unknown, round: AbortSignal) =>
  round.aborted &&
  (error === round.reason ||
    (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"))

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
   * notifyCatalogUpdated),事件到达即取消在途探针并重探,兜底轮询只在事件到不了时接住。
   *
   * 屏障不再因为「目录还没收敛」制造失败,也就不再喂退避;但它**不吞真实故障** —— 只有
   * 404 / `ProviderNotFoundError` 算未收敛(见 `catalogNotReady`),401/503/网络错/单次超时
   * 照旧抛 `ModelContractError`,走既有的 recovering + 1/2/4/8s 恢复链。退出条件三个:
   * marker 答了、探针给出真实故障、或调用方取消。
   */
  const waitForCatalogReady = async (client: Client, directory: string, signal?: AbortSignal) => {
    while (true) {
      if (signal?.aborted) throw new ModelContractError("list", signal.reason)
      // 先武装唤醒、再发探针:提交若落在探针在途期间,事件不能丢 —— 否则屏障会白等一个兜底
      // 周期。实测事件与就绪之间只隔几毫秒,这一格丢不起。
      let landed = false
      let wake: (() => void) | undefined
      // #882 R1 Blocker:事件到达时**在飞的那次探针**必须当场被取消。只置 `landed` 不够 ——
      // 首探针悬挂时 `wake` 还没赋值(还没进 race),事件既叫不醒等待、也打不断请求,屏障只能
      // 挂到 10s 请求预算到期才发下一次。冷启动首探针恰恰是这个形态,所以那是主路径,不是边角。
      const round = new AbortController()
      const unsubscribe = subscribeCatalogUpdated(directory, () => {
        landed = true
        round.abort()
        wake?.()
      })
      try {
        let ready = false
        let failed = false
        let failure: unknown
        try {
          const result = await client.v2.provider.get(
            { providerID: ALPHA_V2_CATALOG_READY_PROVIDER_ID, location: { directory } },
            { signal: requestBudget(signal, round.signal) },
          )
          // The generated client returns fetch aborts as `{ error }` when throwOnError is false.
          // Preserve the caller's request-abort classification before anything else.
          if (signal?.aborted) throw new ModelContractError("list", signal.reason)
          if (!result.error && result.data?.data.id === ALPHA_V2_CATALOG_READY_PROVIDER_ID) ready = true
          else if (!catalogNotReady(result.error, result.response?.status)) {
            failed = true
            failure = result.error
          }
        } catch (error) {
          if (signal?.aborted) throw new ModelContractError("list", signal.reason)
          if (error instanceof ModelContractError) throw error
          failed = true
          failure = error
        }
        if (ready) return
        // #882 R2:**真实失败先判,`landed` 后判**。反过来时,「引擎这一轮已经答了 503、而
        // `catalog.updated` 恰好同时到达」会被短路成「目录尚未收敛,继续等」——那份 503 既不
        // reject 也不进 recovering,而合同说只有 404/`ProviderNotFoundError` 算未就绪。
        if (failed && !cancelledByUs(failure, round.signal)) throw new ModelContractError("list", failure)
        // 事件已落地(含「本轮探针正是被它取消的」那一支):立刻重探,不进等待,也不把这次
        // 主动中断当成故障 —— 取消是我们自己发的。
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
