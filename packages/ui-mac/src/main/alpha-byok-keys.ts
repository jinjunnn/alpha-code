// alpha-managed key store (main process) for catalog BYOK providers AND off-catalog custom providers
// (REQ-226 `#1343`). Keys are encrypted at rest via Electron safeStorage (macOS keychain-backed) into ONE
// JSON file <userData>/alpha-byok-keys.json. This is alpha's OWN vault — it replaced opencode's native
// auth.json and inline keys in config files (design 2026-06-29 §0.4: "opencode auth 出局；auth 全归 alpha").
//
// Fail closed (REQ-226 AC6/AC7; baseline §三 I1): when safeStorage is unavailable (headless, before app
// ready, undecryptable after a re-sign) the store REFUSES — persisting returns {ok:false} and nothing is
// written; a legacy `{v:1, plain}` vault on disk is treated as unreadable (empty store, one warn, the
// value is never parsed, never re-encrypted); opencode's auth.json is never read (the 2026-06-29 one-time
// migration is gone — a key that only ever lived there is re-entered once). Plaintext leaves this module
// through exactly two main-only paths, both feeding the A6 {file:} channel at sidecar fork:
//   - catalog BYOK: injectByokKeysIntoEnv() writes each key into its provider's keyEnv in MAIN's
//     process.env (NEVER clobbering a value the user exported / set in alpha.env); syncSecretFiles
//     mirrors those vars into <userData>/alpha-secrets/<VAR>.
//   - off-catalog custom providers: customProviderSecretValues(ids) hands {custom-provider--<id>: key}
//     straight to syncSecretFiles' `extra` — no env hop (an off-catalog id has no keyEnv).
// The sidecar never sees values: buildAlphaModelConfig emits {file:} refs gated on file presence.
// Changing a key takes effect on the next (re)fork (onChanged → structural respawn).

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { keychainBackend } from "./alpha-keychain-backend"
import { computeByokEnvMutations } from "./alpha-byok-env"
import { customProviderSecretName } from "./alpha-secret-files"
import catalog from "./alpha-models.json"
import type { AlphaModelCatalog } from "../shared/alpha-model-types"
import { getLogger } from "./logging"

const CATALOG = catalog as unknown as AlphaModelCatalog
const FILE = "alpha-byok-keys.json"

export type ByokStoreResult = { ok: true } | { ok: false; reason: string }

let userDataPath = ""
let keys: Record<string, string> = {} // providerId -> apiKey (decrypted, in-memory)

/** Log a message with NO value-bearing payload. Callers pass only messages / errors (paths, never keys). */
function warn(message: string, meta?: unknown) {
  try {
    getLogger().warn(message, meta)
  } catch {}
}

function filePath() {
  return join(userDataPath, FILE)
}

/** keyEnv for a catalog BYOK provider (e.g. deepseek -> DEEPSEEK_API_KEY). undefined for off-catalog ids. */
function keyEnvFor(id: string): string | undefined {
  return CATALOG.byokProviders.find((p) => p.id === id)?.keyEnv
}

function isCatalogByokId(id: string): boolean {
  return CATALOG.byokProviders.some((p) => p.id === id)
}

