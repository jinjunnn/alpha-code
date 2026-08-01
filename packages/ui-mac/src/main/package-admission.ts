import { createHash } from "node:crypto"
import { lstatSync, writeFileSync } from "node:fs"
import { isAbsolute, join, posix, resolve } from "node:path"
import type { AppEnvironment } from "./alpha-environment"
import {
  claimMcpSecretVersionDir,
  collectMcpFileRefPaths,
  mcpSecretVersionedRef,
  newMcpSecretVersionId,
  removeMcpSecretVersionDir,
  resolveMcpRefPath,
  writeMcpSecretVersioned,
} from "./alpha-mcp-secrets"
import { agentMdToEntry } from "./agent-md-entry"
import { readMcpLeafStrict, validateServer } from "./ext-config"
import { evaluateBundleAuthorization, isSafeCapability, type CapabilityDiff } from "./ext-capability-grants"
import { agentConfigItemKey, agentFileProbe, agentInstallKey, recoveryReceiptInputs } from "./ext-agent-install"
import { nextDesiredState } from "./ext-install-policy"
import { canonicalJson, sha256Hex } from "./ext-manifest-v2"
import {
  computeGrantDigest,
  findRecordV2,
  probeLedgerForWrite,
  upsertRecordsV2,
  type UpsertInput,
} from "./ext-receipt-v2"
import { commitInputFromRecord, skillGenerationKey, skillGenerationProbe } from "./ext-skill-generations"
import {
  runExtensionTransaction,
  type TxCommitRecord,
  type TxPlan,
  type TxPlanItem,
  type TxResult,
} from "./ext-transaction"
import {
  evaluatePackageForHost,
  validateCatalogPackageShape,
  type PackageAcceptedFactsV1,
  type PackageInstallabilityDeps,
} from "./package-installability"
import type { CatalogPackageViewV1 } from "../shared/catalog-package-view"
import type { MarkdownAssetRefV1 } from "../shared/host-extension-package-contract/decoder"
import { HOST_EXTENSION_PACKAGE_LIMITS_V1 } from "../shared/host-extension-package-contract/registry"
import type {
  PackageAdmissionAuthorizationV1,
  PackageAdmissionBindingV1,
  PackageAdmissionPreviewV1,
} from "../shared/package-admission"
import type { TxStageNonAuthorizeWire } from "../shared/ext-capability-authorization"
import { evaluatePackageSecretSubmissionV1, packageSecretReferenceV1 } from "../shared/package-secret-prerequisite"
import {
  evaluatePackageConnectionPrerequisiteV1,
  packageConnectionReferenceV1,
  type PackageConnectionReferenceV1,
} from "../shared/package-alpha-connection"
import { lookupAlphaConnectionHandlerV1, ALPHA_CONNECTION_HANDLERS_V1 } from "./alpha-connection-handlers"
import {
  bindAlphaConnectionPackageV1,
  readAlphaConnectionRecordsV1,
  type AlphaConnectionStoreScope,
} from "./alpha-connection-store"

const ATTEMPT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const DIGEST = /^[a-f0-9]{64}$/
const TX_ITEM_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
const MAX_ATTEMPTS = 64
const INTENT_KEYS = new Set(["catalogId", "scope", "attemptId", "grants", "authorization"])
const GRANT_KEYS = new Set(["secrets", "env", "workspace", "cnMirror"])
const AUTHORIZATION_KEYS = new Set(["confirmed", "binding"])
const BINDING_KEYS = new Set([
  "snapshotDigest",
  "envelopeDigest",
  "graphDigest",
  "itemDigests",
  "capabilityDigest",
])

type PackageScope = { scope: "global" } | { scope: "project"; projectDir: string }
type PackageGrants = {
  secrets?: Record<string, string>
  env?: Record<string, string>
  workspace?: string
  cnMirror?: boolean
}

type PackageIntent = {
  catalogId: string
  scope: PackageScope
  attemptId: string
  grants?: PackageGrants
  authorization?: PackageAdmissionAuthorizationV1
}

type VerifiedCatalogLoad =
  | { source: "none"; error: string }
  | {
      source: "remote" | "cache"
      catalog: unknown
      snapshotDigest?: string
    }

export type PackageAdmissionOutcome =
  | {
      ok: true
      kind: "skill" | "agent" | "mcp"
      name: string
      manifestDigest: string
      installedDisabled?: true
      /**
       * Installed, but an optional Alpha Connection is not established. Distinct from
       * `installedDisabled`, which is true for every catalog install under the current activation
       * policy: this one says *why* the thing will not work, so the user is told "connect an
       * account" rather than "turn it on".
       */
      connectionUnavailable?: true
      warning?: string
    }
  | {
      ok: false
      stage: "authorize"
      reason: string
      authorization: CapabilityDiff[]
      packageAuthorization: PackageAdmissionPreviewV1
    }
  | {
      ok: false
      reason: string
      stage?: TxStageNonAuthorizeWire
      package?: CatalogPackageViewV1
    }

