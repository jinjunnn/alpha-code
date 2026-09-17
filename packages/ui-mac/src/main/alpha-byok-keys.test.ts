// Unit tests for alpha's encrypted key store (alpha-byok-keys.ts) — REQ-226 `#1343`.
//
// These drive the REAL module: only the one-function keychain seam (`./alpha-keychain-backend`, a fake
// safeStorage whose availability the test flips — see that file for why `electron` itself is not mocked)
// and `./logging` (a spy) are mocked; the vault lives in a temp userData dir. Baseline
// docs/design/2026-09-17-req226-custom-provider-keychain-baseline.md §三 names the invariants:
//   I1  keychain unavailable ⇒ the store REFUSES (no write, no plaintext fallback, plaintext vault never read)
//   I2  no key value ever reaches the logger
//   AC7 opencode's auth.json is never read (no auto-migration of a third-party plaintext file)
// I9: the previous `alpha-provider-status.test.ts` mock of this whole module is NOT evidence for any of
// these — the module itself has to run. Red-first: on the pre-#1343 module the I1/AC7 cases below fail
// (it wrote `{v:1, plain}` when unavailable, re-encrypted a plaintext vault on load, and migrated
// auth.json at init); the run log is attached to the PR.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

// Fake keychain: reversible byte transform so the on-disk form is provably NOT the plaintext, while a
// re-init can still decrypt it. `available` is flipped per test.
let encryptionAvailable = true
const flip = (input: Uint8Array): Buffer => {
  const out = Buffer.alloc(input.length)
  for (let i = 0; i < input.length; i++) out[i] = input[i]! ^ 0x5a
  return out
}
mock.module("./alpha-keychain-backend", () => ({
  keychainBackend: () => ({
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (value: string) => flip(Buffer.from(value, "utf8")),
    decryptString: (value: Buffer) => flip(value).toString("utf8"),
  }),
}))
const logCalls: { level: string; args: unknown[] }[] = []
mock.module("./logging", () => ({
  getLogger: () => ({
    log: (...args: unknown[]) => logCalls.push({ level: "log", args }),
    warn: (...args: unknown[]) => logCalls.push({ level: "warn", args }),
    error: (...args: unknown[]) => logCalls.push({ level: "error", args }),
  }),
  write: () => {},
  rotateServerLogs: () => {},
}))

const store = await import("./alpha-byok-keys")

const VAULT = "alpha-byok-keys.json"
// A deliberately non-key-shaped test value (never a real credential) — asserted absent from disk/log.
const SECRET = "test-value-not-a-real-key-Zq81"
const savedXdg = process.env.XDG_DATA_HOME
let userData = ""
let xdgHome = ""

const vaultPath = () => path.join(userData, VAULT)
const serializedLog = () => JSON.stringify(logCalls, (_k, v) => (v instanceof Error ? { message: v.message } : v))

