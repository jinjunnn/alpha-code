import type {
  AlphaPackageEnvelopeV1,
  PackageProfilePayloadV1,
} from "./host-extension-package-contract/decoder"

export const PACKAGE_SECRET_PREREQUISITE_PROFILE_V1 = "alpha.secret-prerequisite.v1" as const

export type PackageSecretPrerequisiteStateV1 = "ready" | "required-action" | "blocked"
export type PackageSecretPrerequisiteReasonCodeV1 =
  | "secret-ready"
  | "secret-profile-invalid"
  | "secret-undeclared"
  | "secret-cancelled"
  | "secret-value-required"
  | "secret-reference-missing"
  | "secret-reference-stale"
  | "secret-reference-replaced"
  | "secret-reference-uninstalled"

export type PackageSecretPrerequisiteTargetV1 =
  | { kind: "mcp-environment"; variable: string }
  | { kind: "mcp-remote-headers"; headers: string[]; variable: string }

export type PackageSecretPrerequisiteItemV1 = {
  prerequisiteId: string
  componentId: string
  label: string
  required: boolean
  target: PackageSecretPrerequisiteTargetV1
}

export type PackageSecretPrerequisiteProfileV1 = {
  profile: typeof PACKAGE_SECRET_PREREQUISITE_PROFILE_V1
  componentId: string
  server: string
  items: PackageSecretPrerequisiteItemV1[]
}

export type PackageSecretReferenceV1 = {
  schema: "alpha.package-secret-reference.v1"
  prerequisiteId: string
  componentId: string
  store: "alpha-mcp-secrets"
  server: string
  version: string
  variable: string
}

export type PackageSecretReferenceStatusV1 = "ready" | "cancelled" | "replaced" | "uninstalled"

export type PackageSecretReferenceRecordV1 = {
  status: PackageSecretReferenceStatusV1
  reference?: PackageSecretReferenceV1
}

export type PackageSecretPrerequisiteEvaluationV1 = {
  state: PackageSecretPrerequisiteStateV1
  reasonCode: PackageSecretPrerequisiteReasonCodeV1
  prerequisiteIds: string[]
}

export type PackageSecretPrerequisiteProfileDecodeV1 =
  | { ok: true; profile: PackageSecretPrerequisiteProfileV1 }
  | {
      ok: false
      state: "blocked"
      reasonCode: "secret-profile-invalid"
      errors: string[]
    }

const SAFE_SERVER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const SAFE_VARIABLE = /^[A-Z_][A-Z0-9_]{0,127}$/
const SAFE_VERSION = /^v-[a-f0-9]{8,16}$/
const SUBMISSION_KEYS = new Set(["decision", "secrets"])
const SUBMITTED_SECRET_KEYS = new Set(["prerequisiteId", "value"])
const REFERENCE_KEYS = new Set([
  "schema",
  "prerequisiteId",
  "componentId",
  "store",
  "server",
  "version",
  "variable",
])

/**
 * Consume only the host-owned, already strictly decoded #694 Envelope and payload. The web-owned
 * Declaration is intentionally absent from this API. Target and stable prerequisite identity are
 * derived from signed host fields; the renderer never supplies either.
 */