export type PackageAdmissionDeps = {
  loadVerifiedCatalog: () => Promise<VerifiedCatalogLoad>
  root: () => string
  userDataPath: string
  environment: () => AppEnvironment
  installability?: PackageInstallabilityDeps
  fetchAsset?: (ref: MarkdownAssetRefV1) => Promise<Uint8Array>
  transaction?: typeof runExtensionTransaction
  secretVersionId?: () => string
  now?: () => Date
}

/**
 * `envelope.components[0]` is whichever component the producer listed first, which is not the root
 * in general. Reading `facts.components[0]` instead only moves the same defect one layer up: it
 * turns an **ordering convention** into a load-bearing invariant while the type already carries the
 * fact (`role`). Read the declared role. (`#697` replaces this whole single-component shape with
 * the graph.)
 */
function rootComponentOf(facts: PackageAcceptedFactsV1) {
  return facts.components.find((entry) => entry.role === "root")!.component
}

type PreparedPackage = {
  facts: PackageAcceptedFactsV1
  key: string
  kind: "skill" | "agent" | "mcp"
  name: string
  asset?: Buffer
  agentEntry?: Record<string, unknown>
  itemDigest: string
  binding: PackageAdmissionBindingV1
}

type Attempt = {
  catalogId: string
  scope: PackageScope
  binding: PackageAdmissionBindingV1
  authorization: CapabilityDiff[]
}

export function createPackageAdmissionCoordinator(deps: PackageAdmissionDeps) {
  const attempts = new Map<string, Attempt>()
  const issuedAttempts = new Set<string>()

  return async (rawIntent: unknown): Promise<PackageAdmissionOutcome> => {
    const decoded = decodePackageAdmissionIntent(rawIntent)
    if (!decoded.ok) return decoded
    const intent = decoded.intent
    if (intent.scope.scope !== "global")
      return { ok: false, reason: "package admission: project-scoped installation is unsupported" }

    if (!intent.authorization) {
      if (intent.grants?.secrets && Object.keys(intent.grants.secrets).length > 0)
        return {
          ok: false,
          reason: "package admission: secret values are accepted only after the authorization preview",
        }
      if (issuedAttempts.has(intent.attemptId))
        return { ok: false, reason: "package admission: attemptId was already issued or replayed" }
      const resolved = await resolvePreparedPackage(intent.catalogId, deps)
      if (!resolved.ok) return resolved
      const authorization = evaluateBundleAuthorization(deps.root(), [
        {
          key: resolved.prepared.key,
          capabilities: rootComponentOf(resolved.prepared.facts).capabilities,
        },
      ]).items
      attempts.set(intent.attemptId, {
        catalogId: intent.catalogId,
        scope: intent.scope,
        binding: resolved.prepared.binding,
        authorization,
      })
      issuedAttempts.add(intent.attemptId)
      if (attempts.size > MAX_ATTEMPTS) attempts.delete(attempts.keys().next().value!)
      if (issuedAttempts.size > MAX_ATTEMPTS) issuedAttempts.delete(issuedAttempts.values().next().value!)
      return {
        ok: false,
        stage: "authorize",
        reason: "package admission: exact package plan requires confirmation",
        authorization,
        packageAuthorization: {
          attemptId: intent.attemptId,
          binding: resolved.prepared.binding,
          plan: packagePlanPreview(resolved.prepared),
          items: authorization,
        },
      }
    }

    const attempt = attempts.get(intent.attemptId)
    attempts.delete(intent.attemptId)
    if (!attempt) return { ok: false, reason: "package admission: stale or replayed attempt" }
    if (
      attempt.catalogId !== intent.catalogId ||
      canonicalJson(attempt.scope) !== canonicalJson(intent.scope) ||
      canonicalJson(attempt.binding) !== canonicalJson(intent.authorization.binding)
    )
      return { ok: false, reason: "package admission: authorization binding was tampered or is stale" }
    if (!confirmationMatches(attempt.authorization, intent.authorization.confirmed))
      return { ok: false, reason: "package admission: confirmed capability set does not exactly match the preview" }

    const revalidated = await resolvePreparedPackage(intent.catalogId, deps)
    if (!revalidated.ok) return revalidated
    if (canonicalJson(revalidated.prepared.binding) !== canonicalJson(attempt.binding))
      return { ok: false, reason: "package admission: signed package facts changed; preview is stale" }

    const profile = revalidated.prepared.facts.prerequisite
    const expectedSecretKeys = profile.items.map((item) => item.prerequisiteId).sort()
    const submittedSecretKeys = Object.keys(intent.grants?.secrets ?? {}).sort()
    if (intent.grants?.secrets && canonicalJson(expectedSecretKeys) !== canonicalJson(submittedSecretKeys))
      return { ok: false, reason: "package admission: secret-undeclared" }
    const submitted =
      profile.items.length === 0
        ? { decision: "submit", secrets: [] }
        : intent.grants?.secrets
          ? {
              decision: "submit",
              secrets: profile.items.map((item) => ({
                prerequisiteId: item.prerequisiteId,
                value: intent.grants?.secrets?.[item.prerequisiteId],
              })),
            }
          : { decision: "cancel" }
    const prerequisite = evaluatePackageSecretSubmissionV1(profile, submitted)
    if (prerequisite.state !== "ready") return { ok: false, reason: `package admission: ${prerequisite.reasonCode}` }
    if (
      intent.grants &&
      (intent.grants.env !== undefined || intent.grants.workspace !== undefined || intent.grants.cnMirror !== undefined)
    )
      return { ok: false, reason: "package admission: only signed secret prerequisites accept grants in Phase 1" }

    // §2.7 puts "required Alpha Connection ready" between capability authorization and the local
    // transaction, and this is that step. It runs on the *revalidated* facts and reads the
    // main-owned store directly — the renderer cannot name a connection at all, so there is no
    // supplied value to distrust, and re-resolving here (rather than remembering what the preview
    // decided) is what makes "main re-verifies on every bind" true rather than aspirational.
    //
    // A required connection that is not ready ends the attempt here, with zero transaction calls.
    const connection = resolveConnectionBinding(revalidated.prepared, deps)
    if (!connection.ok) return { ok: false, reason: `package admission: ${connection.reasonCode}` }

    return executePreparedPackage(revalidated.prepared, intent, deps, connection)
  }
}