/** Encrypt + write the whole map. Refuses (no write at all) when the keychain is unavailable. */
function persist(): ByokStoreResult {
  try {
    const keychain = keychainBackend()
    if (!keychain?.isEncryptionAvailable()) {
      warn("alpha-byok-keys: keychain (safeStorage) unavailable — refusing to persist keys (never plaintext)")
      return { ok: false, reason: "keychain unavailable — key not saved" }
    }
    mkdirSync(userDataPath, { recursive: true, mode: 0o700 })
    const enc = keychain.encryptString(JSON.stringify(keys)).toString("base64")
    writeFileSync(filePath(), JSON.stringify({ v: 1, enc }), { encoding: "utf8", mode: 0o600 })
    chmodSync(filePath(), 0o600)
    return { ok: true }
  } catch (error) {
    warn("alpha-byok-keys: persist failed", error)
    return { ok: false, reason: `key store write failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

function load() {
  keys = {}
  let parsed: { v?: unknown; enc?: unknown; plain?: unknown } | null
  try {
    parsed = JSON.parse(readFileSync(filePath(), "utf8"))
  } catch {
    return // no store yet, or unreadable — start empty
  }
  if (!parsed || typeof parsed !== "object") return
  if ("plain" in parsed && parsed.plain !== undefined) {
    // AC7 / I1: a plaintext vault written by a pre-#1343 build (headless fallback). It is never parsed and
    // never "healed" by re-encrypting — both would mean reading the plaintext. The user re-enters keys;
    // the next successful persist overwrites this file with the encrypted form.
    warn("alpha-byok-keys: legacy plaintext vault ignored (never read) — keys must be re-entered")
    return
  }
  if (typeof parsed.enc !== "string") return
  try {
    const keychain = keychainBackend()
    if (!keychain?.isEncryptionAvailable()) {
      warn("alpha-byok-keys: keychain (safeStorage) unavailable — encrypted vault not loaded")
      return
    }
    const obj = JSON.parse(keychain.decryptString(Buffer.from(parsed.enc, "base64"))) as unknown
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return
    for (const [id, value] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof value === "string" && value.length > 0) keys[id] = value
    }
  } catch {
    // Undecryptable after an app re-sign (see ADR-017) or corrupt — start empty; user re-enters.
    keys = {}
  }
}

/** Load the store. Call once at startup (index.ts) AFTER app ready (safeStorage), before the first fork. */
export function initByokKeys(dataPath: string) {
  userDataPath = dataPath
  load()
}

/** Decrypt-to-env bridge(B21 修订):用户提供的 env 值(shell/alpha.env)永不动;本模块自己注入的
 *  var 权威可变——改键覆盖、删键清除(变更计算见 alpha-byok-env.ts,纯逻辑单测)。Call before every
 *  sidecar (re)fork;key 变更后由 onChanged 触发 respawn → A6 syncSecretFiles 镜像新值。
 *  Off-catalog ids have no keyEnv and are skipped here — they travel via customProviderSecretValues. */
const injectedEnvVars = new Set<string>()
export function injectByokKeysIntoEnv() {
  const desired: Record<string, string> = {}
  for (const [id, key] of Object.entries(keys)) {
    const env = keyEnvFor(id)
    if (env) desired[env] = key
  }
  const m = computeByokEnvMutations(desired, process.env, injectedEnvVars)
  for (const name of m.del) delete process.env[name]
  for (const [name, value] of Object.entries(m.set)) process.env[name] = value
}

/**
 * REQ-226 (`#1343`) — the ONLY way an off-catalog custom provider's key leaves this store: the values
 * main hands to syncSecretFiles(…, extra) right before a fork, as `custom-provider--<id>` → key. Only ids
 * that are BOTH in `configuredIds` (the provider blocks in alpha.jsonc) AND in the store are returned;
 * catalog ids are excluded (they travel via keyEnv). Pure: no I/O, no logging.
 */
export function customProviderSecretValues(configuredIds: Iterable<string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const id of configuredIds) {
    if (isCatalogByokId(id)) continue
    const key = keys[id]
    if (key) out[customProviderSecretName(id)] = key
  }
  return out
}

// B21:改键/删键即时生效 —— IPC 层持久化成功后经此回调触发「重注 env + respawn」(index.ts 注入;
// respawn 后 fork 时 syncSecretFiles 把新 env 镜像进 {file:} 通道,新 sidecar 即用新 key)。
let onKeysChanged: () => void = () => {}
export function setByokKeyDeps(deps: { onChanged: () => void }) {
  onKeysChanged = deps.onChanged
}

export function getByokKey(id: string): string | undefined {
  return keys[id]
}

/** id -> key map (decrypted). Main-process only; getProviderKeyStatus derives last-4 hints from it. */
export function byokKeyMap(): Map<string, string> {
  return new Map(Object.entries(keys))
}

/**
 * Persist a key WITHOUT notifying (no env re-inject, no respawn). For callers that sequence the store
 * write with another durable write and then drive ONE refresh themselves (provider-lifecycle:
 * store → alpha.jsonc → respawn). Fail closed: if the keychain refuses, memory is rolled back so the
 * status face never claims "configured" for a key that was not saved.
 */
export function storeByokKey(id: string, key: string): ByokStoreResult {
  if (typeof id !== "string" || !id) return { ok: false, reason: "invalid provider id" }
  if (typeof key !== "string" || key.length === 0) return { ok: false, reason: "missing api key" }
  const previous = keys[id]
  keys[id] = key
  const result = persist()
  if (!result.ok) {
    if (previous === undefined) delete keys[id]
    else keys[id] = previous
  }
  return result
}

export function setByokKey(id: string, key: string): ByokStoreResult {
  const result = storeByokKey(id, key)
  if (result.ok) onKeysChanged() // B21:即时生效(重注 env + respawn)
  return result
}

/**
 * Drop a key WITHOUT notifying (no env re-inject, no respawn). Rollback path for provider-lifecycle
 * (R1 finding 2): when the alpha.jsonc write fails after a first-fill store, the freshly stored entry
 * must vanish again — silently, because nothing was ever applied to a running sidecar.
 */
export function discardByokKey(id: string): ByokStoreResult {
  if (!(id in keys)) return { ok: true }
  delete keys[id]
  return persist()
}

export function removeByokKey(id: string): ByokStoreResult {
  if (!(id in keys)) return { ok: true }
  const result = discardByokKey(id)
  onKeysChanged() // B21:即时吊销(清 env + respawn → A6 删密钥文件)— the in-memory copy is gone regardless
  return result
}

/** Clear the whole store (e.g. for tests / full reset). */
export function clearByokKeys() {
  keys = {}
  try {
    rmSync(filePath(), { force: true })
  } catch {}
}
