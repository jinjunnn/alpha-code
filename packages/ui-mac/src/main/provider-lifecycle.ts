// Custom provider lifecycle (REQ-226 `#1343`; `#1392` moved the definition to the truth file): a custom provider is
// two durable writes, in a fixed order, followed by ONE runtime refresh. MAIN-PROCESS ONLY — this is the only
// module besides the write module itself that imports custom-provider-truth-write.ts, and neither may enter the
// sidecar's import closure (custom-provider-truth-write.test.ts measures that closure against production).
//   add:    validate (address admission = the egress classifier, ext-config.ts validateProviderInput) → read the
//           current truth (a truth file that fails the strict read REFUSES the add before anything is stored: no
//           orphan key, no silent overwrite of records we cannot read) → key into the keychain store (fail closed:
//           keychain refuses ⇒ truth untouched, the reason goes back to the form) → the record into
//           `<appData>/alpha-code-state/custom-providers/<env>.json` (`#1391` truth: main-only writable, outside
//           every fence root; same id ⇒ the record is replaced in place; the key NEVER goes there) → structural
//           respawn. If the truth write fails AFTER the store write, the store is put back exactly as it was
//           (R1 finding 2): a first fill must not leave an orphan entry claiming "configured", and a re-entry must
//           not silently swap the old key while the record still describes the old service. If that rollback
//           itself cannot be persisted (R2 minor), the caller is told so — memory and disk then disagree and the
//           next launch would revive the entry; hiding that behind the write failure is worse.
//   remove: key out of the store → record out of the truth file → structural respawn. Either half failing leaves
//           no leak: store gone / record still there ⇒ status "needs-reentry"; record gone / store still there ⇒
//           an orphan encrypted entry that is never materialized (its id is not in the truth file, so server.ts
//           never asks for it).
//   set-key (catalog presets): if this id still carries a pre-#1343 inline plaintext key in any provider read
//           path, that ONE leaf (`provider.<id>.options.apiKey`) is retired first (R1 finding 1 / R2 blocker) —
//           `needs-reentry` is configured:false, so the picker never offers "remove" and a plain store write
//           never touches config: without this the plaintext would stay forever. Only the leaf: the block
//           (npm / baseURL / models — often the user's hand-written opencode CLI config) stays, and files without
//           the leaf are not written. Retire BEFORE storing: a busy lock then refuses with nothing half-done.
// alpha.jsonc and the other two config files are NOT written by this module any more (基线 I1 / I3): whatever
// provider blocks they still carry are ignored (server.ts logs which, once per process) — the user re-adds the
// service from the picker and the truth file becomes its only home.
// Persistence is only complete once the process-global sidecar has been rebuilt: the rebuild re-runs
// buildAlphaModelConfig, which emits the record as a full provider block (allowlist + baseURL + models) and the
// {file:} ref for the key file main materialized at that fork, before the renderer reconnects and asks the real
// v2 model.list again.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import type { ProviderInput, ProviderResult } from "../shared/alpha-model-types"
import { isExtensionName } from "../shared/extension-name"
import { discardByokKey, getByokKey, removeByokKey, setByokKey, storeByokKey } from "./alpha-byok-keys"
import { resolveCustomProviderTruthLocation } from "./custom-provider-records"
import { canonicalCustomProviderRecord, readCustomProviderTruth, type CustomProviderRecord } from "./custom-provider-truth"
import { writeCustomProviderTruth } from "./custom-provider-truth-write"
import { retireLegacyProviderKeys, validateProviderInput } from "./ext-config"
import { getLogger } from "./logging"

let refreshRuntime: (() => Promise<boolean>) | undefined

export function setProviderLifecycleDeps(deps?: { refreshRuntime: () => Promise<boolean> }) {
  refreshRuntime = deps?.refreshRuntime
}

