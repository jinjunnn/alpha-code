import { createHash } from "node:crypto"
import { isAbsolute } from "node:path"
import type { AppEnvironment } from "./alpha-environment"
import { newMcpSecretVersionId } from "./alpha-mcp-secrets"
import { agentMdToEntry } from "./agent-md-entry"
import { releasePreparedTxResources } from "./ext-config"
import { evaluateBundleAuthorization, evaluateCapabilityDiff, isSafeCapability, type CapabilityDiff } from "./ext-capability-grants"
import { recoveryReceiptInputs } from "./ext-agent-install"
import { nextDesiredState } from "./ext-install-policy"
import { canonicalJson, sha256Hex } from "./ext-manifest-v2"
import { buildAgentTxItems, buildDepartingChildConfigItemsV1, buildMcpTxItems, buildSkillTxItems } from "./ext-package-tx-builders"
import { computeGrantDigest, readPackageLedgerStateV1, type UpsertInput } from "./ext-receipt-v2"
import { commitTransactionLedger } from "./ext-package-ledger-commit"
import {
  computeInstalledGraphDigest,
  type PackageGraphV1,
  type PackageMutationEnvelopeV1,
} from "./ext-package-ledger-v3"
import {
  buildPackageUpdatePreviewV1,
  diffPackageGraphsV1,
  packageChildTxKeyV1,
  packageVersionFromRecordsV1,
  planPackageChildConflictsV1,
  planPackageChildRemovalsV1,
  planPackageClaimTransferV1,
  type PackageChildConflictV1,
  type PackageChildRemovalVerdictV1,
  type PackageGraphDiffV1,
  type PackageUpdatePreviewV1,
} from "./ext-package-lifecycle"
import type { PackageArtifactRemovalV1 } from "./ext-package-uninstall"
import {
  runExtensionTransaction,
  type TxCommitRecord,
  type TxPlan,
  type TxPlanItem,
  type TxPreparedResourceV1,
  type TxResult,
} from "./ext-transaction"
import {
  evaluatePackageForHost,
  validateCatalogPackageShape,
  type PackageAcceptedFactsV1,
  type PackageInstallabilityDeps,
} from "./package-installability"
import type { CatalogPackageViewV1 } from "../shared/catalog-package-view"
import { isLocalPackageId, LOCAL_PACKAGE_ID_PREFIX } from "../shared/local-package-namespace"
import type { MarkdownAssetRefV1 } from "../shared/host-extension-package-contract/decoder"
import { HOST_EXTENSION_PACKAGE_LIMITS_V1 } from "../shared/host-extension-package-contract/registry"
import type {
  PackageAdmissionAuthorizationV1,
  PackageAdmissionBindingV1,
  PackageAdmissionPlanItemV1,
  PackageAdmissionPreviewV1,
} from "../shared/package-admission"
import type { PackageComponentSkipReasonV1 } from "../shared/host-extension-package-contract/decoder"
import type { HealthProbe, HealthVerdict } from "./ext-transaction"
import type { PackageTxBuildV1 } from "./ext-package-tx-builders"
import type { PackageAcceptedComponentV1 } from "./package-installability"
import type { TxStageNonAuthorizeWire } from "../shared/ext-capability-authorization"
import { evaluatePackageSecretSubmissionV1 } from "../shared/package-secret-prerequisite"
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
      /** The **root** component's kind/name. Leaves are enumerated in `installed`. */
      kind: "skill" | "agent" | "mcp"
      name: string
      manifestDigest: string
      /** Every component id this transaction actually installed, root first. */
      installed: string[]
      /** Curated components this host refused to install, with the decoder's own reason token. */
      skipped: Array<{ id: string; reason: PackageComponentSkipReasonV1 }>
      /** MCP component names that landed `enabled` and therefore need one live reload each. */
      activateMcp: string[]
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
  /**
   * `#698`:update 时**离场 child** 的实物清除接缝(生产接线 = `removePackageChildArtifactsV1`
   * 配同一组 installer)。可选,但**不是可跳过**:真有东西要删而接缝缺席时 admission 响亮拒绝,
   * 绝不让「账本说没了、实物还在跑」这种状态发生。
   */
  removePackageChildArtifacts?: (children: Array<{ kind: string; name: string }>) => PackageArtifactRemovalV1
}

/**
 * One accepted component, resolved down to everything the transaction needs. `#697` replaced the
 * old single-component `PreparedPackage` with a list of these: `envelope.components[0]` (and its
 * one-layer-up twin `facts.components[0]`) turned a producer's array order into a load-bearing
 * invariant, and the type already carries the fact (`role`).
 */
