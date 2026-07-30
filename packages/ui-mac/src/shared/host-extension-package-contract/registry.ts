import registryJson from "./host-extension-package.registry.v1.json"

export type PackageProfileIdV1 = "skill" | "agent" | "mcp-local" | "mcp-remote" | "cloud"
export type PackageCapabilityV1 =
  | "alpha.connection-prerequisite.v1"
  | "alpha.mcp-oauth.v1"
  | "alpha.secret-prerequisite.v1"

export type PackageProfileRegistrationV1 = {
  profileId: PackageProfileIdV1
  profileVersion: 1
  mediaType: string
  schemaPath: string
}

export type PackageCapabilityRegistrationV1 = {
  token: PackageCapabilityV1
  semantic: string
}

export type HostExtensionPackageLimitsV1 = {
  maxEnvelopeBytes: number
  maxHeaderDepth: number
  maxHeaderNodes: number
  maxStringBytes: number
  maxCapabilities: number
  maxPayloadBytes: number
  maxPayloadDepth: number
  maxPayloadNodes: number
}

const registry = registryJson as {
  schema: string
  profiles: PackageProfileRegistrationV1[]
  capabilities: PackageCapabilityRegistrationV1[]
  limits: HostExtensionPackageLimitsV1
}

export const HOST_EXTENSION_PACKAGE_REGISTRY_SCHEMA_V1 = "alpha.host-extension-package.registry.v1"
export const PROFILE_REGISTRY_V1: readonly PackageProfileRegistrationV1[] = registry.profiles
export const CAPABILITY_REGISTRY_V1: readonly PackageCapabilityRegistrationV1[] = registry.capabilities
export const HOST_EXTENSION_PACKAGE_LIMITS_V1 = registry.limits

export function findPackageProfileV1(
  profileId: string,
  profileVersion: number,
): PackageProfileRegistrationV1 | undefined {
  return PROFILE_REGISTRY_V1.find(
    (profile) => profile.profileId === profileId && profile.profileVersion === profileVersion,
  )
}

export function isPackageCapabilityV1(token: string): token is PackageCapabilityV1 {
  return CAPABILITY_REGISTRY_V1.some((capability) => capability.token === token)
}

export function assertHostExtensionPackageRegistryV1(): void {
  if (registry.schema !== HOST_EXTENSION_PACKAGE_REGISTRY_SCHEMA_V1)
    throw new Error(`registry schema must be ${HOST_EXTENSION_PACKAGE_REGISTRY_SCHEMA_V1}`)
  const profiles = PROFILE_REGISTRY_V1.map((profile) => `${profile.profileId}@${profile.profileVersion}`)
  if (profiles.join("\n") !== ["agent@1", "cloud@1", "mcp-local@1", "mcp-remote@1", "skill@1"].join("\n"))
    throw new Error("profile registry must contain the sorted Phase 1 profile set exactly once")
  const capabilities = CAPABILITY_REGISTRY_V1.map((capability) => capability.token)
  if (
    capabilities.join("\n") !==
    [
      "alpha.connection-prerequisite.v1",
      "alpha.mcp-oauth.v1",
      "alpha.secret-prerequisite.v1",
    ].join("\n")
  )
    throw new Error("capability registry must contain the sorted Phase 1 vocabulary exactly once")
}
