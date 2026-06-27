// alpha-code's curated model menu, injected into opencode's config by the sidecar (see
// sidecar.ts -> injectAlphaConfig). Everything here rides opencode's NATIVE config contract, so
// it touches zero upstream source and survives every fork-sync (ADR-005/006/007).
//
// The four native levers (runtime: packages/opencode/src/provider/provider.ts):
//   - enabled_providers: HARD allowlist. When set, ONLY these provider ids are visible; every
//     other provider (including ones the user configured in ~/.config/opencode) is dropped.
//   - provider.<id>.whitelist: per-provider model allowlist. REQUIRED to trim a built-in
//     provider -- just listing a few models under `.models` MERGES with the models.dev catalog,
//     it does NOT restrict. whitelist is the only "keep only these" lever.
//   - provider.<id> with { npm, options:{ baseURL, apiKey }, models }: define a custom
//     OpenAI-compatible ("@ai-sdk/openai-compatible") or Anthropic/Claude-compatible
//     ("@ai-sdk/anthropic") gateway -- this is the "自定义模型 / ALPHA 平台模型" path.
//   - model: "<providerID>/<modelID>" -- the default selection.
//
// Keys are written as {env:VAR}. opencode resolves them against the sidecar's process.env,
// which inherits the user's login-shell env via preferAppEnv()/loadShellEnv (server.ts) BEFORE
// the sidecar is forked -- so `export DEEPSEEK_API_KEY=...` in ~/.zshrc works in `bun run dev`
// AND in the packaged .app. (Plain string keys also work but would live in the bundle.)
//
// Consequence of the hard allowlist: a provider with no key is not "connected", so it does not
// appear in the picker. On a fresh machine the menu is empty until at least one key is exported.
//
// Escape hatch: ALPHA_MODELS_DISABLE=1 skips this entirely (the brand-identity injection in
// sidecar.ts is independent, guarded by ALPHA_IDENTITY_DISABLE).

export type AlphaModelConfig = {
  enabled_providers: string[]
  model?: string
  provider: Record<string, unknown>
}

export function buildAlphaModelConfig(): AlphaModelConfig | undefined {
  if (process.env.ALPHA_MODELS_DISABLE === "1") return undefined

  // (1) 国产 built-ins -- already in the models.dev catalog, so they only need a model
  // whitelist plus their key in the env (DEEPSEEK_API_KEY / ZHIPU_API_KEY / MINIMAX_API_KEY /
  // DASHSCOPE_API_KEY). Model ids below are samples from the current catalog snapshot -- edit
  // them to the exact models you are entitled to. minimax is an Anthropic-compatible endpoint
  // upstream; it still restricts via whitelist the same way.
  const provider: Record<string, unknown> = {
    deepseek: { whitelist: ["deepseek-chat", "deepseek-reasoner"] },
    zhipuai: { whitelist: ["glm-5", "glm-4.5-air"] },
    minimax: { whitelist: ["MiniMax-M2"] },
    alibaba: { whitelist: ["qwen-plus", "qwen3-coder-plus"] },
  }
  const enabled = ["deepseek", "zhipuai", "minimax", "alibaba"]

  // (3) ALPHA platform model -- a custom OpenAI-compatible gateway whose key is fronted by ALPHA
  // (代发). It auto-joins the allowlist only once ALPHA_BASE_URL points at the gateway, so the
  // allowlist never carries a dead entry. Set ALPHA_API_KEY too if the gateway needs one.
  if (process.env.ALPHA_BASE_URL) {
    provider.alpha = {
      npm: "@ai-sdk/openai-compatible",
      name: "ALPHA",
      options: { baseURL: process.env.ALPHA_BASE_URL, apiKey: "{env:ALPHA_API_KEY}" },
      // Real models the alpha-platform gateway serves (alpha-platform packages/gateway/src/
      // registry.ts → entries with enabled:true). The login token (ALPHA_API_KEY) authorizes them
      // through the /v1 proxy, so the moment the user is logged in these all appear in the picker.
      // Ordered flagship → standard; the picker derives 等级 from the id (opus=旗舰, sonnet/search=高级).
      models: {
        "claude-opus-4.8": { name: "Claude Opus 4.8" },
        "claude-opus-4.8-direct": { name: "Claude Opus 4.8 · 直连" },
        "claude-sonnet-4.6": { name: "Claude Sonnet 4.6" },
        "claude-haiku-4.5": { name: "Claude Haiku 4.5" },
        "gpt-5.4-search": { name: "GPT-5.4 · 联网" },
        "gpt-5.4-mini": { name: "GPT-5.4 Mini" },
        "gpt-5.4-nano": { name: "GPT-5.4 Nano" },
        "deepseek-v4-pro": { name: "DeepSeek V4 Pro" },
        "deepseek-v4-flash": { name: "DeepSeek V4 Flash" },
        "deepseek-chat": { name: "DeepSeek Chat" },
        "deepseek-reasoner": { name: "DeepSeek Reasoner" },
      },
    }
    enabled.unshift("alpha")
  }

  // (2) 自定义 OpenAI/Claude 网关 -- copy a template, fill baseURL/models, then push the id into
  // `enabled`. OpenAI mode -> npm "@ai-sdk/openai-compatible"; Claude mode -> npm "@ai-sdk/anthropic".
  //   provider["my-gw"] = {
  //     npm: "@ai-sdk/openai-compatible",
  //     name: "My Gateway",
  //     options: { baseURL: "https://gw.example/v1", apiKey: "{env:MY_GW_KEY}" },
  //     models: { "my-model": { name: "My Model" } },
  //   }
  //   enabled.push("my-gw")

  return {
    enabled_providers: enabled,
    // Default model only if explicitly set, so we never force a default whose key is absent.
    // Format "<providerID>/<modelID>", e.g. "deepseek/deepseek-chat".
    ...(process.env.ALPHA_DEFAULT_MODEL ? { model: process.env.ALPHA_DEFAULT_MODEL } : {}),
    provider,
  }
}
