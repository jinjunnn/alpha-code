import type {
  PackageProfilePayloadV1,
  PackageSupportedComponentV1,
} from "./host-extension-package-contract/decoder"

/**
 * Registered Alpha Connection v1 — the frozen shapes for the *other* remote-MCP authorization kind,
 * the one whose protocol authority is a handler compiled into this App rather than the engine's
 * OAuth stack.
 *
 * Three boundaries are load-bearing here and each of them is the reason a field looks the way it
 * does:
 *
 * 1. **`connectionHandlerId` grammar is not ours.** The decoder froze it
 *    (`^[a-z][a-z0-9-]{0,63}$`) and main is only ever allowed to look the finished id up in a
 *    static table. Nothing in this file — or in any main module — may branch on a prefix, a
 *    segment, or a namespace inside that id. Re-deriving meaning from someone else's token is the
 *    `#737` defect class, and the discipline is written down in
 *    `docs/architecture/host-extension-package-contract-boundary.md`.
 *
 * 2. **Handler output is untrusted input.** A handler runs App code, but it speaks to a third
 *    party, so what comes back is decoded with an exact key allowlist before a single byte of it
 *    reaches a durable record. That is why `AlphaConnectionStatusV1` carries `result: unknown`:
 *    the type system must not let a handler hand main a pre-shaped record.
 *
 * 3. **A connection outlives the packages that use it.** Its record is main-owned and lives
 *    outside every path an uninstall touches; a package binds a `connectionId` and nothing else.
 *    Releasing the last binding is not a reason to disconnect — revoking access is a separate,
 *    explicit user action, because the durable side effect lives at the provider, not here.
 */
export const ALPHA_CONNECTION_PREREQUISITE_PROFILE_V1 = "alpha.connection.v1" as const

export const ALPHA_CONNECTION_RECORD_SCHEMA_V1 = "alpha.connection-record.v1" as const

export const ALPHA_CONNECTION_REFERENCE_SCHEMA_V1 = "alpha.package-connection-reference.v1" as const

export type PackageConnectionStateV1 = "ready" | "required-action" | "blocked" | "update-required"

/**
 * Every terminal answer this subsystem can give. The list is exhaustive on purpose: a caller that
 * cannot name its failure cannot fail closed, and a UI that cannot name it invents its own wording.
 */
export const PACKAGE_CONNECTION_REASON_CODES_V1 = [
  "connection-ready",
  "connection-required",
  "connection-handler-unknown",
  "connection-profile-invalid",
  "connection-attempt-stale",
  "connection-cancelled",
  "connection-handler-error",
  "connection-result-invalid",
  "connection-reuse-conflict",
  "connection-record-disconnected",
  "connection-record-expired",
] as const

export type PackageConnectionReasonCodeV1 = (typeof PACKAGE_CONNECTION_REASON_CODES_V1)[number]

/**
 * Nothing here is a dead end. Every failure leaves zero durable local writes behind and can be
 * retried by starting a fresh attempt, which is what makes "fail closed" affordable — the cheap
 * refusal is also the correct one.
 */
export const PACKAGE_CONNECTION_RETRYABLE_REASONS_V1: readonly PackageConnectionReasonCodeV1[] = [
  "connection-required",
  "connection-attempt-stale",
  "connection-cancelled",
  "connection-handler-error",
  "connection-result-invalid",
  "connection-reuse-conflict",
  "connection-record-disconnected",
  "connection-record-expired",
]

export type PackageConnectionPrerequisiteItemV1 = {
  prerequisiteId: string
  componentId: string
  /** Opaque to main: table key only, never parsed. */
  handlerId: string
  label: string
  required: boolean
}

export type PackageConnectionPrerequisiteProfileV1 = {
  profile: typeof ALPHA_CONNECTION_PREREQUISITE_PROFILE_V1
  componentId: string
  items: PackageConnectionPrerequisiteItemV1[]
}

/**
 * What main hands a handler to start work. It is derived entirely from signed facts plus a
 * main-minted id; the renderer contributes nothing but the decision to begin.
 */
export type PackageConnectionAttemptV1 = {
  attemptId: string
  handlerId: string
  prerequisiteId: string
  componentId: string
  catalogId: string
  envelopeDigest: string
  createdAt: string
}

