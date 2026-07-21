import type { ModelRef, ModelV2Info, createOpencodeClient } from "@opencode-ai/sdk/v2/client"

type Client = ReturnType<typeof createOpencodeClient>

export class ModelContractError extends Error {
  constructor(
    readonly operation: "list" | "get" | "switch",
    readonly cause?: unknown,
  ) {
    super(`model contract ${operation} failed`)
    this.name = "ModelContractError"
  }
}

/** The renderer-facing model contract. All calls go through the generated SDK v2 Model.Ref API. */
export function createModelContract(sdk: () => Client | undefined) {
  return {
    async list(directory: string, signal?: AbortSignal): Promise<ModelV2Info[]> {
      const client = sdk()
      if (!client) throw new ModelContractError("list")
      const result = await client.v2.model
        .list({ location: { directory } }, signal ? { signal } : undefined)
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
