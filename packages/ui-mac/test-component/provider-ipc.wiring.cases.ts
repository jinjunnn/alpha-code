// provider-ipc wiring (REQ-226 `#1343`, R1 audit finding 1 + R2 blocker) — run by src/main/provider-ipc.wiring.test.ts
// in a SUBPROCESS, because `mock.module("electron")` is process-global (same reason as app-version-ipc.wiring).
// It lives in test-component/ (like alpha-composer-model.cases.ts) because it sets ALPHA_GLOBAL_DIR to a temp
// root and alpha-environment.test.ts forbids that assignment in any non-test file under src/main.
//
// What is under test is the real IPC handler chain: `providers-set-key` → provider-lifecycle → the real
// alpha-byok-keys store (only its one-function keychain seam is faked) → the real ext-config writer on temp
// config files. R1: a catalog id whose config block still carries a pre-#1343 inline plaintext key is
// `needs-reentry` (configured:false), so the picker never offers "remove" and a plain setKey never touched
// config — the plaintext would stay forever; re-entering the key must retire it. R2 (the regression the first
// fix introduced): retiring the whole `provider.<id>` block threw `Can not delete in empty document` when
// alpha.jsonc had no `provider` key at all (opencode-CLI user, plaintext only in the XDG copy) — so the key
// never reached the store — and would have deleted the user's hand-written npm / baseURL / models. Only the
// `options.apiKey` LEAF may go, and only from files that actually carry it. Red-first: on the first-fix chain
// ① ③ ④ ⑥ fail; on the pre-fix chain (`setByokKey` alone) ① ③ ④ fail.

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
type Result = { ok: boolean; reason?: string }
const invoke = <T>(channel: string, ...args: unknown[]) => handlers.get(channel)!({} as never, ...args) as T
const status = () => invoke<Record<string, KeyState>>("providers-key-status")
const setKey = (id: string, key: string) => invoke<Result>("providers-set-key", id, key)

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
const legacyCopy = () => path.join(tmp, "opencode.jsonc") // the user's own opencode CLI config (XDG read path)
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