/** The bounded record a handler may return. There is no field here a credential can hide in. */
export type AlphaConnectionResultV1 = {
  serviceIdentity: { serviceId: string; accountLabel: string }
  reuseKey: string
  expiresAt?: string
}

export type AlphaConnectionBeginV1 =
  | { ok: true; state: "pending"; browserUrl?: string }
  | { ok: false; reasonCode: Extract<PackageConnectionReasonCodeV1, "connection-handler-error"> }

export type AlphaConnectionStatusV1 =
  | { ok: true; state: "pending" }
  /** `unknown` is deliberate — see boundary 2 in the module header. */
  | { ok: true; state: "ready"; result: unknown }
  | {
      ok: false
      reasonCode: Extract<
        PackageConnectionReasonCodeV1,
        "connection-cancelled" | "connection-handler-error"
      >
    }

export type AlphaConnectionDisconnectV1 =
  | { ok: true }
  | { ok: false; reasonCode: Extract<PackageConnectionReasonCodeV1, "connection-handler-error"> }

/** The fixed handler interface. Three verbs, no escape hatch, no host APIs handed over. */
export type AlphaConnectionHandlerV1 = {
  handlerId: string
  displayName: string
  begin(attempt: PackageConnectionAttemptV1): Promise<AlphaConnectionBeginV1>
  status(attemptId: string): Promise<AlphaConnectionStatusV1>
  disconnect(connectionId: string): Promise<AlphaConnectionDisconnectV1>
}

export type AlphaConnectionHandlerTableV1 = Readonly<Record<string, AlphaConnectionHandlerV1>>

export type AlphaConnectionStateV1 = "ready" | "disconnected"

export type ConnectionRecordV1 = {
  schema: typeof ALPHA_CONNECTION_RECORD_SCHEMA_V1
  connectionId: string
  handlerId: string
  serviceId: string
  accountLabel: string
  reuseKey: string
  state: AlphaConnectionStateV1
  /** Component ids currently bound to this connection. Sorted, unique, and never a delete trigger. */
  packageBindings: string[]
  createdAt: string
  updatedAt: string
  expiresAt?: string
}

/** The only connection fact a package may carry. No credential, no reuse key, no account label. */
export type PackageConnectionReferenceV1 = {
  schema: typeof ALPHA_CONNECTION_REFERENCE_SCHEMA_V1
  prerequisiteId: string
  componentId: string
  handlerId: string
  connectionId: string
}

export type PackageConnectionEvaluationV1 = {
  state: PackageConnectionStateV1
  reasonCode: PackageConnectionReasonCodeV1
  prerequisiteIds: string[]
  connectionId?: string
}

export type AlphaConnectionResultDecodeV1 =
  | { ok: true; result: AlphaConnectionResultV1 }
  | { ok: false; reasonCode: "connection-result-invalid"; errors: string[] }

const RESULT_KEYS = new Set(["serviceIdentity", "reuseKey", "expiresAt"])
const SERVICE_IDENTITY_KEYS = new Set(["serviceId", "accountLabel"])
const RECORD_KEYS = new Set([
  "schema",
  "connectionId",
  "handlerId",
  "serviceId",
  "accountLabel",
  "reuseKey",
  "state",
  "packageBindings",
  "createdAt",
  "updatedAt",
  "expiresAt",
])

export const ALPHA_CONNECTION_ID_RE = /^c-[0-9a-f]{32}$/
export const ALPHA_CONNECTION_HANDLER_ID_RE = /^[a-z][a-z0-9-]{0,63}$/
const SERVICE_ID_RE = /^[a-z][a-z0-9-]{0,63}$/
const REUSE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const COMPONENT_ID_RE = /^[a-z][a-z0-9-]{0,31}:[a-z0-9][a-z0-9._-]{0,127}$/
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1f\x7f]/
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/

/**
 * Project the signed component into the connection prerequisite the user will be asked to satisfy.
 * Only the host-owned, already strictly decoded payload is consulted — the web Declaration is
 * absent from this API for the same reason it is absent from the secret projection.
 */
