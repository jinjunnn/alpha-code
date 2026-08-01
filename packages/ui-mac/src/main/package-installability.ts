import { createHash } from "node:crypto"
import { isAbsolute } from "node:path"
import type {
  CatalogPackageActionV1,
  CatalogPackageComponentV1,
  CatalogPackageReasonCodeV1,
  CatalogPackageViewV1,
} from "../shared/catalog-package-view"
import { isExtensionName } from "../shared/extension-name"
import {
  decodePackageEnvelopeHeaderV1,
  decodePackageProfilePayloadV1,
  HOST_EXTENSION_PACKAGE_SCHEMA_V1,
  type AlphaPackageEnvelopeV1,
  type PackageComponentDecodeV1,
  type PackagePayloadRefV1,
  type PackageProfilePayloadV1,
  type PackageSupportedComponentV1,
} from "../shared/host-extension-package-contract/decoder"
import { HOST_EXTENSION_PACKAGE_LIMITS_V1 } from "../shared/host-extension-package-contract/registry"
import {
  packageEffectiveInstallGraphV1,
  type PackageEffectiveInstallGraphV1,
} from "../shared/package-admission"
import {
  decodePackageSecretPrerequisiteProfileV1,
  type PackageSecretPrerequisiteProfileDecodeV1,
} from "../shared/package-secret-prerequisite"
import {
  decodePackageConnectionPrerequisiteProfileV1,
  type AlphaConnectionHandlerTableV1,
  type PackageConnectionPrerequisiteProfileV1,
} from "../shared/package-alpha-connection"
import { lookupAlphaConnectionHandlerV1, ALPHA_CONNECTION_HANDLERS_V1 } from "./alpha-connection-handlers"

const ATTEMPT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
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
  /** The static Alpha Connection allowlist. Production default is the compiled-in table. */
  connectionHandlers?: AlphaConnectionHandlerTableV1
  accepted?: (facts: PackageAcceptedFactsV1) => void
}

export type PackageEvaluator = (envelope: unknown, deps?: PackageInstallabilityDeps) => Promise<CatalogPackageViewV1>

export type PackageAcceptedComponentV1 = {
  component: PackageSupportedComponentV1
  role: "root" | "leaf"
  payload: PackageProfilePayloadV1
  prerequisite: Extract<PackageSecretPrerequisiteProfileDecodeV1, { ok: true }>["profile"]
  /** Alpha Connection prerequisites declared by this component. Empty for every other profile. */
  connection: PackageConnectionPrerequisiteProfileV1
}

