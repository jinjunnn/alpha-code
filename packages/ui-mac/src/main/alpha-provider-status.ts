// Per-provider BYOK key state for the picker (window.api.providers.keyStatus). MAIN-PROCESS ONLY.
//
// CRITICAL (do not move back into alpha-models.ts): this reads alpha's encrypted keychain
// (alpha-byok-keys → electron `safeStorage`) and the logger (→ logging.ts → electron `app` etc.).
// Those are main-process-only electron exports. alpha-models.ts is loaded by the SIDECAR
// (utilityProcess, via buildAlphaModelConfig); a utilityProcess cannot import main-only electron
// exports and crashes at module init ("Sidecar exited before ready … 'electron' does not provide an
// export named 'app'"). Keeping this electron-touching code in its own main-only module keeps the
// sidecar's module graph electron-free.

import catalog from "./alpha-models.json"
import type { AlphaModelCatalog, ProviderKeyStatus } from "../shared/alpha-model-types"
import { readConfiguredProviderKeys } from "./ext-config"
import { byokKeyMap } from "./alpha-byok-keys"

const CATALOG = catalog as unknown as AlphaModelCatalog

/**
 * Per-provider BYOK key state for the picker. A provider is "configured" if alpha's encrypted keychain
 * holds a key for it (source "keychain", the normal path), else if its keyEnv is set in the (main)
 * process env (alpha.env/shell export), else if opencode.jsonc has an inline apiKey (off-catalog custom
 * nodes). opencode's native auth.json is NOT consulted — any prior key there is migrated into the
 * keychain once at startup (alpha-byok-keys.initByokKeys).
 */
export function getProviderKeyStatus(): ProviderKeyStatus {
  const cfgKeyed = readConfiguredProviderKeys() // opencode.jsonc inline apiKey (off-catalog custom nodes)
  const kc = byokKeyMap() // alpha's encrypted BYOK store — the source of truth post-migration
  // Masked tail only (never the full key) so the renderer can show WHICH key is set, not its value.
  const last4 = (k?: string) => (k && k.length >= 4 ? k.slice(-4) : k ? "••" : undefined)
  const out: ProviderKeyStatus = {}
  for (const p of CATALOG.byokProviders) {
    const kcKey = kc.get(p.id)
    const envVal = p.keyEnv ? process.env[p.keyEnv] : undefined
    if (kcKey) out[p.id] = { configured: true, source: "keychain", hint: last4(kcKey) }
    else if (envVal) out[p.id] = { configured: true, source: "env", hint: last4(envVal) }
    else if (cfgKeyed.has(p.id)) out[p.id] = { configured: true, source: "config", hint: last4(cfgKeyed.get(p.id)) }
    else out[p.id] = { configured: false, source: "none" }
  }
  // Off-catalog custom providers: key in the alpha keychain or inline in opencode.jsonc.
  for (const [id, key] of kc) if (!out[id]) out[id] = { configured: true, source: "keychain", hint: last4(key) }
  for (const [id, key] of cfgKeyed) if (!out[id]) out[id] = { configured: true, source: "config", hint: last4(key) }
  return out
}