export function decodePackageConnectionPrerequisiteProfileV1(
  component: PackageSupportedComponentV1,
  payload: PackageProfilePayloadV1,
): PackageConnectionPrerequisiteProfileV1 {
  if (
    payload.schema !== "alpha.host-extension-package.payload.mcp-remote.v1" ||
    payload.behavior.auth === "none" ||
    payload.behavior.auth.kind !== "alpha-connection"
  )
    return { profile: ALPHA_CONNECTION_PREREQUISITE_PROFILE_V1, componentId: component.id, items: [] }
  const auth = payload.behavior.auth
  return {
    profile: ALPHA_CONNECTION_PREREQUISITE_PROFILE_V1,
    componentId: component.id,
    items: [
      {
        prerequisiteId: `${component.id}#${auth.prerequisiteId}`,
        componentId: component.id,
        handlerId: auth.connectionHandlerId,
        label: auth.label ?? auth.prerequisiteId,
        // A component that is itself optional cannot impose a required prerequisite; a required
        // component with `auth.required === false` may still install and stay unavailable.
        required: component.required && auth.required,
      },
    ],
  }
}

/**
 * Strictly decode what a handler returned. Unknown keys are refused rather than dropped: dropping
 * would let a handler ship a credential that this build happens not to persist and the next one
 * does, and the refusal is what makes "no credential in the record" a property of the decoder
 * instead of a property of the current call sites.
 */
export function decodeAlphaConnectionResultV1(value: unknown): AlphaConnectionResultDecodeV1 {
  const errors: string[] = []
  if (!isObject(value)) return invalidResult(["result: must be an object"])
  for (const key of Object.keys(value))
    if (!RESULT_KEYS.has(key)) errors.push(`result: unknown key "${key}" — refused (strict schema)`)

  const identity = value.serviceIdentity
  let serviceId: string | undefined
  let accountLabel: string | undefined
  if (!isObject(identity)) {
    errors.push("result.serviceIdentity: required object")
  } else {
    for (const key of Object.keys(identity))
      if (!SERVICE_IDENTITY_KEYS.has(key))
        errors.push(`result.serviceIdentity: unknown key "${key}" — refused (strict schema)`)
    serviceId = boundedString(identity.serviceId, "result.serviceIdentity.serviceId", 64, errors, SERVICE_ID_RE)
    accountLabel = boundedString(identity.accountLabel, "result.serviceIdentity.accountLabel", 120, errors)
  }
  const reuseKey = boundedString(value.reuseKey, "result.reuseKey", 128, errors, REUSE_KEY_RE)
  const hasExpiry = Object.hasOwn(value, "expiresAt")
  const expiresAt = hasExpiry
    ? boundedString(value.expiresAt, "result.expiresAt", 32, errors, ISO_RE)
    : undefined

  if (errors.length || !serviceId || !accountLabel || !reuseKey || (hasExpiry && !expiresAt))
    return invalidResult(errors.length ? errors : ["result: incomplete"])
  return {
    ok: true,
    result: {
      serviceIdentity: { serviceId, accountLabel },
      reuseKey,
      ...(expiresAt ? { expiresAt } : {}),
    },
  }
}

