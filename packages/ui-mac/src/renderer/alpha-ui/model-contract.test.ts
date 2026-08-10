import { describe, expect, test } from "bun:test"
import type { ModelRef, ModelV2Info } from "@opencode-ai/sdk/v2/client"
import { ALPHA_V2_CATALOG_READY_PROVIDER_ID } from "../../shared/alpha-config"
// #882:唤醒信道用的是**生产接线**本体(runtime-recovery 的同一对函数),不是测试替身。
// 注入一个 subscribe 桩会让「删掉生产订阅仍全绿」重新成立 —— 那是本仓点名的第 ⑧ 类假闸门。
import { notifyCatalogUpdated } from "../runtime-recovery"
import { createModelContract, ModelContractError } from "./model-contract"
// #882 R1 Major:「503 走既有 recovering 链」不能自己拼一条等价链 —— 直接驱动生产的那个循环。
import { loadEngineModelsWithRetry } from "./model-recovery"

// 引擎在 marker 还没提交时的**真实**回答:HTTP 404 + body `ProviderNotFoundError`
//(packages/server/src/handlers/provider.ts;实跑记录见
// docs/architecture/2026-08-10-catalog-readiness-signals.md 里 marker probe #1/#2 的 404)。
// 两种夹具各自只带**一条**判别轴:屏障的 `catalogNotReady` 是个 OR,两条都单独钉住才不会
// 「删掉一半仍全绿」。下面的用例刻意混用两者,任何一半被删都会有用例转红。
const notReadyByStatus = () => ({
  error: { message: "Provider not found: alpha-internal-catalog-ready" },
  response: { status: 404 },
})
const notReadyByTag = () => ({
  error: {
    _tag: "ProviderNotFoundError",
    providerID: "alpha-internal-catalog-ready",
    message: "Provider not found: alpha-internal-catalog-ready",
  },
})

const model: ModelV2Info = {
  id: "claude-sonnet-4.6",
  providerID: "alpha",
  name: "Claude Sonnet 4.6",
  api: { id: "alpha", type: "aisdk", package: "@ai-sdk/openai-compatible" },
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  request: { headers: {}, body: {} },
  variants: [],
  time: { released: 0 },
  cost: [],
  status: "active",
  enabled: true,
  limit: { context: 200_000, output: 16_000 },
}

