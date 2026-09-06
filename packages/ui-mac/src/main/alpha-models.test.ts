// Unit tests for the sidecar-injected model config assembly (alpha-models.ts). This is the load-bearing
// logic that decides which providers/models opencode sees: BYOK direct nodes (only when keyed), the
// alpha platform gateway (only when ALPHA_BASE_URL is set AND the key file exists), and user custom
// providers merged into the hard allowlist. Since A6, "keyed" means the secret FILE exists under
// <userData>/alpha-secrets (written by main's syncSecretFiles at fork) — env vars alone must NOT
// activate a provider, and apiKey fields must be {file:} refs, never inlined values.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { projectPlatformModels, readCatalogSnapshot, writeCatalogSnapshot } from "./alpha-live-allowlist"
import { buildAlphaModelConfig, getModelCatalog } from "./alpha-models"
import type { EffectiveCatalog } from "../shared/alpha-model-types"
import { buildModelPickerRows } from "../renderer/alpha-ui/model-picker-core"
import { secretFilePath, syncSecretFiles } from "./alpha-secret-files"
import { persistProviderAndRefresh, setProviderLifecycleDeps } from "./provider-lifecycle"

// Every env var this module reads — snapshot + restore so tests don't leak into each other or the host.
const MANAGED = [
  "ALPHA_MODELS_DISABLE",
  "ALPHA_BASE_URL",
  "ALPHA_API_KEY",
  "ALPHA_DEFAULT_MODEL",
  "DEEPSEEK_API_KEY",
  "ZHIPU_API_KEY",
  "MINIMAX_API_KEY",
  "DASHSCOPE_API_KEY",
  "MOONSHOT_API_KEY",
  "ALPHA_GLOBAL_DIR",
  "OPENCODE_CONFIG_DIR",
]
const saved: Record<string, string | undefined> = {}
let tmp = ""
let userData = ""

/** Plant a secret in the {file:} channel the way main's syncSecretFiles would. */
const plantSecret = (varName: string, value: string) => {
  fs.mkdirSync(path.dirname(secretFilePath(userData, varName)), { recursive: true })
  fs.writeFileSync(secretFilePath(userData, varName), value, { mode: 0o600 })
}

