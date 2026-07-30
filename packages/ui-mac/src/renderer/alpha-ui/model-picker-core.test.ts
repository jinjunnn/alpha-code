import { describe, expect, test } from "bun:test"
import type { ModelV2Info } from "@opencode-ai/sdk/v2/client"
import type { EffectiveCatalog, ProviderKeyStatus } from "../../shared/alpha-model-types"
import { byokEngineId } from "../../shared/alpha-model-types"
import { setLocale, t } from "../i18n"
import {
  buildModelPickerRows,
  composerModelFromRef,
  modelRefOf,
  pricingStatusText,
  withModelVariant,
} from "./model-picker-core"

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
  test("平台代理模型与供应商逐项取自目录，不发明 id", () => {
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

// ── REQ-127 #679:计价倍数是平台的,选择器只呈现,不发明 ─────────────────────────────────────
// 删掉的是本地那套写死档位(标准/高级/旗舰 → ×1/×3/×8)。它同时错两次:①对已收录的模型给的是
// 一个与真实倍数无关的数;②对平台刚上线、本地还没收录的模型一律合成最便宜的一档。真实差距是
// claude-fable-5 的 输入 71.4× / 输出 178.6×,而它当时显示「标准 ×1」。
describe("#679 平台计价二态:要么两个真倍数,要么明说不可用", () => {
  /** 带远端 pair 的目录:一个本地收录的模型 + 一个本地快照根本没听说过的模型。 */
  const priced = {
    ...catalog,
    pricingBasisModelId: "deepseek-v4-flash",
    platformModels: [
      ...catalog.platformModels.map((model) =>
        model.id === "claude-fable-5" ? { ...model, pricing: { input: 71.4, output: 178.6 } } : model,
      ),
      { id: "future-model-9", name: "future-model-9", pricing: { input: 2.5, output: 7.5 } },
      { id: "unit-model", name: "Unit", pricing: { input: 1, output: 1 } },
    ],
  } as EffectiveCatalog
  const pricedRows = (over: Partial<Parameters<typeof buildModelPickerRows>[0]> = {}) =>
    rows({
      catalog: priced,
      models: [
        ...priced.platformModels.map((model) => info(priced.platformProvider.id, model.id)),
        ...priced.byokProviders.flatMap((provider) => provider.models.map((id) => info(byokEngineId(provider.id), id))),
      ],
      ...over,
    })
  const rowOf = (id: string, over: Partial<Parameters<typeof buildModelPickerRows>[0]> = {}) =>
    pricedRows(over).find((row) => row.group === "platform" && row.model.id === id)!

  test("平台行原样带上双倍数,且行上不留任何本地档位字段", () => {
    const fable = rowOf("claude-fable-5")
    expect(fable.pricing).toEqual({ input: 71.4, output: 178.6 })
    // 本地快照没收录的线上模型:pair 照样是平台原值,**不合成、不 1×**。
    expect(rowOf("future-model-9").pricing).toEqual({ input: 2.5, output: 7.5 })
    // 结构级:行上不能再冒出任何档位轴 —— 有的话下一次就会有人拿它算价。
    for (const row of pricedRows().filter((entry) => entry.group === "platform"))
      expect(Object.keys(row)).not.toContain("tier")
    for (const row of pricedRows().filter((entry) => entry.group === "platform"))
      expect(Object.keys(row)).not.toContain("mult")
  })

  test("文案是两个倍数、两种语言都是,而且 1 渲染成 1.0(不折叠、不省略)", () => {
    const fable = rowOf("claude-fable-5")
    const unit = rowOf("unit-model")
    try {
      setLocale("zh")
      expect(pricingStatusText(fable)).toBe("输入 71.4× · 输出 178.6×")
      // 折叠成单一 scalar 对至少一侧必然错 —— 两个数必须都在。
      expect(pricingStatusText(fable)).toContain("178.6")
      expect(pricingStatusText(unit)).toBe("输入 1.0× · 输出 1.0×")
      setLocale("en")
      expect(pricingStatusText(fable)).toBe("In 71.4× · Out 178.6×")
      expect(pricingStatusText(unit)).toBe("In 1.0× · Out 1.0×")
    } finally {
      setLocale("zh")
    }
  })

  test("平台行的计价文案只有两个合法取值,没有第三种(白名单,不是「不含 × 与档位词」)", () => {
    // 黑名单挡不住新成员:R1 审计用 `1x`(拉丁字母 x)证明过,一个伪造倍率能同时躲开
    // 「含 ×」与「含档位词」两条。所以这里锁的是**取值本身** —— 平台行的计价文案要么逐字符
    // 等于那一对倍数、要么逐字符等于不可用文案,别的一律不合法。
    const allowed = (row: (typeof mixed)[number]) =>
      row.pricing
        ? t("alpha.model.pricingPair", {
            input: row.pricing.input.toFixed(1),
            output: row.pricing.output.toFixed(1),
          })
        : t("alpha.model.pricingUnavailable")
    // 静态目录(无 V2/LKG,逐行无 pricing)与有 pair 的目录一起过同一条判据。
    const mixed = [...rows(), ...pricedRows()].filter((row) => row.group === "platform")
    expect(mixed.length).toBeGreaterThan(0)
    try {
      for (const locale of ["zh", "en"] as const) {
        setLocale(locale)
        for (const row of mixed) expect(pricingStatusText(row), `${locale} ${row.model.id}`).toBe(allowed(row))
      }
    } finally {
      setLocale("zh")
    }
    // 前提自检:两种形态都真的出现在样本里,否则上面那圈可能只验了其中一种。
    expect(mixed.some((row) => !row.pricing)).toBe(true)
    expect(mixed.some((row) => row.pricing)).toBe(true)
  })

  test("BYOK 与自定义节点没有代理计价,两态一个都不给(给「不可用」也是在暗示它们参与代理计价)", () => {
    const custom = info("my-endpoint", "real-custom-model")
    const all = pricedRows({
      keyStatus: { ...keys, "my-endpoint": { configured: true, source: "config" } },
      models: [
        ...priced.platformModels.map((model) => info(priced.platformProvider.id, model.id)),
        ...priced.byokProviders.flatMap((provider) => provider.models.map((id) => info(byokEngineId(provider.id), id))),
        custom,
      ],
    })
    const nonPlatform = all.filter((row) => row.group !== "platform")
    expect(nonPlatform.length).toBeGreaterThan(0)
    for (const row of nonPlatform) expect(pricingStatusText(row)).toBeNull()
    // 反面:平台组一行都不许是 null —— 两态之一必须给得出来。
    for (const row of all.filter((entry) => entry.group === "platform")) expect(pricingStatusText(row)).not.toBeNull()
  })

  test("平台行带 operational reason 时,计价二态仍然给得出来(二态不被运行态遮住)", () => {
    // needs-credit / loading / unavailable 的平台行都**有** reason。旧实现是 `reason ?? 档位`,
    // 于是这些行两态都不显示。计价与运行态是两件独立的事,这里逐状态钉死。
    const states = ["empty", "loading", "recovering", "failed"] as const
    for (const accountState of states) {
      const platform = pricedRows({ accountState }).filter((row) => row.group === "platform")
      expect(platform.length, accountState).toBeGreaterThan(0)
      for (const row of platform) {
        expect(row.reason, `${accountState} ${row.model.id}`).toBeTruthy()
        expect(pricingStatusText(row), `${accountState} ${row.model.id}`).not.toBeNull()
      }
      expect(pricingStatusText(platform.find((row) => row.model.id === "claude-fable-5")!)).toContain("178.6")
    }
    // 引擎侧的失败态同理。
    for (const listState of ["loading", "recovering", "failed"] as const) {
      const platform = pricedRows({ listState, models: [] }).filter((row) => row.group === "platform")
      for (const row of platform) {
        expect(row.reason, `${listState} ${row.model.id}`).toBeTruthy()
        expect(pricingStatusText(row), `${listState} ${row.model.id}`).not.toBeNull()
      }
    }
  })
})
