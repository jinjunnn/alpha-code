import { describe, expect, test } from "bun:test"
import type { ModelRef, ModelV2Info } from "@opencode-ai/sdk/v2/client"
import { ALPHA_V2_CATALOG_READY_PROVIDER_ID } from "../../shared/alpha-config"
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
})