beforeEach(() => {
  for (const k of MANAGED) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  // Empty config dir → readUserProviderIds() sees no user providers (isolates the byok/gateway logic).
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-models-"))
  process.env.ALPHA_GLOBAL_DIR = path.join(fs.realpathSync(tmp), "alpha-code-state", "env", "dev")
  fs.mkdirSync(process.env.ALPHA_GLOBAL_DIR, { recursive: true })
  process.env.OPENCODE_CONFIG_DIR = tmp
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-models-userdata-"))
})
afterEach(() => {
  setProviderLifecycleDeps()
  for (const k of MANAGED) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  for (const dir of [tmp, userData]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

describe("getModelCatalog", () => {
  test("exposes the catalog with the expected shape", () => {
    const c = getModelCatalog()
    expect(c.platformProvider?.id).toBe("alpha")
    expect(Array.isArray(c.byokProviders)).toBe(true)
    expect(c.byokProviders.some((p) => p.id === "deepseek")).toBe(true)
  })
})

describe("buildAlphaModelConfig — escape hatch + empty state", () => {
  test("ALPHA_MODELS_DISABLE=1 returns undefined (opencode uses its own defaults)", () => {
    process.env.ALPHA_MODELS_DISABLE = "1"
    expect(buildAlphaModelConfig(userData)).toBeUndefined()
  })

  test("no key files / no gateway / no user providers → empty allowlist, no forced default", () => {
    const cfg = buildAlphaModelConfig(userData)
    expect(cfg).toBeDefined()
    expect(cfg!.enabled_providers).toEqual([])
    expect(cfg!.provider).toEqual({})
    // defaultModel is null in the catalog and no env override → never force a `model`
    expect(cfg!.model).toBeUndefined()
  })
})

describe("buildAlphaModelConfig — BYOK direct nodes (only when the key FILE exists)", () => {
  test("an openai-compat provider is injected only when its key file exists, with a {file:} ref", () => {
    plantSecret("DEEPSEEK_API_KEY", "sk-deepseek-123")
    const cfg = buildAlphaModelConfig(userData)!
    expect(cfg.enabled_providers).toContain("deepseek-byok")
    const p = cfg.provider["deepseek-byok"] as any
    expect(p.npm).toBe("@ai-sdk/openai-compatible")
    // the ref is a path token, never the value — OPENCODE_CONFIG_CONTENT must stay secret-free (A6)
    expect(p.options.apiKey).toBe(`{file:${secretFilePath(userData, "DEEPSEEK_API_KEY")}}`)
    expect(p.options.apiKey).not.toContain("sk-deepseek-123")
    expect(Object.keys(p.models).length).toBeGreaterThan(0)
  })

  test("zhipuai (catalog BYOK) is openai-compat with the paas/v4 endpoint", () => {
    plantSecret("ZHIPU_API_KEY", "sk-zhipu-xyz")
    const p = buildAlphaModelConfig(userData)!.provider["zhipuai-byok"] as any
    expect(p.npm).toBe("@ai-sdk/openai-compatible")
    expect(p.options.baseURL).toBe("https://open.bigmodel.cn/api/paas/v4")
    expect(p.options.apiKey).toBe(`{file:${secretFilePath(userData, "ZHIPU_API_KEY")}}`)
  })

  // REQ-074 URL convention (S34 真机批定稿): catalog BYOK providers must ALL be openai-compat.
  // Engine mechanism (upstream provider.ts apiNpm chain): models merged from models.dev keep
  // models.dev's npm (@ai-sdk/openai-compatible) while only models DECLARED in our config get our
  // provider.npm — so an anthropic-compat catalog entry produces mixed SDKs hitting one baseURL
  // (openai join on an anthropic URL = dead route; zhipuai glm-5.1 regression, loud 404 / silent
  // 200-wrapped depending on gateway). anthropic compat stays available for user-added custom
  // nodes only (their model list is exactly what they declare).
  test("every catalog BYOK provider is openai-compat with a clean https baseURL", () => {
    for (const p of getModelCatalog().byokProviders) {
      expect({ id: p.id, compat: p.compat }).toEqual({ id: p.id, compat: "openai" })
      expect({ id: p.id, ok: /^https:\/\/.+[^/]$/.test(p.baseURL) }).toEqual({ id: p.id, ok: true })
    }
  })

  test("an env var ALONE no longer activates a provider (the sidecar env carries no keys, A6)", () => {
    process.env.DEEPSEEK_API_KEY = "sk-deepseek-123"
    const cfg = buildAlphaModelConfig(userData)!
    expect(cfg.provider["deepseek-byok"]).toBeUndefined()
    expect(cfg.enabled_providers).not.toContain("deepseek-byok")
  })

  test("keyless catalog providers are NOT injected", () => {
    const cfg = buildAlphaModelConfig(userData)!
    expect(cfg.provider["deepseek-byok"]).toBeUndefined()
    expect(cfg.provider["moonshot-byok"]).toBeUndefined()
  })

  test("syncSecretFiles(main) → buildAlphaModelConfig(sidecar) round-trips end to end", () => {
    syncSecretFiles(userData, { DEEPSEEK_API_KEY: "sk-rt" })
    expect(buildAlphaModelConfig(userData)!.enabled_providers).toContain("deepseek-byok")
    // revocation flows through: key removed → file deleted → provider gone on next fork
    syncSecretFiles(userData, {})
    expect(buildAlphaModelConfig(userData)!.enabled_providers).not.toContain("deepseek-byok")
  })
})

describe("buildAlphaModelConfig — platform gateway (代发)", () => {
  test("the alpha platform provider joins the FRONT of the allowlist when ALPHA_BASE_URL + key file are set", () => {
    process.env.ALPHA_BASE_URL = "https://gw.example/v1"
    plantSecret("ALPHA_API_KEY", "jwt-abc")
    plantSecret("DEEPSEEK_API_KEY", "sk-deepseek-123") // a BYOK node too, to prove ordering
    const cfg = buildAlphaModelConfig(userData)!
    expect(cfg.enabled_providers[0]).toBe("alpha") // unshifted to the front
    const p = cfg.provider.alpha as any
    expect(p.options.baseURL).toBe("https://gw.example/v1")
    // key is fronted by ALPHA (代发) as a {file:} ref, never inlined and never an env ref
    expect(p.options.apiKey).toBe(`{file:${secretFilePath(userData, "ALPHA_API_KEY")}}`)
    expect(Object.keys(p.models).length).toBeGreaterThan(0)
  })

  test("without ALPHA_BASE_URL there is no platform provider", () => {
    plantSecret("ALPHA_API_KEY", "jwt-abc")
    expect(buildAlphaModelConfig(userData)!.provider.alpha).toBeUndefined()
  })

  test("without the ALPHA_API_KEY file there is no platform provider (no doomed 401 node)", () => {
    process.env.ALPHA_BASE_URL = "https://gw.example/v1"
    expect(buildAlphaModelConfig(userData)!.provider.alpha).toBeUndefined()
  })
})

describe("buildAlphaModelConfig — default model + user providers", () => {
  test("ALPHA_DEFAULT_MODEL overrides the (null) catalog default", () => {
    process.env.ALPHA_DEFAULT_MODEL = "deepseek/deepseek-chat"
    expect(buildAlphaModelConfig(userData)!.model).toBe("deepseek/deepseek-chat")
  })

  test("user custom providers in opencode.jsonc are merged into the allowlist (survive the hard reset)", () => {
    fs.writeFileSync(
      path.join(tmp, "opencode.jsonc"),
      JSON.stringify({ provider: { myco: { npm: "@ai-sdk/openai-compatible", options: {} } } }),
    )
    const cfg = buildAlphaModelConfig(userData)!
    expect(cfg.enabled_providers).toContain("myco")
  })

  test("providers.add 的真实保存→respawn 装配链把 custom id 带进下一 fork enabled_providers", async () => {
    let refreshed: ReturnType<typeof buildAlphaModelConfig>
    let refreshes = 0
    setProviderLifecycleDeps({
      refreshRuntime: async () => {
        refreshes++
        refreshed = buildAlphaModelConfig(userData)
        return true
      },
    })

    const result = await persistProviderAndRefresh({
      id: "custom-node",
      name: "Custom Node",
      compat: "openai",
      baseURL: "https://custom.invalid/v1",
      apiKey: "sk-test",
      models: ["real-custom-model"],
    })

    expect(result).toEqual({ ok: true })
    expect(refreshes).toBe(1)
    expect(refreshed!.enabled_providers).toContain("custom-node")
  })
})

describe("buildAlphaModelConfig — REQ-001 edition 白名单(catalog LKG)", () => {
  // #681:快照硬切 V2 —— basis 与逐行 pair 是同一份不可拆 snapshot 的一部分,写侧会按同一判据校验。
  const liveBase = { fetchedAt: "2026-07-03T00:00:00Z", edition: "cn", pricingBasisModelId: "deepseek-v4-flash" }
  const pair = { input: 1, output: 1 }

  // REQ-109 #595(owner 裁决):live allowlist 不再收窄 BYOK —— 注入只看本地目录 + 本地 KEY 文件。
  test("#595 退出条件 4:live 清单只列 deepseek,zhipu 的 keyed 节点照样注入(平台无权收窄 BYOK)", () => {
    plantSecret("DEEPSEEK_API_KEY", "sk-1")
    plantSecret("ZHIPU_API_KEY", "sk-2")
    writeCatalogSnapshot(userData, { ...liveBase, models: [{ id: "deepseek-v4-flash", pricing: pair }] })
    const cfg = buildAlphaModelConfig(userData)!
    expect(cfg.enabled_providers).toContain("deepseek-byok")
    expect(cfg.provider["zhipuai-byok"]).toBeDefined()
    expect(cfg.enabled_providers).toContain("zhipuai-byok")
  })

  test("#595:旧缓存里残留的 byokProviders 收窄字段已无消费方,两个 keyed 节点都注入", () => {
    plantSecret("DEEPSEEK_API_KEY", "sk-1")
    plantSecret("ZHIPU_API_KEY", "sk-2")
    fs.writeFileSync(
      path.join(userData, "alpha-live-models.json"),
      JSON.stringify({ ...liveBase, byokProviders: ["deepseek"], models: [] }),
    )
    const cfg = buildAlphaModelConfig(userData)!
    expect(cfg.enabled_providers).toContain("deepseek-byok")
    expect(cfg.enabled_providers).toContain("zhipuai-byok")
  })

  test("平台模型以 live 清单为准:snapshot 名称富化,未知 id 诚实用 id 本名", () => {
    process.env.ALPHA_BASE_URL = "https://gw.example/v1"
    plantSecret("ALPHA_API_KEY", "jwt")
    writeCatalogSnapshot(userData, {
      ...liveBase,
      models: [
        { id: "deepseek-v4-flash", pricing: pair },
        { id: "brand-new-model", pricing: { input: 2.5, output: 7.5 } },
      ],
    })
    const p = buildAlphaModelConfig(userData)!.provider.alpha as any
    expect(Object.keys(p.models).sort()).toEqual(["brand-new-model", "deepseek-v4-flash"])
    const snapshotName = getModelCatalog().platformModels.find((m) => m.id === "deepseek-v4-flash")!.name
    expect(p.models["deepseek-v4-flash"].name).toBe(snapshotName)
    expect(p.models["brand-new-model"].name).toBe("brand-new-model")
  })

  test("REQ-029:variants(推理档)随 snapshot 下发到 provider config(echo 实验实锤 wire 形状)", () => {
    process.env.ALPHA_BASE_URL = "https://gw.example/v1"
    plantSecret("ALPHA_API_KEY", "jwt")
    const p = buildAlphaModelConfig(userData)!.provider.alpha as any
    const opus = p.models["claude-opus-4.8"]
    expect(opus.variants["高"]).toEqual({ reasoning: { effort: "high" } }) // OR 统一 reasoning 对象
    const mini = p.models["gpt-5.4-mini"]
    expect(mini.variants["低"]).toEqual({ reasoningEffort: "low" }) // 原生 → reasoning_effort
    // anthropic-wire 不映射 → 诚实不定义(#679 把非规范 id `claude-opus-4.8-direct` 从本地快照
    // 移除后,同类的取样换成仍在册的 claude-sonnet-5)。
    expect(p.models["claude-sonnet-5"].variants).toBeUndefined()
    expect(p.models["deepseek-v4-flash"].variants).toBeUndefined()
  })

  // #681:这条断言一字未改,而它现在证明的东西更强了 —— 空清单在**写侧**就被拒(合法 LKG 不被
  // 覆盖),读侧因此看到「无快照」,于是引擎配置回退静态 snapshot。此前 picker 与 sidecar 各写一份
  // 判据,空缓存时一边 0 行、一边静态 9 行;分叉被消灭后两侧同为静态全量。
  test("live models 空数组 → 回退 snapshot(空白名单按坏配置处理,fail-open 不出空目录)", () => {
    process.env.ALPHA_BASE_URL = "https://gw.example/v1"
    plantSecret("ALPHA_API_KEY", "jwt")
    writeCatalogSnapshot(userData, { ...liveBase, models: [] })
    const p = buildAlphaModelConfig(userData)!.provider.alpha as any
    expect(Object.keys(p.models).length).toBe(getModelCatalog().platformModels.length)
  })

  test("用户自定义 provider 不受白名单约束(2026-07-03 拍板:目录跟随 edition,自定义不拦)", () => {
    writeCatalogSnapshot(userData, { ...liveBase, models: [] })
    fs.writeFileSync(
      path.join(tmp, "opencode.jsonc"),
      JSON.stringify({ provider: { myco: { npm: "@ai-sdk/openai-compatible", options: {} } } }),
    )
    expect(buildAlphaModelConfig(userData)!.enabled_providers).toContain("myco")
  })

  test("缓存损坏 → 视同无缓存(内置 snapshot,不 throw)", () => {
    process.env.ALPHA_BASE_URL = "https://gw.example/v1"
    plantSecret("ALPHA_API_KEY", "jwt")
    fs.writeFileSync(path.join(userData, "alpha-live-models.json"), "{corrupt")
    const p = buildAlphaModelConfig(userData)!.provider.alpha as any
    expect(Object.keys(p.models).length).toBe(getModelCatalog().platformModels.length)
  })
})

// REQ-153 #1236:目录里的 `reasoning` 是引擎 `capabilities.reasoning` 的唯一来源(config schema
// core/src/v1/config/provider.ts:14 → provider/provider.ts:1457;`alpha` / `<id>-byok` 在 models.dev 里
// 没有条目,fallback 恒 false)。此前注入只写 name/variants ⇒ 引擎里**每个**模型都不会思考,
// transform.ts:712 首行 `return {}`;而 picker 读的是 JSON 的 `reasoning` ⇒ 徽标亮着说假话。
// 判据:注入的 reasoning 集合 == 目录声明集合 == picker 徽标集合。三者缺一都是两份判据。
describe("REQ-153 #1236:目录 `reasoning` 转发进引擎配置,徽标与引擎能力同源", () => {
  const liveBase = { fetchedAt: "2026-09-06T00:00:00Z", edition: "cn", pricingBasisModelId: "deepseek-v4-flash" }
  const pair = { input: 1, output: 1 }
  const keyEverything = () => {
    for (const p of getModelCatalog().byokProviders) plantSecret(p.keyEnv, `sk-${p.id}`)
    process.env.ALPHA_BASE_URL = "https://gw.example/v1"
    plantSecret("ALPHA_API_KEY", "jwt")
  }
  /** 引擎会读到 `reasoning: true` 的 `<providerID>:<modelID>` 全集(providerID = 注入用的引擎 id)。 */
  const injectedReasoning = (cfg: NonNullable<ReturnType<typeof buildAlphaModelConfig>>) => {
    const out: string[] = []
    for (const [providerID, provider] of Object.entries(cfg.provider)) {
      const models = (provider as { models: Record<string, { reasoning?: boolean }> }).models
      for (const [modelID, model] of Object.entries(models)) if (model.reasoning === true) out.push(`${providerID}:${modelID}`)
    }
    return out.sort()
  }

  test("平台段:JSON 标 reasoning:true 的每个模型注入后带 reasoning:true;未标的**缺席**(不是 false)", () => {
    keyEverything()
    const p = buildAlphaModelConfig(userData)!.provider.alpha as { models: Record<string, { reasoning?: boolean }> }
    const flagged = getModelCatalog().platformModels.filter((m) => m.reasoning).map((m) => m.id)
    // 空集会让下面的逐项断言空转 —— 先钉住集合非空,且含本票实打确认「默认即思考」的 glm-5.2。
    expect(flagged.length).toBeGreaterThan(0)
    expect(flagged).toContain("glm-5.2")
    for (const m of getModelCatalog().platformModels) {
      expect({ id: m.id, reasoning: p.models[m.id]?.reasoning }).toEqual({ id: m.id, reasoning: m.reasoning ? true : undefined })
    }
  })

  test("BYOK 段:同名平台条目标 reasoning 的模型注入后带 reasoning:true(与 picker 的 BYOK 徽标同一派生)", () => {
    plantSecret("DEEPSEEK_API_KEY", "sk-1")
    plantSecret("ZHIPU_API_KEY", "sk-2")
    const cfg = buildAlphaModelConfig(userData)!
    const deepseek = (cfg.provider["deepseek-byok"] as { models: Record<string, { reasoning?: boolean }> }).models
    const zhipu = (cfg.provider["zhipuai-byok"] as { models: Record<string, { reasoning?: boolean }> }).models
    // #1266 起同名条目的 variants 也一并派生(见下一条),这里只看 reasoning 与「未标即缺席」。
    expect(deepseek["deepseek-v4-pro"]).toMatchObject({ name: "deepseek-v4-pro", reasoning: true })
    expect(deepseek["deepseek-v4-flash"]).toEqual({ name: "deepseek-v4-flash" })
    expect(zhipu["glm-5.2"]).toMatchObject({ name: "glm-5.2", reasoning: true })
    // #1267:BYOK-only 的 glm-4.5-air 没有平台同名条目,徽标来自目录自己的 modelMeta 槽(下一节逐字判)。
    expect(zhipu["glm-4.5-air"]).toMatchObject({ name: "glm-4.5-air", reasoning: true })
  })

  // REQ-153 #1266:BYOK 段的 `variants` 与平台同名条目逐字相同,且与 picker BYOK 行的档位列表同源。
  // 此前注入不写 variants、picker 写死 `[]` ⇒ 直连 deepseek-v4-pro / glm-5.2 亮着徽标一档都选不到。
  // 档位表的 wire 形状按平台 provider 的 npm 写,直连节点能复用的前提是每个 BYOK provider 都是
  // openai-compat(上面「every catalog BYOK provider is openai-compat」那条钉着)——这里再钉 npm 逐字相等。
  test("BYOK 段:同名平台条目的 variants 逐字注入;无同名条目的 BYOK-only id 只从自己的 modelMeta 槽拿;npm 与平台 provider 相同", () => {
    keyEverything()
    const cfg = buildAlphaModelConfig(userData)!
    const platform = getModelCatalog().platformModels
    const platformNpm = getModelCatalog().platformProvider.npm
    let derived = 0
    let own = 0
    for (const provider of getModelCatalog().byokProviders) {
      const injected = cfg.provider[`${provider.id}-byok`] as { npm: string; models: Record<string, { variants?: unknown }> }
      expect({ provider: provider.id, npm: injected.npm }).toEqual({ provider: provider.id, npm: platformNpm })
      for (const id of provider.models) {
        const slot = provider.modelMeta?.[id]
        const twin = platform.find((model) => model.id === id)
        const expected = slot ? slot.variants : twin?.variants
        expect({ provider: provider.id, id, variants: injected.models[id]?.variants }).toEqual({ provider: provider.id, id, variants: expected })
        if (slot?.variants) own++
        else if (twin?.variants) derived++
      }
    }
    // 空集会让上面的逐项断言空转:至少两个直连模型真的从平台同名条目派生到了档位,至少一个从自己的槽拿到。
    expect(derived).toBeGreaterThanOrEqual(2)
    expect(own).toBeGreaterThanOrEqual(1)
  })

  // REQ-153 #1267:BYOK-only id(平台无同名条目)的徽标 / 档位来自 `byokProviders[].modelMeta` 槽。上游
  // transform.options() 对 zhipuai* + openai-compatible 无条件写 thinking:enabled,此前 glm-4.5-air 无徽标、
  // 零档,请求却锁在思考档;`关` 档(thinking.type=disabled)是用户关掉它的唯一途径,而它要被引擎查到就必须
  // 从这里逐字注入(engine provider.ts:1507 把 config variants 与自己派生的表 mergeDeep)。
  // 槽的形状纪律(读它的只有 byokModelMeta,所以这里必须替它把关):
  //   · 键 ∈ 该 provider 的 models —— 打错 id 的槽是静默 no-op,徽标不亮、档位不出、无人变红;
  //   · 键不得与平台同名条目重叠 —— 一个 id 两处元数据 = 两份判据,「显式优先」不该在出货目录上被触发;
  //   · 显式关闭档的 wire 值必须逐字 `disabled`:智谱 2026-09-06 实打,`type` 写错会被上游静默忽略并继续思考(HTTP 仍 200)。
  test("#1267:glm-4.5-air 的 modelMeta 槽逐字注入(reasoning:true + 开/关);槽键 ∈ models 且不与平台同名条目重叠;关档 wire 值逐字 disabled", () => {
    keyEverything()
    const cfg = buildAlphaModelConfig(userData)!
    const catalog = getModelCatalog()
    const zhipu = (cfg.provider["zhipuai-byok"] as { models: Record<string, { name: string; reasoning?: boolean; variants?: Record<string, Record<string, unknown>> }> }).models
    const slot = catalog.byokProviders.find((provider) => provider.id === "zhipuai")!.modelMeta!["glm-4.5-air"]!
    expect(slot).toEqual({
      name: "GLM-4.5-Air",
      reasoning: true,
      variants: { 开: { thinking: { type: "enabled" } }, 关: { thinking: { type: "disabled" } } },
    })
    expect(zhipu["glm-4.5-air"]).toEqual({ name: "glm-4.5-air", reasoning: true, variants: slot.variants })

    const platformIds = new Set(catalog.platformModels.map((model) => model.id))
    let slots = 0
    for (const provider of catalog.byokProviders) {
      for (const [id, meta] of Object.entries(provider.modelMeta ?? {})) {
        slots++
        expect({ provider: provider.id, id, listed: provider.models.includes(id) }).toEqual({ provider: provider.id, id, listed: true })
        expect({ provider: provider.id, id, overlapsPlatform: platformIds.has(id) }).toEqual({ provider: provider.id, id, overlapsPlatform: false })
        // 徽标 ⇒ 有档(#1266 的不变量对槽同样成立);每个显式关闭档的值逐字是 disabled。
        expect({ provider: provider.id, id, badgeImpliesVariants: !meta.reasoning || Object.keys(meta.variants ?? {}).length > 0 }).toEqual({ provider: provider.id, id, badgeImpliesVariants: true })
        for (const [label, options] of Object.entries(meta.variants ?? {})) {
          const thinking = (options as { thinking?: { type?: unknown } }).thinking
          if (thinking) expect({ provider: provider.id, id, label, type: thinking.type }).toEqual({ provider: provider.id, id, label, type: ["enabled", "disabled"].includes(String(thinking.type)) ? thinking.type : "<enabled|disabled>" })
        }
      }
    }
    expect(slots).toBeGreaterThanOrEqual(1) // 零个槽会让上面的逐项断言空转
  })

  test("徽标集合 == 引擎注入 reasoning 集合 —— 同一份目录、同一份 live 快照,两边必须走同一投影", () => {
    keyEverything()
    // live 快照收窄平台段(且把一个未标 reasoning 的模型留在册上):picker 与注入若各查一份目录,
    // 这里就会分叉。
    writeCatalogSnapshot(userData, {
      ...liveBase,
      models: [
        { id: "glm-5.2", pricing: pair },
        { id: "deepseek-v4-pro", pricing: pair },
        { id: "claude-fable-5", pricing: pair },
      ],
    })
    const cfg = buildAlphaModelConfig(userData)!
    const injected = injectedReasoning(cfg)

    const base = getModelCatalog()
    const catalog: EffectiveCatalog = {
      ...base,
      platformModels: projectPlatformModels(base.platformModels, readCatalogSnapshot(userData)),
      liveSync: { status: "cache" },
      pricingBasisModelId: liveBase.pricingBasisModelId,
    }
    const rows = buildModelPickerRows({
      catalog,
      models: [],
      listState: "ready",
      keyStatusState: "ready",
      keyStatus: Object.fromEntries(base.byokProviders.map((p) => [p.id, { configured: true, source: "keychain" as const }])),
      accountState: "member",
      sessionScoped: false,
      query: "",
    })
    const badged = rows
      .filter((row) => row.reasoning)
      .map((row) => `${row.model.providerID}:${row.model.id}`)
      .sort()

    expect(badged.length).toBeGreaterThan(0)
    expect(injected).toEqual(badged)
    // 反例钉死方向:快照里未标 reasoning 的 claude-fable-5 两边都不亮;deepseek BYOK 的 v4-flash 也不亮。
    expect(badged).not.toContain("alpha:claude-fable-5")
    expect(badged).not.toContain("deepseek-byok:deepseek-v4-flash")
    expect(badged).toContain("alpha:glm-5.2")
    expect(badged).toContain("zhipuai-byok:glm-5.2")
    // #1267:BYOK-only 的槽也在同一集合里 —— 平台快照收窄不影响它(它根本不从平台派生)。
    expect(badged).toContain("zhipuai-byok:glm-4.5-air")
  })
})

// REQ-153 #1237:档位**形状**逐腿取自实打表;没实打过的 (引擎 provider, model) 钉在无档。
// v1 作废的原因(票面正文):它假设「config 声明 ⇒ 发到上游 ⇒ 生效」,而两个环节实测都断过 ——
// 网关曾整个丢掉推理字段(alpha-platform#423,已修),智谱直连对非 5.2 的 GLM 压根不校验 `reasoning_effort`
// (`bogus-value` 照样 200、`none` 仍满额思考)。**受理 ≠ 有效**,且**同一模型经直连与经 OpenRouter 形状不同**。
// 所以这里的判据不是「有没有档位」,是「每一个注入引擎的档位表,逐字等于那条腿实打出来的表」:
//   · 表的键是**引擎侧** `<providerID>:<modelID>`,不是目录条目 —— byokModelMeta 会把平台同名条目的档位派生进
//     直连节点,派生出来的那份走的是另一条腿(直连),必须单独入表;
//   · 每行的 evidence 只写读数支持的部分(alpha-platform docs/architecture/openai-wire-reasoning-controls.md §3
//     的逐格读数;本票对 qwen 经 OR 的 N=3 复打记在 docs/architecture/2026-09-06-model-variant-reachability.md §8);
//   · 本机无凭据、一格没打成的模型(qwen / kimi / minimax 直连)**显式**列入无档清单并断言它真的被注入且无档 ——
//     否则下一个人会顺手照 models.dev 文案给它们补上,那正是 v1 作废的形态;
//   · 上游 `transform.smallOptions()` 把档位表**第一项**喂给标题等辅助调用(`request.ts:88-89`,基线 §3.8a),
//     所以凡有显式关闭档的模型,「关」必须排第一 —— 判据在这里,机制本身由 alpha-reasoning-badge-parity 用真引擎证。
// 判官是纯函数,先用已知的坏证明它会红(v1 的 GLM 形状、给未验模型补档、关闭档写错值、关档不在第一位、
// 实打表登记的档位从注入里消失),再判出货目录。
describe("REQ-153 #1237:档位形状逐腿取自实打表;未实打的模型钉在无档", () => {
  type Tiers = Record<string, Record<string, unknown>>
  type InjectedModel = { name: string; reasoning?: boolean; variants?: Tiers }
  type Injected = { provider: Record<string, { models: Record<string, InjectedModel> }> }
  const DOC = "alpha-platform docs/architecture/openai-wire-reasoning-controls.md"
  const REACH = "docs/architecture/2026-09-06-model-variant-reachability.md"
  const effort = (...tiers: [string, string][]): Tiers => Object.fromEntries(tiers.map(([label, value]) => [label, { reasoningEffort: value }]))
  const orEffort = (...tiers: [string, string][]): Tiers => Object.fromEntries(tiers.map(([label, value]) => [label, { reasoning: { effort: value } }]))
  const thinking = (...tiers: [string, "enabled" | "disabled"][]): Tiers => Object.fromEntries(tiers.map(([label, type]) => [label, { thinking: { type } }]))

  /** 引擎 `<providerID>:<modelID>` → 该腿实打过的档位表(逐字)与出处。改这张表 = 先照 DOC §3 的方法对真实端点打一轮。 */
  const VERIFIED_TIERS: Record<string, { leg: string; variants: Tiers; evidence: string }> = {
    "alpha:claude-opus-4.8": {
      leg: "openrouter:anthropic/claude-opus-4.8(anthropic-wire;anthropic 直连腿未验 ⇒ 网关剔除)",
      variants: orEffort(["低", "low"], ["中", "medium"], ["高", "high"]),
      evidence: `${DOC} §3.5:reasoning.effort 写成 output_config.effort,low/medium/high/xhigh/max → 200,none/minimal/bogus → 400;opus 各档 0 个 thinking 块 —— 受理是事实,效果不可观测(#1266 前已声明,本票不动)`,
    },
    "alpha:gpt-5.4-mini": {
      leg: "openrouter:openai/gpt-5.4-mini(openai 直连腿本机 TLS 不可达 ⇒ 未验 ⇒ 网关剔除)",
      variants: effort(["低", "low"], ["中", "medium"], ["高", "high"]),
      evidence: `${DOC} §3.4:bogus-value → 400;none=0 / low=36 / medium=51 / high=78 reasoning_tokens(单样本,效果可观测)`,
    },
    "alpha:gpt-5.4-nano": {
      leg: "openrouter:openai/gpt-5.4-nano(同上)",
      variants: effort(["低", "low"], ["中", "medium"], ["高", "high"]),
      evidence: `${DOC} §3.4:bogus-value → 400;none…high 均 0,xhigh=80 / max=90 —— 受理是事实,低档效果不可观测(#1266 已声明,本票不动)`,
    },
    "alpha:deepseek-v4-pro": {
      leg: "deepseek:deepseek-v4-pro + openrouter:deepseek/deepseek-v4-pro(两腿都受理 reasoning_effort 七值)",
      variants: effort(["低", "low"], ["中", "medium"], ["高", "high"], ["最高", "max"]),
      evidence: `${DOC} §3.3 直连:bogus-value → 400,none → completion=3 无 reasoning 桶(真关);§3.4 OR:bogus → 400,none=0;其余六值单样本无单调差别(#1266 已声明,本票不动)`,
    },
    "alpha:glm-5.2": {
      leg: "zhipu:glm-5.2 + openrouter:z-ai/glm-5.2(两腿都受理 reasoning_effort 七值)",
      variants: effort(["高", "high"], ["最高", "max"]),
      evidence: `${DOC} §3.1 直连:bogus-value → 400 code 1210(七值校验),但 none 仍 171 reasoning_tokens、max=307 非单调 —— 受理是事实、效果未证;§3.4 OR:none=0(#1266 已声明,本票不动)`,
    },
    "alpha:glm-5-turbo": {
      leg: "zhipu:glm-5-turbo(models.config.json 首腿;OR 腿不认 thinking 形状 ⇒ 声明档位时被网关剔除,不换路)",
      variants: thinking(["关", "disabled"], ["开", "enabled"]),
      evidence: `${DOC} §3.2:thinking.type=disabled → reasoning_tokens 0(非流式 completion=4;流式 4 帧无 reasoning delta),enabled → 182;reasoning_effort 在此腿 accepted-and-ignored(bogus-value → 200,none 仍 224)⇒ 网关拒转 ⇒ 桌面不用它(v1 的形状)`,
    },
    "alpha:qwen3.7-max": {
      leg: "openrouter:qwen/qwen3.7-max(唯一腿)",
      variants: effort(["关", "none"], ["开", "medium"]),
      evidence: `${DOC} §3.4 + ${REACH} §8(本票 2026-09-06 复打 N=3,max_tokens 2048,与引擎同发 top_p:1):bogus-value → 400;none → reasoning_tokens 0(3/3);low/medium/high/max 248–308 与 baseline 252–288 无差别 ⇒ 只声明开/关,开取 OR 校验域内的 medium`,
    },
    "alpha:qwen3.7-plus": {
      leg: "openrouter:qwen/qwen3.7-plus(唯一腿)",
      variants: effort(["关", "none"], ["开", "medium"]),
      evidence: `${DOC} §3.4 + ${REACH} §8(同上):bogus-value → 400;none → 0(3/3);low/medium/high/max 268–347 与 baseline 315–340 无差别 ⇒ 只声明开/关`,
    },
    "deepseek-byok:deepseek-v4-pro": {
      leg: "deepseek 直连(经平台同名条目派生,byokModelMeta)",
      variants: effort(["低", "low"], ["中", "medium"], ["高", "high"], ["最高", "max"]),
      evidence: `${DOC} §3.3:直连 bogus-value → 400、none 真关(与 alpha:deepseek-v4-pro 的直连腿同一格读数)`,
    },
    "zhipuai-byok:glm-5.2": {
      leg: "zhipu 直连(经平台同名条目派生,byokModelMeta)",
      variants: effort(["高", "high"], ["最高", "max"]),
      evidence: `${DOC} §3.1:直连 bogus-value → 400(受理已验),none 仍思考、七值非单调(效果未证)—— #1266 已声明,本票不动;见 ${REACH} §8`,
    },
    "zhipuai-byok:glm-4.5-air": {
      leg: "zhipu 直连(目录 modelMeta 槽,#1267)",
      variants: thinking(["关", "disabled"], ["开", "enabled"]),
      evidence: `${REACH} §5:disabled → 无 reasoning_content、completion 128 → 4;type 写错 → 200 且照常思考(上游不校验)。#1237 把「关」调到第一位:此前「开」在前 ⇒ 标题辅助调用带 thinking:enabled(本判官在未调序的目录上当场点名)`,
    },
  }
  /** 本机无凭据、一格没打成 ⇒ 显式无档。键同样是引擎侧 id;值 = 为什么没验(不是文法结论,是可达性)。 */
  const UNVERIFIED_TIERLESS: Record<string, string> = {
    "minimax-byok:MiniMax-M2": "MINIMAX_API_KEY 本机无(alpha-platform .env 与 owner 提供的 key 都没有);上游黑名单族(transform.ts variants() 的 minimax),一格没打",
    "alibaba-byok:qwen3.8-max-preview": "DASHSCOPE_API_KEY 本机无;且上游 enable_thinking 只对 providerID === \"alibaba-cn\" 严格等号写,alibaba-byok 永不匹配 —— 猜 enable_thinking 会让整个节点报错(票面 Out of scope)",
    "alibaba-byok:qwen-plus": "同 qwen3.8-max-preview",
    "alibaba-byok:qwen3-coder-plus": "同 qwen3.8-max-preview",
    "moonshot-byok:kimi-k2": "MOONSHOT_API_KEY 本机无;上游黑名单族(kimi),一格没打",
    "moonshot-byok:moonshot-v1-128k": "MOONSHOT_API_KEY 本机无",
  }
  const isOffTier = (options: Record<string, unknown>) =>
    (options.thinking as { type?: unknown } | undefined)?.type === "disabled" || options.reasoningEffort === "none"

  /** 纯函数判官:返回失败文案;空数组 = 通过。 */
  function judgeTierProvenance(cfg: Injected): string[] {
    const failures: string[] = []
    const seen = new Set<string>()
    for (const [providerID, provider] of Object.entries(cfg.provider)) {
      for (const [modelID, model] of Object.entries(provider.models)) {
        const key = `${providerID}:${modelID}`
        seen.add(key)
        const verified = VERIFIED_TIERS[key]
        if (model.variants) {
          if (!verified) failures.push(`${key}: 声明了档位 ${JSON.stringify(model.variants)},但这条腿没有实打记录 —— 先照 ${DOC} §3 打一轮再入表`)
          else if (JSON.stringify(model.variants) !== JSON.stringify(verified.variants))
            failures.push(`${key}: 注入的档位表 ${JSON.stringify(model.variants)} ≠ 实打表 ${JSON.stringify(verified.variants)}(${verified.leg})`)
          const labels = Object.keys(model.variants)
          const off = labels.filter((label) => isOffTier(model.variants![label]!))
          if (off.length > 0 && !isOffTier(model.variants[labels[0]!]!))
            failures.push(`${key}: 有显式关闭档 ${JSON.stringify(off)} 却把 ${JSON.stringify(labels[0])} 排在第一位 —— 上游 smallOptions() 会把它喂给标题等辅助调用(基线 §3.8a)`)
        } else if (verified) {
          failures.push(`${key}: 实打表登记了档位 ${JSON.stringify(verified.variants)},注入配置里却没有 variants`)
        }
        if (key in UNVERIFIED_TIERLESS && (model.reasoning || model.variants))
          failures.push(`${key}: 本机未实打(${UNVERIFIED_TIERLESS[key]}),却带 reasoning=${String(model.reasoning)} variants=${JSON.stringify(model.variants)}`)
      }
    }
    for (const key of Object.keys(VERIFIED_TIERS)) if (!seen.has(key)) failures.push(`${key}: 实打表登记的模型不在注入配置里(表过期?)`)
    for (const key of Object.keys(UNVERIFIED_TIERLESS)) if (!seen.has(key)) failures.push(`${key}: 无档清单登记的模型不在注入配置里 —— 「它无档」这句话没有被测对象`)
    return failures
  }
  const keyEverything = () => {
    for (const p of getModelCatalog().byokProviders) plantSecret(p.keyEnv, `sk-${p.id}`)
    process.env.ALPHA_BASE_URL = "https://gw.example/v1"
    plantSecret("ALPHA_API_KEY", "jwt")
  }
  const clone = (cfg: Injected): Injected => JSON.parse(JSON.stringify(cfg)) as Injected

  test("出货目录:每个注入引擎的档位表逐字等于该腿的实打表;三个黑名单模型按各自那条腿的形状拿到开/关且关在第一位", () => {
    keyEverything()
    const cfg = buildAlphaModelConfig(userData)! as unknown as Injected
    expect(judgeTierProvenance(cfg)).toEqual([])
    // 空表会让上面的判据空转:实打表至少覆盖本票三个模型 + #1266/#1267 已声明的那些。
    expect(Object.keys(VERIFIED_TIERS).length).toBeGreaterThanOrEqual(11)
    const alpha = cfg.provider.alpha!.models
    expect(alpha["glm-5-turbo"]).toEqual({ name: "GLM-5 Turbo", reasoning: true, variants: { 关: { thinking: { type: "disabled" } }, 开: { thinking: { type: "enabled" } } } })
    expect(alpha["qwen3.7-max"]).toEqual({ name: "Qwen3.7 Max", reasoning: true, variants: { 关: { reasoningEffort: "none" }, 开: { reasoningEffort: "medium" } } })
    expect(alpha["qwen3.7-plus"]).toEqual({ name: "Qwen3.7 Plus", reasoning: true, variants: { 关: { reasoningEffort: "none" }, 开: { reasoningEffort: "medium" } } })
    // 同一模型经不同腿形状不同:GLM 直连只认 thinking,qwen 经 OR 只走 reasoning_effort —— 两者不得互换。
    expect(Object.keys(alpha["glm-5-turbo"]!.variants!)).toEqual(["关", "开"])
    expect(Object.keys(alpha["qwen3.7-max"]!.variants!)).toEqual(["关", "开"])
  })

  test("未实打的直连模型(qwen / kimi / minimax)真的被注入、且无徽标无档 —— 「无档」有被测对象,不是空集", () => {
    keyEverything()
    const cfg = buildAlphaModelConfig(userData)! as unknown as Injected
    let pinned = 0
    for (const key of Object.keys(UNVERIFIED_TIERLESS)) {
      const [providerID, modelID] = key.split(":") as [string, string]
      const model = cfg.provider[providerID]?.models[modelID]
      expect({ key, injected: model !== undefined }).toEqual({ key, injected: true })
      expect({ key, reasoning: model?.reasoning, variants: model?.variants }).toEqual({ key, reasoning: undefined, variants: undefined })
      pinned++
    }
    expect(pinned).toBe(6)
    // 平台侧 qwen3.7-* 经 OR 有档,直连 alibaba-byok 的是另一组 id(qwen3.8-max-preview / qwen-plus / qwen3-coder-plus),
    // 不存在同名派生;这里钉住「平台的 qwen 档位没有漏进 alibaba 直连节点」这条不变量。
    for (const model of Object.values(cfg.provider["alibaba-byok"]!.models)) expect(model.variants).toBeUndefined()
  })

  test("手段自证:五种已知的坏各自变红并点名(v1 的 GLM 形状 / 给未验模型补档 / 关档写错值 / 关档不在第一位 / 实打表的档位从注入里消失)", () => {
    keyEverything()
    const base = buildAlphaModelConfig(userData)! as unknown as Injected
    expect(judgeTierProvenance(base)).toEqual([])

    const v1 = clone(base) // v1 票面的形状:按 reasoningEffort 给 GLM turbo 声明档位 —— 直连腿 accepted-and-ignored
    v1.provider.alpha!.models["glm-5-turbo"]!.variants = { 高: { reasoningEffort: "high" }, 最高: { reasoningEffort: "max" } }
    expect(judgeTierProvenance(v1).map((line) => line.split(":").slice(0, 2).join(":"))).toEqual(["alpha:glm-5-turbo"])
    expect(judgeTierProvenance(v1)[0]).toContain("≠ 实打表")

    const guessed = clone(base) // 照 models.dev 文案给 MiniMax 直连补档
    guessed.provider["minimax-byok"]!.models["MiniMax-M2"] = { name: "MiniMax-M2", reasoning: true, variants: { 开: { thinking: { type: "enabled" } } } }
    const guessedFailures = judgeTierProvenance(guessed)
    expect(guessedFailures.map((line) => line.split(":").slice(0, 2).join(":"))).toEqual(["minimax-byok:MiniMax-M2", "minimax-byok:MiniMax-M2"])
    expect(guessedFailures.some((line) => line.includes("没有实打记录"))).toBe(true)
    expect(guessedFailures.some((line) => line.includes("本机未实打"))).toBe(true)

    const typo = clone(base) // 关档值写错:OR 的校验域里没有 "off"(bogus → 400),实打表逐字比对当场红
    typo.provider.alpha!.models["qwen3.7-max"]!.variants = { 关: { reasoningEffort: "off" }, 开: { reasoningEffort: "medium" } }
    expect(judgeTierProvenance(typo).map((line) => line.split(":").slice(0, 2).join(":"))).toEqual(["alpha:qwen3.7-max"])

    const reordered = clone(base) // 开排第一 ⇒ 标题辅助调用会带 thinking:enabled
    reordered.provider.alpha!.models["glm-5-turbo"]!.variants = { 开: { thinking: { type: "enabled" } }, 关: { thinking: { type: "disabled" } } }
    const reorderedFailures = judgeTierProvenance(reordered)
    expect(reorderedFailures.length).toBe(2) // 逐字不等(顺序也是表的一部分)+ 关档不在第一位
    expect(reorderedFailures.some((line) => line.includes("smallOptions"))).toBe(true)

    const dropped = clone(base) // 实打表登记了档位,注入却没有 —— 目录被人退回无档
    delete dropped.provider.alpha!.models["qwen3.7-plus"]!.variants
    expect(judgeTierProvenance(dropped)).toEqual([`alpha:qwen3.7-plus: 实打表登记了档位 ${JSON.stringify(VERIFIED_TIERS["alpha:qwen3.7-plus"]!.variants)},注入配置里却没有 variants`])
  })
})
