// Per-provider key state for the picker (window.api.providers.keyStatus). MAIN-PROCESS ONLY.
//
// CRITICAL (do not move back into alpha-models.ts): this reads alpha's encrypted keychain
// (alpha-byok-keys → electron `safeStorage`) and the logger (→ logging.ts → electron `app` etc.).
// Those are main-process-only electron exports. alpha-models.ts is loaded by the SIDECAR
// (utilityProcess, via buildAlphaModelConfig); a utilityProcess cannot import main-only electron
// exports and crashes at module init ("Sidecar exited before ready … 'electron' does not provide an
// export named 'app'"). Keeping this electron-touching code in its own main-only module keeps the
// sidecar's module graph electron-free.

import catalog from "./alpha-models.json"
import type { AlphaModelCatalog, ProviderKeyState, ProviderKeyStatus } from "../shared/alpha-model-types"
import { readConfiguredProviderKeys, type ProviderKeyKind } from "./ext-config"
import { byokKeyMap } from "./alpha-byok-keys"

const CATALOG = catalog as unknown as AlphaModelCatalog

/** Masked tail only (never the full key) so the renderer can show WHICH key is set, not its value. */
const last4 = (k: string): string => (k.length >= 4 ? k.slice(-4) : "••")

/** REQ-226 (`#1343`): the state of an alpha.jsonc provider block whose key is NOT in the keychain store.
 *  The value is never read (readConfiguredProviderKeys returns kinds only), so there is never a hint:
 *   "user-ref"          → configured via a hand-written `{file:}` / `{env:}` (alpha does not manage it)
 *   "legacy-plaintext"  → a pre-#1343 inline key the engine is no longer allowed to use → needs re-entry
 *   "keychain-marker"   → alpha's marker but the store has no key (keychain unavailable / re-signed /
 *                          entry gone) → needs re-entry */
function configOnlyState(kind: ProviderKeyKind): ProviderKeyState {
  return kind === "user-ref" ? { configured: true, source: "config" } : { configured: false, source: "needs-reentry" }
}

/**
 * Per-provider key state for the picker. A provider is "configured" if alpha's encrypted keychain
 * holds a key for it (source "keychain", the normal path — the only source with a last-4 hint), else if
 * its keyEnv is set in the (main) process env (alpha.env/shell export), else if alpha.jsonc carries a
 * hand-written reference. Nothing here ever returns a key value; a config file's plaintext is never read.
 */
export function getProviderKeyStatus(): ProviderKeyStatus {
  const cfgKinds = readConfiguredProviderKeys() // alpha.jsonc provider blocks, classified, value-free
  const kc = byokKeyMap() // alpha's encrypted key store — the source of truth
  const out: ProviderKeyStatus = {}
  for (const p of CATALOG.byokProviders) {
    const kcKey = kc.get(p.id)
    const envVal = p.keyEnv ? process.env[p.keyEnv] : undefined
    const kind = cfgKinds.get(p.id)
    if (kcKey) out[p.id] = { configured: true, source: "keychain", hint: last4(kcKey) }
    else if (envVal) out[p.id] = { configured: true, source: "env", hint: last4(envVal) }
    else if (kind) out[p.id] = configOnlyState(kind)
    else out[p.id] = { configured: false, source: "none" }
  }
  // Off-catalog custom providers: key in the keychain store, else whatever the alpha.jsonc block says.
  for (const [id, key] of kc) if (!out[id]) out[id] = { configured: true, source: "keychain", hint: last4(key) }
  for (const [id, kind] of cfgKinds) if (!out[id]) out[id] = configOnlyState(kind)
  return out
}