export type ResolvedPackageConnectionV1 = {
  ok: true
  references: PackageConnectionReferenceV1[]
  /** An optional connection that is not ready: install, but land disabled and say so. */
  unavailable: boolean
}

/**
 * Answer the connection question for one prepared package from signed facts plus the main-owned
 * store. Required and optional diverge on exactly one point: a required prerequisite that is not
 * ready refuses the install, an optional one lets it land in the "installed, not connected" state
 * the baseline asks for — visible, honest, and reconnectable without reinstalling.
 */
function resolveConnectionBinding(
  prepared: PreparedPackage,
  deps: PackageAdmissionDeps,
): ResolvedPackageConnectionV1 | { ok: false; reasonCode: string } {
  const items = prepared.facts.connection.items
  if (items.length === 0) return { ok: true, references: [], unavailable: false }
  const scope = connectionScope(deps)
  const stored = readAlphaConnectionRecordsV1(scope)
  if (!stored.ok) return { ok: false, reasonCode: `connection store unreadable (${stored.reason})` }
  const now = deps.now?.() ?? new Date()
  const table = deps.installability?.connectionHandlers ?? ALPHA_CONNECTION_HANDLERS_V1

  const references: PackageConnectionReferenceV1[] = []
  let unavailable = false
  for (const item of items) {
    const known = lookupAlphaConnectionHandlerV1(item.handlerId, table).ok
    const evaluated = evaluatePackageConnectionPrerequisiteV1(item, stored.records, known, now)
    if (evaluated.state !== "ready") {
      if (item.required) return { ok: false, reasonCode: evaluated.reasonCode }
      unavailable = true
      continue
    }
    const record = stored.records.find((candidate) => candidate.connectionId === evaluated.connectionId)
    const reference = record ? packageConnectionReferenceV1(item, record) : undefined
    if (!reference) return { ok: false, reasonCode: "connection-result-invalid" }
    references.push(reference)
  }
  return { ok: true, references, unavailable }
}

/**
 * The store scope is derived, never injected: `extensionRoot` has to be the *real* transaction root
 * for the independence guard to mean anything, and a caller-supplied one could be made to agree
 * with a bad layout.
 */
function connectionScope(deps: PackageAdmissionDeps): AlphaConnectionStoreScope {
  return { userDataPath: deps.userDataPath, extensionRoot: deps.root() }
}

