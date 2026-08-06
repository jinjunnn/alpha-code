import { describe, expect, test } from "bun:test"
import { Catalog } from "@opencode-ai/core/catalog"
import { ModelV2 } from "@opencode-ai/core/model"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { PluginInternal } from "@opencode-ai/core/plugin/internal"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Effect } from "effect"
import { listAvailableModels } from "./model"

describe("model.list catalog boot barrier (#857)", () => {
  test("first read waits for the governed catalog and equals the stable hot path", async () => {
    const providerID = ProviderV2.ID.make("test")
    const ungoverned = [ModelV2.Info.empty(providerID, ModelV2.ID.make("models-dev-intermediate"))]
    const governed = [ModelV2.Info.empty(providerID, ModelV2.ID.make("alpha-governed"))]
    const calls: string[] = []
    const waited: string[] = []
    let settled = false

    const catalog = Catalog.Service.of({
      transform: () => Effect.die("not used"),
      reload: () => Effect.void,
      provider: {
        get: () => Effect.succeed(undefined),
        all: () => Effect.succeed([]),
        available: () => Effect.succeed([]),
      },
      model: {
        get: () => Effect.succeed(undefined),
        all: () => Effect.succeed([]),
        available: () =>
          Effect.sync(() => {
            calls.push("read")
            return settled ? governed : ungoverned
          }),
        default: () => Effect.succeed(undefined),
        small: () => Effect.succeed(undefined),
      },
    })
    const plugin = PluginV2.Service.of({
      add: () => Effect.void,
      remove: () => Effect.void,
      wait: (id) =>
        Effect.sync(() => {
          calls.push("wait")
          waited.push(id)
          settled = true
        }),
    })

    const run = () =>
      Effect.runPromise(
        listAvailableModels().pipe(
          Effect.provideService(Catalog.Service, catalog),
          Effect.provideService(PluginV2.Service, plugin),
        ),
      )

    // Control:the catalog really exposes the ungoverned intermediate set before the barrier.
    expect(await Effect.runPromise(catalog.model.available())).toEqual(ungoverned)

    const first = await run()
    const hot = await run()

    expect(first).toEqual(governed)
    expect(hot).toEqual(first)
    expect(calls).toEqual(["read", "wait", "read", "wait", "read"])
    expect(waited).toEqual([PluginInternal.CatalogReadyPluginID, PluginInternal.CatalogReadyPluginID])
  })
})
