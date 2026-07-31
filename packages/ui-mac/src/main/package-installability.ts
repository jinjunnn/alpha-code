import { createHash } from "node:crypto"
import { isAbsolute } from "node:path"
import type {
  CatalogPackageActionV1,
  CatalogPackageReasonCodeV1,
  CatalogPackageViewV1,
} from "../shared/catalog-package-view"
import {
  decodePackageEnvelopeHeaderV1,
  decodePackageProfilePayloadV1,
  type PackagePayloadRefV1,
} from "../shared/host-extension-package-contract/decoder"
import {
  decodePackageSecretPrerequisiteProfileV1,
  type PackageSecretPrerequisiteProfileDecodeV1,
} from "../shared/package-secret-prerequisite"

const PACKAGE_ID = /^package:[a-z0-9][a-z0-9._-]{0,127}$/
const VERSION = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/
const PRELUDE_KEYS = new Set(["packageId", "version"])
const MAX_PACKAGE_PAYLOAD_BYTES = 1024 * 1024
const PAYLOAD_TIMEOUT_MS = 8000

const ACTION_BY_REASON = {
  "package-compatible": { kind: "install", enabled: true },
  "package-prerequisite-required": {
    kind: "resolve-prerequisite",
    enabled: true,
  },
  "package-host-update-required": { kind: "update-alpha", enabled: true },
  "package-invalid": { kind: "none", enabled: false },
  "package-payload-unavailable": { kind: "none", enabled: false },
  "package-payload-integrity": { kind: "none", enabled: false },
  "package-payload-invalid": { kind: "none", enabled: false },
  "package-prerequisite-invalid": { kind: "none", enabled: false },
} as const satisfies Record<CatalogPackageReasonCodeV1, Omit<CatalogPackageActionV1, "reasonCode">>

export type PackagePreludeV1 = { packageId: string; version: string }

export type PackageInstallabilityDeps = {
  fetchPayload?: (ref: PackagePayloadRefV1) => Promise<Uint8Array>
  decodePayload?: typeof decodePackageProfilePayloadV1
  decodeSecretPrerequisite?: typeof decodePackageSecretPrerequisiteProfileV1
}

export type PackageEvaluator = (envelope: unknown, deps?: PackageInstallabilityDeps) => Promise<CatalogPackageViewV1>

export type CatalogPackageShapeValidation =
  | { ok: true; packages: Array<{ envelope: unknown; prelude: PackagePreludeV1 }> }
  | { ok: false; error: string }

export type PackagePreflightOutcome = {
  ok: false
  reason: string
  package: CatalogPackageViewV1
}

export type PackageInstallPreflightResult = { matched: false } | { matched: true; outcome: PackagePreflightOutcome }

export function packageActionForReason(reasonCode: CatalogPackageReasonCodeV1): CatalogPackageActionV1 {
  return { ...ACTION_BY_REASON[reasonCode], reasonCode }
}

/**
 * Validate the part of a signed Catalog needed to keep package identity unambiguous. A package
 * with a safely decoded prelude may become a blocked safe view; an unsafe/duplicate prelude makes
 * the whole candidate snapshot unusable because main cannot safely identify what it would hide.
 */
export function validateCatalogPackageShape(catalog: unknown): CatalogPackageShapeValidation {
  if (!isObject(catalog)) return { ok: false, error: "catalog must be an object" }
  if (!Object.hasOwn(catalog, "packages")) return { ok: true, packages: [] }
  if (!Array.isArray(catalog.packages) || catalog.packages.length === 0)
    return { ok: false, error: "catalog.packages must be a non-empty array when present" }

  const packages = catalog.packages.map((envelope, index) => {
    const prelude = decodeSafePrelude(envelope)
    return prelude.ok
      ? { ok: true as const, envelope, prelude: prelude.prelude }
      : {
          ok: false as const,
          error: `catalog.packages[${index}].prelude cannot be decoded safely: ${prelude.error}`,
        }
  })
  const malformed = packages.find((item) => !item.ok)
  if (malformed && !malformed.ok) return malformed

  const seen = new Set<string>()
  for (const item of packages) {
    if (!item.ok) continue
    const identity = `${item.prelude.packageId}\u0000${item.prelude.version}`
    if (seen.has(identity))
      return {
        ok: false,
        error: `catalog.packages contains duplicate identity ${item.prelude.packageId}@${item.prelude.version}`,
      }
    seen.add(identity)
  }
  return {
    ok: true,
    packages: packages.flatMap((item) => (item.ok ? [{ envelope: item.envelope, prelude: item.prelude }] : [])),
  }
}