function packagePlanPreview(prepared: PreparedPackage): PackageAdmissionPreviewV1["plan"] {
  const component = rootComponentOf(prepared.facts)
  const operations =
    prepared.kind === "skill"
      ? (["write-generation", "write-install-record", "write-capability-grant"] as const)
      : prepared.kind === "agent"
        ? (["write-file", "update-config", "write-install-record", "write-capability-grant"] as const)
        : prepared.facts.prerequisite.items.length > 0
          ? (["write-secret-version", "update-config", "write-install-record", "write-capability-grant"] as const)
          : (["update-config", "write-install-record", "write-capability-grant"] as const)
  return {
    packageId: prepared.facts.envelope.prelude.packageId,
    version: prepared.facts.envelope.prelude.version,
    scope: { scope: "global" },
    items: [
      {
        componentId: component.id,
        key: prepared.key,
        kind: prepared.kind,
        name: prepared.name,
        manifestDigest: `sha256:${prepared.itemDigest}`,
        payloadDigest: `sha256:${component.payloadRef.sha256}`,
        capabilities: [...component.capabilities].sort(),
        prerequisites: prepared.facts.prerequisite.items.map((item) => ({
          prerequisiteId: item.prerequisiteId,
          label: item.label,
          required: item.required,
        })),
        operations: [...operations],
      },
    ],
  }
}

async function resolvePreparedPackage(
  catalogId: string,
  deps: PackageAdmissionDeps,
): Promise<{ ok: true; prepared: PreparedPackage } | Extract<PackageAdmissionOutcome, { ok: false; reason: string }>> {
  const loaded = await deps.loadVerifiedCatalog()
  if (loaded.source === "none")
    return { ok: false, reason: `package admission: verified Catalog unavailable (${loaded.error})` }
  if (!loaded.snapshotDigest || !DIGEST.test(loaded.snapshotDigest))
    return { ok: false, reason: "package admission: verified Catalog snapshot digest unavailable" }
  const validated = validateCatalogPackageShape(loaded.catalog)
  if (!validated.ok) return { ok: false, reason: `package admission: ${validated.error}` }
  const selected = validated.packages.find((item) => item.prelude.packageId === catalogId)
  if (!selected) return { ok: false, reason: "package admission: catalogId not found in verified Catalog" }

  let accepted: PackageAcceptedFactsV1 | undefined
  const view = await evaluatePackageForHost(selected.envelope, {
    ...deps.installability,
    accepted: (facts) => {
      accepted = facts
    },
  })
  if (!accepted || view.verdict !== "compatible") return { ok: false, reason: view.action.reasonCode, package: view }

  const facts = accepted
  const component = rootComponentOf(facts)
  const name = component.id.slice(component.id.indexOf(":") + 1)
  const kind = component.profileId === "skill" ? "skill" : component.profileId === "agent" ? "agent" : "mcp"
  const key = kind === "skill" ? skillGenerationKey(name) : kind === "agent" ? agentInstallKey(name) : `mcp--${name}`
  const assetRef =
    facts.payload.schema === "alpha.host-extension-package.payload.skill.v1" ||
    facts.payload.schema === "alpha.host-extension-package.payload.agent.v1"
      ? facts.payload.behavior.asset
      : undefined
  const asset = assetRef
    ? Buffer.from(await (deps.fetchAsset ?? fetchPackageAsset)(assetRef).catch(() => new Uint8Array()))
    : undefined
  if (
    assetRef &&
    (!asset ||
      asset.byteLength !== assetRef.bytes ||
      createHash("sha256").update(asset).digest("hex") !== assetRef.sha256)
  )
    return { ok: false, reason: "package admission: package asset unavailable or failed integrity", package: view }
  const agentEntry =
    facts.payload.schema === "alpha.host-extension-package.payload.agent.v1" && asset
      ? agentMdToEntry(asset.toString("utf8"))
      : undefined
  if (agentEntry && !agentEntry.ok)
    return { ok: false, reason: `package admission: agent payload invalid (${agentEntry.reason})`, package: view }

  const itemDigest = sha256Hex(
    canonicalJson({
      component,
      payload: facts.payload,
      ...(assetRef ? { asset: { sha256: assetRef.sha256, bytes: assetRef.bytes } } : {}),
    }),
  )
  return {
    ok: true,
    prepared: {
      facts,
      key,
      kind,
      name,
      ...(asset ? { asset } : {}),
      ...(agentEntry?.ok ? { agentEntry: agentEntry.entry } : {}),
      itemDigest,
      binding: {
        snapshotDigest: loaded.snapshotDigest,
        envelopeDigest: sha256Hex(canonicalJson(facts.envelope)),
        graphDigest: sha256Hex(canonicalJson(facts.graph)),
        itemDigests: { [component.id]: itemDigest },
        capabilityDigest: sha256Hex(canonicalJson({ [key]: component.capabilities })),
      },
    },
  }
}