export function decodePackageSecretPrerequisiteProfileV1(
  envelope: AlphaPackageEnvelopeV1,
  payload: PackageProfilePayloadV1,
): PackageSecretPrerequisiteProfileDecodeV1 {
  const component = envelope.components[0]
  const hasCapability = component.capabilities.includes(PACKAGE_SECRET_PREREQUISITE_PROFILE_V1)
  const errors: string[] = []
  const suffix = component.id.slice(component.id.indexOf(":") + 1)

  if (payload.schema === "alpha.host-extension-package.payload.mcp-local.v1") {
    if (!SAFE_SERVER.test(suffix))
      errors.push("secret prerequisite component id cannot be represented by the existing MCP secret store")
    if (component.profileId !== "mcp-local")
      errors.push(`secret prerequisite payload/profile mismatch: ${component.profileId}`)
    validateRequiredSecrets(payload.behavior.requiredSecrets, errors)
    if (hasCapability !== (payload.behavior.requiredSecrets.length > 0))
      errors.push("secret prerequisite capability does not match requiredSecrets")
    if (errors.length) return invalidProfile(errors)
    return {
      ok: true,
      profile: {
        profile: PACKAGE_SECRET_PREREQUISITE_PROFILE_V1,
        componentId: component.id,
        server: suffix,
        items: payload.behavior.requiredSecrets.map((variable) => ({
          prerequisiteId: `${component.id}#${variable}`,
          componentId: component.id,
          label: variable,
          required: component.required,
          target: { kind: "mcp-environment", variable },
        })),
      },
    }
  }

  if (payload.schema === "alpha.host-extension-package.payload.mcp-remote.v1") {
    if (!SAFE_SERVER.test(suffix))
      errors.push("secret prerequisite component id cannot be represented by the existing MCP secret store")
    if (component.profileId !== "mcp-remote")
      errors.push(`secret prerequisite payload/profile mismatch: ${component.profileId}`)
    validateRequiredSecrets(payload.behavior.requiredSecrets, errors)
    const declared = new Set(payload.behavior.requiredSecrets)
    const placeholders = Object.values(payload.behavior.headersTemplate).flatMap((template) =>
      [...template.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]!),
    )
    placeholders
      .filter((variable) => !SAFE_VARIABLE.test(variable) || !declared.has(variable))
      .forEach((variable) =>
        errors.push(`payload.behavior.headersTemplate: undeclared secret placeholder "${variable}"`),
      )
    const targets = payload.behavior.requiredSecrets.map((variable) => ({
      variable,
      headers: Object.entries(payload.behavior.headersTemplate)
        .filter(([, template]) => template.includes(`{${variable}}`))
        .map(([header]) => header)
        .sort(),
    }))
    targets
      .filter((target) => target.headers.length === 0)
      .forEach((target) =>
        errors.push(`payload.behavior.requiredSecrets: "${target.variable}" has no header target`),
      )
    if (hasCapability !== (payload.behavior.requiredSecrets.length > 0))
      errors.push("secret prerequisite capability does not match requiredSecrets")
    if (errors.length) return invalidProfile(errors)
    return {
      ok: true,
      profile: {
        profile: PACKAGE_SECRET_PREREQUISITE_PROFILE_V1,
        componentId: component.id,
        server: suffix,
        items: targets.map((target) => ({
          prerequisiteId: `${component.id}#${target.variable}`,
          componentId: component.id,
          label: target.variable,
          required: component.required,
          target: {
            kind: "mcp-remote-headers",
            headers: target.headers,
            variable: target.variable,
          },
        })),
      },
    }
  }

  if (hasCapability)
    errors.push(`secret prerequisite capability is unsupported by payload ${payload.schema}`)
  if (errors.length) return invalidProfile(errors)
  return {
    ok: true,
    profile: {
      profile: PACKAGE_SECRET_PREREQUISITE_PROFILE_V1,
      componentId: component.id,
      server: suffix,
      items: [],
    },
  }
}

/**
 * Strictly validate the renderer's short-lived submission. The result contains IDs and status
 * only; plaintext is never copied into an evaluator result, receipt, log, or telemetry shape.
 */
export function evaluatePackageSecretSubmissionV1(
  profile: PackageSecretPrerequisiteProfileV1,
  input: unknown,
): PackageSecretPrerequisiteEvaluationV1 {
  if (!isObject(input) || Object.keys(input).some((key) => !SUBMISSION_KEYS.has(key)))
    return blocked("secret-undeclared")
  if (input.decision === "cancel" && input.secrets === undefined)
    return blocked("secret-cancelled")
  if (input.decision !== "submit" || !Array.isArray(input.secrets))
    return blocked("secret-undeclared")

  const declared = new Set(profile.items.map((item) => item.prerequisiteId))
  const ids: string[] = []
  let missingValue = false
  for (const secret of input.secrets) {
    if (
      !isObject(secret) ||
      Object.keys(secret).some((key) => !SUBMITTED_SECRET_KEYS.has(key)) ||
      typeof secret.prerequisiteId !== "string"
    )
      return blocked("secret-undeclared")
    if (!declared.has(secret.prerequisiteId) || ids.includes(secret.prerequisiteId))
      return blocked("secret-undeclared")
    ids.push(secret.prerequisiteId)
    if (typeof secret.value !== "string" || secret.value.length === 0) missingValue = true
  }
  if (ids.length !== declared.size || profile.items.some((item) => !ids.includes(item.prerequisiteId)))
    missingValue = true
  if (missingValue) return requiredAction("secret-value-required", ids)
  return { state: "ready", reasonCode: "secret-ready", prerequisiteIds: ids.sort() }
}

