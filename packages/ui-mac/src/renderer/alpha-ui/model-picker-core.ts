import type { ModelRef, ModelV2Info } from "@opencode-ai/sdk/v2/client"
import type { EffectiveCatalog, ProviderKeyStatus, Tier } from "../../shared/alpha-model-types"
import { byokEngineId } from "../../shared/alpha-model-types"
import type { ComposerModel } from "./composer-state"
import { t } from "../i18n"

export type AccountState = "member" | "balance" | "empty" | "out" | "loading" | "recovering" | "failed"
export type ModelListState = "loading" | "recovering" | "ready" | "failed"
export type KeyStatusState = "loading" | "ready" | "failed"
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
  /** **picker 可选择性**,不是引擎执行证明(契约 docs/contracts/byok-availability.md)。 */
  availability: ModelAvailability
  reason?: string
  /** REQ-109 #595:该行的可选择性完全由本地事实(本地目录 + 本地 KEY)决定,引擎清单
   *  (`listState` / `model.list` 内容 / `readyListEpoch`)不得否定它。只有内置 BYOK 目录行带此标记;
   *  平台代理行与从引擎清单派生的自定义节点行都不带。点击层据此跳过引擎清单 membership 检查。 */
  engineIndependent?: true
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
  /** true = 会话内的 picker(换模型必须落到服务端 switchModel)。只影响 BYOK 行在引擎恢复中的
   *  **文案诚实性**:home 可先选,session 不能 —— 不得让两者共用「可先选择」。 */
  sessionScoped: boolean
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
    // REQ-109 #595:KEY 已配置 ⇒ 直接从本地目录派生可选行。**引擎不再是最终裁判** —— 不查
    // `model.list`、不看 `listState`,后者最多提供「引擎重启中」文案。判据集封闭为
    // {本地钥匙串, 本地目录}(契约 docs/contracts/byok-availability.md);登录态、账户额度、
    // 平台连通、live allowlist、引擎清单内容一律不得否定它。
    return provider.models.map((id): ModelPickerRow => {
      // The engine injects BYOK nodes under `<id>-byok` (byokEngineId) to dodge the models.dev
      // collision, so carry the engine id as the selectable model's providerID — inference must route
      // to the injected node. Display id (provider.id) stays for keyStatus/pico/name/key above.
      const display = input.catalog.platformModels.find((model) => model.id === id)
      return {
        key: `${provider.id}:${id}`,
        group: "byok",
        model: { id, providerID: byokEngineId(provider.id), name: display?.name ?? id, variants: [] },
        providerName: provider.name,
        pico: provider.pico,
        reasoning: !!display?.reasoning,
        availability: "available",
        // 「当前可执行」是另一个谓词:引擎未 ready 时如实说明还要等什么,但不撤销可选择性。
        // session 与 home 的可做之事不同,文案必须分开 —— 否则会出现「说可先选却点不了」。
        ...(input.listState === "ready"
          ? {}
          : {
              reason: input.sessionScoped
                ? t("alpha.model.byokEngineRestartingSession")
                : t("alpha.model.byokEngineRestarting"),
            }),
        engineIndependent: true,
      }
    })
  })

  const catalogProviderIDs = new Set([
    input.catalog.platformProvider.id,
    ...input.catalog.byokProviders.map((provider) => provider.id),
  ])
  const custom =
    input.keyStatusState === "ready" && input.listState !== "failed"
      ? Object.entries(input.keyStatus)
          .filter(([providerID, status]) => status.configured && !catalogProviderIDs.has(providerID))
          .flatMap(([providerID]): ModelPickerRow[] =>
            input.models
              .filter((model) => model.providerID === providerID)
              .map((model) => {
                const available = input.listState === "ready" && model.enabled && model.status !== "deprecated"
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
                  availability: available ? "available" : input.listState === "recovering" ? "loading" : "unavailable",
                  reason:
                    available
                      ? undefined
                      : input.listState === "recovering"
                        ? t("alpha.model.syncing")
                        : t("alpha.model.unavailable"),
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
  if (account === "loading" || account === "recovering")
    return {
      kind: "loading",
      reason: account === "recovering" ? t("alpha.model.syncing") : t("alpha.model.accountLoading"),
    }
  if (account === "failed") return { kind: "unavailable", reason: t("alpha.model.accountUnavailable") }
  if (list === "loading") return { kind: "loading", reason: t("alpha.model.listLoading") }
  if (list === "recovering") return { kind: "loading", reason: t("alpha.model.syncing") }
  if (list === "failed") return { kind: "unavailable", reason: t("alpha.model.listUnavailable") }
  if (!model?.enabled || model.status === "deprecated") return { kind: "unavailable", reason: t("alpha.model.unavailable") }
  return { kind: "available" }
}
