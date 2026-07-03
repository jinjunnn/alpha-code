// Unit tests for the sidecar-injected model config assembly (alpha-models.ts). This is the load-bearing
// logic that decides which providers/models opencode sees: BYOK direct nodes (only when keyed), the
// alpha platform gateway (only when ALPHA_BASE_URL is set), and user custom providers merged into the
// hard allowlist. All driven by process.env + the user's opencode.jsonc (via OPENCODE_CONFIG_DIR).

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { buildAlphaModelConfig, getModelCatalog } from "./alpha-models"

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
  "OPENCODE_CONFIG_DIR",
]
const saved: Record<string, string | undefined> = {}
let tmp = ""

beforeEach(() => {
  for (const k of MANAGED) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  // Empty config dir → readUserProviderIds() sees no user providers (isolates the byok/gateway logic).
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-models-"))
  process.env.OPENCODE_CONFIG_DIR = tmp
})
afterEach(() => {
  for (const k of MANAGED) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* best effort */
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
    expect(buildAlphaModelConfig()).toBeUndefined()
  })

  test("no keys / no gateway / no user providers → empty allowlist, no forced default", () => {
    const cfg = buildAlphaModelConfig()
    expect(cfg).toBeDefined()
    expect(cfg!.enabled_providers).toEqual([])
    expect(cfg!.provider).toEqual({})
    // defaultModel is null in the catalog and no env override → never force a `model`
    expect(cfg!.model).toBeUndefined()
  })
})

describe("buildAlphaModelConfig — BYOK direct nodes (only when keyed)", () => {
  test("an openai-compat provider is injected only when its keyEnv is set, with the inlined key", () => {
    process.env.DEEPSEEK_API_KEY = "sk-deepseek-123"
    const cfg = buildAlphaModelConfig()!
    expect(cfg.enabled_providers).toContain("deepseek")
    const p = cfg.provider.deepseek as any
    expect(p.npm).toBe("@ai-sdk/openai-compatible")
    expect(p.options.apiKey).toBe("sk-deepseek-123")
    expect(Object.keys(p.models).length).toBeGreaterThan(0)
  })

  test("an anthropic-compat provider uses the anthropic sdk npm", () => {
    process.env.ZHIPU_API_KEY = "sk-zhipu-xyz"
    const p = buildAlphaModelConfig()!.provider.zhipuai as any
    expect(p.npm).toBe("@ai-sdk/anthropic")
    expect(p.options.apiKey).toBe("sk-zhipu-xyz")
  })

  test("keyless catalog providers are NOT injected", () => {
    const cfg = buildAlphaModelConfig()!
    expect(cfg.provider.deepseek).toBeUndefined()
    expect(cfg.provider.moonshot).toBeUndefined()
  })
})

describe("buildAlphaModelConfig — platform gateway (代发)", () => {
  test("the alpha platform provider joins the FRONT of the allowlist only when ALPHA_BASE_URL is set", () => {
    process.env.ALPHA_BASE_URL = "https://gw.example/v1"
    process.env.DEEPSEEK_API_KEY = "sk-deepseek-123" // a BYOK node too, to prove ordering
    const cfg = buildAlphaModelConfig()!
    expect(cfg.enabled_providers[0]).toBe("alpha") // unshifted to the front
    const p = cfg.provider.alpha as any
    expect(p.options.baseURL).toBe("https://gw.example/v1")
    // key is fronted by ALPHA (代发) as an env ref, never inlined
    expect(p.options.apiKey).toBe("{env:ALPHA_API_KEY}")
    expect(Object.keys(p.models).length).toBeGreaterThan(0)
  })

  test("without ALPHA_BASE_URL there is no platform provider", () => {
    expect(buildAlphaModelConfig()!.provider.alpha).toBeUndefined()
  })
})

describe("buildAlphaModelConfig — default model + user providers", () => {
  test("ALPHA_DEFAULT_MODEL overrides the (null) catalog default", () => {
    process.env.ALPHA_DEFAULT_MODEL = "deepseek/deepseek-chat"
    expect(buildAlphaModelConfig()!.model).toBe("deepseek/deepseek-chat")
  })

  test("user custom providers in opencode.jsonc are merged into the allowlist (survive the hard reset)", () => {
    fs.writeFileSync(
      path.join(tmp, "opencode.jsonc"),
      JSON.stringify({ provider: { myco: { npm: "@ai-sdk/openai-compatible", options: {} } } }),
    )
    const cfg = buildAlphaModelConfig()!
    expect(cfg.enabled_providers).toContain("myco")
  })
})