/** Build the only durable-safe reference shape from the signed prerequisite and main-owned version. */
export function packageSecretReferenceV1(
  profile: PackageSecretPrerequisiteProfileV1,
  prerequisiteId: string,
  version: string,
): PackageSecretReferenceV1 | undefined {
  const item = profile.items.find((candidate) => candidate.prerequisiteId === prerequisiteId)
  if (!item || !SAFE_VERSION.test(version)) return
  return {
    schema: "alpha.package-secret-reference.v1",
    prerequisiteId: item.prerequisiteId,
    componentId: item.componentId,
    store: "alpha-mcp-secrets",
    server: profile.server,
    version,
    variable: item.target.variable,
  }
}

/** Missing, stale, replaced, cancelled, and uninstalled references all fail closed. */
export function evaluatePackageSecretReferenceV1(
  profile: PackageSecretPrerequisiteProfileV1,
  prerequisiteId: string,
  record: PackageSecretReferenceRecordV1 | undefined,
  currentVersion: string | undefined,
  filePresent: boolean,
): PackageSecretPrerequisiteEvaluationV1 {
  const item = profile.items.find((candidate) => candidate.prerequisiteId === prerequisiteId)
  if (!item) return blocked("secret-undeclared")
  if (!record) return blocked("secret-reference-missing", [prerequisiteId])
  if (record.status === "cancelled") return blocked("secret-cancelled", [prerequisiteId])
  if (record.status === "replaced") return blocked("secret-reference-replaced", [prerequisiteId])
  if (record.status === "uninstalled") return blocked("secret-reference-uninstalled", [prerequisiteId])
  if (!record.reference) return blocked("secret-reference-missing", [prerequisiteId])
  if (record.status !== "ready") return blocked("secret-reference-stale", [prerequisiteId])
  const expected = packageSecretReferenceV1(profile, prerequisiteId, record.reference.version)
  if (
    !expected ||
    Object.keys(record.reference).some((key) => !REFERENCE_KEYS.has(key)) ||
    Object.entries(expected).some(
      ([key, value]) =>
        record.reference?.[key as keyof PackageSecretReferenceV1] !== value,
    ) ||
    currentVersion !== record.reference.version
  )
    return blocked("secret-reference-stale", [prerequisiteId])
  if (!filePresent) return blocked("secret-reference-missing", [prerequisiteId])
  return { state: "ready", reasonCode: "secret-ready", prerequisiteIds: [prerequisiteId] }
}

function validateRequiredSecrets(requiredSecrets: string[], errors: string[]) {
  if (
    requiredSecrets.some(
      (variable, index) =>
        !SAFE_VARIABLE.test(variable) ||
        (index > 0 && variable <= requiredSecrets[index - 1]!),
    )
  )
    errors.push("payload.behavior.requiredSecrets: must be safe, unique, and byte-order sorted")
}

function invalidProfile(errors: string[]): PackageSecretPrerequisiteProfileDecodeV1 {
  return {
    ok: false,
    state: "blocked",
    reasonCode: "secret-profile-invalid",
    errors,
  }
}

function blocked(
  reasonCode: Exclude<PackageSecretPrerequisiteReasonCodeV1, "secret-ready" | "secret-value-required">,
  prerequisiteIds: string[] = [],
): PackageSecretPrerequisiteEvaluationV1 {
  return { state: "blocked", reasonCode, prerequisiteIds }
}

function requiredAction(
  reasonCode: "secret-value-required",
  prerequisiteIds: string[] = [],
): PackageSecretPrerequisiteEvaluationV1 {
  return { state: "required-action", reasonCode, prerequisiteIds }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
