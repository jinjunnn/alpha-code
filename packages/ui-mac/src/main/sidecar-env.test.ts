// Unit tests for the A6 sidecar env allowlist (sidecar-env.ts). The contract under test IS the A6
// acceptance criterion: no secret (ALPHA_API_KEY / BYOK keys / ALPHA_CLOUD_TOKEN / EXA_API_KEY /
// DEV_PLATFORM_TOKEN) may survive into the env that MCP/LSP/shell children inherit, while everything
// the sidecar genuinely needs must still pass.

import { describe, expect, test } from "bun:test"
import { createSidecarEnv } from "./sidecar-env"

describe("createSidecarEnv — default-deny", () => {
  test("strips every secret named by the A6 acceptance criteria", () => {
    const env = createSidecarEnv({
      ALPHA_API_KEY: "jwt",
      ALPHA_CLOUD_TOKEN: "bearer",
      DEEPSEEK_API_KEY: "sk-1",
      MOONSHOT_API_KEY: "sk-2",
      EXA_API_KEY: "exa",
      DEV_PLATFORM_TOKEN: "dev",
      PATH: "/usr/bin",
    })
    expect(env.ALPHA_API_KEY).toBeUndefined()
    expect(env.ALPHA_CLOUD_TOKEN).toBeUndefined()
    expect(env.DEEPSEEK_API_KEY).toBeUndefined()
    expect(env.MOONSHOT_API_KEY).toBeUndefined()
    expect(env.EXA_API_KEY).toBeUndefined()
    expect(env.DEV_PLATFORM_TOKEN).toBeUndefined()
    expect(env.PATH).toBe("/usr/bin")
  })

  test("drops arbitrary unknown vars (default-deny, not a blocklist)", () => {
    const env = createSidecarEnv({ RANDOM_SHELL_EXPORT: "x", AWS_SECRET_ACCESS_KEY: "y", DEBUG: "1", LD_PRELOAD: "z" })
    expect(Object.keys(env)).toEqual([])
  })

  test("passes the system/proxy/node basics children legitimately need", () => {
    const env = createSidecarEnv({
      PATH: "/usr/bin",
      HOME: "/Users/u",
      SHELL: "/bin/zsh",
      TMPDIR: "/tmp",
      LANG: "en_US.UTF-8",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      HTTPS_PROXY: "http://127.0.0.1:7890",
      no_proxy: "localhost",
      NODE_EXTRA_CA_CERTS: "/etc/ca.pem",
    })
    for (const key of [
      "PATH",
      "HOME",
      "SHELL",
      "TMPDIR",
      "LANG",
      "SSH_AUTH_SOCK",
      "HTTPS_PROXY",
      "no_proxy",
      "NODE_EXTRA_CA_CERTS",
    ]) {
      expect(env[key]).toBeDefined()
    }
  })

  test("passes the non-secret alpha controls the sidecar reads", () => {
    const env = createSidecarEnv({
      ALPHA_BASE_URL: "https://gw.example/v1",
      ALPHA_CLOUD_MCP_URL: "https://mcp.example",
      ALPHA_DEFAULT_MODEL: "alpha/x",
      ALPHA_MODELS_DISABLE: "1",
      ALPHA_IDENTITY_DISABLE: "1",
      ALPHA_BEHAVIOR_DISABLE: "1",
      ALPHA_WEBSEARCH_DISABLE: "1",
      // main-only alpha vars must NOT pass
      ALPHA_WEB_URL: "https://web.example",
      ALPHA_SHOT: "1",
    })
    expect(env.ALPHA_BASE_URL).toBe("https://gw.example/v1")
    expect(env.ALPHA_CLOUD_MCP_URL).toBe("https://mcp.example")
    expect(env.ALPHA_DEFAULT_MODEL).toBe("alpha/x")
    expect(env.ALPHA_MODELS_DISABLE).toBe("1")
    expect(env.ALPHA_IDENTITY_DISABLE).toBe("1")
    expect(env.ALPHA_BEHAVIOR_DISABLE).toBe("1")
    expect(env.ALPHA_WEBSEARCH_DISABLE).toBe("1")
    expect(env.ALPHA_WEB_URL).toBeUndefined()
    expect(env.ALPHA_SHOT).toBeUndefined()
  })

  test("passes OPENCODE_/XDG_/LC_/ELECTRON_ prefixes (channel DB, state home, locale, dev exec path)", () => {
    const env = createSidecarEnv({
      OPENCODE_ENABLE_EXA: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_CHANNEL: "prod",
      XDG_STATE_HOME: "/Users/u/Library/Application Support/alpha-code",
      LC_ALL: "en_US.UTF-8",
      ELECTRON_EXEC_PATH: "/opt/electron",
    })
    expect(env.OPENCODE_ENABLE_EXA).toBe("1")
    expect(env.OPENCODE_DISABLE_MODELS_FETCH).toBe("1")
    expect(env.OPENCODE_CHANNEL).toBe("prod")
    expect(env.XDG_STATE_HOME).toBeDefined()
    expect(env.LC_ALL).toBeDefined()
    expect(env.ELECTRON_EXEC_PATH).toBeDefined()
  })

  test("vetoes credential-shaped names even under an allowed prefix", () => {
    const env = createSidecarEnv({ OPENCODE_API_KEY: "zen", ELECTRON_GITHUB_TOKEN: "gh", OPENCODE_CLIENT: "desktop" })
    expect(env.OPENCODE_API_KEY).toBeUndefined()
    expect(env.ELECTRON_GITHUB_TOKEN).toBeUndefined()
    expect(env.OPENCODE_CLIENT).toBe("desktop")
  })
})

