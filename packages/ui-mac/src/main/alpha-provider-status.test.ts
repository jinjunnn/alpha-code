// Unit tests for the picker's key-status logic (alpha-provider-status.ts). The source-priority
// (keychain > env > alpha.jsonc reference) and the last-4 masking are what the model picker shows as
// 已配置 / 需配置 / 需重填 — worth locking down.
//
// REQ-226 `#1343` (baseline §三 I9): the store is NOT mocked any more — only its one-function keychain seam
// (`./alpha-keychain-backend`, a fake safeStorage; see that file for why `electron` itself is not mocked)
// and `./logging` are, and the real alpha-byok-keys.ts runs against a temp userData. The env +
// alpha.jsonc paths are driven for real via temp config dirs. AC3/AC7: nothing returned here ever carries
// a key value; a config file's plaintext is classified, never read back.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

mock.module("./alpha-keychain-backend", () => ({
  keychainBackend: () => ({
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8"),
  }),
}))
mock.module("./logging", () => ({
  getLogger: () => ({ log: () => {}, warn: () => {}, error: () => {} }),
  write: () => {},
  rotateServerLogs: () => {},
}))

const { getProviderKeyStatus } = await import("./alpha-provider-status")
const { clearByokKeys, initByokKeys, setByokKey } = await import("./alpha-byok-keys")
const { PROVIDER_KEYCHAIN_MARKER } = await import("./ext-config")

