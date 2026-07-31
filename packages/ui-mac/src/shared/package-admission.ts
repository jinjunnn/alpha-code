import type { CapabilityDiffWire } from "./ext-capability-authorization"

export type PackageAdmissionBindingV1 = {
  snapshotDigest: string
  envelopeDigest: string
  itemDigests: Record<string, string>
  capabilityDigest: string
}

export type PackageAdmissionAuthorizationV1 = {
  confirmed: Record<string, string[]>
  binding: PackageAdmissionBindingV1
}

export type PackageAdmissionPlanV1 = {
  packageId: string
  version: string
  scope: { scope: "global" }
  items: Array<{
    componentId: string
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
  }>
}

export type PackageAdmissionPreviewV1 = {
  attemptId: string
  binding: PackageAdmissionBindingV1
  plan: PackageAdmissionPlanV1
  items: CapabilityDiffWire[]
}
