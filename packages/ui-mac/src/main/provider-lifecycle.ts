// Custom provider lifecycle: persistence is only complete once the process-global sidecar has been
// rebuilt. The rebuild re-runs buildAlphaModelConfig, which merges the persisted provider id into
// enabled_providers before the renderer reconnects and asks the real v2 model.list again.

import type { ProviderInput, ProviderResult } from "../shared/alpha-model-types"
import { persistProvider } from "./ext-config"

let refreshRuntime: (() => Promise<boolean>) | undefined

export function setProviderLifecycleDeps(deps?: { refreshRuntime: () => Promise<boolean> }) {
  refreshRuntime = deps?.refreshRuntime
}

export async function persistProviderAndRefresh(input: ProviderInput): Promise<ProviderResult> {
  if (!refreshRuntime) return { ok: false, reason: "provider runtime is not ready" }
  const persisted = persistProvider(input)
  if (!persisted.ok) return persisted
  const refreshed = await refreshRuntime().catch(() => false)
  return refreshed ? persisted : { ok: false, reason: "provider saved but runtime refresh failed" }
}
