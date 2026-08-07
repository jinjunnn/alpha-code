import type { ModelRef, ModelV2Info, createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { ALPHA_V2_CATALOG_READY_PROVIDER_ID } from "../../shared/alpha-config"

type Client = ReturnType<typeof createOpencodeClient>

type ModelContractOptions = {
  catalogReadyTimeoutMs?: number
  catalogReadyPollMs?: number
  now?: () => number
  wait?: (delayMs: number, signal?: AbortSignal) => Promise<void>
}

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
    readonly reason: "request" | "catalog-not-ready" = "request",
  ) {
    super(`model contract ${operation} failed`)
    this.name = "ModelContractError"
  }
}

/** The renderer-facing model contract. All calls go through the generated SDK v2 Model.Ref API. */
export function createModelContract(sdk: () => Client | undefined, options: ModelContractOptions = {}) {
  const catalogReadyTimeoutMs = options.catalogReadyTimeoutMs ?? 1_500
  const catalogReadyPollMs = options.catalogReadyPollMs ?? 10
  const now = options.now ?? Date.now
  const waitForNextProbe = options.wait ?? wait

  const waitForCatalogReady = async (client: Client, directory: string, signal?: AbortSignal) => {
    const deadline = now() + catalogReadyTimeoutMs
    let cause: unknown
    while (true) {
      if (signal?.aborted) throw new ModelContractError("list", signal.reason)
      const remainingMs = deadline - now()
      if (remainingMs <= 0) throw new ModelContractError("list", cause, "catalog-not-ready")
      // The caller's model request budget is intentionally much wider than this readiness
      // barrier. Give each marker request its own deadline so a cold location graph cannot
      // turn the 1.5 s catalog-ready gate into the caller's 10 s abort timeout.
      const deadlineSignal = AbortSignal.timeout(Math.max(1, Math.ceil(remainingMs)))
      const probeSignal = signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal
      try {
        const result = await client.v2.provider.get(
          { providerID: ALPHA_V2_CATALOG_READY_PROVIDER_ID, location: { directory } },
          { signal: probeSignal },
        )
        if (deadlineSignal.aborted || now() >= deadline)
          throw new ModelContractError("list", result.error, "catalog-not-ready")
        if (!result.error && result.data?.data.id === ALPHA_V2_CATALOG_READY_PROVIDER_ID) return
        cause = result.error
      } catch (error) {
        if (signal?.aborted) throw new ModelContractError("list", signal.reason)
        if (deadlineSignal.aborted || now() >= deadline)
          throw error instanceof ModelContractError
            ? error
            : new ModelContractError("list", error, "catalog-not-ready")
        cause = error
      }
      await waitForNextProbe(catalogReadyPollMs, signal)
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
