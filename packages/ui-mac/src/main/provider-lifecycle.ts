// Custom provider lifecycle (REQ-226 `#1343`): a custom provider is two durable writes, in a fixed order,
// followed by ONE runtime refresh.
//   add:    validate → key into the keychain store (fail closed: keychain refuses ⇒ alpha.jsonc untouched,
//           the reason goes back to the form) → definition into alpha.jsonc with the constant marker
//           (never the key) → structural respawn. If the alpha.jsonc write fails AFTER the store write
//           (config lock busy, write refused) the store is put back exactly as it was (R1 finding 2): a
//           first fill must not leave an orphan entry claiming "configured", and a re-entry must not
//           silently swap the old key while the block still describes the old service. If that rollback
//           itself cannot be persisted (R2 minor), the caller is told so — memory and disk then disagree
//           and the next launch would revive the entry; hiding that behind "config busy" is worse.
//   remove: key out of the store → definition out of alpha.jsonc → structural respawn. Either half failing
//           leaves no leak: store gone / block still there ⇒ marker block, status "needs-reentry"; block
//           gone / store still there ⇒ an orphan encrypted entry that is never materialized (its id is not
//           in alpha.jsonc).
//   set-key (catalog presets): if this id still carries a pre-#1343 inline plaintext key in any provider read
//           path, that ONE leaf (`provider.<id>.options.apiKey`) is retired first (R1 finding 1 / R2 blocker) —
//           `needs-reentry` is configured:false, so the picker never offers "remove" and a plain store write
//           never touches config: without this the plaintext would stay forever. Only the leaf: the block
//           (npm / baseURL / models — often the user's hand-written opencode CLI config) stays, and files without
//           the leaf are not written (deleting a whole block from an alpha.jsonc that has no `provider` key threw
//           `Can not delete in empty document`, so the key never reached the store). Retire BEFORE storing: a
//           busy lock then refuses with nothing half-done, and a keychain refusal after the retirement only
//           loses a leaf the engine was already forbidden to use.
// Persistence is only complete once the process-global sidecar has been rebuilt: the rebuild re-runs
// buildAlphaModelConfig, which merges the persisted provider id into enabled_providers and emits the
// {file:} ref for the key file main materialized at that fork, before the renderer reconnects and asks
// the real v2 model.list again.

import type { ProviderInput, ProviderResult } from "../shared/alpha-model-types"
import { discardByokKey, getByokKey, removeByokKey, setByokKey, storeByokKey } from "./alpha-byok-keys"
import { persistProvider, removeProvider, retireLegacyProviderKeys, validateProviderInput } from "./ext-config"

let refreshRuntime: (() => Promise<boolean>) | undefined

export function setProviderLifecycleDeps(deps?: { refreshRuntime: () => Promise<boolean> }) {
  refreshRuntime = deps?.refreshRuntime
}

export async function persistProviderAndRefresh(input: ProviderInput): Promise<ProviderResult> {
  if (!refreshRuntime) return { ok: false, reason: "provider runtime is not ready" }
  // Validate before the store write so a rejected definition never leaves an orphan key behind.
  const valid = validateProviderInput(input)
  if (!valid.ok) return valid
  // Keychain first. storeByokKey does not notify — the single respawn below is the refresh.
  const previous = getByokKey(input.id)
  const stored = storeByokKey(input.id, input.apiKey)
  if (!stored.ok) return stored
  const persisted = persistProvider(input)
  if (!persisted.ok) {
    // ② failed after ①: restore the store to its pre-call state (silent — nothing reached a sidecar).
    const restored = previous === undefined ? discardByokKey(input.id) : storeByokKey(input.id, previous)
    if (!restored.ok)
      return {
        ok: false,
        reason: `${persisted.reason}; key store rollback failed too: ${restored.reason} — the key store may disagree with the config until the service is re-added`,
      }
    return persisted
  }
  const refreshed = await refreshRuntime().catch(() => false)
  return refreshed ? persisted : { ok: false, reason: "provider saved but runtime refresh failed" }
}

export async function removeProviderAndRefresh(id: string): Promise<ProviderResult> {
  if (!refreshRuntime) return { ok: false, reason: "provider runtime is not ready" }
  const dropped = removeByokKey(id)
  if (!dropped.ok) return dropped
  const removed = removeProvider(id)
  if (!removed.ok) return removed
  const refreshed = await refreshRuntime().catch(() => false)
  return refreshed ? removed : { ok: false, reason: "provider removed but runtime refresh failed" }
}

/** providers-set-key: store a key in the keychain (notifies: env re-inject + respawn); if this id still has a
 *  legacy plaintext `options.apiKey` leaf in any provider read path, retire that leaf first — see the file header. */
export function setProviderKeyAndRetireLegacyKey(id: string, key: string): ProviderResult {
  const retired = retireLegacyProviderKeys(id)
  if (!retired.ok) return retired
  return setByokKey(id, key)
}
