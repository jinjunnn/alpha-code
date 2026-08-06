import type { CapabilityDiffWire } from "./ext-capability-authorization"
import type {
  AlphaPackageEnvelopeV1,
  PackageComponentSkipReasonV1,
  PackageSupportedComponentV1,
} from "./host-extension-package-contract/decoder"

export type PackageAdmissionBindingV1 = {
  snapshotDigest: string
  envelopeDigest: string
  /**
   * Binds the **planned** install graph: the root plus every leaf that is actually going to be
   * installed, each with the required flag and payload digest that decision was made from.
   * `envelopeDigest` alone cannot express this — two hosts reading the same signed envelope can
   * legitimately produce different effective graphs when one of them skips a curated component.
   *
   * `#758`: this is computed **before** anything is installed, over what the envelope declares
   * (`PackageEffectiveInstallGraphV1`). It is **not** the ledger's `installedGraphDigest`
   * (`main/ext-package-ledger-v3.ts`), which covers the graph as actually installed, per-node
   * `manifestDigest` included, and carries a `sha256:` prefix this one does not. The two values
   * are never equal and are not supposed to be.
   */
  graphDigest: string
  itemDigests: Record<string, string>
  capabilityDigest: string
}

export type PackageAdmissionAuthorizationV1 = {
  confirmed: Record<string, string[]>
  binding: PackageAdmissionBindingV1
}

export type PackageEffectiveInstallGraphV1 = {
  packageId: string
  version: string
  root: string
  components: Array<{
    id: string
    required: boolean
    profileId: string
    profileVersion: number
    payloadSha256: string
  }>
}

/**
 * The one place that answers "what is actually going to be installed". Components are sorted by id
 * so that a producer re-ordering `components[]` cannot change the digest, and skipped components
 * are absent by construction — the caller passes only what survived the support gate.
 */
export function packageEffectiveInstallGraphV1(
  envelope: AlphaPackageEnvelopeV1,
  supported: ReadonlyArray<PackageSupportedComponentV1>,
): PackageEffectiveInstallGraphV1 {
  return {
    packageId: envelope.prelude.packageId,
    version: envelope.prelude.version,
    root: envelope.root,
    components: supported
      .map((component) => ({
        id: component.id,
        required: component.required,
        profileId: component.profileId,
        profileVersion: component.profileVersion,
        payloadSha256: component.payloadRef.sha256,
      }))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
  }
}

/**
 * One row per **signed** component on the authorization screen — including the ones this host is
 * not going to install. `included` is the discriminator, and a skipped row carries the decoder's
 * own `skipReasonCode` verbatim: the safe view, this preview, and the durable authorization
 * receipt must all name the same reason with the same characters, or "the user is told the same
 * thing at every step" is a claim nothing enforces (§4.3).
 *
 * A skipped component has no transaction key, no digest and no operations — it is not going to be
 * installed — so this is a real union rather than an included-row with nulled fields.
 */
export type PackageAdmissionPlanItemV1 =
  | {
      included: true
      componentId: string
      role: "root" | "leaf"
      required: boolean
      key: string
      /** `#809`:与 `packageChildKindV1` 那张表的值域逐字相同。IPC 契约面收窄一格就会让
       *  managed plugin 在授权屏上无法表示 —— 而它已经装得上了。 */
      kind: "skill" | "agent" | "mcp" | "plugin"
      name: string
      manifestDigest: string
      payloadDigest: string
      capabilities: string[]
      prerequisites: Array<{
        prerequisiteId: string
        label: string
        required: boolean
      }>
      operations: Array<
        | "write-generation"
        | "write-file"
        | "write-secret-version"
        | "update-config"
        | "write-install-record"
        | "write-capability-grant"
      >
    }
  | {
      included: false
      componentId: string
      role: "leaf"
      required: false
      skipReasonCode: PackageComponentSkipReasonV1
    }

export type PackageAdmissionPlanV1 = {
  packageId: string
  version: string
  scope: { scope: "global" }
  items: PackageAdmissionPlanItemV1[]
}

/**
 * `#698`:同一个 packageId 已经装过时,这一屏要回答的不是「会装什么」而是「会**变**什么」。
 * 每一行的判据都是 exact 值(manifestDigest / componentId / required),没有 semver、没有
 * 「差不多是同一个」。`change` 的五个取值穷举了一个 `(kind,name)` 位置能发生的全部事:
 * 新增 / 消失 / 换了内容 / 只翻了 required / 一个字节都没变。
 */
export type PackageUpdateChangeWireV1 = "added" | "removed" | "replaced" | "optional-changed" | "unchanged"

export type PackageUpdateComponentWireV1 = {
  componentId: string | null
  kind: string
  name: string
  key: string
  change: PackageUpdateChangeWireV1
  requiredBefore: boolean | null
  requiredAfter: boolean | null
  prerequisiteIds: string[]
  capabilities: { previous: string[] | null; requested: string[]; added: string[]; removed: string[] }
}

/** 离场 child 的判决。`retain` 一定带具名理由 —— 「你的东西为什么没跟着包一起消失」是用户会问的。 */
export type PackageUpdateClaimWireV1 = {
  kind: string
  name: string
  decision: "delete" | "retain"
  remainingOwners: string[]
  reasonCode: "shared-with-package" | "user-installed" | "legacy-protected" | "unmanaged" | null
}

export type PackageUpdatePreviewWireV1 = {
  operation: "install" | "update" | "uninstall"
  packageId: string
  versionBefore: string | null
  versionAfter: string | null
  graphBeforeDigest: string | null
  graphAfterDigest: string | null
  /** root 的 manifestDigest 变了 ⇒ owner token 变了 ⇒ 每个留下来的 child 都要换 owner。 */
  ownerChanged: boolean
  components: PackageUpdateComponentWireV1[]
  claims: PackageUpdateClaimWireV1[]
  capabilityExpansion: boolean
}

export type PackageAdmissionPreviewV1 = {
  attemptId: string
  binding: PackageAdmissionBindingV1
  plan: PackageAdmissionPlanV1
  items: CapabilityDiffWire[]
  /** 首次安装时 `operation: "install"` 且每一行都是 `added` —— 同一个形状,不另出一个可选分支。 */
  update: PackageUpdatePreviewWireV1
}
