// Custom provider lifecycle (REQ-226 `#1343`): a custom provider is two durable writes, in a fixed order,
// followed by ONE runtime refresh.
//   add:    validate → key into the keychain store (fail closed: keychain refuses ⇒ alpha.jsonc untouched,
//           the reason goes back to the form) → definition into alpha.jsonc with the constant marker
//           (never the key) → structural respawn.
//   remove: key out of the store → definition out of alpha.jsonc → structural respawn. Either half failing
//           leaves no leak: store gone / block still there ⇒ marker block, status "needs-reentry"; block
//           gone / store still there ⇒ an orphan encrypted entry that is never materialized (its id is not
//           in alpha.jsonc).
// Persistence is only complete once the process-global sidecar has been rebuilt: the rebuild re-runs
// buildAlphaModelConfig, which merges the persisted provider id into enabled_providers and emits the
// {file:} ref for the key file main materialized at that fork, before the renderer reconnects and asks
// the real v2 model.list again.

import type { ProviderInput, ProviderResult } from "../shared/alpha-model-types"
import { removeByokKey, storeByokKey } from "./alpha-byok-keys"
import { persistProvider, removeProvider, validateProviderInput } from "./ext-config"

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
  const stored = storeByokKey(input.id, input.apiKey)
  if (!stored.ok) return stored
  const persisted = persistProvider(input)
  if (!persisted.ok) return persisted
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