const truthFs = { mkdirSync, writeFileSync, renameSync, rmSync }
const log = (line: string) => getLogger()?.warn(line)

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The current truth: location + records. Location unknown or file unreadable ⇒ refuse (reason names the file); absent ⇒ empty. */
function currentTruth(): { ok: true; path: string; providers: CustomProviderRecord[] } | { ok: false; reason: string } {
  const location = resolveCustomProviderTruthLocation()
  if (!location.ok) return { ok: false, reason: `custom-provider truth location unknown — ${location.reason}` }
  const read = readCustomProviderTruth(location.path, { readFileSync, log })
  if (!read.ok) return { ok: false, reason: `existing custom-provider records are unreadable — ${read.reason}; nothing was changed` }
  return { ok: true, path: location.path, providers: read.providers }
}

function writeTruth(path: string, providers: readonly CustomProviderRecord[]): ProviderResult {
  try {
    writeCustomProviderTruth(path, providers, truthFs)
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: `custom-provider truth write failed — ${errorMessage(error)}` }
  }
}

/** The record the truth file keeps for this input: definition only, model ids trimmed, never the key. */
function recordFromInput(input: ProviderInput): CustomProviderRecord {
  return canonicalCustomProviderRecord({
    id: input.id,
    name: input.name,
    compat: input.compat,
    baseURL: input.baseURL,
    models: input.models.map((m) => String(m).trim()).filter(Boolean),
  })
}

export async function persistProviderAndRefresh(input: ProviderInput): Promise<ProviderResult> {
  if (!refreshRuntime) return { ok: false, reason: "provider runtime is not ready" }
  // Validate before the store write so a rejected definition never leaves an orphan key behind.
  const valid = validateProviderInput(input)
  if (!valid.ok) return valid
  // Read the truth BEFORE the store write for the same reason: an unreadable truth file refuses the whole add.
  const truth = currentTruth()
  if (!truth.ok) return { ok: false, reason: truth.reason }
  // Keychain first. storeByokKey does not notify — the single respawn below is the refresh.
  const previous = getByokKey(input.id)
  const stored = storeByokKey(input.id, input.apiKey)
  if (!stored.ok) return stored
  const record = recordFromInput(input)
  const next = truth.providers.some((r) => r.id === input.id)
    ? truth.providers.map((r) => (r.id === input.id ? record : r))
    : [...truth.providers, record]
  const persisted = writeTruth(truth.path, next)
  if (!persisted.ok) {
    // ② failed after ①: restore the store to its pre-call state (silent — nothing reached a sidecar).
    const restored = previous === undefined ? discardByokKey(input.id) : storeByokKey(input.id, previous)
    if (!restored.ok)
      return {
        ok: false,
        reason: `${persisted.reason}; key store rollback failed too: ${restored.reason} — the key store may disagree with the saved services until the service is re-added`,
      }
    return persisted
  }
  getLogger()?.log(`custom providers: saved ${input.id} (${record.baseURL}) to ${truth.path}; ${next.length} record(s) now`)
  const refreshed = await refreshRuntime().catch(() => false)
  return refreshed ? persisted : { ok: false, reason: "provider saved but runtime refresh failed" }
}

export async function removeProviderAndRefresh(id: string): Promise<ProviderResult> {
  if (!refreshRuntime) return { ok: false, reason: "provider runtime is not ready" }
  if (!isExtensionName(id)) return { ok: false, reason: "invalid provider id" }
  const truth = currentTruth()
  if (!truth.ok) return { ok: false, reason: truth.reason }
  const dropped = removeByokKey(id)
  if (!dropped.ok) return dropped
  if (truth.providers.some((r) => r.id === id)) {
    const removed = writeTruth(
      truth.path,
      truth.providers.filter((r) => r.id !== id),
    )
    if (!removed.ok) return removed
    getLogger()?.log(`custom providers: removed ${id} from ${truth.path}; ${truth.providers.length - 1} record(s) now`)
  }
  const refreshed = await refreshRuntime().catch(() => false)
  return refreshed ? { ok: true } : { ok: false, reason: "provider removed but runtime refresh failed" }
}

/** providers-set-key: store a key in the keychain (notifies: env re-inject + respawn); if this id still has a
 *  legacy plaintext `options.apiKey` leaf in any provider read path, retire that leaf first — see the file header. */
export function setProviderKeyAndRetireLegacyKey(id: string, key: string): ProviderResult {
  const retired = retireLegacyProviderKeys(id)
  if (!retired.ok) return retired
  return setByokKey(id, key)
}