describe("providers-set-key — re-entering a key retires ONLY the legacy plaintext leaf (R1 finding 1 / R2 blocker)", () => {
  test("① audit scenario: alpha.jsonc is only {$schema}, the plaintext lives in the user's CLI copy ⇒ key stored, that apiKey leaf gone, everything else identical, status keychain", () => {
    const schemaOnly = '{\n  "$schema": "https://opencode.ai/config.json"\n}\n'
    fs.mkdirSync(path.dirname(primary()), { recursive: true })
    fs.writeFileSync(primary(), schemaOnly)
    writeProviders(legacyCopy(), {
      deepseek: {
        options: { baseURL: "https://api.deepseek.com/v1", apiKey: LEGACY },
        models: { "deepseek-chat": { name: "chat" } },
      },
      other: { options: { apiKey: `${LEGACY}-other` } }, // a sibling id's leaf must not be touched
    })
    expect(status().deepseek).toEqual({ configured: false, source: "needs-reentry" })

    expect(setKey("deepseek", SECRET)).toEqual({ ok: true })
    expect(getByokKey("deepseek")).toBe(SECRET)
    expect(fs.readFileSync(primary(), "utf8")).toBe(schemaOnly) // nothing to retire there ⇒ never written
    const legacy = providersIn(legacyCopy())
    expect(legacy.deepseek).toEqual({
      options: { baseURL: "https://api.deepseek.com/v1" },
      models: { "deepseek-chat": { name: "chat" } },
    })
    expect(legacy.other).toEqual({ options: { apiKey: `${LEGACY}-other` } })
    expect(fs.readFileSync(legacyCopy(), "utf8")).not.toContain(`"${LEGACY}"`)
    expect(status().deepseek).toEqual({ configured: true, source: "keychain", hint: SECRET.slice(-4) })
    expect(notified).toBe(1) // one env re-inject + respawn, as before
  })

  test("② marker / user-reference / absent blocks are left byte-identical (only legacy plaintext is retired)", () => {
    writeProviders(primary(), {
      mine: { options: { baseURL: "https://x.invalid/v1", apiKey: "alpha-keychain" } },
      ref: { options: { apiKey: "{file:/somewhere/key}" } },
    })
    const before = fs.readFileSync(primary(), "utf8")
    expect(setKey("deepseek", SECRET).ok).toBe(true) // no block at all
    expect(setKey("mine", SECRET).ok).toBe(true)
    expect(setKey("ref", SECRET).ok).toBe(true)
    expect(fs.readFileSync(primary(), "utf8")).toBe(before)
    expect(getByokKey("deepseek")).toBe(SECRET)
    expect(getByokKey("mine")).toBe(SECRET)
  })

  test("③ off-catalog block with hand-written npm / name / baseURL / models + plaintext apiKey: only the apiKey leaf is retired, the definition stays, key stored", () => {
    writeProviders(primary(), {
      "my-endpoint": {
        npm: "@ai-sdk/openai-compatible",
        name: "Mine",
        options: { baseURL: "https://x.invalid/v1", apiKey: LEGACY },
        models: { m: { name: "m" } },
      },
    })
    expect(setKey("my-endpoint", SECRET)).toEqual({ ok: true })
    expect(providersIn(primary())["my-endpoint"]).toEqual({
      npm: "@ai-sdk/openai-compatible",
      name: "Mine",
      options: { baseURL: "https://x.invalid/v1" },
      models: { m: { name: "m" } },
    })
    expect(fs.readFileSync(primary(), "utf8")).not.toContain(LEGACY)
    expect(getByokKey("my-endpoint")).toBe(SECRET)
  })

  test("④ config lock busy while retiring the leaf: refused as busy, key NOT stored, file untouched, no respawn; after release the same call succeeds and only the leaf is gone", () => {
    writeProviders(primary(), { deepseek: { options: { baseURL: "https://api.deepseek.com/v1", apiKey: LEGACY } } })
    const before = fs.readFileSync(primary(), "utf8")
    const held = tryAcquireBundleLock(process.env.ALPHA_GLOBAL_DIR!, { txId: "tx-in-flight" })
    expect(held.ok).toBe(true)
    if (!held.ok) return
    try {
      const result = setKey("deepseek", SECRET)
      expect(result.ok).toBe(false)
      expect(result.reason).toContain("config busy")
      expect(getByokKey("deepseek")).toBeUndefined()
      expect(fs.readFileSync(primary(), "utf8")).toBe(before)
      expect(notified).toBe(0)
    } finally {
      held.lock.release()
    }
    expect(setKey("deepseek", SECRET)).toEqual({ ok: true })
    expect(providersIn(primary()).deepseek).toEqual({ options: { baseURL: "https://api.deepseek.com/v1" } })
  })

  // `#1392`:providers-add / providers-remove 走真源文件(<casBaseRoot>/custom-providers/<env>.json),alpha.jsonc 不参与 ——
  // 即使 alpha.jsonc 里躺着同名旧块,添加与删除都不碰它(基线 I3:旧记录只忽略 + 一行日志,server.ts)。
  test("⑤ providers-add writes the truth file, providers-remove goes store → truth → refresh; alpha.jsonc is never written", async () => {
    const truth = path.join(fs.realpathSync(tmp), "alpha-code-state", "custom-providers", "dev.json")
    const old = { "my-endpoint": { options: { baseURL: "https://stale.invalid/v1", apiKey: "alpha-keychain" } } }
    writeProviders(primary(), old)
    const before = fs.readFileSync(primary(), "utf8")
    const added = await invoke<Promise<Result>>("providers-add", { id: "my-endpoint", name: "Mine", compat: "openai", baseURL: "https://mine.invalid/v1", apiKey: SECRET, models: ["m"] })
    expect(added).toEqual({ ok: true })
    expect(refreshes).toBe(1)
    expect(getByokKey("my-endpoint")).toBe(SECRET)
    expect(fs.readFileSync(truth, "utf8")).toBe('{"v":1,"providers":[{"id":"my-endpoint","name":"Mine","compat":"openai","baseURL":"https://mine.invalid/v1","models":["m"]}]}\n')
    expect(fs.readFileSync(primary(), "utf8")).toBe(before)
    const removed = await invoke<Promise<Result>>("providers-remove", "my-endpoint")
    expect(removed).toEqual({ ok: true })
    expect(getByokKey("my-endpoint")).toBeUndefined()
    expect(fs.readFileSync(truth, "utf8")).toBe('{"v":1,"providers":[]}\n')
    expect(fs.readFileSync(primary(), "utf8")).toBe(before)
    expect(refreshes).toBe(2)
  })

  test("⑥ alpha's marker block in alpha.jsonc + a plaintext leaf for the same id in the user's CLI copy: marker file byte-identical, the CLI copy's leaf retired", () => {
    writeProviders(primary(), { "my-endpoint": { options: { baseURL: "https://x.invalid/v1", apiKey: "alpha-keychain" } } })
    writeProviders(legacyCopy(), { "my-endpoint": { options: { baseURL: "https://cli.invalid/v1", apiKey: LEGACY } } })
    const before = fs.readFileSync(primary(), "utf8")
    expect(setKey("my-endpoint", SECRET)).toEqual({ ok: true })
    expect(fs.readFileSync(primary(), "utf8")).toBe(before)
    expect(providersIn(legacyCopy())["my-endpoint"]).toEqual({ options: { baseURL: "https://cli.invalid/v1" } })
    expect(getByokKey("my-endpoint")).toBe(SECRET)
  })
})
