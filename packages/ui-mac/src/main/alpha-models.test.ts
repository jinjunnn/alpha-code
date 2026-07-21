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
import { writeLiveAllowlist } from "./alpha-live-allowlist"
import { buildAlphaModelConfig, getModelCatalog } from "./alpha-models"
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
    expect(cfg.enabled_providers).toContain("deepseek")
    const p = cfg.provider.deepseek as any
    expect(p.npm).toBe("@ai-sdk/openai-compatible")
    // the ref is a path token, never the value — OPENCODE_CONFIG_CONTENT must stay secret-free (A6)
    expect(p.options.apiKey).toBe(`{file:${secretFilePath(userData, "DEEPSEEK_API_KEY")}}`)
    expect(p.options.apiKey).not.toContain("sk-deepseek-123")
    expect(Object.keys(p.models).length).toBeGreaterThan(0)
  })

  test("zhipuai (catalog BYOK) is openai-compat with the paas/v4 endpoint", () => {
    plantSecret("ZHIPU_API_KEY", "sk-zhipu-xyz")
    const p = buildAlphaModelConfig(userData)!.provider.zhipuai as any
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
    expect(cfg.provider.deepseek).toBeUndefined()
    expect(cfg.enabled_providers).not.toContain("deepseek")
  })

  test("keyless catalog providers are NOT injected", () => {
    const cfg = buildAlphaModelConfig(userData)!
    expect(cfg.provider.deepseek).toBeUndefined()
    expect(cfg.provider.moonshot).toBeUndefined()
  })

  test("syncSecretFiles(main) → buildAlphaModelConfig(sidecar) round-trips end to end", () => {
    syncSecretFiles(userData, { DEEPSEEK_API_KEY: "sk-rt" })
    expect(buildAlphaModelConfig(userData)!.enabled_providers).toContain("deepseek")
    // revocation flows through: key removed → file deleted → provider gone on next fork
    syncSecretFiles(userData, {})
    expect(buildAlphaModelConfig(userData)!.enabled_providers).not.toContain("deepseek")
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

describe("buildAlphaModelConfig — REQ-001 edition 白名单(live 缓存)", () => {
  const liveBase = { fetchedAt: "2026-07-03T00:00:00Z", edition: "cn" }

  test("byokProviders 白名单收窄内置 BYOK:不在名单的 keyed provider 不注入", () => {
    plantSecret("DEEPSEEK_API_KEY", "sk-1")
    plantSecret("ZHIPU_API_KEY", "sk-2")
    writeLiveAllowlist(userData, { ...liveBase, byokProviders: ["deepseek"], models: [] })
    const cfg = buildAlphaModelConfig(userData)!
    expect(cfg.enabled_providers).toContain("deepseek")
    expect(cfg.provider.zhipuai).toBeUndefined()
    expect(cfg.enabled_providers).not.toContain("zhipuai")
  })

  test("byokProviders null = 不限制(两个 keyed 都注入)", () => {
    plantSecret("DEEPSEEK_API_KEY", "sk-1")
    plantSecret("ZHIPU_API_KEY", "sk-2")
    writeLiveAllowlist(userData, { ...liveBase, byokProviders: null, models: [] })
    const cfg = buildAlphaModelConfig(userData)!
    expect(cfg.enabled_providers).toContain("deepseek")
    expect(cfg.enabled_providers).toContain("zhipuai")
  })

  test("平台模型以 live 清单为准:snapshot 名称富化,未知 id 诚实用 id 本名", () => {
    process.env.ALPHA_BASE_URL = "https://gw.example/v1"
    plantSecret("ALPHA_API_KEY", "jwt")
    writeLiveAllowlist(userData, {
      ...liveBase,
      byokProviders: null,
      models: [{ id: "deepseek-v4-flash" }, { id: "brand-new-model" }],
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
    expect(p.models["claude-opus-4.8-direct"].variants).toBeUndefined() // anthropic-wire 不映射 → 诚实不定义
    expect(p.models["deepseek-v4-flash"].variants).toBeUndefined()
  })

  test("live models 空数组 → 回退 snapshot(空白名单按坏配置处理,fail-open 不出空目录)", () => {
    process.env.ALPHA_BASE_URL = "https://gw.example/v1"
    plantSecret("ALPHA_API_KEY", "jwt")
    writeLiveAllowlist(userData, { ...liveBase, byokProviders: null, models: [] })
    const p = buildAlphaModelConfig(userData)!.provider.alpha as any
    expect(Object.keys(p.models).length).toBe(getModelCatalog().platformModels.length)
  })

  test("用户自定义 provider 不受白名单约束(2026-07-03 拍板:目录跟随 edition,自定义不拦)", () => {
    writeLiveAllowlist(userData, { ...liveBase, byokProviders: ["deepseek"], models: [] })
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
