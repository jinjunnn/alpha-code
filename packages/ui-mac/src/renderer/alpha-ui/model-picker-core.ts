import type { ModelRef, ModelV2Info } from "@opencode-ai/sdk/v2/client"
import type { EffectiveCatalog, ProviderKeyStatus, Tier } from "../../shared/alpha-model-types"
import type { ComposerModel } from "./composer-state"
import { t } from "../i18n"

export type AccountState = "member" | "balance" | "empty" | "out" | "loading" | "error"
export type ModelListState = "loading" | "ready" | "failed"
export type KeyStatusState = "loading" | "ready" | "error"
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
  keyStatusState: KeyStatusState
  keyStatus: ProviderKeyStatus
  accountState: AccountState
  query: string
}): ModelPickerRow[] {
  const actual = new Map(input.models.map((model) => [`${model.providerID}:${model.id}`, model]))
  const query = input.query.trim().toLowerCase()
  const matches = (row: ModelPickerRow) =>
    !query || `${row.model.name} ${row.model.id} ${row.providerName} ${row.reason ?? ""}`.toLowerCase().includes(query)

  // 登录前沿用既有 IA：统一登录入口由组件呈现，不铺一整组逐模型锁定行。
  const platform = (input.accountState === "out" ? [] : input.catalog.platformModels).map((model): ModelPickerRow => {
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
    if (input.keyStatusState !== "ready") {
      return [
        {
          key: `${provider.id}:key-status`,
          group: "byok",
          model: { id: provider.models[0] ?? "", providerID: provider.id, name: provider.name, variants: [] },
          providerName: provider.name,
          pico: provider.pico,
          reasoning: false,
          availability: input.keyStatusState === "loading" ? "loading" : "unavailable",
          reason: input.keyStatusState === "loading" ? t("alpha.model.keyLoading") : t("alpha.model.keyFailed"),
        },
      ]
    }
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
          reason: t("alpha.model.keyMissing"),
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
          reason: input.listState === "loading" ? t("alpha.model.configuredLoading") : t("alpha.model.configuredUnavailable"),
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
        reason: available ? undefined : t("alpha.model.unavailable"),
      }
    })
  })

  const catalogProviderIDs = new Set([
    input.catalog.platformProvider.id,
    ...input.catalog.byokProviders.map((provider) => provider.id),
  ])
  const custom =
    input.keyStatusState === "ready" && input.listState === "ready"
      ? Object.entries(input.keyStatus)
          .filter(([providerID, status]) => status.configured && !catalogProviderIDs.has(providerID))
          .flatMap(([providerID]): ModelPickerRow[] =>
            input.models
              .filter((model) => model.providerID === providerID)
              .map((model) => {
                const available = model.enabled && model.status !== "deprecated"
                return {
                  key: `${providerID}:${model.id}`,
                  group: "byok",
                  model: {
                    id: model.id,
                    providerID,
                    name: model.name,
                    variants: model.variants.map((variant) => variant.id),
                  },
                  providerName: providerID,
                  pico: { letter: providerID.slice(0, 1).toUpperCase() || "?", color: "var(--a-accent-solid)" },
                  reasoning: false,
                  availability: available ? "available" : "unavailable",
                  reason: available ? undefined : t("alpha.model.unavailable"),
                }
              }),
          )
      : []

  return [...platform, ...byok, ...custom].filter(matches)
}

function platformAvailability(
  account: AccountState,
  list: ModelListState,
  model: ModelV2Info | undefined,
): { kind: ModelAvailability; reason?: string } {
  if (account === "out") return { kind: "needs-login", reason: t("alpha.model.needsLogin") }
  if (account === "empty") return { kind: "needs-credit", reason: t("alpha.model.needsCredit") }
  if (account === "loading") return { kind: "loading", reason: t("alpha.model.accountLoading") }
  if (account === "error") return { kind: "unavailable", reason: t("alpha.model.accountUnavailable") }
  if (list === "loading") return { kind: "loading", reason: t("alpha.model.listLoading") }
  if (list === "failed") return { kind: "unavailable", reason: t("alpha.model.listUnavailable") }
  if (!model?.enabled || model.status === "deprecated") return { kind: "unavailable", reason: t("alpha.model.unavailable") }
  return { kind: "available" }
}
