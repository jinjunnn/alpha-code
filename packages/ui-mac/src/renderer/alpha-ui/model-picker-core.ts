import type { ModelRef, ModelV2Info } from "@opencode-ai/sdk/v2/client"
import type { EffectiveCatalog, ProviderKeyStatus, Tier } from "../../shared/alpha-model-types"
import type { ComposerModel } from "./composer-state"

export type AccountState = "member" | "balance" | "empty" | "out" | "loading" | "error"
export type ModelListState = "loading" | "ready" | "failed"
export type ModelAvailability = "available" | "needs-login" | "needs-credit" | "needs-key" | "loading" | "unavailable"

export type ModelPickerRow = {
  key: string
  group: "platform" | "byok"
  model: ComposerModel
  providerName: string
  pico: { letter: string; color: string }
  tier?: Tier
  mult?: string
  reasoning: boolean
  availability: ModelAvailability
  reason?: string
}

export function modelRefOf(model: ComposerModel): ModelRef {
  return {
    id: model.id,
    providerID: model.providerID,
    ...(model.variant ? { variant: model.variant } : {}),
  }
}

export function composerModelFromRef(ref: ModelRef, catalog: EffectiveCatalog | null): ComposerModel {
  const platform =
    catalog?.platformProvider.id === ref.providerID
      ? catalog.platformModels.find((model) => model.id === ref.id)
      : undefined
  return {
    ...ref,
    name: platform?.name ?? ref.id,
    variants: platform?.variants ? Object.keys(platform.variants) : [],
  }
}

export function withModelVariant(model: ComposerModel, variant: string | null): ComposerModel {
  return {
    ...model,
    variant: variant && model.variants.includes(variant) ? variant : undefined,
  }
}

export function buildModelPickerRows(input: {
  catalog: EffectiveCatalog
  models: readonly ModelV2Info[]
  listState: ModelListState
  keyStatus: ProviderKeyStatus
  accountState: AccountState
  query: string
}): ModelPickerRow[] {
  const actual = new Map(input.models.map((model) => [`${model.providerID}:${model.id}`, model]))
  const query = input.query.trim().toLowerCase()
  const matches = (row: ModelPickerRow) =>
    !query || `${row.model.name} ${row.model.id} ${row.providerName} ${row.reason ?? ""}`.toLowerCase().includes(query)

  const platform = input.catalog.platformModels.map((model): ModelPickerRow => {
    const key = `${input.catalog.platformProvider.id}:${model.id}`
    const availability = platformAvailability(input.accountState, input.listState, actual.get(key))
    return {
      key,
      group: "platform",
      model: {
        id: model.id,
        providerID: input.catalog.platformProvider.id,
        name: model.name,
        variants: model.variants ? Object.keys(model.variants) : [],
      },
      providerName: input.catalog.platformProvider.name,
      pico: input.catalog.platformProvider.pico,
      tier: model.tier,
      mult: input.catalog.tiers[model.tier]?.mult,
      reasoning: !!model.reasoning,
      availability: availability.kind,
      reason: availability.reason,
    }
  })

  const byok = input.catalog.byokProviders.flatMap((provider): ModelPickerRow[] => {
    if (!(input.keyStatus[provider.id]?.configured ?? false)) {
      return [
        {
          key: `${provider.id}:needs-key`,
          group: "byok",
          model: { id: provider.models[0] ?? "", providerID: provider.id, name: provider.name, variants: [] },
          providerName: provider.name,
          pico: provider.pico,
          reasoning: false,
          availability: "needs-key",
          reason: "未配置 KEY · 点击配置",
        },
      ]
    }
    if (input.listState !== "ready") {
      return [
        {
          key: `${provider.id}:loading`,
          group: "byok",
          model: { id: provider.models[0] ?? "", providerID: provider.id, name: provider.name, variants: [] },
          providerName: provider.name,
          pico: provider.pico,
          reasoning: false,
          availability: input.listState === "loading" ? "loading" : "unavailable",
          reason: input.listState === "loading" ? "已配置 · 模型加载中…" : "已配置 · 模型列表暂不可用",
        },
      ]
    }
    return provider.models.map((id): ModelPickerRow => {
      const info = actual.get(`${provider.id}:${id}`)
      const display = input.catalog.platformModels.find((model) => model.id === id)
      const available = !!info?.enabled && info.status !== "deprecated"
      return {
        key: `${provider.id}:${id}`,
        group: "byok",
        model: { id, providerID: provider.id, name: display?.name ?? id, variants: [] },
        providerName: provider.name,
        pico: provider.pico,
        reasoning: !!display?.reasoning,
        availability: available ? "available" : "unavailable",
        reason: available ? undefined : "当前不可用",
      }
    })
  })

  return [...platform, ...byok].filter(matches)
}

function platformAvailability(
  account: AccountState,
  list: ModelListState,
  model: ModelV2Info | undefined,
): { kind: ModelAvailability; reason?: string } {
  if (account === "out") return { kind: "needs-login", reason: "需登录" }
  if (account === "empty") return { kind: "needs-credit", reason: "余额不足" }
  if (account === "loading") return { kind: "loading", reason: "账户状态加载中" }
  if (account === "error") return { kind: "unavailable", reason: "账户状态暂不可用" }
  if (list === "loading") return { kind: "loading", reason: "模型加载中" }
  if (list === "failed") return { kind: "unavailable", reason: "模型列表暂不可用" }
  if (!model?.enabled || model.status === "deprecated") return { kind: "unavailable", reason: "当前不可用" }
  return { kind: "available" }
}