type PreparedComponent = {
  accepted: PackageAcceptedComponentV1
  key: string
  kind: "skill" | "agent" | "mcp"
  name: string
  asset?: Buffer
  agentEntry?: Record<string, unknown>
  itemDigest: string
}

/** A curated component this host will not install, carrying the decoder's own token verbatim. */
type SkippedComponent = { componentId: string; skipReasonCode: PackageComponentSkipReasonV1 }

type PreparedPackage = {
  facts: PackageAcceptedFactsV1
  /** Root first, then every included leaf **sorted by component id**. */
  components: PreparedComponent[]
  root: PreparedComponent
  /** Sorted by component id. */
  skipped: SkippedComponent[]
  binding: PackageAdmissionBindingV1
}

const byComponentId = <T extends { id: string }>(left: T, right: T) =>
  left.id < right.id ? -1 : left.id > right.id ? 1 : 0

/**
 * The transaction key a skipped component gets inside the journal / authorization receipt. The
 * engine's `skippedOptional.key` must be fs-safe (`SAFE_KEY`) and component ids carry a colon, so
 * identity travels as a digest of the id rather than as a hand-rolled re-spelling of it. The
 * *reason* is never re-spelled: it is the decoder's token, byte for byte.
 */
export function packageSkippedTxKeyV1(componentId: string): string {
  return `skipped--${sha256Hex(componentId).slice(0, 24)}`
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
      // `#698`:计划期判决 —— 与执行期调用同一个函数,所以确认屏与真正提交的 mutation 同源。
      const lifecycle = resolvePackageLifecyclePlan(deps.root(), resolved.prepared)
      if (!lifecycle.ok) return { ok: false, reason: `package admission: ${lifecycle.reason}` }
      if (lifecycle.plan.conflicts.length > 0) return { ok: false, reason: conflictReason(lifecycle.plan.conflicts) }
      // 一次展示、一次授权:Bundle 的每个**将被安装**的组件各出一条 diff。被跳过的组件不出现
      // (§4.3:不该要用户为一个不会安装的东西授权),但它仍在 plan 里如实可见。
      const authorization = evaluateBundleAuthorization(
        deps.root(),
        resolved.prepared.components.map((component) => ({
          key: component.key,
          capabilities: component.accepted.component.capabilities,
        })),
      ).items
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
          update: packageUpdatePreview(deps.root(), resolved.prepared, lifecycle.plan, authorization),
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

    // 密钥面按**组件**分区。prerequisiteId 自带 componentId 前缀,所以一张扁平的 secrets map
    // 分区是无歧义的;每个组件用**它自己的** profile 判定(store server 是逐组件的)。
    // 「提交集恰等于声明集」的整包断言留在分区之前 —— 否则一个多余的、属于任何组件的 id
    // 都可以躲进「不属于我」的缝里。
    const profiles = revalidated.prepared.components.map((component) => component.accepted.prerequisite)
    const expectedSecretKeys = profiles
      .flatMap((profile) => profile.items.map((item) => item.prerequisiteId))
      .sort()
    const submittedSecretKeys = Object.keys(intent.grants?.secrets ?? {}).sort()
    if (intent.grants?.secrets && canonicalJson(expectedSecretKeys) !== canonicalJson(submittedSecretKeys))
      return { ok: false, reason: "package admission: secret-undeclared" }
    for (const profile of profiles) {
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
    }
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

    // `#698`:判决在**执行期重算**,不吃 preview 时那份。两次之间账本可能被别的操作改过
    // (另一个包装了同一个 child、用户单装了它、另一版本落了地),而这里算错的后果是删错东西。
    const lifecycle = resolvePackageLifecyclePlan(deps.root(), revalidated.prepared)
    if (!lifecycle.ok) return { ok: false, reason: `package admission: ${lifecycle.reason}` }
    if (lifecycle.plan.conflicts.length > 0) return { ok: false, reason: conflictReason(lifecycle.plan.conflicts) }

    return executePreparedPackage(revalidated.prepared, intent, deps, connection, lifecycle.plan)
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
  // 逐组件:Bundle 里任何一个将被安装的组件都可能声明连接前置。required 未就绪 = 整包拒
  // (全有或全无),optional 未就绪 = 整包落 disabled 并如实说明。
  const items = prepared.components.flatMap((component) => component.accepted.connection.items)
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

function componentOperations(component: PreparedComponent) {
  return component.kind === "skill"
    ? (["write-generation", "write-install-record", "write-capability-grant"] as const)
    : component.kind === "agent"
      ? (["write-file", "update-config", "write-install-record", "write-capability-grant"] as const)
      : component.accepted.prerequisite.items.length > 0
        ? (["write-secret-version", "update-config", "write-install-record", "write-capability-grant"] as const)
        : (["update-config", "write-install-record", "write-capability-grant"] as const)
}

/**
 * The **authorization screen** is a preview too, and it is the one the user actually presses
 * "confirm" on. It therefore lists every signed component, not just the ones being installed:
 * without the skipped rows the user confirms an install while being told nothing about the part of
 * the package that will silently not arrive.
 */
function packagePlanPreview(prepared: PreparedPackage): PackageAdmissionPreviewV1["plan"] {
  const installed: PackageAdmissionPlanItemV1[] = prepared.components.map((component) => ({
    included: true,
    componentId: component.accepted.component.id,
    role: component.accepted.role,
    required: component.accepted.component.required,
    key: component.key,
    kind: component.kind,
    name: component.name,
    manifestDigest: `sha256:${component.itemDigest}`,
    payloadDigest: `sha256:${component.accepted.component.payloadRef.sha256}`,
    capabilities: [...component.accepted.component.capabilities].sort(),
    prerequisites: component.accepted.prerequisite.items.map((item) => ({
      prerequisiteId: item.prerequisiteId,
      label: item.label,
      required: item.required,
    })),
    operations: [...componentOperations(component)],
  }))
  const skipped: PackageAdmissionPlanItemV1[] = prepared.skipped.map((entry) => ({
    included: false,
    componentId: entry.componentId,
    role: "leaf",
    required: false,
    // 逐字来自 decoder(经安全视图透传),不是在这里重新措辞。
    skipReasonCode: entry.skipReasonCode,
  }))
  return {
    packageId: prepared.facts.envelope.prelude.packageId,
    version: prepared.facts.envelope.prelude.version,
    scope: { scope: "global" },
    items: [...installed, ...skipped],
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
  // REQ-128 Phase 3 `#782` G8②:`local:` 是**本地导入**保留的 packageId 命名空间(基线 §5
  // 显式让给本票的**唯一一处** admission 改动)。这是一条**更严的拒绝**,不是在 admission 上
  // 开本地入口 —— 方向与 admission 的既有姿态一致。
  //
  // **为什么只做铸造侧的单向闸等于没做**:本机「这个包装没装」的唯一判据是
  // `ext-package-installed`(`ext-ipc.ts`),它**纯按字符串查 V3 图、不问来源**。一个 packageId
  // 为 `local:x` 的已验签信封装上之后,远程 catalog 详情页会命中本地包的图,当场长出
  // 「移除此扩展包」——用户在一个远程包的页面上,一键卸掉自己手动导入的插件。
  //
  // 可达性(第零问):envelope decoder 的 `PACKAGE_ID_RE` 与账本的那条**逐字相同**
  // (`^[a-z][a-z0-9-]{0,31}:[a-z0-9][a-z0-9._-]{0,127}$`),两侧都接受 `local:x` ⇒ 这个状态
  // 走我们自己的解码链到得了,不是合成夹具里才成立的。
  if (isLocalPackageId(selected.prelude.packageId))
    return {
      ok: false,
      reason: `package admission: packageId namespace "${LOCAL_PACKAGE_ID_PREFIX}" is reserved for locally imported packages and must not appear in a verified Catalog`,
    }

  let accepted: PackageAcceptedFactsV1 | undefined
  const view = await evaluatePackageForHost(selected.envelope, {
    ...deps.installability,
    accepted: (facts) => {
      accepted = facts
    },
  })
  if (!accepted || view.verdict !== "compatible") return { ok: false, reason: view.action.reasonCode, package: view }

  const facts = accepted
  // 固定顺序:root 先,其余按**组件 id** 排序。生产者重排 `components[]` 不得改变 admission
  // 的任何一步 —— 顺序是排版约定,不是不变量。
  const rootAccepted = facts.components.find((entry) => entry.role === "root")!
  const ordered = [
    rootAccepted,
    ...facts.components
      .filter((entry) => entry.role === "leaf")
      .sort((left, right) => byComponentId(left.component, right.component)),
  ]

  const components: PreparedComponent[] = []
  for (const entry of ordered) {
    const component = entry.component
    const name = component.id.slice(component.id.indexOf(":") + 1)
    const kind = component.profileId === "skill" ? "skill" : component.profileId === "agent" ? "agent" : "mcp"
    // 事务 key 只此一处派生(`packageChildTxKeyV1`)—— 卸载时清授权账用的是同一个函数。
    // 两处各写一遍 ternary,偏差只会在「装得上但卸载后 grants.json 还在」时现身。
    const key = packageChildTxKeyV1(kind, name)
    const assetRef =
      entry.payload.schema === "alpha.host-extension-package.payload.skill.v1" ||
      entry.payload.schema === "alpha.host-extension-package.payload.agent.v1"
        ? entry.payload.behavior.asset
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
      entry.payload.schema === "alpha.host-extension-package.payload.agent.v1" && asset
        ? agentMdToEntry(asset.toString("utf8"))
        : undefined
    if (agentEntry && !agentEntry.ok)
      return { ok: false, reason: `package admission: agent payload invalid (${agentEntry.reason})`, package: view }

    components.push({
      accepted: entry,
      key,
      kind,
      name,
      ...(asset ? { asset } : {}),
      ...(agentEntry?.ok ? { agentEntry: agentEntry.entry } : {}),
      itemDigest: sha256Hex(
        canonicalJson({
          component,
          payload: entry.payload,
          ...(assetRef ? { asset: { sha256: assetRef.sha256, bytes: assetRef.bytes } } : {}),
        }),
      ),
    })
  }

  // 一个 Bundle 里两个组件解析到同一条 fs 记录(同 kind 同名)= 两条 item 争同一个 live 叶。
  // 引擎的 duplicate-key 闸只看 item key,而 skill 与 agent 的 key 前缀不同 —— 所以这一条要在
  // 这里判,且判的是 (kind,name),即账本与 claim 的真身份。
  const identities = new Set<string>()
  for (const component of components) {
    const identity = `${component.kind}:${component.name}`
    if (identities.has(identity))
      return {
        ok: false,
        reason: `package admission: package installs ${identity} twice — refusing (one child, one owner)`,
        package: view,
      }
    identities.add(identity)
  }

  // 被跳过的组件**不重新推导**:直接消费安全视图那一份,于是详情页、确认屏、收据拿到的是
  // 同一个字符串,而不是三处各算一遍的三个答案(§4.3 闸 ③)。
  const skipped: SkippedComponent[] = view.components
    .filter((entry): entry is typeof entry & { skipReasonCode: PackageComponentSkipReasonV1 } =>
      !entry.included && entry.skipReasonCode !== null,
    )
    .map((entry) => ({ componentId: entry.componentId, skipReasonCode: entry.skipReasonCode }))
    .sort((left, right) => (left.componentId < right.componentId ? -1 : left.componentId > right.componentId ? 1 : 0))

  return {
    ok: true,
    prepared: {
      facts,
      components,
      root: components[0]!,
      skipped,
      binding: {
        snapshotDigest: loaded.snapshotDigest,
        envelopeDigest: sha256Hex(canonicalJson(facts.envelope)),
        graphDigest: sha256Hex(canonicalJson(facts.graph)),
        itemDigests: Object.fromEntries(
          components.map((component) => [component.accepted.component.id, component.itemDigest]),
        ),
        capabilityDigest: sha256Hex(
          canonicalJson(
            Object.fromEntries(
              components.map((component) => [component.key, component.accepted.component.capabilities]),
            ),
          ),
        ),
      },
    },
  }
}

/**
 * Build every component's plan, then run **one** transaction over all of it. The whole point of the
 * Bundle is that there is no per-child commit: required children are all-or-nothing, and the ledger
 * sees exactly one `PackageLedgerMutationV1` carried on the root item.
 */
async function executePreparedPackage(
  prepared: PreparedPackage,
  intent: PackageIntent,
  deps: PackageAdmissionDeps,
  connection: ResolvedPackageConnectionV1,
  lifecycle: PackageLifecyclePlanV1,
): Promise<PackageAdmissionOutcome> {
  const root = deps.root()
  const now = (deps.now?.() ?? new Date()).toISOString()

  // `#698`(review R2):离场 child 的清除**一分为二**,依据是「它还能不能跑」。
  //
  //   · **能跑的那一半 = config 键**(`agent.<name>` / `mcp.<name>`)⇒ 普通的事务 config item,
  //     与安装侧的 config 编辑在同一次事务、同一把锁、同一套 before-image 回滚里。不需要第二把锁
  //     (R1 那版把删除搬进 commitReceipt,而引擎正持着 root bundle 锁,配置写要取同一把
  //     非重入锁 ⇒ Agent/MCP 清理必然失败);skill 的启用面是账本派生允许集,随同一次
  //     `applyPackageMutation` 一起变,所以它不出 config item。
  //   · **不能跑的那一半 = 内容文件 / generation store / 授权账**⇒ 事务**返回之后**清理。
  //     那时锁已释放,而且这条路径按构造不碰任何配置(`removeFsInstallFilesOnly`),重入不可能发生。
  //
  // 事务失败时:config 由 before-image 回旧,文件清理根本没跑 ⇒ 全旧。事务成功后文件清理失败:
  // 离场 child 已经**不可能被加载**(config 键没了、record 没了、不在允许集里),剩下的是惰性
  // 磁盘残留 —— 如实报 warning。**不声称可恢复**:journal 此时已终态,没有任何东西会重试它。
  const doomed = lifecycle.verdicts.filter((verdict) => verdict.decision === "delete")
  if (doomed.length > 0 && !deps.removePackageChildArtifacts)
    return {
      ok: false,
      reason: `package admission: this update removes ${doomed
        .map((verdict) => `${verdict.kind}:${verdict.name}`)
        .join(", ")}, but no artifact-removal seam is wired — refusing (fail closed)`,
    }
  const builds: Array<{ component: PreparedComponent; build: PackageTxBuildV1; desiredState: "enabled" | "disabled" }> = []

  for (const component of prepared.components) {
    const manifestDigest = `sha256:${component.itemDigest}`
    const receipt: UpsertInput = {
      id: component.accepted.component.id,
      name: component.name,
      kind: component.kind,
      environment: deps.environment(),
      scope: { kind: "global" },
      version: prepared.facts.envelope.prelude.version,
      manifestDigest,
      payloadDigest: `sha256:${component.accepted.component.payloadRef.sha256}`,
      grantDigest: computeGrantDigest(intent.grants),
      desiredState: nextDesiredState(root, component.kind, component.name, { origin: "catalog" }),
      origin: "catalog",
      installedAt: now,
    }
    // "Installed but unavailable" is not a new state — it is the existing disabled desired-state,
    // reached for one more reason, so the runtime, the detail page and the enable toggle already
    // know what to do with it. It is a real override, not a coincidence with today's default: a
    // package with a prior `enabled` record would otherwise come back enabled with no connection
    // behind it. A Bundle's connection prerequisite belongs to the package, so it lands on every
    // component: half a package running against a connection that is not there is worse than none.
    //
    // It has to stay *above* `common`: since #705 the ledger template is handed to the builders, so
    // this is the last point at which one write reaches every builder and every item they emit.
    if (connection.unavailable) receipt.desiredState = "disabled"
    // #705:计划构造归 builders(Bundle 与单装同一真源),本函数只负责执行与结果映射。
    const common = {
      root,
      key: component.key,
      name: component.name,
      capabilities: component.accepted.component.capabilities,
      manifestDigest,
      receipt,
    }
    const built =
      component.kind === "skill"
        ? buildSkillTxItems({ ...common, ...(component.asset ? { asset: component.asset } : {}) })
        : component.kind === "agent"
          ? buildAgentTxItems({
              ...common,
              ...(component.asset ? { asset: component.asset } : {}),
              ...(component.agentEntry ? { agentEntry: component.agentEntry } : {}),
            })
          : buildMcpTxItems({
              ...common,
              userDataPath: deps.userDataPath,
              payload: component.accepted.payload,
              prerequisite: component.accepted.prerequisite,
              secretValues: intent.grants?.secrets ?? {},
              newSecretVersionId: deps.secretVersionId ?? newMcpSecretVersionId,
            })
    if (!built.ok) return { ok: false, reason: `package admission: ${built.reason}` }
    builds.push({ component, build: built.build, desiredState: receipt.desiredState })
  }

  const rootManifestDigest = lifecycle.rootManifestDigest
  const planned = builds.flatMap((entry) => entry.build.items)
  // REQ-128 `#706`:V3 mutation 只挂在 **root** package item 上。挂错 item 或挂多份都会被
  // `validatePlan` / `commitTransactionLedger` 在写盘前拒掉。
  const rootItemIndex = planned.findIndex((item) => item.key === prepared.root.key)
  if (rootItemIndex < 0)
    return {
      ok: false,
      reason: `package admission: planning builder produced no root item for "${prepared.root.key}" — refusing (no ledger mutation carrier)`,
    }
  const items = [
    ...planned.map((item, index) =>
      index === rootItemIndex ? { ...item, packageMutation: packageMutationEnvelope(lifecycle) } : item,
    ),
    // 离场 child 的 config 清除排在最后:同一 target 上的 image 按 item 顺序链式累积
    // (`prepareConfigTx(target, edits, accumulatedText)`),放在安装项之后语义最直白。
    ...buildDepartingChildConfigItemsV1({ root, children: doomed.map((verdict) => ({ kind: verdict.kind, name: verdict.name })) }),
  ]

  // 每条 item 路由回**产它的那个 builder** 的 populate/probe。不共用一个「反正三种都返回同一个
  // router」的巧合:那是把一条今天成立的等式当成不变量。未登记的 key 一律 fail-closed。
  const populateByKey = new Map<string, PackageTxBuildV1["populate"]>()
  const probeByKey = new Map<string, HealthProbe>()
  for (const entry of builds)
    for (const item of entry.build.items) {
      populateByKey.set(item.key, entry.build.populate)
      probeByKey.set(item.key, entry.build.probe)
    }

  const preparedResources = builds.flatMap((entry) => (entry.build.prepared ? [entry.build.prepared] : []))

  // #712:受限密钥版本以**类型化 descriptor** 进计划(→ journal),不再只是一对匿名闭包。
  // 释放归引擎调度(abort/rollback 前),恢复期对同一条 journal 做同一件事 —— 单一真源。
  const result = await (deps.transaction ?? runExtensionTransaction)(
    root,
    packagePlan(items, prepared, intent, now, preparedResources.map((entry) => entry.descriptor)),
    {
      populate: (item, stagingDir) => {
        const populate = populateByKey.get(item.key)
        if (!populate) throw new Error(`no populate seam for transaction item "${item.key}" — refusing (fail closed)`)
        return populate(item, stagingDir)
      },
      ...(preparedResources.length
        ? {
            populatePrepared: () => {
              for (const entry of preparedResources) entry.populate()
            },
            // 逐个探,第一个不健康即返回。健康时**原样透传**最后一个裁决对象而不是重造一个
            // `{healthy:true}` —— 单资源时与 `#705` 抽取前逐字同形(parity 用例冻结了这一点)。
            probePrepared: (): HealthVerdict => {
              let verdict: HealthVerdict = { healthy: true }
              for (const entry of preparedResources) {
                verdict = entry.probe()
                if (!verdict.healthy) return verdict
              }
              return verdict
            },
            releasePrepared: (resources) => releasePreparedTxResources(deps.userDataPath, resources),
          }
        : {}),
      probe: async (input) => {
        const probe = probeByKey.get(input.key)
        if (!probe)
          return { healthy: false, reason: `no health probe for transaction item "${input.key}" — refusing (fail closed)` }
        return probe(input)
      },
      precondition: () => {
        for (const entry of builds) {
          const verdict = entry.build.precondition()
          if (!verdict.ok) return verdict
        }
        return { ok: true }
      },
      commitReceipt: (records) => commitPackageReceipts(root, records),
    },
  )
  // 事务返回之后 = 锁已释放。惰性残留在这里清,失败只报不改结果(离场 child 此刻已不可能被加载)。
  const cleanupWarnings: string[] = []
  if (result.ok && doomed.length > 0 && deps.removePackageChildArtifacts) {
    const removal = deps.removePackageChildArtifacts(doomed.map((verdict) => ({ kind: verdict.kind, name: verdict.name })))
    if (!removal.ok)
      cleanupWarnings.push(
        `removed package components are no longer active, but their leftover files could not be deleted: ${removal.reason} — they are inert; nothing retries this automatically`,
      )
  }
  return transactionOutcome(
    result,
    prepared,
    rootManifestDigest,
    builds,
    connection,
    [bindConnectionsAfterCommit(result, connection, deps), ...cleanupWarnings].filter((entry): entry is string => !!entry).join("; ") || undefined,
  )
}

function packagePlan(
  items: TxPlanItem[],
  prepared: PreparedPackage,
  intent: PackageIntent,
  decidedAt: string,
  preparedResources: TxPreparedResourceV1[],
): TxPlan {
  return {
    items,
    authorization: {
      confirmed: intent.authorization!.confirmed,
      decidedAt,
    },
    // §4.3 闸 ③ 的第三个面:被跳过的组件进 journal,并由引擎落进 Bundle 授权收据。
    // `reason` 是 decoder 的 token 本身 —— 与安全视图、确认屏逐字相同。
    ...(prepared.skipped.length
      ? {
          skippedOptional: prepared.skipped.map((entry) => ({
            key: packageSkippedTxKeyV1(entry.componentId),
            reason: entry.skipReasonCode,
          })),
        }
      : {}),
    ...(preparedResources.length ? { prepared: preparedResources } : {}),
  }
}

const graphNodeOf = (component: PreparedComponent) => ({
  componentId: component.accepted.component.id,
  kind: component.kind,
  name: component.name,
  required: component.accepted.component.required,
  manifestDigest: `sha256:${component.itemDigest}`,
})

/**
 * REQ-128 `#698`:一次 package 操作在**账本层面**的完整判决。install / update 共用一份 ——
 * 「这是第一次装」只是 `before === null` 的那一格,不是另一条代码路径。
 */
type PackageLifecyclePlanV1 = {
  rootManifestDigest: string
  graph: PackageGraphV1
  before: PackageGraphV1 | null
  diff: PackageGraphDiffV1
  /** 离场 child 的逐个判决(claim-aware)。`before === null` 时恒空。 */
  verdicts: PackageChildRemovalVerdictV1[]
  conflicts: PackageChildConflictV1[]
}

/**
 * 判决在**动任何东西之前**算完,而且 preview 与执行调用的是同一个函数 —— 用户确认屏上看到的
 * 「谁会被删、谁会留下」与真正提交的那份 mutation 因此不可能分叉。
 */
function resolvePackageLifecyclePlan(
  root: string,
  prepared: PreparedPackage,
): { ok: true; plan: PackageLifecyclePlanV1 } | { ok: false; reason: string } {
  const rootManifestDigest = `sha256:${prepared.root.itemDigest}`
  const graph = packageGraphOf(prepared, rootManifestDigest)
  const state = readPackageLedgerStateV1(root)
  if (!state.ok) return { ok: false, reason: state.reason }
  const before = state.packageGraphs.find((candidate) => candidate.packageId === graph.packageId) ?? null
  // `#764`:「当前版本」取自上一代 root 组件的 v2 record —— 与图、claim 同一次账本读。账本没有
  // package 级记录,所以这里也不去问一个不存在的东西;之前这一栏根本没被填,preview 恒 null。
  const diffed = diffPackageGraphsV1(before, graph, {
    before: before ? packageVersionFromRecordsV1(before, state.records) : null,
    after: prepared.facts.envelope.prelude.version,
  })
  if (!diffed.ok) return diffed
  const departing = diffed.diff.changes
    .filter((change) => change.change === "removed")
    .map((change) => ({ kind: change.kind, name: change.name }))
  return {
    ok: true,
    plan: {
      rootManifestDigest,
      graph,
      before,
      diff: diffed.diff,
      verdicts: diffed.diff.ownerBefore
        ? planPackageChildRemovalsV1({
            departing,
            ownerBefore: diffed.diff.ownerBefore,
            claims: state.claims,
            recordKeys: state.recordKeys,
          })
        : [],
      // 别的 package 已经拥有同名 child 且 digest 不同 ⇒ 装下去会覆盖它的内容,而它的图仍指着
      // 旧 digest。这必须在**计划期**拒(票面 Development plan 6),不是等写盘时被一句
      // 「graph mismatch」拦下 —— 那时用户已经点过确认了。
      conflicts: planPackageChildConflictsV1({ graphs: state.packageGraphs, candidate: graph }),
    },
  }
}

/**
 * `#698` 的 update preview(票面 Development plan 2:显示 capability / prerequisite / claim 变化)。
 *
 * 三栏各有各的真源,一栏都不许重新推导:
 *   · **capability** ← 已提交的授权账(`grants.json`)与本次请求集的 diff。`requiresConfirmation`
 *     为真就必须重新确认 —— 「扩大能力必须重授权」因此不是新开关,而是把既有的授权账 diff 摆进
 *     update 语境。**离场组件**也出现在这里(请求集为空集 ⇒ `removed` = 它此前被授过的全部能力),
 *     否则用户在一次更新里看不到自己正在放弃什么。
 *   · **prerequisite** ← 本次将被采集的前置 id(after 侧)。`unchanged` 组件的 manifestDigest 逐字
 *     未变 ⇒ 它声明的前置按构造也未变,所以「变了没有」由 `change` 那一栏回答,不另编一套。
 *   · **claim** ← 离场 child 的逐个判决(删 / 留 + 具名理由)。
 */
function packageUpdatePreview(
  root: string,
  prepared: PreparedPackage,
  plan: PackageLifecyclePlanV1,
  authorization: CapabilityDiff[],
): PackageUpdatePreviewV1 {
  const capabilityDiffByKey = new Map(authorization.map((diff) => [diff.key, diff]))
  // 离场组件不在本次授权集里(它不会被安装),但它**有**一份已提交的授权账。空请求集与那份账
  // 的 diff 就是「这次会放弃哪些能力」。
  for (const change of plan.diff.changes) {
    if (change.change !== "removed") continue
    const key = packageChildTxKeyV1(change.kind as "skill" | "agent" | "mcp", change.name)
    if (!capabilityDiffByKey.has(key)) capabilityDiffByKey.set(key, evaluateCapabilityDiff(root, key, []))
  }
  const prerequisiteIdsByKey = new Map(
    prepared.components.map((component) => [
      component.key,
      component.accepted.prerequisite.items.map((item) => item.prerequisiteId),
    ]),
  )
  return buildPackageUpdatePreviewV1({
    diff: plan.diff,
    graphBeforeDigest: plan.before?.installedGraphDigest ?? null,
    graphAfterDigest: plan.graph.installedGraphDigest,
    claims: plan.verdicts,
    prerequisiteIdsByKey,
    capabilityDiffByKey,
  })
}

const conflictReason = (conflicts: PackageChildConflictV1[]): string =>
  `package admission: package-child-conflict — ${conflicts
    .map(
      (conflict) =>
        `${conflict.kind}:${conflict.name} is already installed by "${conflict.holderPackageId}" at ${conflict.holderDigest}, this package wants ${conflict.candidateDigest}`,
    )
    .join("; ")}`

/**
 * REQ-128 `#706`:package 安装的**有效安装图** —— root 加上每一个真的会被装的 leaf。被跳过的
 * 组件按构造不在图里(§4.3),所以两台宿主对同一个签名信封可以合法地得到不同的图。
 *
 * root 走**声明的 `role`**,不是 `components[0]` —— 后者是生产者随手排的顺序,把它当 root 就是
 * 把一个排版约定升级成承重不变量。这个 componentId 直接进 owner token 的派生链,认错了 =
 * claim 归属认错人。
 */
function packageGraphOf(prepared: PreparedPackage, rootManifestDigest: string): PackageGraphV1 {
  const withoutDigest = {
    packageId: prepared.facts.envelope.prelude.packageId,
    envelopeDigest: `sha256:${prepared.binding.envelopeDigest}`,
    root: { ...graphNodeOf(prepared.root), required: true, manifestDigest: rootManifestDigest },
    children: prepared.components.slice(1).map(graphNodeOf),
  }
  return { ...withoutDigest, installedGraphDigest: computeInstalledGraphDigest(withoutDigest) }
}

/** 挂在 root package item 上的静态半场:图、package 记录、claim mutation 与 child 删除集。
 *  child record 的 **upsert** 半场在提交时由 commit records 派生(`commitTransactionLedger`),
 *  所以主提交与崩溃前滚算出的是同一份 mutation。
 *
 *  `#698`:claim mutation 不再是「给每个组件 acquire 一次」。update 时 root 的 manifestDigest 一变,
 *  owner token 就跟着变 —— 旧 owner 若不释放,账本里每一条旧 claim 都会成为「孤儿 owner」
 *  (`validateV3State`:claim 指名一张这本账里没有的图),整次写盘被拒。换句话说,`#697` 之后
 *  「装第二个版本」在结构上是**装不上**的,而这正是本票要修的第一件事。 */
function packageMutationEnvelope(plan: PackageLifecyclePlanV1): PackageMutationEnvelopeV1 {
  const graph = plan.graph
  return {
    operation: plan.before ? "update" : "install",
    graphBeforeDigest: plan.before?.installedGraphDigest ?? null,
    graphAfter: graph,
    // 释放全部旧 owner 在前、获取全部新 owner 在后(集合代数按序施加,反过来会把刚获取的抹掉)。
    claimMutations: planPackageClaimTransferV1(plan.diff),
    // 只有判决为 `delete` 的离场 child 才去账。judgment 为 `retain` 的(还有别的包在用 / 用户自己
    // 也装过 / legacy 存量 / 不受管)一件都不动 —— 账本的 `validatePackageMutationScopeV1` 与
    // dangling-claim 闸会在写盘前把算错的那种拦下。
    childRemovals: plan.verdicts
      .filter((verdict) => verdict.decision === "delete")
      .map((verdict) => ({ kind: verdict.kind, name: verdict.name })),
  }
}

function commitPackageReceipts(root: string, records: TxCommitRecord[]) {
  commitTransactionLedger(root, records)
}

function transactionOutcome(
  result: TxResult,
  prepared: PreparedPackage,
  rootManifestDigest: string,
  builds: Array<{ component: PreparedComponent; desiredState: "enabled" | "disabled" }>,
  connection: ResolvedPackageConnectionV1,
  connectionWarning?: string,
): PackageAdmissionOutcome {
  if (!result.ok) {
    if (result.stage === "authorize")
      return { ok: false, reason: "package admission: transaction authorization changed; start a new attempt" }
    return { ok: false, reason: result.reason, stage: result.stage }
  }
  const warnings = [...result.warnings, ...(connectionWarning ? [connectionWarning] : [])]
  const rootBuild = builds[0]!
  return {
    ok: true,
    kind: prepared.root.kind,
    name: prepared.root.name,
    manifestDigest: rootManifestDigest,
    installed: prepared.components.map((component) => component.accepted.component.id),
    skipped: prepared.skipped.map((entry) => ({ id: entry.componentId, reason: entry.skipReasonCode })),
    // 每个落 `enabled` 的 MCP 组件报**一次**,去重后排序 —— 调用方据此各重载一次,不多不少。
    activateMcp: [
      ...new Set(
        builds
          .filter((entry) => entry.component.kind === "mcp" && entry.desiredState === "enabled")
          .map((entry) => entry.component.name),
      ),
    ].sort(),
    ...(rootBuild.component.kind === "mcp" && rootBuild.desiredState === "disabled"
      ? { installedDisabled: true as const }
      : {}),
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