const MANAGED = [
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

// Deliberately non-key-shaped test values (never real credentials); asserted absent from every output.
const LEGACY = "legacy-plain-value-Ab12"

beforeEach(() => {
  for (const k of MANAGED) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-provstatus-"))
  process.env.ALPHA_GLOBAL_DIR = path.join(fs.realpathSync(tmp), "alpha-code-state", "env", "dev")
  fs.mkdirSync(process.env.ALPHA_GLOBAL_DIR, { recursive: true })
  process.env.OPENCODE_CONFIG_DIR = tmp
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-provstatus-userdata-"))
  clearByokKeys()
  initByokKeys(userData)
})
afterEach(() => {
  clearByokKeys()
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

/** Legacy XDG copy (providerReadPaths fallback). */
function writeLegacyInlineKey(providerId: string, apiKey: string) {
  fs.writeFileSync(path.join(tmp, "opencode.jsonc"), JSON.stringify({ provider: { [providerId]: { options: { apiKey } } } }))
}
/** The real source: alpha.jsonc in the current environment root. */
function writeAlphaProviders(provider: Record<string, { options?: Record<string, unknown> }>) {
  fs.writeFileSync(path.join(process.env.ALPHA_GLOBAL_DIR!, "alpha.jsonc"), JSON.stringify({ provider }))
}
const keychain = (id: string, key: string) => expect(setByokKey(id, key)).toEqual({ ok: true })

describe("getProviderKeyStatus — source priority", () => {
  test("nothing configured → every catalog provider is { configured:false, source:'none' }", () => {
    const s = getProviderKeyStatus()
    expect(s.deepseek).toEqual({ configured: false, source: "none" })
    expect(s.zhipuai.configured).toBe(false)
  })

  test("keychain key → source 'keychain' with a masked last-4 hint", () => {
    keychain("deepseek", "sk-abcdef1234")
    const s = getProviderKeyStatus()
    expect(s.deepseek).toEqual({ configured: true, source: "keychain", hint: "1234" })
  })

  test("env keyEnv (no keychain) → source 'env'", () => {
    process.env.DEEPSEEK_API_KEY = "sk-envkey9876"
    const s = getProviderKeyStatus()
    expect(s.deepseek).toEqual({ configured: true, source: "env", hint: "9876" })
  })

  test("REQ-226 AC7: a legacy inline plaintext key (no keychain/env) → 'needs-reentry', NOT configured, NO hint, value never returned", () => {
    writeLegacyInlineKey("deepseek", LEGACY)
    const s = getProviderKeyStatus()
    expect(s.deepseek).toEqual({ configured: false, source: "needs-reentry" })
    expect(JSON.stringify(s)).not.toContain(LEGACY)
    expect(JSON.stringify(s)).not.toContain(LEGACY.slice(-4))
  })

  test("a hand-written {file:} / {env:} reference → source 'config', configured, no hint (alpha does not manage it)", () => {
    writeAlphaProviders({ deepseek: { options: { apiKey: "{file:/somewhere/deepseek.key}" } } })
    expect(getProviderKeyStatus().deepseek).toEqual({ configured: true, source: "config" })
    writeAlphaProviders({ deepseek: { options: { apiKey: "{env:DEEPSEEK_API_KEY}" } } })
    expect(getProviderKeyStatus().deepseek).toEqual({ configured: true, source: "config" })
  })

  test("keychain beats env beats config", () => {
    keychain("deepseek", "sk-fromKeychainAAAA")
    process.env.DEEPSEEK_API_KEY = "sk-fromEnvBBBB"
    writeLegacyInlineKey("deepseek", LEGACY)
    expect(getProviderKeyStatus().deepseek.source).toBe("keychain")
    clearByokKeys()
    initByokKeys(userData)
    expect(getProviderKeyStatus().deepseek.source).toBe("env")
  })
})

describe("getProviderKeyStatus — off-catalog custom providers (REQ-226 #1343)", () => {
  test("marker block + key in the store → 'keychain' with a hint (the normal post-#1343 state)", () => {
    writeAlphaProviders({ "my-endpoint": { options: { baseURL: "https://x.invalid/v1", apiKey: PROVIDER_KEYCHAIN_MARKER } } })
    keychain("my-endpoint", "sk-offcatalog7890")
    expect(getProviderKeyStatus()["my-endpoint"]).toEqual({ configured: true, source: "keychain", hint: "7890" })
  })

  test("marker block + NO key in the store (keychain unavailable / re-signed / entry gone) → 'needs-reentry', no hint", () => {
    writeAlphaProviders({ "my-endpoint": { options: { baseURL: "https://x.invalid/v1", apiKey: PROVIDER_KEYCHAIN_MARKER } } })
    expect(getProviderKeyStatus()["my-endpoint"]).toEqual({ configured: false, source: "needs-reentry" })
  })

  test("legacy plaintext block → 'needs-reentry', no hint, value never returned", () => {
    writeAlphaProviders({ "my-endpoint": { options: { baseURL: "https://x.invalid/v1", apiKey: LEGACY } } })
    const s = getProviderKeyStatus()
    expect(s["my-endpoint"]).toEqual({ configured: false, source: "needs-reentry" })
    expect(JSON.stringify(s)).not.toContain(LEGACY)
  })

  test("user-reference block → 'config', configured, no hint", () => {
    writeAlphaProviders({ "my-endpoint": { options: { apiKey: "{file:/somewhere/key}" } } })
    expect(getProviderKeyStatus()["my-endpoint"]).toEqual({ configured: true, source: "config" })
  })

  test("a key present only in the store (no alpha.jsonc block) is still surfaced as 'keychain'", () => {
    keychain("mycustom", "sk-offcatalog7890")
    expect(getProviderKeyStatus().mycustom).toEqual({ configured: true, source: "keychain", hint: "7890" })
  })

  test("AC3: every returned state has only {configured, source, hint?} and the hint is ≤ 4 chars", () => {
    writeAlphaProviders({
      a: { options: { apiKey: PROVIDER_KEYCHAIN_MARKER } },
      b: { options: { apiKey: LEGACY } },
      c: { options: { apiKey: "{file:/x}" } },
    })
    keychain("a", "sk-verylongsecretkey-END")
    keychain("deepseek", "sk-anotherlongsecretkey-XYZ0")
    const s = getProviderKeyStatus()
    for (const [id, state] of Object.entries(s)) {
      expect(Object.keys(state).sort()).toEqual(expect.arrayContaining(["configured", "source"]))
      expect(Object.keys(state).every((k) => ["configured", "source", "hint"].includes(k))).toBe(true)
      if (state.hint !== undefined) expect(state.hint.length).toBeLessThanOrEqual(4)
      if (state.source !== "keychain" && state.source !== "env") expect(state.hint).toBeUndefined()
      expect(id.length).toBeGreaterThan(0)
    }
    expect(JSON.stringify(s)).not.toContain("secretkey")
  })
})

describe("getProviderKeyStatus — masking", () => {
  test("keys shorter than 4 chars are masked to bullets, not leaked", () => {
    keychain("deepseek", "ab")
    expect(getProviderKeyStatus().deepseek.hint).toBe("••")
  })

  test("never leaks the full key — only a <=4 char hint", () => {
    const key = "sk-verylongsecretkey-END"
    keychain("deepseek", key)
    const hint = getProviderKeyStatus().deepseek.hint!
    expect(hint).toBe("-END") // the last 4 chars only
    expect(hint.length).toBe(4)
    expect(key.includes(hint)).toBe(true)
    expect(hint).not.toBe(key) // never the full secret
  })
})
