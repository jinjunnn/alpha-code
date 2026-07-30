import { describe, expect, test } from "bun:test"
import type { ModelV2Info } from "@opencode-ai/sdk/v2/client"
import type { EffectiveCatalog, ProviderKeyStatus } from "../../shared/alpha-model-types"
import { byokEngineId } from "../../shared/alpha-model-types"
import { t } from "../i18n"
import { buildModelPickerRows, composerModelFromRef, modelRefOf, withModelVariant } from "./model-picker-core"

const catalog = {
  ...(await Bun.file(new URL("../../main/alpha-models.json", import.meta.url)).json()),
  liveSync: { status: "static" },
  // #681:平台段没有有效 V2/LKG 时 basis 为 null(该 stub 不带远端目录)。
  pricingBasisModelId: null,
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
      // The engine lists injected BYOK models under the engine id (`<id>-byok`), not the display id.
      ...catalog.byokProviders.flatMap((provider) => provider.models.map((id) => info(byokEngineId(provider.id), id))),
    ],
    listState: "ready",
    keyStatusState: "ready",
    keyStatus: keys,
    accountState: "member",
    sessionScoped: false,
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
    expect(byok.filter((row) => row.model.providerID === byokEngineId("deepseek")).map((row) => row.model.id)).toEqual(
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
    const failed = rows({ keyStatusState: "failed", keyStatus: {} })

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

  test("contract 加载失败时平台侧 fail-closed：目录仍可辨认，但没有代理模型伪装可用", () => {
    const failed = rows({ listState: "failed", models: [] })
    const platform = failed.filter((row) => row.group === "platform")
    expect(platform.some((row) => row.availability === "available")).toBe(false)
    expect(failed.find((row) => row.model.providerID === "alpha")?.reason).toBe(t("alpha.model.listUnavailable"))
    // 未配 KEY 的 BYOK 供应商仍是「点击配置」,不被引擎故障改写成「暂不可用」。
    expect(failed.find((row) => row.model.providerID === "zhipuai")?.availability).toBe("needs-key")
  })

  test("恢复窗口保留已渲染目录行；平台行标为同步中", () => {
    const ready = rows()
    const recovering = rows({ listState: "recovering" })
    const previouslyAvailable = ready.filter((row) => row.group === "platform" && row.availability === "available")
    const recoveringAvailable = recovering.filter((row) =>
      previouslyAvailable.some((previous) => previous.key === row.key),
    )

    expect(recovering.map((row) => row.key)).toEqual(ready.map((row) => row.key))
    expect(recoveringAvailable.length).toBeGreaterThan(0)
    expect(recoveringAvailable.every((row) => row.availability === "loading")).toBe(true)
    expect(recoveringAvailable.every((row) => row.reason === t("alpha.model.syncing"))).toBe(true)
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

// ── REQ-109 #595:两个独立谓词 ───────────────────────────────────────────────────────────────────
//   「BYOK 本地可选择」= 本地目录存在模型 + 本地 KEY 已配置;
//   「当前可执行」     = 引擎已恢复。
// 登录态、账户额度、平台连通、live allowlist、引擎 model.list 内容一律不得否定前者。
// 契约:docs/contracts/byok-availability.md。
describe("BYOK 可选择性脱离登录 / 平台 / 引擎清单(#595)", () => {
  const deepseekModels = catalog.byokProviders.find((provider) => provider.id === "deepseek")!.models
  const deepseekRows = (over: Partial<Parameters<typeof buildModelPickerRows>[0]> = {}) =>
    rows(over).filter((row) => row.model.providerID === byokEngineId("deepseek"))

  test("退出条件 1:未登录 + KEY 已配置 → BYOK 行可见可选,不是「正在同步」", () => {
    const actual = deepseekRows({ accountState: "out" })
    expect(actual.map((row) => row.model.id)).toEqual(deepseekModels)
    expect(actual.every((row) => row.availability === "available")).toBe(true)
    expect(actual.every((row) => row.engineIndependent === true)).toBe(true)
    expect(actual.some((row) => row.reason === t("alpha.model.syncing"))).toBe(false)
    expect(actual.every((row) => row.reason === undefined)).toBe(true)
  })

  test("退出条件 2:listState recovering + KEY 已配置 → 仍可选,行内状态是「引擎重启中」而非「正在同步」", () => {
    const actual = deepseekRows({ listState: "recovering" })
    expect(actual.map((row) => row.model.id)).toEqual(deepseekModels)
    expect(actual.every((row) => row.availability === "available")).toBe(true)
    expect(actual.every((row) => row.reason === t("alpha.model.byokEngineRestarting"))).toBe(true)
    expect(actual.some((row) => row.reason === t("alpha.model.syncing"))).toBe(false)
  })

  test("退出条件 3:引擎清单缺 `<id>-byok` 全部行(甚至 listState failed)→ BYOK 行仍可选", () => {
    const missing = deepseekRows({ models: platformModels })
    expect(missing.map((row) => row.model.id)).toEqual(deepseekModels)
    expect(missing.every((row) => row.availability === "available")).toBe(true)

    // 引擎明确回报 disabled / deprecated 也不再撤销可选择性 —— 引擎不是最终裁判。
    const disabled = deepseekRows({
      models: [
        ...platformModels,
        ...deepseekModels.map((id) => info(byokEngineId("deepseek"), id, false, "deprecated")),
      ],
    })
    expect(disabled.every((row) => row.availability === "available")).toBe(true)

    const failed = deepseekRows({ listState: "failed", models: [] })
    expect(failed.map((row) => row.model.id)).toEqual(deepseekModels)
    expect(failed.every((row) => row.availability === "available")).toBe(true)
  })

  test("封闭输入集:平台/账户/引擎的任何状态组合都不改变 BYOK 行(只有本地 KEY 与本地目录说话)", () => {
    const baseline = deepseekRows()
    const shape = (list: ReturnType<typeof deepseekRows>) =>
      list.map((row) => `${row.key}|${row.model.providerID}|${row.availability}`)
    const accountStates = ["member", "balance", "empty", "out", "loading", "recovering", "failed"] as const
    for (const accountState of accountStates)
      expect(shape(deepseekRows({ accountState }))).toEqual(shape(baseline))
    // 平台段被 live 清单收窄到空(平台不可达 / edition 收窄)也不动 BYOK 段。
    expect(
      shape(deepseekRows({ catalog: { ...catalog, platformModels: [] }, models: [] })),
    ).toEqual(shape(baseline))

    // 反面:未配 KEY 仍然是 needs-key(主权不等于伪装已配 KEY)。
    const unkeyed = rows({ keyStatus: {} }).filter((row) => row.group === "byok")
    expect(unkeyed.every((row) => row.availability === "needs-key")).toBe(true)
    expect(unkeyed.some((row) => row.engineIndependent)).toBe(false)
  })

  test("#595 Minor:session 与 home 的恢复中文案分开 —— session 不得说「可先选择」", () => {
    const home = deepseekRows({ listState: "recovering" })
    const session = deepseekRows({ listState: "recovering", sessionScoped: true })
    expect(home.every((row) => row.reason === t("alpha.model.byokEngineRestarting"))).toBe(true)
    expect(session.every((row) => row.reason === t("alpha.model.byokEngineRestartingSession"))).toBe(true)
    expect(session.some((row) => row.reason === t("alpha.model.byokEngineRestarting"))).toBe(false)
    // 可选择性本身与模式无关(谓词 1 是行的属性,不是模式的属性)。
    expect(session.every((row) => row.availability === "available")).toBe(true)
    // 引擎 ready 时两种模式都不带恢复中文案。
    expect(deepseekRows({ sessionScoped: true }).every((row) => row.reason === undefined)).toBe(true)
  })

  test("engineIndependent 只标本地 BYOK 目录行:平台行与自定义节点行都不带", () => {
    const custom = info("my-endpoint", "real-custom-model")
    const actual = rows({
      keyStatus: { ...keys, "my-endpoint": { configured: true, source: "config" } },
      models: [...platformModels, custom],
    })
    expect(actual.filter((row) => row.engineIndependent).map((row) => row.model.providerID)).toEqual(
      deepseekModels.map(() => byokEngineId("deepseek")),
    )
    expect(actual.find((row) => row.model.providerID === "my-endpoint")?.engineIndependent).toBeUndefined()
    expect(actual.find((row) => row.group === "platform")?.engineIndependent).toBeUndefined()
  })
})
