import { describe, expect, test } from "bun:test"
import type { ModelV2Info } from "@opencode-ai/sdk/v2/client"
import type { EffectiveCatalog, ProviderKeyStatus } from "../../shared/alpha-model-types"
import { t } from "../i18n"
import { buildModelPickerRows, composerModelFromRef, modelRefOf, withModelVariant } from "./model-picker-core"

const catalog = {
  ...(await Bun.file(new URL("../../main/alpha-models.json", import.meta.url)).json()),
  liveSync: { status: "static" },
} as EffectiveCatalog

const info = (
  providerID: string,
  id: string,
  enabled = true,
  status: ModelV2Info["status"] = "active",
): ModelV2Info => ({
  id,
  providerID,
  name: id,
  api: { id: providerID, type: "aisdk", package: "@ai-sdk/openai-compatible" },
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  request: { headers: {}, body: {} },
  variants: [],
  time: { released: 0 },
  cost: [],
  status,
  enabled,
  limit: { context: 128_000, output: 8_192 },
})

const platformModels = catalog.platformModels.map((model) => info(catalog.platformProvider.id, model.id))
const keys: ProviderKeyStatus = Object.fromEntries(
  catalog.byokProviders.map((provider) => [
    provider.id,
    { configured: provider.id === "deepseek", source: provider.id === "deepseek" ? "keychain" : "none" },
  ]),
)

const rows = (over: Partial<Parameters<typeof buildModelPickerRows>[0]> = {}) =>
  buildModelPickerRows({
    catalog,
    models: [
      ...platformModels,
      ...catalog.byokProviders.flatMap((provider) => provider.models.map((id) => info(provider.id, id))),
    ],
    listState: "ready",
    keyStatusState: "ready",
    keyStatus: keys,
    accountState: "member",
    query: "",
    ...over,
  })

describe("真实 alpha-models.json → picker 两组", () => {
  test("平台代理模型、供应商与档位逐项取自目录，不发明 id", () => {
    const actual = rows()
    const platform = actual.filter((row) => row.group === "platform")
    const byok = actual.filter((row) => row.group === "byok")

    expect(platform.map((row) => row.model.id)).toEqual(catalog.platformModels.map((model) => model.id))
    expect(platform.find((row) => row.model.id === "claude-opus-4.8")?.model.variants).toEqual(["低", "中", "高"])
    expect(byok.filter((row) => row.model.providerID === "deepseek").map((row) => row.model.id)).toEqual(
      catalog.byokProviders.find((provider) => provider.id === "deepseek")?.models ?? [],
    )
    expect(byok.filter((row) => row.availability === "needs-key").map((row) => row.model.providerID)).toEqual(
      catalog.byokProviders.filter((provider) => provider.id !== "deepseek").map((provider) => provider.id),
    )
  })

  test("disabled/deprecated 与需 KEY 都按真实状态禁用或引导", () => {
    const disabled = rows({
      models: platformModels.map((model) => (model.id === "claude-opus-4.8" ? { ...model, enabled: false } : model)),
    })
    expect(disabled.find((row) => row.model.id === "claude-opus-4.8")?.availability).toBe("unavailable")

    const loggedOut = rows({ accountState: "out", keyStatus: {} })
    expect(loggedOut.filter((row) => row.group === "platform")).toEqual([])
    expect(loggedOut.filter((row) => row.group === "byok").every((row) => row.availability === "needs-key")).toBe(true)
  })

  test("KEY 状态未知或失败不伪装成未配置", () => {
    const loading = rows({ keyStatusState: "loading", keyStatus: {} })
    const failed = rows({ keyStatusState: "error", keyStatus: {} })

    expect(loading.filter((row) => row.group === "byok").every((row) => row.reason === t("alpha.model.keyLoading"))).toBe(true)
    expect(failed.filter((row) => row.group === "byok").every((row) => row.reason === t("alpha.model.keyFailed"))).toBe(true)
    expect([...loading, ...failed].some((row) => row.availability === "needs-key")).toBe(false)
  })

  test("已配置的 off-catalog provider 只从正式 list 派生真实模型行", () => {
    const custom = info("my-endpoint", "real-custom-model")
    custom.name = "Real Custom Model"
    custom.variants = [{ id: "fast", headers: {}, body: {} }]
    const actual = rows({
      keyStatus: { ...keys, "my-endpoint": { configured: true, source: "config" } },
      models: [...platformModels, custom],
    }).filter((row) => row.model.providerID === "my-endpoint")

    expect(actual).toHaveLength(1)
    expect(actual[0]?.model).toEqual({
      providerID: "my-endpoint",
      id: "real-custom-model",
      name: "Real Custom Model",
      variants: ["fast"],
    })
  })

  test("contract 加载失败时 fail-closed：目录仍可辨认，但没有模型伪装可用", () => {
    const failed = rows({ listState: "failed", models: [] })
    expect(failed.some((row) => row.availability === "available")).toBe(false)
    expect(failed.find((row) => row.model.providerID === "alpha")?.reason).toBe(t("alpha.model.listUnavailable"))
    expect(failed.find((row) => row.model.providerID === "deepseek")?.reason).toBe(t("alpha.model.configuredUnavailable"))
  })

  test("搜索无匹配时返回真实空态，而非回退到全量或假条目", () => {
    expect(rows({ query: "definitely-not-a-real-model" })).toEqual([])
  })
})

describe("Model.Ref 统一与 session 真值投影", () => {
  test("上游 session ref 覆盖 UI 旧投影，variant 与 id/providerID 不拆成两份", () => {
    const upstream = { providerID: "alpha", id: "claude-opus-4.8", variant: "高" }
    const projected = composerModelFromRef(upstream, catalog)
    expect(projected).toMatchObject({ ...upstream, name: "Claude Opus 4.8", variants: ["低", "中", "高"] })
    expect(modelRefOf(projected)).toEqual(upstream)
    expect(withModelVariant(projected, "低")).toMatchObject({
      id: upstream.id,
      providerID: upstream.providerID,
      variant: "低",
    })
    expect(withModelVariant(projected, "不存在").variant).toBeUndefined()
  })
})