export type PackageAcceptedFactsV1 = {
  envelope: AlphaPackageEnvelopeV1
  /**
   * Every supported component, root first. `#697` removed the root-only `payload` / `prerequisite`
   * / `connection` convenience fields that used to sit beside this list: a Bundle has one of each
   * *per component*, and a root-shaped shortcut is how "we only ever looked at the first one"
   * survives a graph landing.
   */
  components: PackageAcceptedComponentV1[]
  /** Root plus every leaf that will actually be installed; skipped components are absent. */
  graph: PackageEffectiveInstallGraphV1
}

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
 * bounded header/graph/support gate → §5.1 门二(signed Bundle) → per supported component (exact
 * payload fetch/digest → strict profile decoder → safe prerequisite projection). No payload/secret
 * stage is reachable after a header/support/Bundle failure, and a skipped component reaches none of
 * them at all.
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
    if (header.stage === "support")
      return view(prelude.prelude, "update-required", "package-host-update-required", [], header.presentation)
    return blockedView(prelude.prelude, "package-invalid")
  }

  const presentation = {
    displayName: header.envelope.presentation.displayName,
    description: header.envelope.presentation.description,
  }
  const componentViews = safeComponentViews(header.components)
  const refuse = (reason: Exclude<CatalogPackageReasonCodeV1, "package-compatible" | "package-prerequisite-required" | "package-host-update-required">) =>
    blockedView(header.envelope.prelude, reason, componentViews, presentation)

  const rootEntry = header.components.find((entry) => entry.role === "root")
  // §4.1 条件 1 已经在 decoder 里把 non-required root 判成 header 失败;这里保留原来的单组件
  // 判据作为第二道 fail-closed —— decoder 一旦回归,安装动作不会因此静默变成可点。
  if (!rootEntry || rootEntry.status !== "supported" || !rootEntry.component.required)
    return refuse("package-invalid")

  // §5.1 门二在 `#697` 翻开:admission 现在把**整张有效安装图**放进一次事务,所以 Bundle 不再
  // 需要被拦在这里。翻开的判据不是「读起来像装得下」,而是 `package-mixed-bundle.wiring.cases.ts`
  // 里那条走真 IPC、真事务、真恢复的生产接线用例 —— 它装的正是 canonical mixed Bundle。
  //
  // 这里刻意**没有**换成「有效图长度 > 1 就拒」之类的替代闸:那正是审计抓到的漏洞形态
  // ——「root + 一个不受支持的 optional leaf」的有效图长度是 1,会绕过去装出半装包。门二的
  // 正确终结方式是让 admission 真的能装完整张图,而不是换一个更弱的谓词。

  const supported = [
    ...header.components.filter((entry) => entry.role === "root" && entry.status === "supported"),
    ...header.components.filter((entry) => entry.role === "leaf" && entry.status === "supported"),
  ] as Extract<PackageComponentDecodeV1, { status: "supported" }>[]

  for (const entry of supported) {
    const name = entry.component.id.slice(entry.component.id.indexOf(":") + 1)
    if (
      (entry.component.profileId === "skill" || entry.component.profileId === "agent") &&
      !isExtensionName(name)
    )
      return refuse("package-invalid")
  }

  const accepted: PackageAcceptedComponentV1[] = []
  for (const entry of supported) {
    const component = entry.component
    const fetched = await (deps.fetchPayload ?? fetchPackagePayload)(component.payloadRef).then(
      (payloadBytes) => ({ ok: true as const, payloadBytes }),
      () => ({ ok: false as const }),
    )
    if (!fetched.ok) return refuse("package-payload-unavailable")
    const payloadBytes = fetched.payloadBytes
    if (
      payloadBytes.byteLength !== component.payloadRef.bytes ||
      createHash("sha256").update(payloadBytes).digest("hex") !== component.payloadRef.sha256
    )
      return refuse("package-payload-integrity")

    const decoded = (deps.decodePayload ?? decodePackageProfilePayloadV1)(
      component.profileId,
      payloadBytes,
      component.capabilities,
    )
    if (!decoded.ok) return refuse("package-payload-invalid")

    const prerequisite = (deps.decodeSecretPrerequisite ?? decodePackageSecretPrerequisiteProfileV1)(
      component,
      decoded.payload,
    )
    if (!prerequisite.ok) return refuse("package-prerequisite-invalid")

    // Alpha Connection is answered here, in the browse/detail evaluator, which is the earliest
    // point at which the host knows a signed package wants one: the declaration lives inside the
    // component payload fetched just above, so this is the first line that can see it. An id this
    // build has no handler for becomes `update-required` now — before a handler runs, before an
    // auth/browser window opens, before anything reaches the connection store, before the install
    // button is enabled. It is *not* before every outbound call: that one payload request has
    // already gone out, and if it had failed the user would see `package-payload-unavailable`
    // instead. `package-alpha-connection.test.ts` pins the verdict and that fetch count at exactly
    // one. The lookup itself is a table hit and nothing else: main never reads structure out of the
    // id (`#737` discipline).
    const connection = decodePackageConnectionPrerequisiteProfileV1(component, decoded.payload)
    const unknownHandler = connection.items.find(
      (item) =>
        !lookupAlphaConnectionHandlerV1(item.handlerId, deps.connectionHandlers ?? ALPHA_CONNECTION_HANDLERS_V1).ok,
    )
    if (unknownHandler)
      return view(
        header.envelope.prelude,
        "update-required",
        "package-host-update-required",
        componentViews,
        presentation,
      )
    accepted.push({
      component,
      role: entry.role,
      payload: decoded.payload,
      prerequisite: prerequisite.profile,
      connection,
    })
  }

  const graph = packageEffectiveInstallGraphV1(
    header.envelope,
    accepted.map((entry) => entry.component),
  )

  deps.accepted?.({ envelope: header.envelope, components: accepted, graph })
  return compatibleView(header.envelope, componentViews, accepted)
}

