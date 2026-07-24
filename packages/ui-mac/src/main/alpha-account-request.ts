import type { RoutePurpose } from "@alpha-code/contracts-consumer"
import type { AccountResult } from "../preload/types"
import type { RenewalResult } from "./alpha-auth"

const REFRESH_COOLDOWN_MS = 30_000

export function createAuthedGet(deps: {
  accountBase: () => string
  getAccessToken: (purpose: RoutePurpose) => string | undefined
  refreshTokens: () => Promise<RenewalResult>
  fetch: typeof fetch
  now: () => number
  warn: (message: string, error: unknown) => void
  isContractIncompatibleError: (error: unknown) => boolean
  reportContractFailure: (error: unknown) => void
}) {
  const refreshCooldownUntil = new Map<RoutePurpose, number>()

  const authedGet = async <T>(
    path: string,
    purpose: RoutePurpose,
    decode: (text: string) => T,
    retried = false,
  ): Promise<AccountResult<T>> => {
    try {
      const token = deps.getAccessToken(purpose)
      if (!token) return { error: "not-authenticated" }
      const res = await deps.fetch(`${deps.accountBase()}${path}`, {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      })
      if (res.status === 401) {
        const now = deps.now()
        if (!retried && now >= (refreshCooldownUntil.get(purpose) ?? 0)) {
          const renewal = await deps.refreshTokens()
          if (renewal.outcome === "refreshed") return authedGet(path, purpose, decode, true)
        }
        if (retried) refreshCooldownUntil.set(purpose, now + REFRESH_COOLDOWN_MS)
        return { error: "unauthorized" }
      }
      if (!res.ok) return { error: `http-${res.status}` }
      return decode(await res.text())
    } catch (error) {
      if (deps.isContractIncompatibleError(error)) {
        deps.reportContractFailure(error)
        return { error: "contract-incompatible" }
      }
      deps.warn("alpha-account: fetch failed", error)
      return { error: "network" }
    }
  }

  return authedGet
}