export async function evaluateCatalogPackagesForHost(
  catalog: unknown,
  deps: PackageInstallabilityDeps = {},
  evaluator: PackageEvaluator = evaluatePackageForHost,
): Promise<{ ok: true; views: CatalogPackageViewV1[] } | { ok: false; error: string }> {
  const validated = validateCatalogPackageShape(catalog)
  if (!validated.ok) return validated
  return {
    ok: true,
    views: await Promise.all(validated.packages.map((item) => evaluator(item.envelope, deps))),
  }
}

/**
 * The only host compatibility authority for one signed package envelope. Ordering is fixed:
 * bounded header/support gate → exact payload fetch/digest → strict profile decoder → safe
 * prerequisite projection. No payload/secret stage is reachable after a header/support failure.
 */
export async function evaluatePackageForHost(
  envelope: unknown,
  deps: PackageInstallabilityDeps = {},
): Promise<CatalogPackageViewV1> {
  const prelude = decodeSafePrelude(envelope)
  if (!prelude.ok) return blockedView({ packageId: "package:invalid", version: "invalid" }, "package-invalid")

  const bytes = encodeEnvelope(envelope)
  if (!bytes) return blockedView(prelude.prelude, "package-invalid")
  const header = decodePackageEnvelopeHeaderV1(bytes)
  if (!header.ok) {
    if (header.stage === "support") return view(prelude.prelude, "update-required", "package-host-update-required")
    return blockedView(prelude.prelude, "package-invalid")
  }

  const component = header.envelope.components[0]
  if (!component.required)
    return blockedView(header.envelope.prelude, "package-invalid", {
      displayName: header.envelope.presentation.displayName,
      description: header.envelope.presentation.description,
    })
  const fetched = await (deps.fetchPayload ?? fetchPackagePayload)(component.payloadRef).then(
    (payloadBytes) => ({ ok: true as const, payloadBytes }),
    () => ({ ok: false as const }),
  )
  if (!fetched.ok)
    return blockedView(header.envelope.prelude, "package-payload-unavailable", {
      displayName: header.envelope.presentation.displayName,
      description: header.envelope.presentation.description,
    })
  const payloadBytes = fetched.payloadBytes
  if (
    payloadBytes.byteLength !== component.payloadRef.bytes ||
    createHash("sha256").update(payloadBytes).digest("hex") !== component.payloadRef.sha256
  )
    return blockedView(header.envelope.prelude, "package-payload-integrity", {
      displayName: header.envelope.presentation.displayName,
      description: header.envelope.presentation.description,
    })

  const decoded = (deps.decodePayload ?? decodePackageProfilePayloadV1)(
    component.profileId,
    payloadBytes,
    component.capabilities,
  )
  if (!decoded.ok)
    return blockedView(header.envelope.prelude, "package-payload-invalid", {
      displayName: header.envelope.presentation.displayName,
      description: header.envelope.presentation.description,
    })

  const prerequisite = (deps.decodeSecretPrerequisite ?? decodePackageSecretPrerequisiteProfileV1)(
    header.envelope,
    decoded.payload,
  )
  if (!prerequisite.ok)
    return blockedView(header.envelope.prelude, "package-prerequisite-invalid", {
      displayName: header.envelope.presentation.displayName,
      description: header.envelope.presentation.description,
    })
  return compatibleView(header.envelope, prerequisite)
}

/**
 * Package-aware install routing. The renderer supplies only intent, never a safe-view verdict or
 * execution payload. Main reloads the verified Catalog and evaluates the selected raw envelope
 * again; package admission/execution belongs to #713, so this slice stops after the preflight.
 * Legacy/seed intents remain on the existing planner unchanged.
 */
