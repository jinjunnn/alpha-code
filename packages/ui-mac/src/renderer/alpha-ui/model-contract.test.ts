import { describe, expect, test } from "bun:test"
import type { ModelRef, ModelV2Info } from "@opencode-ai/sdk/v2/client"
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
})