async function executePreparedPackage(
  prepared: PreparedPackage,
  intent: PackageIntent,
  deps: PackageAdmissionDeps,
  connection: ResolvedPackageConnectionV1,
): Promise<PackageAdmissionOutcome> {
  const root = deps.root()
  const component = rootComponentOf(prepared.facts)
  const manifestDigest = `sha256:${prepared.itemDigest}`
  const now = (deps.now?.() ?? new Date()).toISOString()
  const receipt: UpsertInput = {
    id: component.id,
    name: prepared.name,
    kind: prepared.kind,
    environment: deps.environment(),
    scope: { kind: "global" },
    version: prepared.facts.envelope.prelude.version,
    manifestDigest,
    payloadDigest: `sha256:${component.payloadRef.sha256}`,
    grantDigest: computeGrantDigest(intent.grants),
    desiredState: nextDesiredState(root, prepared.kind, prepared.name, { origin: "catalog" }),
    origin: "catalog",
    installedAt: now,
  }
  // "Installed but unavailable" is not a new state — it is the existing disabled desired-state,
  // reached for one more reason, so the runtime, the detail page and the enable toggle already know
  // what to do with it. It is a real override, not a coincidence with today's default: a package
  // with a prior `enabled` record would otherwise come back enabled with no connection behind it.
  if (connection.unavailable) receipt.desiredState = "disabled"
  const planItems: TxPlanItem[] = []
  let populate = (_item: TxPlanItem, _stagingDir: string) => {}
  let probe = undefined as Parameters<typeof runExtensionTransaction>[2]["probe"]

  if (prepared.kind === "skill" && prepared.asset) {
    planItems.push({
      key: prepared.key,
      files: [
        {
          path: "SKILL.md",
          sha256: createHash("sha256").update(prepared.asset).digest("hex"),
          size: prepared.asset.byteLength,
        },
      ],
      manifestDigest,
      capabilities: component.capabilities,
      receipt,
    })
    populate = (_item, stagingDir) => writeFileSync(join(stagingDir, "SKILL.md"), prepared.asset!)
    probe = skillGenerationProbe
  }
  if (prepared.kind === "agent" && prepared.asset && prepared.agentEntry) {
    const relTarget = posix.join("agents", `${prepared.name}.md`)
    receipt.files = [join(root, relTarget)]
    receipt.configKey = `agent.${prepared.name}`
    planItems.push(
      {
        key: prepared.key,
        action: "file",
        file: {
          relTarget,
          next: prepared.asset,
          requireAbsent: findRecordV2(root, "agent", prepared.name) === null,
        },
        manifestDigest,
        capabilities: component.capabilities,
        receipt,
      },
      {
        key: agentConfigItemKey(prepared.name),
        action: "config",
        config: {
          target: join(root, "alpha.jsonc"),
          edits: [
            {
              keyPath: ["agent", prepared.name],
              value:
                receipt.desiredState === "disabled" ? { ...prepared.agentEntry, disable: true } : prepared.agentEntry,
            },
          ],
        },
      },
    )
    probe = agentFileProbe(root)
  }

  let secretVersion: string | undefined
  let secretFiles: string[] = []
  if (prepared.kind === "mcp") {
    secretVersion = prepared.facts.prerequisite.items.length
      ? (deps.secretVersionId ?? newMcpSecretVersionId)()
      : undefined
    const secretValues = intent.grants?.secrets ?? {}
    const refs = Object.fromEntries(
      prepared.facts.prerequisite.items.map((item) => [
        item.target.variable,
        mcpSecretVersionedRef(
          deps.userDataPath,
          prepared.facts.prerequisite.server,
          secretVersion!,
          item.target.variable,
        ),
      ]),
    )
    const config =
      prepared.facts.payload.schema === "alpha.host-extension-package.payload.mcp-local.v1"
        ? {
            type: "local",
            command: prepared.facts.payload.behavior.command,
            environment: { ...prepared.facts.payload.behavior.environment, ...refs },
          }
        : prepared.facts.payload.schema === "alpha.host-extension-package.payload.mcp-remote.v1"
          ? {
              type: "remote",
              url: prepared.facts.payload.behavior.url,
              headers: Object.fromEntries(
                Object.entries(prepared.facts.payload.behavior.headersTemplate).map(([header, template]) => [
                  header,
                  prepared.facts.prerequisite.items.reduce(
                    (value, item) => value.replaceAll(`{${item.target.variable}}`, refs[item.target.variable]!),
                    template,
                  ),
                ]),
              ),
            }
          : undefined
    if (!config) return { ok: false, reason: "package admission: profile cannot build an MCP transaction" }
    const valid = validateServer(config)
    if (!valid.ok) return { ok: false, reason: `package admission: ${valid.reason}` }
    receipt.configKey = `mcp.${prepared.name}`
    planItems.push({
      key: prepared.key,
      action: "config",
      config: {
        target: join(root, "alpha.jsonc"),
        edits: [
          {
            keyPath: ["mcp", prepared.name],
            value: receipt.desiredState === "disabled" ? { ...config, enabled: false } : config,
          },
        ],
      },
      manifestDigest,
      capabilities: component.capabilities,
      receipt,
    })
    secretFiles = Object.values(refs).map((ref) => ref.slice("{file:".length, -1))

    const existing = readMcpLeafStrict(prepared.name)
    if (!existing.ok) return { ok: false, reason: `package admission: ${existing.reason}` }
    if (existing.value && !findRecordV2(root, "mcp", prepared.name))
      return { ok: false, reason: "package admission: unregistered MCP config is not adopted or overwritten" }

    const result = await (deps.transaction ?? runExtensionTransaction)(root, packagePlan(planItems, intent, now), {
      populate,
      populatePrepared: secretVersion
        ? () => {
            const claimed = claimMcpSecretVersionDir(
              deps.userDataPath,
              prepared.facts.prerequisite.server,
              secretVersion!,
            )
            if (!claimed.ok) throw new Error(claimed.reason)
            for (const item of prepared.facts.prerequisite.items) {
              const reference = packageSecretReferenceV1(
                prepared.facts.prerequisite,
                item.prerequisiteId,
                secretVersion!,
              )
              if (!reference) throw new Error(`invalid secret reference for ${item.prerequisiteId}`)
              const written = writeMcpSecretVersioned(
                deps.userDataPath,
                reference.server,
                reference.version,
                reference.variable,
                secretValues[item.prerequisiteId]!,
              )
              if (!written.ok) throw new Error(written.reason)
            }
          }
        : undefined,
      probePrepared: secretVersion
        ? () => ({
            healthy: secretFiles.every((file) => {
              try {
                return lstatSync(file).isFile()
              } catch {
                return false
              }
            }),
            reason: "prepared secret file is missing",
          })
        : undefined,
      precondition: () => {
        const ledger = probeLedgerForWrite(root)
        if (!ledger.ok) return ledger
        const current = readMcpLeafStrict(prepared.name)
        if (!current.ok) return current
        if (current.value && !findRecordV2(root, "mcp", prepared.name))
          return { ok: false, reason: "unregistered MCP config appeared before commit" }
        return { ok: true }
      },
      commitReceipt: (records) => commitPackageReceipts(root, records),
    })
    if (!result.ok && secretVersion) cleanupUnreferencedSecretVersion(prepared, secretVersion, secretFiles, deps)
    return transactionOutcome(
    result,
    prepared,
    manifestDigest,
    receipt.desiredState,
    connection,
    bindConnectionsAfterCommit(result, connection, deps),
  )
  }

  if (planItems.length === 0)
    return { ok: false, reason: "package admission: package profile could not produce a transaction plan" }
  const result = await (deps.transaction ?? runExtensionTransaction)(root, packagePlan(planItems, intent, now), {
    populate,
    ...(probe ? { probe } : {}),
    precondition: () => probeLedgerForWrite(root),
    commitReceipt: (records) => commitPackageReceipts(root, records),
  })
  return transactionOutcome(
    result,
    prepared,
    manifestDigest,
    receipt.desiredState,
    connection,
    bindConnectionsAfterCommit(result, connection, deps),
  )
}