export async function runCatalogInstallWithPackagePreflight<T>(
  rawIntent: unknown,
  deps: {
    loadVerifiedCatalog: () => Promise<
      { source: "none"; error: string } | { source: "remote" | "cache"; catalog: unknown }
    >
    installLegacy: (intent: unknown) => Promise<T>
    evaluator?: PackageEvaluator
    installability?: PackageInstallabilityDeps
  },
): Promise<T | PackagePreflightOutcome> {
  const preflight = await preflightPackageInstall(rawIntent, deps)
  if (!preflight.matched) return deps.installLegacy(rawIntent)
  return preflight.outcome
}

export async function preflightPackageInstall(
  rawIntent: unknown,
  deps: {
    loadVerifiedCatalog: () => Promise<
      { source: "none"; error: string } | { source: "remote" | "cache"; catalog: unknown }
    >
    evaluator?: PackageEvaluator
    installability?: PackageInstallabilityDeps
  },
): Promise<PackageInstallPreflightResult> {
  if (!isObject(rawIntent) || typeof rawIntent.catalogId !== "string" || !rawIntent.catalogId.startsWith("package:"))
    return { matched: false }
  if (!PACKAGE_ID.test(rawIntent.catalogId))
    return {
      matched: true,
      outcome: {
        ok: false,
        reason: "package preflight: invalid catalogId",
        package: blockedView({ packageId: "package:invalid", version: "unknown" }, "package-invalid"),
      },
    }

  const loaded = await deps.loadVerifiedCatalog()
  if (loaded.source === "none")
    return {
      matched: true,
      outcome: {
        ok: false,
        reason: "package-catalog-unavailable",
        package: blockedView({ packageId: rawIntent.catalogId, version: "unknown" }, "package-payload-unavailable"),
      },
    }
  const validated = validateCatalogPackageShape(loaded.catalog)
  if (!validated.ok)
    return {
      matched: true,
      outcome: {
        ok: false,
        reason: "package-catalog-invalid",
        package: blockedView({ packageId: rawIntent.catalogId, version: "unknown" }, "package-invalid"),
      },
    }
  const selected = validated.packages.find((item) => item.prelude.packageId === rawIntent.catalogId)
  if (!selected)
    return {
      matched: true,
      outcome: {
        ok: false,
        reason: "package preflight: catalogId not found in verified Catalog",
        package: blockedView({ packageId: rawIntent.catalogId, version: "unknown" }, "package-invalid"),
      },
    }

  const intent = decodePackagePreflightIntent(rawIntent)
  if (!intent.ok)
    return {
      matched: true,
      outcome: {
        ok: false,
        reason: intent.reason,
        package: blockedView(selected.prelude, "package-invalid"),
      },
    }
  const evaluated = await (deps.evaluator ?? evaluatePackageForHost)(selected.envelope, deps.installability)
  return {
    matched: true,
    outcome: {
      ok: false,
      reason:
        evaluated.verdict === "compatible" && evaluated.prerequisites.status === "ready"
          ? "package-admission-not-implemented"
          : evaluated.action.reasonCode,
      package: evaluated,
    },
  }
}

function compatibleView(
  envelope: Extract<Awaited<ReturnType<typeof decodePackageEnvelopeHeaderV1>>, { ok: true }>["envelope"],
  prerequisite: Extract<PackageSecretPrerequisiteProfileDecodeV1, { ok: true }>,
): CatalogPackageViewV1 {
  const items = prerequisite.profile.items.map((item) => ({
    prerequisiteId: item.prerequisiteId,
    label: item.label,
    required: item.required,
  }))
  const reason = items.length > 0 ? "package-prerequisite-required" : "package-compatible"
  return {
    catalogId: envelope.prelude.packageId,
    verdict: "compatible",
    action: packageActionForReason(reason),
    prerequisites: {
      status: items.length > 0 ? "required-action" : "ready",
      items,
    },
    presentation: {
      displayName: envelope.presentation.displayName,
      description: envelope.presentation.description,
      version: envelope.prelude.version,
    },
  }
}

function blockedView(
  prelude: PackagePreludeV1,
  reason: Exclude<
    CatalogPackageReasonCodeV1,
    "package-compatible" | "package-prerequisite-required" | "package-host-update-required"
  >,
  presentation?: { displayName: string; description: string },
) {
  return view(prelude, "blocked", reason, presentation)
}

