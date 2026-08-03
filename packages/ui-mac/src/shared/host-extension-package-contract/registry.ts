import registryJson from "./host-extension-package.registry.v1.json"

export type PackageProfileIdV1 = "skill" | "agent" | "mcp-local" | "mcp-remote" | "opencode-plugin"
/**
 * `engine:config` and `engine:plugin` are **not** new words. They are the tokens the renderer's
 * authorization surface has always used for the legacy plugin install path
 * (`shared/ext-capability-authorization.ts:30` requests exactly this pair), promoted into the host
 * registry so a managed package discloses the same two facts a sideloaded plugin does. Minting a
 * package-only synonym would have disclosed *less* than the legacy path for the same effect.
 *
 * Host capability admission is registry membership and nothing else (`isPackageCapabilityV1`), so
 * there is no `alpha.*` naming rule to satisfy.
 */
export type PackageCapabilityV1 =
  | "alpha.connection.v1"
  | "alpha.mcp-oauth.v1"
  | "alpha.secret-prerequisite.v1"
  | "engine:config"
  | "engine:plugin"

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
  maxComponents: number
  maxMarkdownAssetBytes: number
  maxScriptAssetBytes: number
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

export const HOST_EXTENSION_PACKAGE_LIMIT_KEYS_V1 = [
  "maxCapabilities",
  "maxComponents",
  "maxEnvelopeBytes",
  "maxHeaderDepth",
  "maxHeaderNodes",
  "maxMarkdownAssetBytes",
  "maxPayloadBytes",
  "maxPayloadDepth",
  "maxPayloadNodes",
  "maxScriptAssetBytes",
  "maxStringBytes",
] as const

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
  if (
    profiles.join("\n") !==
    ["agent@1", "mcp-local@1", "mcp-remote@1", "opencode-plugin@1", "skill@1"].join("\n")
  )
    throw new Error("profile registry must contain the sorted host profile set exactly once")
  const capabilities = CAPABILITY_REGISTRY_V1.map((capability) => capability.token)
  if (
    capabilities.join("\n") !==
    [
      "alpha.connection.v1",
      "alpha.mcp-oauth.v1",
      "alpha.secret-prerequisite.v1",
      "engine:config",
      "engine:plugin",
    ].join("\n")
  )
    throw new Error("capability registry must contain the sorted host vocabulary exactly once")
  // 界也是合同的一部分。少一条界 = 宿主某处又回去写死一个常量(#737 记在案的 5 MiB 残留就是
  // 这么长出来的),而没有任何东西会红。exact-set 让「悄悄删掉一条界」与「悄悄加一条没人读的
  // 界」同时变红。
  if (
    Object.keys(registry.limits).sort().join("\n") !== HOST_EXTENSION_PACKAGE_LIMIT_KEYS_V1.join("\n")
  )
    throw new Error("limit registry must contain the sorted host limit set exactly once")
  if (
    Object.values(registry.limits).some(
      (value) => typeof value !== "number" || !Number.isInteger(value) || value < 1,
    )
  )
    throw new Error("every registry limit must be a positive integer")
}