describe("createSidecarEnv — escape hatch", () => {
  test("ALPHA_ENV_ALLOWLIST_EXTRA passes the named non-secret vars through", () => {
    const env = createSidecarEnv({
      ALPHA_ENV_ALLOWLIST_EXTRA: "MY_CUSTOM_VAR, MY_PROVIDER_BASE_URL",
      MY_CUSTOM_VAR: "v",
      MY_PROVIDER_BASE_URL: "https://p.example/v1",
      UNNAMED_VAR: "not-in-the-hatch",
      DEEPSEEK_API_KEY: "still-stripped",
    })
    expect(env.MY_CUSTOM_VAR).toBe("v")
    expect(env.MY_PROVIDER_BASE_URL).toBe("https://p.example/v1")
    expect(env.UNNAMED_VAR).toBeUndefined()
    expect(env.DEEPSEEK_API_KEY).toBeUndefined()
    // the hatch itself stays visible for diagnostics
    expect(env.ALPHA_ENV_ALLOWLIST_EXTRA).toBeDefined()
  })

  // #603: the hatch used to pass its named vars BEFORE the SECRETISH guard, so
  // ALPHA_ENV_ALLOWLIST_EXTRA=ALPHA_API_KEY leaked the raw platform bearer into the sidecar and
  // every MCP/LSP/agent-shell child it spawns. The A6 / startup-baseline ③ invariant "a token never
  // enters the sidecar env" is absolute: no user opt-in may waive it.
  test("vetoes the absolute platform tokens even when named in the hatch", () => {
    const env = createSidecarEnv({
      ALPHA_ENV_ALLOWLIST_EXTRA: "ALPHA_API_KEY,ALPHA_CLOUD_TOKEN,DEV_PLATFORM_TOKEN",
      ALPHA_API_KEY: "jwt",
      ALPHA_CLOUD_TOKEN: "bearer",
      DEV_PLATFORM_TOKEN: "dev",
    })
    expect(env.ALPHA_API_KEY).toBeUndefined()
    expect(env.ALPHA_CLOUD_TOKEN).toBeUndefined()
    expect(env.DEV_PLATFORM_TOKEN).toBeUndefined()
  })

  test("vetoes any credential-shaped name named in the hatch (SECRETISH, not a fixed blocklist)", () => {
    const names = ["EXA_API_KEY", "GH_TOKEN", "DB_PASSWORD", "SOME_CREDENTIAL", "AWS_SECRET_ACCESS_KEY", "my_api_key"]
    const env = createSidecarEnv({
      ALPHA_ENV_ALLOWLIST_EXTRA: names.join(","),
      ...Object.fromEntries(names.map((name) => [name, "leak"])),
      MY_CUSTOM_VAR: "kept",
    })
    for (const name of names) expect(env[name]).toBeUndefined()
    expect(Object.values(env)).not.toContain("leak")
  })

  test("the veto is absolute: no path (hatch, exact, prefix) passes a credential-shaped name", () => {
    const env = createSidecarEnv({
      ALPHA_ENV_ALLOWLIST_EXTRA: "ALPHA_API_KEY,OPENCODE_API_KEY,MY_CUSTOM_VAR",
      ALPHA_API_KEY: "jwt",
      OPENCODE_API_KEY: "zen",
      OPENCODE_CLIENT: "desktop",
      PATH: "/usr/bin",
      MY_CUSTOM_VAR: "v",
    })
    expect(Object.keys(env).filter((key) => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key))).toEqual([])
    // …while the hatch and the ordinary allowlist keep working
    expect(env.MY_CUSTOM_VAR).toBe("v")
    expect(env.OPENCODE_CLIENT).toBe("desktop")
    expect(env.PATH).toBe("/usr/bin")
  })
})
