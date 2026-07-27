// Fail-closed decoder for the account summary read (`GET {ACCOUNT_BASE}/v1/account/summary`).
//
// Until #631 this surface was `JSON.parse(text) as AccountSummary` — a cast, i.e. ZERO runtime
// checking. Any producer rename, retype or dropped field reached the renderer as a structurally
// broken `AccountSummary` (NaN balances, `undefined.usedCredits`), and no test could see it.
//
// The accepted shape is alpha-web's published contract
// `alpha.web-account.summary.v1` (contracts/web-account/account-summary.v1.schema.json).
//
// THE RULE, and it has exactly one exception: a payload the published schema allows is never
// rejected. This decoder was twice too strict on the inactive-plan branch — first by demanding a
// bare `{ id: "none" }` with no `name`, then by refusing the schema's other optional plan
// properties — so the key-set gate is now structural rather than per-branch: each object is
// screened ONCE against the property set the schema declares for it, and a branch that cannot
// represent a permitted property DISCARDS it rather than rejecting the payload. Adding a
// per-branch key list here is the defect returning; do not reintroduce one.
//
// The one deliberate narrowing is the ACTIVE branch, whose `AccountPlan` variant cannot be built
// without `name`, both credit windows, `renewsAt` and `daysLeft`. `schema_version`/`schema` are
// optional (the producer emits neither today) but are constrained when present.
//
// The KEY SETS BELOW ARE NOT FREE-STANDING CONSTANTS. They are exported and asserted equal to the
// vendored schema's declared property sets by alpha-web-contract-fixtures.test.ts, so an upstream
// release that adds an optional property turns the merge gate red instead of silently making this
// decoder over-strict again. They are not imported into the decoder directly because that would put
// a cross-package JSON import into the packaged main bundle; the binding is enforced by test.
//
// The pinned fixture and schema that drive this decoder are vendored under
// packages/alpha-contracts-consumer/vendor/alpha-web/contracts/web-account/.

import { ContractIncompatibleError } from "@alpha-code/contracts-consumer"
import type { AccountPlan, AccountSummary, AccountWindow } from "../preload/types"

/** Property sets declared by `alpha.web-account.summary.v1`; see the drift test named above. */
export const SUMMARY_KEYS = ["schema_version", "schema", "balanceFen", "walletUsedFen", "plan", "usage", "usageSeries"]
export const PLAN_KEYS = ["id", "name", "status", "window5h", "window7d", "renewsAt", "daysLeft"]
export const WINDOW_KEYS = ["usedCredits", "limitCredits", "resetsInMin"]
export const USAGE_KEYS = ["todayTokens", "weekTokens", "tasksThisMonth"]
export const SERIES_KEYS = ["date", "tokens"]
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/

type Version = number | "missing" | "unknown"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)
const onlyKeys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key))
/** Credits, tokens, fen and day counts are all non-negative integers on this contract. */
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0
const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0
const isCalendarDate = (value: unknown): value is string => typeof value === "string" && CALENDAR_DATE.test(value)

function reject(received: Version): never {
  throw new ContractIncompatibleError({ surface: "account", received_version: received, reason: "schema-validation" })
}

function decodeWindow(value: unknown, version: Version): AccountWindow {
  if (
    !isRecord(value) ||
    !onlyKeys(value, WINDOW_KEYS) ||
    !isCount(value.usedCredits) ||
    !isCount(value.limitCredits) ||
    !isCount(value.resetsInMin)
  )
    reject(version)
  return { usedCredits: value.usedCredits, limitCredits: value.limitCredits, resetsInMin: value.resetsInMin }
}

function decodeUsage(value: unknown, version: Version): AccountSummary["usage"] {
  if (
    !isRecord(value) ||
    !onlyKeys(value, USAGE_KEYS) ||
    !isCount(value.todayTokens) ||
    !isCount(value.weekTokens) ||
    !isCount(value.tasksThisMonth)
  )
    reject(version)
  return { todayTokens: value.todayTokens, weekTokens: value.weekTokens, tasksThisMonth: value.tasksThisMonth }
}

function decodePlan(value: unknown, version: Version): AccountPlan {
  if (!isRecord(value) || !onlyKeys(value, PLAN_KEYS) || !isText(value.id)) reject(version)
  // Inactive plan. The schema requires only { id, status } and permits every other plan property
  // here too; alpha-platform#106's emptyPlan() emits { id: "none", name: "None", status: "none" }.
  // The key set was already screened above, so this branch adds NO key restriction of its own: it
  // keeps what the inactive `AccountPlan` variant can carry and lets the rest fall away. The
  // discarded properties are deliberately not type-checked — they reach no consumer, and checking
  // them could only turn a schema-valid payload into a rejection.
  if (value.status === "none") {
    if (value.name === undefined) return { id: value.id, status: "none" }
    if (!isText(value.name)) reject(version)
    return { id: value.id, name: value.name, status: "none" }
  }
  if (value.status !== "active" || !isText(value.name) || !isCalendarDate(value.renewsAt) || !isCount(value.daysLeft))
    reject(version)
  return {
    id: value.id,
    name: value.name,
    status: "active",
    window5h: decodeWindow(value.window5h, version),
    window7d: decodeWindow(value.window7d, version),
    renewsAt: value.renewsAt,
    daysLeft: value.daysLeft,
  }
}

/** Decodes an account-summary response body. Throws `ContractIncompatibleError` on anything the
 *  contract does not describe, so `createAuthedGet` surfaces `contract-incompatible` and reports the
 *  failure instead of handing the renderer a malformed summary. */
export function decodeAccountSummary(text: string): AccountSummary {
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    reject("unknown")
  }
  if (!isRecord(payload)) reject("missing")
  const version: Version =
    "schema_version" in payload ? (typeof payload.schema_version === "number" ? payload.schema_version : "unknown") : "missing"
  if (
    !onlyKeys(payload, SUMMARY_KEYS) ||
    (payload.schema_version !== undefined && payload.schema_version !== 1) ||
    (payload.schema !== undefined && payload.schema !== "alpha.web-account.summary.v1") ||
    !isCount(payload.balanceFen) ||
    !isCount(payload.walletUsedFen) ||
    !Array.isArray(payload.usageSeries)
  )
    reject(version)
  const usageSeries = payload.usageSeries.map((point: unknown) => {
    if (!isRecord(point) || !onlyKeys(point, SERIES_KEYS) || !isCalendarDate(point.date) || !isCount(point.tokens))
      reject(version)
    return { date: point.date, tokens: point.tokens }
  })
  return {
    balanceFen: payload.balanceFen,
    walletUsedFen: payload.walletUsedFen,
    plan: decodePlan(payload.plan, version),
    usage: decodeUsage(payload.usage, version),
    usageSeries,
  }
}