describe("typed model contract", () => {
  test("list/get/switch 均直达 v2，切换携带统一 Model.Ref", async () => {
    const calls: Array<{ operation: string; input: unknown }> = []
    const sdk = {
      v2: {
        provider: {
          get: async (input: unknown) => {
            calls.push({ operation: "catalog-ready", input })
            return { data: { data: { id: ALPHA_V2_CATALOG_READY_PROVIDER_ID } } }
          },
        },
        model: {
          list: async (input: unknown) => {
            calls.push({ operation: "list", input })
            return { data: { data: [model] } }
          },
        },
        session: {
          get: async (input: unknown) => {
            calls.push({ operation: "get", input })
            return { data: { data: { model: { id: model.id, providerID: model.providerID, variant: "高" } } } }
          },
          switchModel: async (input: unknown) => {
            calls.push({ operation: "switch", input })
            return { data: undefined }
          },
        },
      },
    }
    const contract = createModelContract(() => sdk as never)
    const ref: ModelRef = { id: model.id, providerID: model.providerID, variant: "高" }

    expect(await contract.list("/repo")).toEqual([model])
    expect(await contract.current("ses_1")).toEqual(ref)
    await contract.switch("ses_1", ref)

    expect(calls).toEqual([
      {
        operation: "catalog-ready",
        input: { providerID: ALPHA_V2_CATALOG_READY_PROVIDER_ID, location: { directory: "/repo" } },
      },
      { operation: "list", input: { location: { directory: "/repo" } } },
      { operation: "get", input: { sessionID: "ses_1" } },
      { operation: "switch", input: { sessionID: "ses_1", model: ref } },
    ])
  })

  test("缺客户端与 contract error 均 fail-closed，不伪造目录或成功态", async () => {
    const absent = createModelContract(() => undefined)
    await expect(absent.list("/repo")).rejects.toBeInstanceOf(ModelContractError)

    const failed = createModelContract(
      () =>
        ({
          v2: {
            provider: {
              get: async () => ({ data: { data: { id: ALPHA_V2_CATALOG_READY_PROVIDER_ID } } }),
            },
            model: { list: async () => ({ error: { message: "down" } }) },
            session: {
              get: async () => ({ error: { message: "down" } }),
              switchModel: async () => ({ error: { message: "down" } }),
            },
          },
        }) as never,
    )
    await expect(failed.list("/repo")).rejects.toMatchObject({ operation: "list" })
    await expect(failed.current("ses_1")).rejects.toMatchObject({ operation: "get" })
    await expect(failed.switch("ses_1", { id: model.id, providerID: model.providerID })).rejects.toMatchObject({
      operation: "switch",
    })
  })

  test("#857 first list waits for the same-directory governed catalog; bypass exposes the intermediate set", async () => {
    const ungoverned = [{ ...model, id: "models-dev-intermediate", providerID: "ungoverned" }]
    const calls: string[] = []
    let probes = 0
    let ready = false
    const sdk = {
      v2: {
        provider: {
          get: async () => {
            probes++
            calls.push(`catalog-ready:${probes}`)
            if (probes < 3) return notReadyByStatus()
            ready = true
            return { data: { data: { id: ALPHA_V2_CATALOG_READY_PROVIDER_ID } } }
          },
        },
        model: {
          list: async () => {
            calls.push("model.list")
            return { data: { data: ready ? [model] : ungoverned } }
          },
        },
      },
    }

    // Mutation control:removing/reversing the barrier really does expose a different first set.
    expect((await sdk.v2.model.list()).data.data).toEqual(ungoverned)

    // Generated client carries every API group; this focused double implements only the three
    // groups ModelContract can touch.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    const contract = createModelContract(() => sdk as never, { wait: async () => {} })
    const first = await contract.list("/repo")
    const hot = await contract.list("/repo")

    expect(first).toEqual([model])
    expect(hot).toEqual(first)
    expect(calls).toEqual([
      "model.list",
      "catalog-ready:1",
      "catalog-ready:2",
      "catalog-ready:3",
      "model.list",
      "catalog-ready:4",
      "model.list",
    ])
  })

  // ── #882 的判官 ────────────────────────────────────────────────────────────────
  // 票面判据是**事件到达与请求发起的间隔**,不是启动总时长。这里把时钟冻死(注入的 `wait`
  // 永不 resolve ⇒ 任何兜底轮询在本用例里结构上都到不了期),只留 `catalog.updated` 这一条
  // 唤醒源。改回固定计时器轮询的实现在冻结时钟下**不可能**通过 —— 这就是「把取数改回固定
  // 计时器轮询时测试转红」的机械判官。
  //
  // 期望值不自指:唤醒由 runtime-recovery 的生产函数投递,断言的是探针次数与最终清单,
  // 没有一个锚点是从被测模块自己读回来的。
  test("#882 首次读取由 catalog.updated 驱动:冻结时钟下仍能就绪，且事件到达与重探之间零计时器", async () => {
    let probes = 0
    let ready = false
    let timerArmed = 0
    const contract = createModelContract(
      () =>
        ({
          v2: {
            provider: {
              get: async () => {
                probes++
                if (!ready) return notReadyByTag()
                return { data: { data: { id: ALPHA_V2_CATALOG_READY_PROVIDER_ID } } }
              },
            },
            model: { list: async () => ({ data: { data: [model] } }) },
          },
        }) as never,
      {
        // 冻结时钟:兜底档位在本用例里永远到不了期。唯一还能推进屏障的就是事件。
        wait: () => {
          timerArmed++
          return new Promise<void>(() => {})
        },
      },
    )

    const listing = contract.list("/frozen-clock")
    // 自旋到屏障真的停在等待上。冻结时钟下它会一直停在这里 —— 固定计时器实现到此即死。
    for (let spin = 0; spin < 1_000 && timerArmed === 0; spin++) await Promise.resolve()
    expect(probes).toBe(1)
    expect(timerArmed).toBe(1)

    // 别的目录的提交不得唤醒本目录(否则「按 directory 分派」这句是假的):投递之后再自旋一轮,
    // 屏障必须仍然停着、探针数不动。
    notifyCatalogUpdated("/some-other-directory")
    for (let spin = 0; spin < 50; spin++) await Promise.resolve()
    expect(probes).toBe(1)

    ready = true
    notifyCatalogUpdated("/frozen-clock")
    for (let spin = 0; spin < 50 && probes < 2; spin++) await Promise.resolve()

    // 先断言、再 await:固定计时器实现在这一行当场红(probes 仍是 1),而不是挂到用例超时 ——
    // 判官自己必须快。事件到达之后只多发了一次探针,且没有再武装过任何计时器:事件到达与
    // 请求发起之间隔着 0 个 tick,这正是票面的判据。
    expect(probes).toBe(2)
    expect(timerArmed).toBe(1)
    expect(await listing).toEqual([model])
  })

  test("#882 事件到达时**在飞的**探针当场被取消并立刻重探(不等 10s 请求预算)", async () => {
    // R1 Blocker:上一条用例里事件到达时探针**已经返回**;冷启动首探针恰恰是**还在飞**。
    // 真机记录:sidecar ready 在 1912.9ms,而 marker 端点到 15699.7ms 仍不答 —— 事件在这中间
    // 到达时,如果只置 `landed` 而不取消在途请求,下一次探针最迟要等 ENGINE_FETCH_TIMEOUT_MS
    //(10s)的请求预算到期。所以这是主路径,不是边角。
    let probes = 0
    let ready = false
    let timerArmed = 0
    const probeSignals: AbortSignal[] = []
    const contract = createModelContract(
      () =>
        ({
          v2: {
            provider: {
              get: async (_input: unknown, options: { signal: AbortSignal }) => {
                probes++
                probeSignals.push(options.signal)
                if (ready) return { data: { data: { id: ALPHA_V2_CATALOG_READY_PROVIDER_ID } } }
                // 首探针**悬挂**:除非被取消,否则永不返回。生成客户端把 abort 回成
                // `{ error }`(throwOnError=false),这里照抄那个形状。
                return new Promise((resolve) => {
                  options.signal.addEventListener(
                    "abort",
                    () => resolve({ error: new DOMException("This operation was aborted", "AbortError") }),
                    { once: true },
                  )
                })
              },
            },
            model: { list: async () => ({ data: { data: [model] } }) },
          },
        }) as never,
      {
        // 冻结兜底:本用例里任何计时器都到不了期,能推进屏障的只有「取消在途探针」这一条。
        wait: () => {
          timerArmed++
          return new Promise<void>(() => {})
        },
      },
    )

    const listing = contract.list("/in-flight")
    for (let spin = 0; spin < 1_000 && probes === 0; spin++) await Promise.resolve()
    // 屏障停在**请求**上,还没走到兜底档位 —— 这正是审计复现的那一格。
    expect(probes).toBe(1)
    expect(timerArmed).toBe(0)
    expect(probeSignals[0]!.aborted).toBe(false)

    ready = true
    notifyCatalogUpdated("/in-flight")
    // 修复前这一行当场红(仍是 false):回调只置 `landed`,`wake` 尚未赋值、探针也没被打断。
    expect(probeSignals[0]!.aborted).toBe(true)

    for (let spin = 0; spin < 200 && probes < 2; spin++) await Promise.resolve()
    expect(probes).toBe(2)
    // 第二次探针拿的是**新一轮**的 signal,没被上一轮的取消连坐。
    expect(probeSignals[1]!.aborted).toBe(false)
    // 全程一个兜底计时器都没武装过:事件到达与下一次请求之间隔着 0 个 tick。
    expect(timerArmed).toBe(0)
    expect(await listing).toEqual([model])
  })

  test("#882 屏障只把 404/ProviderNotFoundError 当未就绪:401/503/网络错/单次超时一律抛 ModelContractError", async () => {
    // R1 Major:修复前这四种全被读成「目录尚未收敛」⇒ 屏障永不返回 ⇒ `list()` 永不 reject ⇒
    // alpha-composer 一直 await ⇒ **用户永久停在 loading、发送禁用**,失败回调一次都不执行。
    // 那比本票原本要修的「20 秒后能用」更糟。
    const failures = {
      "401": { error: { _tag: "UnauthorizedError", message: "unauthorized" }, response: { status: 401 } },
      "503": { error: { _tag: "ServiceUnavailableError", message: "unavailable" }, response: { status: 503 } },
      // 生成客户端把 fetch 异常(网络错 / AbortSignal.timeout 到期)回成
      // `{ error, response: undefined }` —— 没有 status 可读,更不能默认当成未就绪。
      transport: { error: new TypeError("Failed to fetch"), response: undefined },
      timeout: { error: new DOMException("The operation timed out.", "TimeoutError"), response: undefined },
    }
    for (const [label, outcome] of Object.entries(failures)) {
      let probes = 0
      let waits = 0
      const contract = createModelContract(
        () =>
          ({
            v2: {
              provider: {
                get: async () => {
                  probes++
                  return outcome
                },
              },
              model: { list: async () => ({ data: { data: [model] } }) },
            },
          }) as never,
        {
          // 判官必须快:吞掉故障的实现会在这里空转,第 4 轮就用一个**可辨认**的普通 Error 收场,
          // 于是 `toBeInstanceOf(ModelContractError)` 当场红,而不是挂到用例超时。
          wait: async () => {
            if (++waits > 3) throw new Error(`屏障把 ${label} 吞成了「尚未收敛」:第 ${waits} 轮兜底等待`)
          },
        },
      )

      const failure = await contract.list(`/failing-${label}`).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(ModelContractError)
      expect(failure).toMatchObject({ operation: "list" })
      expect((failure as ModelContractError).cause).toBe(outcome.error)
      // 一次就抛:真实故障不该在屏障里空转,它要交给恢复链去决定节奏。
      expect(probes).toBe(1)
      expect(waits).toBe(0)
    }
  })

  test("#882 503 接回既有的 recovering + 1/2/4/8s 恢复链(不新造一条)", async () => {
    // 「抛出去」只是半条判据 —— 还得证明抛给了**生产里那条链**。这里直接驱动
    // model-recovery.ts 的 loadEngineModelsWithRetry(composer 用的就是它),不自己拼等价链。
    let unavailable = true
    const unavailableBody = { _tag: "ServiceUnavailableError", message: "unavailable" }
    const contract = createModelContract(
      () =>
        ({
          v2: {
            provider: {
              get: async () =>
                unavailable
                  ? { error: unavailableBody, response: { status: 503 } }
                  : { data: { data: { id: ALPHA_V2_CATALOG_READY_PROVIDER_ID } } },
            },
            model: { list: async () => ({ data: { data: [model] } }) },
          },
        }) as never,
      // 修好的实现在 503 上一次都不等;吞故障的实现会在这里空转,拿一个**可辨认**的普通 Error
      // 收场 —— 下面按「每次失败的到底是什么」判,那个 Error 不是 ModelContractError,当场红。
      // (这一条必须自己抓得住:靠 `loadEngineModelsWithRetry` 判不出来,它对任何异常一视同仁。)
      { wait: async () => Promise.reject(new Error("屏障仍在把 503 当作『尚未收敛』等下去")) },
    )

    const attemptFailures: unknown[] = []
    const readOnce = () =>
      contract.list("/unavailable").catch((error: unknown) => {
        attemptFailures.push(error)
        throw error
      })

    const recoveringAt: number[] = []
    const delays: number[] = []
    const loaded = await loadEngineModelsWithRetry<ModelV2Info[]>({
      initial: readOnce(),
      read: readOnce,
      wait: async (delayMs) => {
        delays.push(delayMs)
        // 第 4 次退避之后引擎恢复:证明这条链**还在重试**,而不是失败一次就永久停摆。
        if (delays.length === 4) unavailable = false
        return "elapsed"
      },
      clearWake: () => {},
      // 有界:任何不收敛的实现在这里被判 stale 而快速红,不会挂成用例超时。
      isStale: () => delays.length > 8,
      onAttemptFailed: () => recoveringAt.push(delays.length),
    })

    expect(loaded).toEqual({ status: "loaded", data: [model] })
    // 喂给这条链的必须是屏障抛出的 ModelContractError,且 cause 就是引擎那份 503 body ——
    // 不是「随便什么异常最终也能走完重试」。
    expect(attemptFailures).toHaveLength(4)
    for (const failure of attemptFailures) {
      expect(failure).toBeInstanceOf(ModelContractError)
      expect((failure as ModelContractError).cause).toBe(unavailableBody)
    }
    // 每一次 503 都触发一次 onAttemptFailed —— composer 把它接成 setModelChainState("recovering")。
    expect(recoveringAt).toEqual([0, 1, 2, 3])
    // 退避档位来自生产的 nextEngineRetryDelay;期望值是独立字面量,不从被测模块读回来。
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000])
  })

  test("#882 R2 503 与 catalog.updated 撞在同一轮:按失败来源判，不被 landed 短路", async () => {
    // R2 未闭合的窄竞态:生产曾先执行 `if (landed) continue` 再看 `failed`,于是「引擎这一轮
    // 已经答了 503」与「catalog.updated 恰好同时到达」撞上时,503 走了「目录尚未收敛,继续等」
    // 那条路被**吞掉**。审计用真实生成客户端无写复现:markerProbes=2、首个 signal 已 abort,
    // 而 `contract.list()` 最终 **resolved** —— 503 一次都没进 recovering。
    //
    // 两个方向都要钉:真实失败必须抛(否则窄竞态原样回来),我们自己的取消必须不抛(否则事件
    // 唤醒退化回 1/2/4/8s 退避,把 #882 本身修的东西改坏)。只钉一个方向,反方向的错实现全绿。
    const unavailableBody = { _tag: "ServiceUnavailableError", message: "unavailable" }

    // ① 引擎的 503 **已经形成**,而 catalog.updated 落在同一轮里。
    let probes = 0
    const failing = createModelContract(
      () =>
        ({
          v2: {
            provider: {
              get: async () => {
                probes++
                if (probes === 1) {
                  // 事件先落地(landed=true + 在途探针被取消),再把这一轮**真实**的答案交出来。
                  notifyCatalogUpdated("/race-503")
                  return { error: unavailableBody, response: { status: 503 } }
                }
                // 吞掉 503 的实现靠这一次「成功」走完屏障 —— 那正是审计量到的 markerProbes=2。
                // 它同时让本用例**快速转红**(list 直接 resolve),而不是空转成用例超时。
                return { data: { data: { id: ALPHA_V2_CATALOG_READY_PROVIDER_ID } } }
              },
            },
            model: { list: async () => ({ data: { data: [model] } }) },
          },
        }) as never,
      { wait: async () => Promise.reject(new Error("真实 503 不该让屏障进入兜底等待")) },
    )

    const failure = await failing.list("/race-503").catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ModelContractError)
    expect(failure).toMatchObject({ operation: "list" })
    // cause 必须是引擎那份 503 body,不是被我们自己的取消顶替掉的 abort 错误。
    expect((failure as ModelContractError).cause).toBe(unavailableBody)
    // 一次就抛:抛在第二次探针**之后**,等于仍然吞掉了这一轮引擎给出的答案。
    expect(probes).toBe(1)

    // ② 反方向:本轮失败正是**我们自己**为了重探发的取消。形状取自实跑,不是想象 ——
    //    生成客户端(throwOnError 未开)把 fetch 的拒绝原样回成 `{ error, response: undefined }`,
    //    而 `AbortSignal.any` 保留 abort reason 的对象身份 ⇒ error 就是 `signal.reason` 本身。
    let cancelProbes = 0
    let timerArmed = 0
    const recovering = createModelContract(
      () =>
        ({
          v2: {
            provider: {
              get: async (_input: unknown, options: { signal: AbortSignal }) => {
                cancelProbes++
                if (cancelProbes > 1) return { data: { data: { id: ALPHA_V2_CATALOG_READY_PROVIDER_ID } } }
                // 首探针悬挂,只可能被事件取消收场。
                return new Promise((resolve) => {
                  options.signal.addEventListener("abort", () => resolve({ error: options.signal.reason }), {
                    once: true,
                  })
                })
              },
            },
            model: { list: async () => ({ data: { data: [model] } }) },
          },
        }) as never,
      {
        wait: () => {
          timerArmed++
          return new Promise<void>(() => {})
        },
      },
    )

    const listing = recovering.list("/race-cancel")
    for (let spin = 0; spin < 1_000 && cancelProbes === 0; spin++) await Promise.resolve()
    expect(cancelProbes).toBe(1)
    notifyCatalogUpdated("/race-cancel")
    // 把「landed 时一律抛」当修法的实现在这里 reject —— 事件唤醒会退化成一次恢复链重试。
    await expect(listing).resolves.toEqual([model])
    expect(cancelProbes).toBe(2)
    // 事件唤醒路径上一个兜底计时器都不该武装。
    expect(timerArmed).toBe(0)
  })

  test("#882 事件到不了时兜底轮询仍能就绪，且每一轮都闩在 250ms 档位上", async () => {
    // 实测:先于 renderer 订阅就已收敛的目录再也不会发 catalog.updated。屏障因此不能只认事件。
    //
    // #882 R1 Major:注入的 `wait` 如果忽略 `delayMs` 立即完成,这条用例就只证明了「轮询会重试」
    // —— 把生产常量从 250ms 改成 60s,它照样全绿,而晚订阅且无事件的目录会停在 loading 至少
    // 一分钟。所以这里记录每一轮真实收到的 `delayMs`,并**手动**放行,不真睡。
    // 期望值 250 是独立字面量:`CATALOG_READY_POLL_MS` 没有导出,断言不可能从被测模块读回来。
    let probes = 0
    const delays: number[] = []
    let release: (() => void) | undefined
    const contract = createModelContract(
      () =>
        ({
          v2: {
            provider: {
              get: async () => {
                probes++
                if (probes < 4) return notReadyByStatus()
                return { data: { data: { id: ALPHA_V2_CATALOG_READY_PROVIDER_ID } } }
              },
            },
            model: { list: async () => ({ data: { data: [model] } }) },
          },
        }) as never,
      {
        wait: (delayMs) => {
          delays.push(delayMs)
          return new Promise<void>((resolve) => {
            release = resolve
          })
        },
      },
    )

    // 全程一条 catalog.updated 都不投递。
    const listing = contract.list("/never-notified")
    for (let round = 1; round <= 3; round++) {
      for (let spin = 0; spin < 1_000 && delays.length < round; spin++) await Promise.resolve()
      expect(delays.length).toBe(round)
      expect(probes).toBe(round)
      const resume = release
      release = undefined
      resume!()
    }
    await expect(listing).resolves.toEqual([model])
    expect(probes).toBe(4)
    expect(delays).toEqual([250, 250, 250])
  })

  test("#882 屏障不再自己判失败:探针一直不就绪也不会抛，只有调用方取消才结束", async () => {
    // 旧实现在 1.5s 处把「还没收敛」抛成一次请求失败,喂给 1/2/4/8s 指数退避,而退避窗口内
    // 一个探针都不发。现在等待只由调用方的取消收场。
    const caller = new AbortController()
    let probes = 0
    const contract = createModelContract(
      () =>
        ({
          v2: {
            provider: {
              get: async () => {
                probes++
                return notReadyByTag()
              },
            },
          },
        }) as never,
      { wait: async () => {} },
    )

    const pending = contract.list("/never-ready", caller.signal).catch((error) => error)
    // 自旋有界:无界的 `while (probes < 50)` 会在**屏障提前收场**的实现下饿死事件循环 ——
    // 连 bun 自己的用例超时都发不出来,一次绕过实验因此挂死而不是转红(本轮实测)。
    // 判官必须快:先有界自旋,再用断言说清「它根本没跑到 50 次」。
    for (let spin = 0; spin < 5_000 && probes < 50; spin++) await Promise.resolve()
    expect(probes).toBeGreaterThanOrEqual(50)
    caller.abort(new Error("chain superseded"))
    const failure = await pending
    expect(failure).toBeInstanceOf(ModelContractError)
    expect(failure.cause).toBe(caller.signal.reason)
  })

  test("caller abort stays the recorded cause during both catalog probe and poll wait", async () => {
    for (const phase of ["probe", "poll"] as const) {
      const caller = new AbortController()
      let probeSignal: AbortSignal | undefined
      const contract = createModelContract(
        () =>
          ({
            v2: {
              provider: {
                get: async (_input: unknown, options: { signal?: AbortSignal }) => {
                  probeSignal = options.signal
                  if (phase === "poll") return notReadyByStatus()
                  return new Promise<{ error: unknown }>((resolve) => {
                    if (probeSignal?.aborted) return resolve({ error: probeSignal.reason })
                    probeSignal?.addEventListener("abort", () => resolve({ error: probeSignal?.reason }), {
                      once: true,
                    })
                  })
                },
              },
            },
          }) as never,
        { catalogReadyPollMs: 1_000 },
      )

      const pending = contract.list("/repo", caller.signal).catch((error) => error)
      setTimeout(() => caller.abort(new Error(`caller cancelled during ${phase}`)), 10)
      const failure = await pending

      expect(failure).toBeInstanceOf(ModelContractError)
      expect(failure).toMatchObject({ operation: "list" })
      expect(failure.cause).toBe(caller.signal.reason)
      expect(probeSignal).toBeDefined()
      // 探针拿的是「调用方取消 ∪ 本次往返的悬挂预算」的合成 signal,不是调用方那一个 —— 悬挂
      // 防御(2026-07-12)必须留在每次往返上,而不是从一个总 deadline 里切。
      expect(probeSignal).not.toBe(caller.signal)
    }
  })
})
