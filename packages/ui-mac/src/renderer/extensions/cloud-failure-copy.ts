import { t } from "../i18n"

export function failureCopy(code: string) {
  if (code === "not-authenticated" || code === "unauthorized") {
    return { text: t("alpha.ext.cloudErrAuth"), action: "login" as const }
  }
  if (code === "account_allowance_exhausted") {
    return { text: t("alpha.ext.cloudErrAllowance"), action: "overflow" as const }
  }
  if (code === "account_wallet_insufficient") {
    return { text: t("alpha.ext.cloudErrWallet"), action: "recharge" as const }
  }
  if (code === "account_suspended") return { text: t("alpha.ext.cloudErrSuspended"), action: null }
  return null
}

export function failureCodeFromEvent(payload: { data: unknown }): string | undefined {
  const data = payload.data
  if (!data || typeof data !== "object") return undefined
  // Live/replayed frames contain an event record; synthesized terminal frames contain a status view.
  const event = "type" in data
  const reason =
    event && "data" in data
      ? data.data
      : "job_id" in data && "status" in data && "result" in data
        ? data.result
        : undefined
  if (!reason || typeof reason !== "object") return undefined
  const code = event
    ? "code" in reason
      ? reason.code
      : undefined
    : "failure_code" in reason
      ? reason.failure_code
      : undefined
  return typeof code === "string" && /^[a-z][a-z0-9_]{2,63}$/.test(code) ? code : undefined
}