/**
 * Package-aware install routing. The renderer supplies only intent, never a safe-view verdict or
 * execution payload. Package attempts delegate to the main-owned admission coordinator, which
 * reloads the verified Catalog and evaluates the selected raw envelope again. Legacy/seed intents
 * remain on the existing planner unchanged.
 */
export async function runCatalogInstallWithPackagePreflight<T, P = never>(
  rawIntent: unknown,
  deps: {
    loadVerifiedCatalog: () => Promise<
      { source: "none"; error: string } | { source: "remote" | "cache"; catalog: unknown }
    >
    installLegacy: (intent: unknown) => Promise<T>
    installPackage?: (intent: unknown) => Promise<P>
    evaluator?: PackageEvaluator
    installability?: PackageInstallabilityDeps
  },
): Promise<T | P | PackagePreflightOutcome> {
  if (
    deps.installPackage &&
    isObject(rawIntent) &&
    Object.hasOwn(rawIntent, "attemptId")
  )
    return deps.installPackage(rawIntent)
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
  if (!isObject(rawIntent) || !Object.hasOwn(rawIntent, "attemptId"))
    return { matched: false }
  const catalogId = typeof rawIntent.catalogId === "string" ? rawIntent.catalogId : "package:invalid"
  const loaded = await deps.loadVerifiedCatalog()
  if (loaded.source === "none")
    return {
      matched: true,
      outcome: {
        ok: false,
        reason: "package-catalog-unavailable",
        package: blockedView({ packageId: catalogId, version: "unknown" }, "package-payload-unavailable"),
      },
    }
  const validated = validateCatalogPackageShape(loaded.catalog)
  if (!validated.ok)
    return {
      matched: true,
      outcome: {
        ok: false,
        reason: "package-catalog-invalid",
        package: blockedView({ packageId: catalogId, version: "unknown" }, "package-invalid"),
      },
    }
  const selected = validated.packages.find((item) => item.prelude.packageId === catalogId)
  if (!selected)
    return {
      matched: true,
      outcome: {
        ok: false,
        reason: "package preflight: catalogId not found in verified Catalog",
        package: blockedView({ packageId: catalogId, version: "unknown" }, "package-invalid"),
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
      // `verdict === "compatible"` 只从 `compatibleView` 来,它的两个 reason 都是 enabled ⇒
      // 再 `&& action.enabled` 是恒真的死代码,会被误读成第二道闸。判据只留真的那两条。
      reason:
        evaluated.verdict === "compatible" && evaluated.prerequisites.status === "ready"
          ? "package-admission-not-implemented"
          : evaluated.action.reasonCode,
      package: evaluated,
    },
  }
}

function safeComponentViews(components: PackageComponentDecodeV1[]): CatalogPackageComponentV1[] {
  return components.map((entry) => ({
    componentId: entry.component.id,
    role: entry.role,
    required: entry.component.required,
    included: entry.status === "supported",
    skipReasonCode: entry.status === "skipped" ? entry.reasonCode : null,
  }))
}

