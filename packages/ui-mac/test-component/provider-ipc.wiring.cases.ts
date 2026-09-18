// provider-ipc wiring (REQ-226 `#1343`, R1 audit finding 1) — run by src/main/provider-ipc.wiring.test.ts in a
// SUBPROCESS, because `mock.module("electron")` is process-global (same reason as app-version-ipc.wiring). It lives
// in test-component/ (like alpha-composer-model.cases.ts) because it sets ALPHA_GLOBAL_DIR to a temp root and
// alpha-environment.test.ts forbids that assignment in any non-test file under src/main.
//
// What is under test is the real IPC handler chain: `providers-set-key` → provider-lifecycle → the real
// alpha-byok-keys store (only its one-function keychain seam is faked) → the real ext-config writer on a
// temp alpha.jsonc. The finding: a catalog id whose alpha.jsonc block still carries a pre-#1343 inline
// plaintext key is now `needs-reentry` (configured:false), so the picker never offers "remove" and a plain
// setKey never touched config — the plaintext block would stay in alpha.jsonc forever. Re-entering the key
// must retire that block. Red-first: on the pre-fix handler (`setByokKey` alone) cases ① ③ ④ fail.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { tryAcquireBundleLock } from "../src/main/ext-bundle-lock"

const handlers = new Map<string, (...args: unknown[]) => unknown>()
mock.module("electron", () => ({
  app: { getPath: () => "/tmp", isPackaged: false, on: () => {}, off: () => {}, getVersion: () => "0.0.0" },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    },
  },
  BrowserWindow: class {},
  dialog: {},
  shell: { openExternal: async () => {} },
  utilityProcess: {
    fork: () => {
      throw new Error("unexpected utilityProcess.fork")
    },
  },
}))
mock.module("../src/main/alpha-keychain-backend", () => ({
  keychainBackend: () => ({
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8"),
  }),
}))
mock.module("../src/main/logging", () => ({
  getLogger: () => ({ log: () => {}, warn: () => {}, error: () => {} }),
  write: () => {},
  rotateServerLogs: () => {},
}))

const { registerProviderIpcHandlers } = await import("../src/main/provider-ipc")
const { clearByokKeys, getByokKey, initByokKeys, setByokKeyDeps } = await import("../src/main/alpha-byok-keys")
const { setProviderLifecycleDeps } = await import("../src/main/provider-lifecycle")
registerProviderIpcHandlers()

type KeyState = { configured: boolean; source: string; hint?: string }
const invoke = <T>(channel: string, ...args: unknown[]) => handlers.get(channel)!({} as never, ...args) as T

// Deliberately non-key-shaped test values (never real credentials).
const LEGACY = "legacy-plain-value-Ab12"
const SECRET = "test-value-not-a-real-key-Zq81"
const MANAGED = ["ALPHA_GLOBAL_DIR", "OPENCODE_CONFIG_DIR", "DEEPSEEK_API_KEY"]
const saved: Record<string, string | undefined> = {}
let tmp = ""
let userData = ""
let notified = 0
let refreshes = 0

const primary = () => path.join(process.env.ALPHA_GLOBAL_DIR!, "alpha.jsonc")
const legacyCopy = () => path.join(tmp, "opencode.jsonc")
const writeProviders = (file: string, provider: Record<string, unknown>) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ provider }, null, 2))
}
const providersIn = (file: string): Record<string, unknown> =>
  fs.existsSync(file) ? ((JSON.parse(fs.readFileSync(file, "utf8")) as { provider?: Record<string, unknown> }).provider ?? {}) : {}

beforeEach(() => {
  for (const k of MANAGED) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-provider-ipc-"))
  process.env.ALPHA_GLOBAL_DIR = path.join(fs.realpathSync(tmp), "alpha-code-state", "env", "dev")
  fs.mkdirSync(process.env.ALPHA_GLOBAL_DIR, { recursive: true })
  process.env.OPENCODE_CONFIG_DIR = tmp
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-provider-ipc-userdata-"))
  notified = 0
  refreshes = 0
  clearByokKeys()
  initByokKeys(userData)
  setByokKeyDeps({ onChanged: () => notified++ })
  setProviderLifecycleDeps({
    refreshRuntime: async () => {
      refreshes++
      return true
    },
  })
})
afterEach(() => {
  clearByokKeys()
  setByokKeyDeps({ onChanged: () => {} })
  setProviderLifecycleDeps()
  for (const k of MANAGED) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  for (const dir of [tmp, userData]) fs.rmSync(dir, { recursive: true, force: true })
})

