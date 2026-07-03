// alpha-managed BYOK key store (main process). BYOK API keys are encrypted at rest via Electron
// safeStorage (system keychain), mirroring alpha-auth.ts. This is alpha's OWN key vault — it replaces
// reliance on opencode's native auth.json AND on plaintext inline keys in opencode.jsonc for BYOK
// (design 2026-06-29 §0.4: "opencode auth 出局；auth 全归 alpha").
//
// Why a main-process store + env bridge: safeStorage only works in the main process, but the config
// that references the key (buildAlphaModelConfig) runs in the SIDECAR (utilityProcess). So before
// each sidecar (re)fork, injectByokKeysIntoEnv() decrypts every stored key and writes it into the
// provider's keyEnv in MAIN's process.env (NEVER clobbering a value the user exported / set in
// alpha.env). The sidecar does NOT inherit those vars (A6 allowlist) — at fork, syncSecretFiles
// mirrors them into <userData>/alpha-secrets/<VAR> and the config carries {file:} refs instead.
// Changing a key therefore takes effect on the next (re)fork (Phase 4 makes that a respawn).

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { safeStorage } from "electron"
import { computeByokEnvMutations } from "./alpha-byok-env"
import catalog from "./alpha-models.json"
import type { AlphaModelCatalog } from "../shared/alpha-model-types"
import { getLogger } from "./logging"

const CATALOG = catalog as unknown as AlphaModelCatalog
const FILE = "alpha-byok-keys.json"

let userDataPath = ""
let keys: Record<string, string> = {} // providerId -> apiKey (decrypted, in-memory)

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

function persist() {
  try {
    mkdirSync(userDataPath, { recursive: true, mode: 0o700 })
    const json = JSON.stringify(keys)
    if (safeStorage.isEncryptionAvailable()) {
      const enc = safeStorage.encryptString(json).toString("base64")
      writeFileSync(filePath(), JSON.stringify({ v: 1, enc }), { encoding: "utf8", mode: 0o600 })
    } else {
      // No OS keychain (e.g. headless): persist with a loud warning, owner-only perms.
      warn("alpha-byok-keys: safeStorage unavailable, persisting keys without encryption")
      writeFileSync(filePath(), JSON.stringify({ v: 1, plain: json }), { encoding: "utf8", mode: 0o600 })
    }
    chmodSync(filePath(), 0o600)
  } catch (error) {
    warn("alpha-byok-keys: persist failed", error)
  }
}

function load() {
  try {
    const parsed = JSON.parse(readFileSync(filePath(), "utf8")) as { v: number; enc?: string; plain?: string }
    let json: string | undefined
    if (parsed.enc && safeStorage.isEncryptionAvailable()) {
      json = safeStorage.decryptString(Buffer.from(parsed.enc, "base64"))
    } else if (parsed.plain) {
      json = parsed.plain
    }
    if (json) {
      const obj = JSON.parse(json) as Record<string, string>
      keys = obj && typeof obj === "object" ? obj : {}
      // 自愈:历史版本曾在 app ready 前初始化本库(safeStorage 不可用)→ 迁移写走了明文兜底。
      // 现在钥匙串可用就立即重加密落盘,消掉磁盘上的明文密钥(REQ-002 联调实锤,2026-07-03)。
      if (parsed.plain && safeStorage.isEncryptionAvailable()) {
        warn("alpha-byok-keys: re-encrypting legacy plaintext vault")
        persist()
      }
    }
  } catch {
    // No store yet, or undecryptable after an app re-sign (see ADR-017) — start empty; user re-enters.
    keys = {}
  }
}

/**
 * One-time migration OFF opencode's native auth.json (design §0.4). Reads auth.json ONCE; for any
 * catalog BYOK provider that has an "api" key there but no key in alpha's store yet, copies it in.
 * Best-effort and idempotent. This is the ONLY place that reads opencode auth, and only to migrate
 * away from it — after this the call path never touches auth.json.
 */
function migrateFromOpencodeAuth() {
  try {
    const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
    const authPath = join(dataHome, "opencode", "auth.json")
    if (!existsSync(authPath)) return
    const data = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, { type?: string; key?: unknown } | null>
    let migrated = 0
    for (const p of CATALOG.byokProviders) {
      if (keys[p.id]) continue
      const entry = data?.[p.id]
      const key = entry && typeof entry === "object" && entry.type === "api" ? entry.key : undefined
      if (typeof key === "string" && key.length > 0) {
        keys[p.id] = key
        migrated++
      }
    }
    if (migrated > 0) {
      persist()
      try {
        getLogger().log("alpha-byok-keys: migrated keys off opencode auth.json", { count: migrated })
      } catch {}
    }
  } catch (error) {
    warn("alpha-byok-keys: migration from auth.json failed", error)
  }
}

/** Load the store + run one-time auth.json migration. Call once at startup (index.ts), before fork. */
export function initByokKeys(dataPath: string) {
  userDataPath = dataPath
  load()
  migrateFromOpencodeAuth()
}

/** Decrypt-to-env bridge(B21 修订):用户提供的 env 值(shell/alpha.env)永不动;本模块自己注入的
 *  var 权威可变——改键覆盖、删键清除(变更计算见 alpha-byok-env.ts,纯逻辑单测)。Call before every
 *  sidecar (re)fork;key 变更后由 onChanged 触发 respawn → A6 syncSecretFiles 镜像新值。 */
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

// B21:改键/删键即时生效 —— IPC 层持久化成功后经此回调触发「重注 env + respawn」(index.ts 注入;
// respawn 后 fork 时 syncSecretFiles 把新 env 镜像进 {file:} 通道,新 sidecar 即用新 key)。
let onKeysChanged: () => void = () => {}
export function setByokKeyDeps(deps: { onChanged: () => void }) {
  onKeysChanged = deps.onChanged
}

export function getByokKey(id: string): string | undefined {
  return keys[id]
}

/** id -> key map (decrypted). Main-process only; used by getProviderKeyStatus for the configured/hint state. */
export function byokKeyMap(): Map<string, string> {
  return new Map(Object.entries(keys))
}

export function setByokKey(id: string, key: string): { ok: true } | { ok: false; reason: string } {
  if (typeof id !== "string" || !id) return { ok: false, reason: "invalid provider id" }
  if (typeof key !== "string" || key.length === 0) return { ok: false, reason: "missing api key" }
  keys[id] = key
  persist()
  onKeysChanged() // B21:即时生效(重注 env + respawn)
  return { ok: true }
}

export function removeByokKey(id: string): { ok: true } | { ok: false; reason: string } {
  if (!(id in keys)) return { ok: true }
  delete keys[id]
  persist()
  onKeysChanged() // B21:即时吊销(清 env + respawn → A6 删密钥文件)
  return { ok: true }
}

/** Clear the whole store (e.g. for tests / full reset). */
export function clearByokKeys() {
  keys = {}
  try {
    rmSync(filePath(), { force: true })
  } catch {}
}