function packagePlan(items: TxPlanItem[], intent: PackageIntent, decidedAt: string): TxPlan {
  return {
    items,
    authorization: {
      confirmed: intent.authorization!.confirmed,
      decidedAt,
    },
  }
}

function commitPackageReceipts(root: string, records: TxCommitRecord[]) {
  const written = upsertRecordsV2(root, recoveryReceiptInputs(records))
  if (!written.ok) throw new Error(`package receipt commit failed: ${written.reason}`)
}

function transactionOutcome(
  result: TxResult,
  prepared: PreparedPackage,
  manifestDigest: string,
  desiredState: "enabled" | "disabled",
  connection: ResolvedPackageConnectionV1,
  connectionWarning?: string,
): PackageAdmissionOutcome {
  if (!result.ok) {
    if (result.stage === "authorize")
      return { ok: false, reason: "package admission: transaction authorization changed; start a new attempt" }
    return { ok: false, reason: result.reason, stage: result.stage }
  }
  const warnings = [...result.warnings, ...(connectionWarning ? [connectionWarning] : [])]
  return {
    ok: true,
    kind: prepared.kind,
    name: prepared.name,
    manifestDigest,
    ...(prepared.kind === "mcp" && desiredState === "disabled" ? { installedDisabled: true as const } : {}),
    ...(connection.unavailable ? { connectionUnavailable: true as const } : {}),
    ...(warnings.length ? { warning: warnings.join("; ") } : {}),
  }
}