/** Strict record decoder. Corrupt or unknown-shaped records are unusable, never partially trusted. */
export function decodeConnectionRecordV1(
  value: unknown,
): { ok: true; record: ConnectionRecordV1 } | { ok: false; errors: string[] } {
  const errors: string[] = []
  if (!isObject(value)) return { ok: false, errors: ["record: must be an object"] }
  if (value.schema !== ALPHA_CONNECTION_RECORD_SCHEMA_V1)
    return { ok: false, errors: [`record.schema: unsupported ${JSON.stringify(value.schema)}`] }
  for (const key of Object.keys(value))
    if (!RECORD_KEYS.has(key)) errors.push(`record: unknown key "${key}" — refused (strict schema)`)

  const connectionId = boundedString(value.connectionId, "record.connectionId", 64, errors, ALPHA_CONNECTION_ID_RE)
  const handlerId = boundedString(value.handlerId, "record.handlerId", 64, errors, ALPHA_CONNECTION_HANDLER_ID_RE)
  const serviceId = boundedString(value.serviceId, "record.serviceId", 64, errors, SERVICE_ID_RE)
  const accountLabel = boundedString(value.accountLabel, "record.accountLabel", 120, errors)
  const reuseKey = boundedString(value.reuseKey, "record.reuseKey", 128, errors, REUSE_KEY_RE)
  const createdAt = boundedString(value.createdAt, "record.createdAt", 32, errors, ISO_RE)
  const updatedAt = boundedString(value.updatedAt, "record.updatedAt", 32, errors, ISO_RE)
  const state = value.state === "ready" || value.state === "disconnected" ? value.state : undefined
  if (!state) errors.push('record.state: expected "ready" or "disconnected"')
  const bindings = decodePackageBindings(value.packageBindings, errors)
  const hasExpiry = Object.hasOwn(value, "expiresAt")
  const expiresAt = hasExpiry
    ? boundedString(value.expiresAt, "record.expiresAt", 32, errors, ISO_RE)
    : undefined

  if (
    errors.length ||
    !connectionId ||
    !handlerId ||
    !serviceId ||
    !accountLabel ||
    !reuseKey ||
    !createdAt ||
    !updatedAt ||
    !state ||
    !bindings ||
    (hasExpiry && !expiresAt)
  )
    return { ok: false, errors: errors.length ? errors : ["record: incomplete"] }
  return {
    ok: true,
    record: {
      schema: ALPHA_CONNECTION_RECORD_SCHEMA_V1,
      connectionId,
      handlerId,
      serviceId,
      accountLabel,
      reuseKey,
      state,
      packageBindings: bindings,
      createdAt,
      updatedAt,
      ...(expiresAt ? { expiresAt } : {}),
    },
  }
}

/**
 * Build the record a completed attempt produces, reusing the existing connection when the handler
 * reports the same reuse key. Reuse is decided here, once, from the handler's bounded result — the
 * renderer has no way to name a connection, and admission never invents one.
 */
export function nextConnectionRecordV1(
  existing: ReadonlyArray<ConnectionRecordV1>,
  attempt: PackageConnectionAttemptV1,
  result: AlphaConnectionResultV1,
  mint: { connectionId: string; now: string },
):
  | { ok: true; record: ConnectionRecordV1; reused: boolean }
  | { ok: false; reasonCode: "connection-reuse-conflict" } {
  const sameHandler = existing.filter((record) => record.handlerId === attempt.handlerId)
  const match = sameHandler.filter((record) => record.reuseKey === result.reuseKey)
  if (match.length > 1) return { ok: false, reasonCode: "connection-reuse-conflict" }
  const prior = match[0]
  // A second live identity for the same handler is a real ambiguity, not something to guess at:
  // this build has no multi-account model, so it refuses instead of silently picking one.
  if (!prior && sameHandler.some((record) => record.state === "ready"))
    return { ok: false, reasonCode: "connection-reuse-conflict" }
  if (prior && prior.serviceId !== result.serviceIdentity.serviceId)
    return { ok: false, reasonCode: "connection-reuse-conflict" }
  if (!ALPHA_CONNECTION_ID_RE.test(mint.connectionId)) return { ok: false, reasonCode: "connection-reuse-conflict" }
  return {
    ok: true,
    reused: !!prior,
    record: {
      schema: ALPHA_CONNECTION_RECORD_SCHEMA_V1,
      connectionId: prior?.connectionId ?? mint.connectionId,
      handlerId: attempt.handlerId,
      serviceId: result.serviceIdentity.serviceId,
      accountLabel: result.serviceIdentity.accountLabel,
      reuseKey: result.reuseKey,
      state: "ready",
      packageBindings: prior?.packageBindings ?? [],
      createdAt: prior?.createdAt ?? mint.now,
      updatedAt: mint.now,
      ...(result.expiresAt ? { expiresAt: result.expiresAt } : {}),
    },
  }
}

/**
 * Answer, for one signed prerequisite, whether this host may proceed. Every branch is named and
 * every non-ready branch is retryable; there is no path that returns "probably fine".
 */
