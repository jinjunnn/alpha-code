import { describe, expect, test } from "bun:test"
import type { ModelRef, ModelV2Info } from "@opencode-ai/sdk/v2/client"
import { ALPHA_V2_CATALOG_READY_PROVIDER_ID } from "../../shared/alpha-config"
// #882:唤醒信道用的是**生产接线**本体(runtime-recovery 的同一对函数),不是测试替身。
// 注入一个 subscribe 桩会让「删掉生产订阅仍全绿」重新成立 —— 那是本仓点名的第 ⑧ 类假闸门。
import { notifyCatalogUpdated } from "../runtime-recovery"
import { createModelContract, ModelContractError } from "./model-contract"

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
            if (probes < 3) return { error: { message: "not ready" } }
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
                if (!ready) return { error: { message: "not ready" } }
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

  test("#882 事件到不了时兜底轮询仍能就绪(事件唯一化 = 新的死信道)", async () => {
    // 实测:先于 renderer 订阅就已收敛的目录再也不会发 catalog.updated。屏障因此不能只认事件。
    let probes = 0
    const contract = createModelContract(
      () =>
        ({
          v2: {
            provider: {
              get: async () => {
                probes++
                if (probes < 4) return { error: { message: "not ready" } }
                return { data: { data: { id: ALPHA_V2_CATALOG_READY_PROVIDER_ID } } }
              },
            },
            model: { list: async () => ({ data: { data: [model] } }) },
          },
        }) as never,
      { wait: async () => {} },
    )

    // 全程一条 catalog.updated 都不投递。
    await expect(contract.list("/never-notified")).resolves.toEqual([model])
    expect(probes).toBe(4)
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
                return { error: { message: "not ready" } }
              },
            },
          },
        }) as never,
      { wait: async () => {} },
    )

    const pending = contract.list("/never-ready", caller.signal).catch((error) => error)
    while (probes < 50) await Promise.resolve()
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
                  if (phase === "poll") return { error: { message: "not ready" } }
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