/**
 * Record the package→connection edge after the transaction is durable, never before. A failure here
 * is reported, not fatal: the install really did happen, and an unrecorded binding only makes the
 * connection look less used than it is — which errs toward keeping it, the safe direction.
 */
function bindConnectionsAfterCommit(
  result: TxResult,
  connection: ResolvedPackageConnectionV1,
  deps: PackageAdmissionDeps,
): string | undefined {
  if (!result.ok || connection.references.length === 0) return
  const scope = connectionScope(deps)
  const now = (deps.now?.() ?? new Date()).toISOString()
  const failures = connection.references.flatMap((reference) => {
    const bound = bindAlphaConnectionPackageV1(scope, reference.connectionId, reference.componentId, now)
    return bound.ok ? [] : [bound.reason]
  })
  return failures.length ? `connection binding not recorded: ${failures.join("; ")}` : undefined
}

function cleanupUnreferencedSecretVersion(
  prepared: PreparedPackage,
  version: string,
  secretFiles: string[],
  deps: PackageAdmissionDeps,
) {
  const live = readMcpLeafStrict(prepared.name)
  if (!live.ok) return
  const referenced = new Set(collectMcpFileRefPaths(live.value).map((ref) => resolveMcpRefPath(ref, deps.root())))
  if (secretFiles.some((file) => referenced.has(resolve(file)))) return
  removeMcpSecretVersionDir(deps.userDataPath, prepared.facts.prerequisite.server, version)
}

function confirmationMatches(diffs: CapabilityDiff[], confirmed: Record<string, string[]>) {
  const requested = Object.fromEntries(diffs.map((diff) => [diff.key, [...diff.requested].sort()]))
  const normalized = Object.fromEntries(
    Object.entries(confirmed).map(([key, capabilities]) => [key, [...capabilities].sort()]),
  )
  return canonicalJson(requested) === canonicalJson(normalized)
}