export function evaluatePackageConnectionPrerequisiteV1(
  item: PackageConnectionPrerequisiteItemV1,
  records: ReadonlyArray<ConnectionRecordV1>,
  handlerKnown: boolean,
  now: Date,
): PackageConnectionEvaluationV1 {
  const ids = [item.prerequisiteId]
  if (!handlerKnown)
    return { state: "update-required", reasonCode: "connection-handler-unknown", prerequisiteIds: ids }
  const candidates = records.filter((record) => record.handlerId === item.handlerId)
  const live = candidates.filter((record) => record.state === "ready" && !isExpired(record, now))
  if (live.length > 1)
    return { state: "blocked", reasonCode: "connection-reuse-conflict", prerequisiteIds: ids }
  const connection = live[0]
  if (connection)
    return {
      state: "ready",
      reasonCode: "connection-ready",
      prerequisiteIds: ids,
      connectionId: connection.connectionId,
    }
  if (candidates.some((record) => record.state === "ready" && isExpired(record, now)))
    return { state: "required-action", reasonCode: "connection-record-expired", prerequisiteIds: ids }
  if (candidates.some((record) => record.state === "disconnected"))
    return { state: "required-action", reasonCode: "connection-record-disconnected", prerequisiteIds: ids }
  return { state: "required-action", reasonCode: "connection-required", prerequisiteIds: ids }
}

/** The durable-safe projection a package may carry. Deliberately narrower than the record. */
export function packageConnectionReferenceV1(
  item: PackageConnectionPrerequisiteItemV1,
  record: ConnectionRecordV1,
): PackageConnectionReferenceV1 | undefined {
  if (record.handlerId !== item.handlerId) return
  if (!ALPHA_CONNECTION_ID_RE.test(record.connectionId)) return
  return {
    schema: ALPHA_CONNECTION_REFERENCE_SCHEMA_V1,
    prerequisiteId: item.prerequisiteId,
    componentId: item.componentId,
    handlerId: item.handlerId,
    connectionId: record.connectionId,
  }
}

/**
 * Add or remove one component binding. Zero bindings is a normal state, not a delete trigger: a
 * connection the user authorised at a provider outlives every package that happened to need it,
 * and reclaiming it is an explicit disconnect, never a side effect of an uninstall.
 */
export function withPackageBindingV1(
  record: ConnectionRecordV1,
  componentId: string,
  operation: "bind" | "release",
  now: string,
): ConnectionRecordV1 {
  const current = new Set(record.packageBindings)
  if (operation === "bind") {
    if (!COMPONENT_ID_RE.test(componentId)) return record
    current.add(componentId)
  } else current.delete(componentId)
  const packageBindings = [...current].sort()
  if (packageBindings.join(" ") === record.packageBindings.join(" ")) return record
  return { ...record, packageBindings, updatedAt: now }
}

function isExpired(record: ConnectionRecordV1, now: Date): boolean {
  if (!record.expiresAt) return false
  const at = Date.parse(record.expiresAt)
  return Number.isNaN(at) || at <= now.getTime()
}

function decodePackageBindings(value: unknown, errors: string[]): string[] | undefined {
  if (!Array.isArray(value)) {
    errors.push("record.packageBindings: required array")
    return
  }
  if (value.length > 64) {
    errors.push("record.packageBindings: exceeds 64 entries")
    return
  }
  const bindings: string[] = []
  for (const entry of value) {
    if (typeof entry !== "string" || !COMPONENT_ID_RE.test(entry)) {
      errors.push("record.packageBindings: invalid component id")
      return
    }
    if (bindings.includes(entry)) {
      errors.push("record.packageBindings: duplicate component id")
      return
    }
    bindings.push(entry)
  }
  return bindings
}

function boundedString(
  value: unknown,
  at: string,
  max: number,
  errors: string[],
  pattern?: RegExp,
): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${at}: required non-empty string`)
    return
  }
  if (value.length > max) {
    errors.push(`${at}: exceeds ${max} characters`)
    return
  }
  if (CONTROL_RE.test(value)) {
    errors.push(`${at}: control characters are refused`)
    return
  }
  if (pattern && !pattern.test(value)) {
    errors.push(`${at}: invalid format`)
    return
  }
  return value
}

function invalidResult(errors: string[]): AlphaConnectionResultDecodeV1 {
  return { ok: false, reasonCode: "connection-result-invalid", errors }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
