import type { ModelRef, ModelV2Info, createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { ALPHA_V2_CATALOG_READY_PROVIDER_ID } from "../../shared/alpha-config"
import { subscribeCatalogUpdated } from "../runtime-recovery"
import { ENGINE_FETCH_TIMEOUT_MS } from "./model-picker-logic"

type Client = ReturnType<typeof createOpencodeClient>

/**
 * #881:目录**真就绪时刻**在系统里的表示。
 *
 * 在此之前它没有表示 —— 最接近的载体 `renderer.home.model_list.end.durationMs` 把三个成因
 * 不同的量压成一个标量:①屏障等待(打包首启实测十几秒,那不是故障)、②唤醒来自事件还是
 * 250ms 兜底(死信道的唯一判别轴)、③随后的 `v2.model.list` 网络往返(热路径 5–50ms)。
 * 归因需要的分项在那个标量下**结构上产不出来**。
 */
export type CatalogReadyFact = {
  /** 屏障自己的等待:进入屏障 → marker 首次答 200。**不含**随后的 `v2.model.list` 往返。 */
  barrierMs: number
  /** marker 探针发出的轮数,含就绪那一轮。恒 ≥ 1。 */
  probes: number
  /** 走满一个兜底轮询周期的次数。事件路径恒为 0 —— 这是死信道的判别轴。 */
  pollWaits: number
  /**
   * #1083:**没在单探针期限内答上来**的探针轮数。恒 ≥ 0,健康路径恒为 0。
   *
   * 它是 #1080 那条尾巴在系统里的表示:那 6 个样本里每一条失败链都只发了 1 轮探针就被掀掉,
   * 而屏障对「这一轮没答」的既定反应本该是换一轮重探。分项存在之前,这件事在证据里只表现为
   * 一个 `outcome:"error:request"` + `durationMs≈10002`,与「引擎真的答了个 503」同形。
   */
  probeTimeouts: number
  /** 让**就绪那一轮**探针得以发出的唤醒来源。 */
  wake: "first" | "event" | "poll" | "timeout"
}

type ModelContractOptions = {
  catalogReadyPollMs?: number
  /** #1083:单探针期限。生产用 `CATALOG_READY_PROBE_TIMEOUT_MS`;用例调小以确定性地驱动到期分支。 */
  probeTimeoutMs?: number
  now?: () => number
  wait?: (delayMs: number, signal?: AbortSignal) => Promise<void>
  /**
   * #881:就绪时刻的**汇总**上报。刻意不是「每轮探针一条」—— 首启收敛实测约 16s,250ms 一档
   * 就是约 64 条标,每条都过 IPC + sanitize + 落盘,观测自己会污染要归因的那段。一条汇总标
   * 加三个计数已经够拆分项。
   *
   * 发标通道由调用方注入,contract 不 import renderer 的 `startup-timeline`(它读 `window.api`,
   * 静态 import 会把本模块的组件测试整文件拖进 server 构建 —— 本仓点名过的形态)。
   */
  onCatalogReady?: (fact: CatalogReadyFact) => void
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
export const CATALOG_READY_POLL_MS = 250

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

/**
 * #1083:屏障自己的**单探针**期限 —— 与 `ENGINE_FETCH_TIMEOUT_MS` 是两件事,别再共用一个。
 *
 * `ENGINE_FETCH_TIMEOUT_MS`(10s)是**链级**的悬挂防御:到期 = 这次取数失败 = 掀掉整条链、
 * 交给 1/2/4/8s 退避。屏障借用它是个类别错误 —— 屏障是个**轮询循环**,它对「这一轮没答」的
 * 既定反应(#882)是换一轮重探,而不是判引擎坏了。
 *
 * #1080 的尾巴就是这个错误的样子(`docs/verification/2026-08-23-req109-1080-post1056-catalog-p95/`):
 * 6/26 个样本里,首轮 marker 探针没答上来,10s 预算到期 → `outcome:"error:request"` → 退避 1s →
 * 整条链重来 → 首轮探针再没答 → …。每条失败链的 `catalog_ready` 一条都没有,即**屏障一次都
 * 没走到它自己的第二轮探针**:一个 250ms 的轮询循环被一个 10s 的链级预算按死在第一轮。
 * 而同一次启动里,sidecar 早在 ~897ms 就对**同一个目录**(`alphaUserWorkspaceDir()`)prewarm
 * 到了 `outcome:"ready" / status:200` —— 目录当时**已经收敛**,链却在退避里空转了 18.7–42.5s。
 *
 * 取值纪律(单测钉住):必须 > 兜底轮询档位(否则期限会抢在设计好的轮询节奏前面),必须 <
 * `ENGINE_FETCH_TIMEOUT_MS`(否则探针又能走到链级预算,等于这条改动没发生)。abort 顺带关掉
 * 底层连接,不让 Chromium 连接池继续复用一条死套接字(与 `ENGINE_FETCH_TIMEOUT_MS` 同款理由)。
 */
export const CATALOG_READY_PROBE_TIMEOUT_MS = 1_000

/** 屏障探针的取消面:调用方 signal + 本轮重探取消 + 本轮期限。**不含**链级预算(见上)。 */
const anySignal = (...signals: Array<AbortSignal | undefined>) => {
  const present = signals.filter((candidate): candidate is AbortSignal => candidate !== undefined)
  return present.length === 1 ? present[0]! : AbortSignal.any(present)
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
 * 判据来自实跑,不是推断(bun 起真 HTTP 服务 + 生成客户端走
 * `packages/sdk/js/src/v2/gen/client/client.gen.ts` 的 result-tuple 路径,`throwOnError` 未开):
 * ①fetch 的拒绝被**原样**回成 `{ error, response: undefined }`(`wrapClientError` 只在
 * `throwOnError` 时才介入);②`AbortSignal.any` 保留 abort reason 的**对象身份**,`requestBudget`
 * 合成出来的 signal 其 `reason` 就是 `round.reason` 本身;③我们的 `round.abort()` 不带 reason,
 * 平台因此自造一个 `name === "AbortError"` 的 `DOMException`。三条合起来:「我们自己取消的那次
 * 失败」在这里的形状恒为一个 `AbortError`,且必须发生在 `round.aborted` 之后 —— 没取消过,就
 * 不存在「自己取消」这回事。
 *
 * 落不进来的:401/503(引擎真的答了,body 是 `_tag` 形状的 POJO)、网络错(`TypeError`)。它们
 * 照旧抛 `ModelContractError`,**哪怕 `catalog.updated` 恰好在同一轮到达** —— 那正是 R2 点名的
 * 那条窄竞态。判错时的方向也是安全的那一侧:多抛一次 = 恢复链多重试一次,不是永久 loading。
 *
 * #1083:屏障自己的单探针期限**不走这条判据** —— 它由调用点直接看 `deadline.signal.aborted`
 * 判定。理由同上:abort reason 的名字不是身份,`AbortSignal.any` 合成之后更分不清是谁点的火;
 * 谁点的火只有点火的人知道,所以那个 controller 由屏障自己持有。
 */
const cancelledByUs = (error: unknown, round: AbortSignal) =>
  round.aborted && typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"

/** The renderer-facing model contract. All calls go through the generated SDK v2 Model.Ref API. */
export function createModelContract(sdk: () => Client | undefined, options: ModelContractOptions = {}) {
  const catalogReadyPollMs = options.catalogReadyPollMs ?? CATALOG_READY_POLL_MS
  const probeTimeoutMs = options.probeTimeoutMs ?? CATALOG_READY_PROBE_TIMEOUT_MS
  const waitForNextProbe = options.wait ?? wait
  const now = options.now ?? (() => performance.now())
  const onCatalogReady = options.onCatalogReady

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
   * 404 / `ProviderNotFoundError` 算未收敛(见 `catalogNotReady`),401/503/网络错
   * 照旧抛 `ModelContractError`,走既有的 recovering + 1/2/4/8s 恢复链。退出条件三个:
   * marker 答了、探针给出真实故障、或调用方取消。
   *
   * #1083 改的是**第四种情形**:探针**根本没答**。它以前借链级的 `ENGINE_FETCH_TIMEOUT_MS`
   * (10s)当期限,到期被算作请求失败 —— 于是一轮不答就掀掉整条链。现在屏障有自己的单探针
   * 期限(`CATALOG_READY_PROBE_TIMEOUT_MS`),到期只是「这一轮没答」:计一次 `probeTimeouts`、
   * 换一轮重探。**没答不是回答**,不能拿它冒充引擎的故障判决。
   */
  const waitForCatalogReady = async (client: Client, directory: string, signal?: AbortSignal) => {
    // #881:分项计数。屏障是**唯一**知道这些事实的位置(就绪时刻、探针轮数、唤醒来源),
    // 此前它们在这里被原地丢弃,只 `return`。
    const startedAt = now()
    let probes = 0
    let pollWaits = 0
    let probeTimeouts = 0
    let wakeSource: CatalogReadyFact["wake"] = "first"
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
      // #1083:屏障自己的单探针期限。它与 `round`(事件到达时的重探取消)是两个独立来源,
      // 判决时必须分得开 —— 所以用一个我们自己持有的 controller,而不是去认 abort reason
      // 的名字(`AbortError` / `TimeoutError` 那套在这里正是判错的来源)。
      const deadline = new AbortController()
      const deadlineTimer = setTimeout(() => deadline.abort(), probeTimeoutMs)
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
          probes++
          const result = await client.v2.provider.get(
            { providerID: ALPHA_V2_CATALOG_READY_PROVIDER_ID, location: { directory } },
            // #1083:**不含** `ENGINE_FETCH_TIMEOUT_MS`。那是链级预算,到期即整条链失败;
            // 屏障要的是「这一轮没答就换一轮」,两者不是同一件事。
            { signal: anySignal(signal, round.signal, deadline.signal) },
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
        if (ready) {
          // #881:就绪时刻**只在真就绪时**发一次。放进 finally / 无条件发,等于拿「发起时刻」
          // 或「取消时刻」冒充就绪 —— 那正是本票要消灭的「客户端计时器冒充被测方答复」。
          try {
            onCatalogReady?.({ barrierMs: now() - startedAt, probes, pollWaits, probeTimeouts, wake: wakeSource })
          } catch {
            // 观测绝不扰动被观测对象:上报抛出不得把屏障变成一次失败(= 用户停在 recovering)。
          }
          return
        }
        // #882 R2:**真实失败先判,`landed` 后判**。反过来时,「引擎这一轮已经答了 503、而
        // `catalog.updated` 恰好同时到达」会被短路成「目录尚未收敛,继续等」——那份 503 既不
        // reject 也不进 recovering,而合同说只有 404/`ProviderNotFoundError` 算未就绪。
        if (failed && !cancelledByUs(failure, round.signal)) {
          // #1083:本轮探针没在**我们自己的**期限内答上来 —— 这不是引擎的回答,所以不是故障。
          // 换一轮重探(重新武装 `catalog.updated` 订阅 + 一条全新请求;abort 顺带关掉上一条
          // 可能已经死掉的连接)。把它当成一次请求失败,会掀掉整条链、交给 1/2/4/8s 退避,
          // 而退避窗口里一个探针都不发 —— #1080 的 6 个尾巴样本全部是这个形态:
          // 每条失败链的 `probes` 都停在 1,屏障一次都没走到它自己的第二轮。
          if (deadline.signal.aborted) {
            probeTimeouts++
            wakeSource = "timeout"
            continue
          }
          throw new ModelContractError("list", failure)
        }
        // 事件已落地(含「本轮探针正是被它取消的」那一支):立刻重探,不进等待,也不把这次
        // 主动中断当成故障 —— 取消是我们自己发的。
        if (landed) {
          wakeSource = "event"
          continue
        }
        const woken = new Promise<void>((resolve) => {
          wake = resolve
        })
        const fallback = waitForNextProbe(catalogReadyPollMs, signal)
        // 事件先到时,兜底定时器仍可能在之后因 abort 而拒绝 —— 先接住,避免未处理拒绝。
        fallback.catch(() => {})
        await Promise.race([woken, fallback])
        // `woken` 只由订阅回调解决,而那个回调解决它之前先置 `landed` ⇒ `landed` 就是「谁赢了这场
        // race」的判据。走满一个兜底周期才计入 `pollWaits`(#881 要分开报的那条轴)。
        wakeSource = landed ? "event" : "poll"
        if (!landed) pollWaits++
      } catch (error) {
        if (signal?.aborted && !(error instanceof ModelContractError))
          throw new ModelContractError("list", signal.reason)
        throw error
      } finally {
        clearTimeout(deadlineTimer)
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
