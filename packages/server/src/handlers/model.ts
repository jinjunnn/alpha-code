import { Catalog } from "@opencode-ai/core/catalog"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { PluginInternal } from "@opencode-ai/core/plugin/internal"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const listAvailableModels = Effect.fn("ModelHttpApi.listAvailable")(function* () {
  const plugin = yield* PluginV2.Service
  // #857:PluginInternal boots in a background fiber. Reading Catalog before its final marker can
  // serialize the 6,132-row models.dev intermediate state; the same process settles to Alpha's
  // governed set moments later. This wait is local-only (no account/bearer dependency) and the
  // marker is registered after ConfigProvider + Variant have committed their initial transforms.
  yield* plugin.wait(PluginInternal.CatalogReadyPluginID)
  const catalog = yield* Catalog.Service
  return yield* catalog.model.available()
})

export const ModelHandler = HttpApiBuilder.group(Api, "server.model", (handlers) =>
  Effect.gen(function* () {
    return handlers.handle(
      "model.list",
      Effect.fn(function* () {
        return yield* response(listAvailableModels())
      }),
    )
  }),
)