async function fetchPackageAsset(ref: MarkdownAssetRefV1): Promise<Uint8Array> {
  if (ref.bytes > HOST_EXTENSION_PACKAGE_LIMITS_V1.maxMarkdownAssetBytes)
    throw new Error("package asset exceeds host limit")
  const response = await fetch(ref.url, { redirect: "error" })
  if (!response.ok) throw new Error(`package asset HTTP ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > HOST_EXTENSION_PACKAGE_LIMITS_V1.maxMarkdownAssetBytes)
    throw new Error("package asset exceeds host limit")
  return bytes
}

function decodePackageAdmissionIntent(
  input: unknown,
): { ok: true; intent: PackageIntent } | { ok: false; reason: string } {
  if (!isObject(input)) return { ok: false, reason: "package admission: intent must be an object" }
  const unknown = Object.keys(input).find((key) => !INTENT_KEYS.has(key))
  if (unknown) return { ok: false, reason: `package admission: renderer-supplied key "${unknown}" is refused` }
  // 长度界消费契约的值(decoder 对 packageId 的 max 是 160),不是重写文法。
  // 没有它,被攻陷的 renderer 可以把任意长度字符串塞进有界的 attempts Map。
  if (typeof input.catalogId !== "string" || input.catalogId.length > 160)
    return { ok: false, reason: "package admission: invalid catalogId" }
  const scope = decodeScope(input.scope)
  if (!scope.ok) return scope
  if (typeof input.attemptId !== "string" || !ATTEMPT_ID.test(input.attemptId))
    return { ok: false, reason: "package admission: invalid attemptId" }
  const grants = input.grants === undefined ? undefined : decodeGrants(input.grants)
  if (grants && !grants.ok) return grants
  const authorization = input.authorization === undefined ? undefined : decodePackageAuthorization(input.authorization)
  if (authorization && !authorization.ok) return authorization
  return {
    ok: true,
    intent: {
      catalogId: input.catalogId,
      scope: scope.scope,
      attemptId: input.attemptId,
      ...(grants?.ok ? { grants: grants.grants } : {}),
      ...(authorization?.ok ? { authorization: authorization.authorization } : {}),
    },
  }
}

function decodeScope(input: unknown): { ok: true; scope: PackageScope } | { ok: false; reason: string } {
  if (!isObject(input)) return { ok: false, reason: "package admission: invalid scope" }
  if (input.scope === "global" && Object.keys(input).every((key) => key === "scope"))
    return { ok: true, scope: { scope: "global" } }
  if (
    input.scope === "project" &&
    Object.keys(input).every((key) => key === "scope" || key === "projectDir") &&
    typeof input.projectDir === "string" &&
    isAbsolute(input.projectDir)
  )
    return { ok: true, scope: { scope: "project", projectDir: input.projectDir } }
  return { ok: false, reason: "package admission: invalid scope" }
}

function decodeGrants(input: unknown): { ok: true; grants: PackageGrants } | { ok: false; reason: string } {
  if (!isObject(input) || Object.keys(input).some((key) => !GRANT_KEYS.has(key)))
    return { ok: false, reason: "package admission: invalid grants" }
  const grants: PackageGrants = {}
  if (input.secrets !== undefined) {
    const secrets = decodeStringMap(input.secrets)
    if (!secrets) return { ok: false, reason: "package admission: invalid grants" }
    grants.secrets = secrets
  }
  if (input.env !== undefined) {
    const env = decodeStringMap(input.env)
    if (!env) return { ok: false, reason: "package admission: invalid grants" }
    grants.env = env
  }
  if (input.workspace !== undefined) {
    if (typeof input.workspace !== "string" || !isAbsolute(input.workspace))
      return { ok: false, reason: "package admission: invalid grants" }
    grants.workspace = input.workspace
  }
  if (input.cnMirror !== undefined) {
    if (typeof input.cnMirror !== "boolean") return { ok: false, reason: "package admission: invalid grants" }
    grants.cnMirror = input.cnMirror
  }
  return { ok: true, grants }
}

function decodePackageAuthorization(
  input: unknown,
): { ok: true; authorization: PackageAdmissionAuthorizationV1 } | { ok: false; reason: string } {
  if (!isObject(input) || Object.keys(input).some((key) => !AUTHORIZATION_KEYS.has(key)))
    return { ok: false, reason: "package admission: invalid authorization" }
  if (!isObject(input.confirmed)) return { ok: false, reason: "package admission: invalid authorization" }
  const confirmed: Record<string, string[]> = {}
  for (const [key, capabilities] of Object.entries(input.confirmed)) {
    if (!TX_ITEM_KEY.test(key) || !Array.isArray(capabilities) || capabilities.length > 32)
      return { ok: false, reason: "package admission: invalid authorization" }
    if (!capabilities.every(isSafeCapability) || new Set(capabilities).size !== capabilities.length)
      return { ok: false, reason: "package admission: invalid authorization" }
    confirmed[key] = [...capabilities]
  }
  const binding = decodeBinding(input.binding)
  if (!binding) return { ok: false, reason: "package admission: invalid authorization binding" }
  return { ok: true, authorization: { confirmed, binding } }
}

function decodeBinding(input: unknown): PackageAdmissionBindingV1 | undefined {
  if (!isObject(input) || Object.keys(input).some((key) => !BINDING_KEYS.has(key))) return
  if (
    typeof input.snapshotDigest !== "string" ||
    !DIGEST.test(input.snapshotDigest) ||
    typeof input.envelopeDigest !== "string" ||
    !DIGEST.test(input.envelopeDigest) ||
    typeof input.capabilityDigest !== "string" ||
    !DIGEST.test(input.capabilityDigest) ||
    typeof input.graphDigest !== "string" ||
    !DIGEST.test(input.graphDigest) ||
    !isObject(input.itemDigests)
  )
    return
  const itemDigests: Record<string, string> = {}
  for (const [key, digest] of Object.entries(input.itemDigests)) {
    if (key.length === 0 || key.length > 200 || typeof digest !== "string" || !DIGEST.test(digest)) return
    itemDigests[key] = digest
  }
  if (Object.keys(itemDigests).length === 0) return
  return {
    snapshotDigest: input.snapshotDigest,
    envelopeDigest: input.envelopeDigest,
    graphDigest: input.graphDigest,
    itemDigests,
    capabilityDigest: input.capabilityDigest,
  }
}

function decodeStringMap(input: unknown): Record<string, string> | undefined {
  if (!isObject(input) || Object.keys(input).length > 32) return
  const entries = Object.entries(input)
  if (
    entries.some(
      ([key, value]) =>
        key.length === 0 ||
        key.length > 200 ||
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > 64 * 1024,
    )
  )
    return
  return Object.fromEntries(entries) as Record<string, string>
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