describe("providers-set-key — re-entering a key retires a legacy plaintext block (R1 finding 1)", () => {
  test("① catalog id with a legacy plaintext block in alpha.jsonc AND the legacy XDG copy: key stored, both blocks gone, status keychain", () => {
    writeProviders(primary(), { deepseek: { options: { apiKey: LEGACY } } })
    writeProviders(legacyCopy(), { deepseek: { options: { apiKey: `${LEGACY}-xdg` } } })
    expect(invoke<Record<string, KeyState>>("providers-key-status").deepseek).toEqual({ configured: false, source: "needs-reentry" })

    const result = invoke<{ ok: boolean; reason?: string }>("providers-set-key", "deepseek", SECRET)
    expect(result).toEqual({ ok: true })
    expect(getByokKey("deepseek")).toBe(SECRET)
    expect(providersIn(primary()).deepseek).toBeUndefined()
    expect(providersIn(legacyCopy()).deepseek).toBeUndefined()
    expect(fs.readFileSync(primary(), "utf8")).not.toContain(LEGACY)
    expect(fs.readFileSync(legacyCopy(), "utf8")).not.toContain(LEGACY)
    expect(invoke<Record<string, KeyState>>("providers-key-status").deepseek).toEqual({
      configured: true,
      source: "keychain",
      hint: SECRET.slice(-4),
    })
    expect(notified).toBe(1) // one env re-inject + respawn, as before
  })

  test("② marker / user-reference / absent blocks are left byte-identical (only legacy plaintext is retired)", () => {
    writeProviders(primary(), {
      mine: { options: { baseURL: "https://x.invalid/v1", apiKey: "alpha-keychain" } },
      ref: { options: { apiKey: "{file:/somewhere/key}" } },
    })
    const before = fs.readFileSync(primary(), "utf8")
    expect(invoke<{ ok: boolean }>("providers-set-key", "deepseek", SECRET).ok).toBe(true) // no block at all
    expect(invoke<{ ok: boolean }>("providers-set-key", "mine", SECRET).ok).toBe(true)
    expect(invoke<{ ok: boolean }>("providers-set-key", "ref", SECRET).ok).toBe(true)
    expect(fs.readFileSync(primary(), "utf8")).toBe(before)
    expect(getByokKey("deepseek")).toBe(SECRET)
    expect(getByokKey("mine")).toBe(SECRET)
  })

  test("③ an off-catalog legacy plaintext block is retired the same way (the plaintext never stays; the definition is re-added)", () => {
    writeProviders(primary(), {
      "my-endpoint": { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://x.invalid/v1", apiKey: LEGACY }, models: { m: { name: "m" } } },
    })
    expect(invoke<{ ok: boolean }>("providers-set-key", "my-endpoint", SECRET)).toEqual({ ok: true })
    expect(providersIn(primary())["my-endpoint"]).toBeUndefined()
    expect(fs.readFileSync(primary(), "utf8")).not.toContain(LEGACY)
    expect(getByokKey("my-endpoint")).toBe(SECRET)
  })

  test("④ config lock busy while retiring the block: refused as busy, key NOT stored, block untouched, no respawn", () => {
    writeProviders(primary(), { deepseek: { options: { apiKey: LEGACY } } })
    const held = tryAcquireBundleLock(process.env.ALPHA_GLOBAL_DIR!, { txId: "tx-in-flight" })
    expect(held.ok).toBe(true)
    if (!held.ok) return
    try {
      const result = invoke<{ ok: boolean; reason?: string }>("providers-set-key", "deepseek", SECRET)
      expect(result.ok).toBe(false)
      expect(result.reason).toContain("config busy")
      expect(getByokKey("deepseek")).toBeUndefined()
      expect(providersIn(primary()).deepseek).toEqual({ options: { apiKey: LEGACY } })
      expect(notified).toBe(0)
    } finally {
      held.lock.release()
    }
    // released ⇒ the same call succeeds and the block is gone
    expect(invoke<{ ok: boolean }>("providers-set-key", "deepseek", SECRET)).toEqual({ ok: true })
    expect(providersIn(primary()).deepseek).toBeUndefined()
  })

  test("⑤ providers-remove still goes store → config → refresh (unchanged by the fix)", async () => {
    writeProviders(primary(), { "my-endpoint": { options: { apiKey: "alpha-keychain" } } })
    expect(invoke<{ ok: boolean }>("providers-set-key", "my-endpoint", SECRET).ok).toBe(true)
    const removed = await invoke<Promise<{ ok: boolean }>>("providers-remove", "my-endpoint")
    expect(removed).toEqual({ ok: true })
    expect(getByokKey("my-endpoint")).toBeUndefined()
    expect(providersIn(primary())["my-endpoint"]).toBeUndefined()
    expect(refreshes).toBe(1)
  })
})
