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
   * Binds the **effective** install graph: the root plus every leaf that is actually going to be
   * installed, each with the required flag and payload digest that decision was made from.
   * `envelopeDigest` alone cannot express this — two hosts reading the same signed envelope can
   * legitimately produce different effective graphs when one of them skips a curated component.
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
      kind: "skill" | "agent" | "mcp"
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

export type PackageAdmissionPreviewV1 = {
  attemptId: string
  binding: PackageAdmissionBindingV1
  plan: PackageAdmissionPlanV1
  items: CapabilityDiffWire[]
}