beforeEach(() => {
  encryptionAvailable = true
  logCalls.length = 0
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-byok-keys-"))
  // Point the (retired) auth.json lookup at a temp XDG home so the test never touches a real one.
  xdgHome = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-byok-xdg-"))
  process.env.XDG_DATA_HOME = xdgHome
  store.clearByokKeys()
  store.initByokKeys(userData)
})
afterEach(() => {
  store.clearByokKeys()
  store.setByokKeyDeps({ onChanged: () => {} })
  if (savedXdg === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = savedXdg
  for (const dir of [userData, xdgHome]) fs.rmSync(dir, { recursive: true, force: true })
})

describe("I1 — keychain unavailable ⇒ refuse, never plaintext", () => {
  test("setByokKey returns {ok:false} and writes NO vault file when safeStorage is unavailable", () => {
    encryptionAvailable = false
    const result = store.setByokKey("deepseek", SECRET)
    expect(result.ok).toBe(false)
    expect(fs.existsSync(vaultPath())).toBe(false)
    // Memory must not outrun disk: a "configured" status backed by nothing persisted is the placebo AC6 forbids.
    expect(store.getByokKey("deepseek")).toBeUndefined()
    expect(store.byokKeyMap().size).toBe(0)
  })

  test("a legacy plaintext vault on disk is treated as unreadable: empty store, one warn, value never read", () => {
    fs.writeFileSync(vaultPath(), JSON.stringify({ v: 1, plain: JSON.stringify({ deepseek: SECRET }) }))
    store.initByokKeys(userData)
    expect(store.byokKeyMap().size).toBe(0)
    expect(store.getByokKey("deepseek")).toBeUndefined()
    expect(logCalls.filter((c) => c.level === "warn")).toHaveLength(1)
    // No self-heal: re-encrypting would require READING the plaintext. The file is left as found.
    expect(JSON.parse(fs.readFileSync(vaultPath(), "utf8"))).toEqual({ v: 1, plain: JSON.stringify({ deepseek: SECRET }) })
  })

  test("an encrypted vault with the keychain unavailable loads as an empty store (no crash, no fallback)", () => {
    expect(store.setByokKey("deepseek", SECRET).ok).toBe(true)
    encryptionAvailable = false
    store.initByokKeys(userData)
    expect(store.byokKeyMap().size).toBe(0)
    // and the still-encrypted file is untouched
    expect(JSON.parse(fs.readFileSync(vaultPath(), "utf8")).enc).toBeDefined()
  })

  test("encrypted round-trip: set → re-init → get; the file on disk is not the plaintext and is 0600", () => {
    expect(store.setByokKey("deepseek", SECRET)).toEqual({ ok: true })
    const raw = fs.readFileSync(vaultPath(), "utf8")
    expect(raw).not.toContain(SECRET)
    expect(JSON.parse(raw)).toHaveProperty("enc")
    expect(JSON.parse(raw)).not.toHaveProperty("plain")
    expect(fs.statSync(vaultPath()).mode & 0o777).toBe(0o600)
    store.initByokKeys(userData)
    expect(store.getByokKey("deepseek")).toBe(SECRET)
  })

  test("removeByokKey drops the id and rewrites the encrypted vault without it", () => {
    store.setByokKey("deepseek", SECRET)
    store.setByokKey("custom-a", `${SECRET}-2`)
    expect(store.removeByokKey("deepseek")).toEqual({ ok: true })
    store.initByokKeys(userData)
    expect(store.getByokKey("deepseek")).toBeUndefined()
    expect(store.getByokKey("custom-a")).toBe(`${SECRET}-2`)
  })
})

describe("AC7 — opencode auth.json is never read", () => {
  test("an auth.json holding a catalog api key is ignored at init: store stays empty, no vault created, nothing logged", () => {
    const authDir = path.join(xdgHome, "opencode")
    fs.mkdirSync(authDir, { recursive: true })
    fs.writeFileSync(path.join(authDir, "auth.json"), JSON.stringify({ deepseek: { type: "api", key: SECRET } }))
    store.initByokKeys(userData)
    expect(store.byokKeyMap().size).toBe(0)
    expect(fs.existsSync(vaultPath())).toBe(false)
    expect(serializedLog()).not.toContain(SECRET)
    expect(serializedLog()).not.toContain("migrat")
  })
})

describe("materialization interface (baseline §2.1 步骤 2)", () => {
  test("customProviderSecretValues: only ids that are BOTH off-catalog AND in the store, keyed custom-provider--<id>", () => {
    store.setByokKey("deepseek", `${SECRET}-catalog`) // catalog id: travels via keyEnv, never via this path
    store.setByokKey("my-endpoint", `${SECRET}-custom`)
    store.setByokKey("orphan", `${SECRET}-orphan`) // in the store but not in alpha.jsonc ⇒ not materialized
    const out = store.customProviderSecretValues(["deepseek", "my-endpoint", "absent-from-store"])
    expect(out).toEqual({ "custom-provider--my-endpoint": `${SECRET}-custom` })
  })
})

describe("storeByokKey vs setByokKey (single respawn for providers-add)", () => {
  test("storeByokKey persists without notifying; setByokKey notifies once; a refused store never notifies", () => {
    let notified = 0
    store.setByokKeyDeps({ onChanged: () => notified++ })
    expect(store.storeByokKey("my-endpoint", SECRET)).toEqual({ ok: true })
    expect(notified).toBe(0)
    expect(JSON.parse(fs.readFileSync(vaultPath(), "utf8"))).toHaveProperty("enc")
    expect(store.setByokKey("deepseek", SECRET)).toEqual({ ok: true })
    expect(notified).toBe(1)
    encryptionAvailable = false
    expect(store.setByokKey("zhipuai", SECRET).ok).toBe(false)
    expect(notified).toBe(1)
  })

  test("input validation: empty id / empty key are refused before any disk I/O", () => {
    expect(store.storeByokKey("", SECRET).ok).toBe(false)
    expect(store.storeByokKey("x", "").ok).toBe(false)
    expect(fs.existsSync(vaultPath())).toBe(false)
  })
})

describe("I2 — values never reach the logger", () => {
  test("set / remove / unavailable / plaintext-vault / auth.json paths: serialized logger args never contain the key", () => {
    store.setByokKey("my-endpoint", SECRET)
    store.removeByokKey("my-endpoint")
    encryptionAvailable = false
    store.setByokKey("my-endpoint", SECRET)
    encryptionAvailable = true
    fs.writeFileSync(vaultPath(), JSON.stringify({ v: 1, plain: JSON.stringify({ deepseek: SECRET }) }))
    store.initByokKeys(userData)
    const authDir = path.join(xdgHome, "opencode")
    fs.mkdirSync(authDir, { recursive: true })
    fs.writeFileSync(path.join(authDir, "auth.json"), JSON.stringify({ deepseek: { type: "api", key: SECRET } }))
    store.initByokKeys(userData)
    // The spy saw something (so "no leak" is not "no logging happened") …
    expect(logCalls.length).toBeGreaterThan(0)
    // … and none of it carries the value.
    expect(serializedLog()).not.toContain(SECRET)
  })
})