function view(
  prelude: PackagePreludeV1,
  verdict: "update-required" | "blocked",
  reason: CatalogPackageReasonCodeV1,
  presentation?: { displayName: string; description: string },
): CatalogPackageViewV1 {
  return {
    catalogId: prelude.packageId,
    verdict,
    action: packageActionForReason(reason),
    prerequisites: { status: "ready", items: [] },
    presentation: {
      displayName: presentation?.displayName ?? prelude.packageId,
      description: presentation?.description ?? "",
      version: prelude.version,
    },
  }
}

function decodeSafePrelude(envelope: unknown): { ok: true; prelude: PackagePreludeV1 } | { ok: false; error: string } {
  if (!isObject(envelope) || !isObject(envelope.prelude)) return { ok: false, error: "required object" }
  if (
    Object.keys(envelope.prelude).some((key) => !PRELUDE_KEYS.has(key)) ||
    typeof envelope.prelude.packageId !== "string" ||
    typeof envelope.prelude.version !== "string" ||
    !PACKAGE_ID.test(envelope.prelude.packageId) ||
    !VERSION.test(envelope.prelude.version) ||
    CONTROL.test(envelope.prelude.packageId) ||
    CONTROL.test(envelope.prelude.version)
  )
    return { ok: false, error: "invalid packageId/version binding" }
  return {
    ok: true,
    prelude: {
      packageId: envelope.prelude.packageId,
      version: envelope.prelude.version,
    },
  }
}

function decodePackagePreflightIntent(input: Record<string, unknown>): { ok: true } | { ok: false; reason: string } {
  const allowed = new Set(["catalogId", "scope", "attemptId", "grants"])
  const unknown = Object.keys(input).find((key) => !allowed.has(key))
  if (unknown)
    return {
      ok: false,
      reason: `package preflight: renderer-supplied key "${unknown}" is refused`,
    }
  if (typeof input.catalogId !== "string" || !PACKAGE_ID.test(input.catalogId))
    return { ok: false, reason: "package preflight: invalid catalogId" }
  if (
    !isObject(input.scope) ||
    (input.scope.scope !== "global" && input.scope.scope !== "project") ||
    Object.keys(input.scope).some((key) => key !== "scope" && key !== "projectDir") ||
    (input.scope.scope === "global" && input.scope.projectDir !== undefined) ||
    (input.scope.scope === "project" &&
      (typeof input.scope.projectDir !== "string" || !isAbsolute(input.scope.projectDir)))
  )
    return { ok: false, reason: "package preflight: invalid scope" }
  if (
    input.attemptId !== undefined &&
    (typeof input.attemptId !== "string" || input.attemptId.length === 0 || input.attemptId.length > 128)
  )
    return { ok: false, reason: "package preflight: invalid attemptId" }
  if (input.grants !== undefined && !isObject(input.grants))
    return { ok: false, reason: "package preflight: invalid grants" }
  if (
    isObject(input.grants) &&
    Object.keys(input.grants).some(
      (key) => key !== "secrets" && key !== "env" && key !== "workspace" && key !== "cnMirror",
    )
  )
    return { ok: false, reason: "package preflight: invalid grants" }
  return { ok: true }
}

async function fetchPackagePayload(ref: PackagePayloadRefV1): Promise<Uint8Array> {
  if (ref.bytes > MAX_PACKAGE_PAYLOAD_BYTES) throw new Error("package payload exceeds host limit")
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PAYLOAD_TIMEOUT_MS)
  try {
    const response = await fetch(ref.url, {
      signal: controller.signal,
      redirect: "error",
    })
    if (!response.ok) throw new Error(`package payload HTTP ${response.status}`)
    if (response.url) {
      const final = new URL(response.url)
      if (final.protocol !== "https:" || final.username !== "" || final.password !== "")
        throw new Error("package payload redirected outside HTTPS")
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > MAX_PACKAGE_PAYLOAD_BYTES) throw new Error("package payload exceeds host limit")
    return bytes
  } finally {
    clearTimeout(timer)
  }
}

function encodeEnvelope(envelope: unknown) {
  try {
    const json = JSON.stringify(envelope)
    return json === undefined ? undefined : new TextEncoder().encode(json)
  } catch {
    return undefined
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
