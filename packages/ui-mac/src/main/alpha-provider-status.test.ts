// Unit tests for the picker's BYOK key-status logic (alpha-provider-status.ts). The source-priority
// (keychain > env > opencode.jsonc inline > none) and the last-4 masking are what the model picker
// shows as 已配置/需配置 — worth locking down. The keychain (alpha-byok-keys → electron safeStorage) is
// mocked so this runs off-device; the env + opencode.jsonc paths are driven for real via a temp config.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

// Mutable so each test can set what the "keychain" holds. The mock closure reads it by reference.
let mockKeychain = new Map<string, string>()
mock.module("./alpha-byok-keys", () => ({ byokKeyMap: () => mockKeychain }))

const { getProviderKeyStatus } = await import("./alpha-provider-status")

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

beforeEach(() => {
  mockKeychain = new Map()
  for (const k of MANAGED) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-provstatus-"))
  process.env.ALPHA_GLOBAL_DIR = path.join(fs.realpathSync(tmp), "alpha-code-state", "env", "dev")
  fs.mkdirSync(process.env.ALPHA_GLOBAL_DIR, { recursive: true })
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

function writeInlineKey(providerId: string, apiKey: string) {
  fs.writeFileSync(path.join(tmp, "opencode.jsonc"), JSON.stringify({ provider: { [providerId]: { options: { apiKey } } } }))
}

describe("getProviderKeyStatus — source priority", () => {
  test("nothing configured → every catalog provider is { configured:false, source:'none' }", () => {
    const s = getProviderKeyStatus()
    expect(s.deepseek).toEqual({ configured: false, source: "none" })
    expect(s.zhipuai.configured).toBe(false)
  })

  test("keychain key → source 'keychain' with a masked last-4 hint", () => {
    mockKeychain.set("deepseek", "sk-abcdef1234")
    const s = getProviderKeyStatus()
    expect(s.deepseek).toEqual({ configured: true, source: "keychain", hint: "1234" })
  })

  test("env keyEnv (no keychain) → source 'env'", () => {
    process.env.DEEPSEEK_API_KEY = "sk-envkey9876"
    const s = getProviderKeyStatus()
    expect(s.deepseek).toEqual({ configured: true, source: "env", hint: "9876" })
  })

  test("opencode.jsonc inline apiKey (no keychain/env) → source 'config'", () => {
    writeInlineKey("deepseek", "sk-configkeyWXYZ")
    const s = getProviderKeyStatus()
    expect(s.deepseek.configured).toBe(true)
    expect(s.deepseek.source).toBe("config")
    expect(s.deepseek.hint).toBe("WXYZ")
  })

  test("keychain beats env beats config", () => {
    mockKeychain.set("deepseek", "sk-fromKeychainAAAA")
    process.env.DEEPSEEK_API_KEY = "sk-fromEnvBBBB"
    writeInlineKey("deepseek", "sk-fromConfigCCCC")
    expect(getProviderKeyStatus().deepseek.source).toBe("keychain")
  })
})

describe("getProviderKeyStatus — masking + off-catalog", () => {
  test("keys shorter than 4 chars are masked to bullets, not leaked", () => {
    mockKeychain.set("deepseek", "ab")
    expect(getProviderKeyStatus().deepseek.hint).toBe("••")
  })

  test("an off-catalog provider present only in the keychain is still surfaced", () => {
    mockKeychain.set("mycustom", "sk-offcatalog7890")
    const s = getProviderKeyStatus()
    expect(s.mycustom).toEqual({ configured: true, source: "keychain", hint: "7890" })
  })

  test("never leaks the full key — only a <=4 char hint", () => {
    const key = "sk-verylongsecretkey-END"
    mockKeychain.set("deepseek", key)
    const hint = getProviderKeyStatus().deepseek.hint!
    expect(hint).toBe("-END") // the last 4 chars only
    expect(hint.length).toBe(4)
    expect(key.includes(hint)).toBe(true)
    expect(hint).not.toBe(key) // never the full secret
  })
})