function compatibleView(
  envelope: AlphaPackageEnvelopeV1,
  components: CatalogPackageComponentV1[],
  accepted: PackageAcceptedComponentV1[],
): CatalogPackageViewV1 {
  // 授权集只含「受支持且未跳过」的组件(§4.3):被跳过的子件不会安装,就不该要用户为它授权。
  // Connection prerequisites join the secret ones on the same channel and are ordered after them
  // per component: the safe view says *what must be satisfied*, and readiness is main's answer at
  // admission time, exactly as it already is for secrets — the browse surface has no store access
  // and must not be the place that decides a package is ready.
  const items = accepted.flatMap((entry) =>
    [
      ...entry.prerequisite.items,
      ...entry.connection.items,
    ].map((item) => ({
      prerequisiteId: item.prerequisiteId,
      label: item.label,
      required: item.required,
    })),
  )
  const reason = items.length > 0 ? "package-prerequisite-required" : "package-compatible"
  return {
    catalogId: envelope.prelude.packageId,
    verdict: "compatible",
    action: packageActionForReason(reason),
    components,
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
  components: CatalogPackageComponentV1[] = [],
  presentation?: { displayName: string; description: string },
) {
  return view(prelude, "blocked", reason, components, presentation)
}

function view(
  prelude: PackagePreludeV1,
  verdict: "update-required" | "blocked",
  reason: CatalogPackageReasonCodeV1,
  components: CatalogPackageComponentV1[],
  presentation?: { displayName: string; description: string },
): CatalogPackageViewV1 {
  return {
    catalogId: prelude.packageId,
    verdict,
    action: packageActionForReason(reason),
    components,
    prerequisites: { status: "ready", items: [] },
    presentation: {
      displayName: presentation?.displayName ?? prelude.packageId,
      description: presentation?.description ?? "",
      version: prelude.version,
    },
  }
}

function decodeSafePrelude(envelope: unknown): { ok: true; prelude: PackagePreludeV1 } | { ok: false; error: string } {
  if (!isObject(envelope)) return { ok: false, error: "required object" }
  const bytes = encodeEnvelope({
    schema: HOST_EXTENSION_PACKAGE_SCHEMA_V1,
    prelude: envelope.prelude,
    presentation: { displayName: "Prelude probe", description: "Contract decoder probe" },
    root: "package:prelude-probe",
    components: [
      {
        id: "package:prelude-probe",
        required: true,
        dependencies: [],
        profileId: "skill",
        profileVersion: 1,
        capabilities: [],
        payloadRef: {
          sha256: "0".repeat(64),
          bytes: 1,
          mediaType: "application/vnd.alpha.host-extension-package.skill.v1+json",
          url: "https://example.invalid/prelude-probe.json",
        },
      },
    ],
    capabilities: [],
  })
  if (!bytes) return { ok: false, error: "cannot encode prelude probe" }
  const decoded = decodePackageEnvelopeHeaderV1(bytes)
  if (!decoded.ok) return { ok: false, error: decoded.errors.join("; ") }
  return { ok: true, prelude: decoded.envelope.prelude }
}

function decodePackagePreflightIntent(input: Record<string, unknown>): { ok: true } | { ok: false; reason: string } {
  const allowed = new Set(["catalogId", "scope", "attemptId", "grants"])
  const unknown = Object.keys(input).find((key) => !allowed.has(key))
  if (unknown)
    return {
      ok: false,
      reason: `package preflight: renderer-supplied key "${unknown}" is refused`,
    }
  if (typeof input.catalogId !== "string" || input.catalogId.length > 160)
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
    (typeof input.attemptId !== "string" || !ATTEMPT_ID.test(input.attemptId))
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

export async function fetchPackagePayload(
  ref: PackagePayloadRefV1,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array> {
  if (ref.bytes > HOST_EXTENSION_PACKAGE_LIMITS_V1.maxPayloadBytes)
    throw new Error("package payload exceeds host limit")
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PAYLOAD_TIMEOUT_MS)
  try {
    const response = await fetchImpl(ref.url, {
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
    if (bytes.byteLength > HOST_EXTENSION_PACKAGE_LIMITS_V1.maxPayloadBytes)
      throw new Error("package payload exceeds host limit")
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
