import registryJson from "./host-extension-package.registry.v1.json"

export type PackageProfileIdV1 = "skill" | "agent" | "mcp-local" | "mcp-remote"
export type PackageCapabilityV1 =
  | "alpha.connection.v1"
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
  /** `#828`:一个组件的资产**文件条数**上界(skill 载荷的 `behavior.files`)。 */
  maxComponentAssetFiles: number
  /** `#827`:信封能装的组件数上界 —— **32,不是 16**。
   *
   *  口径:只数今天合法的四个 profile,`.mcp.json` 里**每个 server** 各算一个,commands/hooks 不计。
   *  按此实测 62 个真实插件(`#826`)最大 13,**但 13 是偶然值**:最大那个插件的 `.mcp.json` 不是
   *  合法 JSON(缺逗号、少右括号)按 0 个 server 计,而字节里躺着 12 个 —— 上游修好即 `13+12=25`。
   *  **「25 怎么办」的答案就是这条界:32 ≥ 25,装得下**,不需要发布端 `blocked` finding,也不需要拆
   *  成多个 Bundle(那会打掉「整包装、整包卸」,ADR-040 已划到票外);32 是容纳 25 的最小常用档,且
   *  仍低于事务引擎的 64,保住「信封比事务更严」这层纵深。
   *
   *  ⚠️ 唯一与本界共同起作用的是 `maxHeaderNodes`:32 组件各带满 3 个 capability = 525 > 512 会先撞
   *  节点界(真实目标 25 组件带满 = 413,有余量);放宽它不在本票范围。 */
  maxComponents: number
  /**
   * `#828` 起这是**该组件资产的总字节预算**,不再是「单个 markdown 资产的上限」。
   *
   * 名字保持不变是刻意的:改名会同时动两仓的 exact-set 断言、发布端 `HOST_LIMIT_KEYS`、
   * 以及一份已归档的 Phase 1 验证证据矩阵,而语义变化本身用一条注释就能说清。
   * 单文件语义因此**一字未变**:一份 5 MiB 的 `SKILL.md` 改前能过、改后照样能过
   * (总预算 = 单文件上限 ⇒ 只有一条时两者恒等)。
   */
  maxMarkdownAssetBytes: number
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
  "maxComponentAssetFiles",
  "maxComponents",
  "maxEnvelopeBytes",
  "maxHeaderDepth",
  "maxHeaderNodes",
  "maxMarkdownAssetBytes",
  "maxPayloadBytes",
  "maxPayloadDepth",
  "maxPayloadNodes",
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
  if (profiles.join("\n") !== ["agent@1", "mcp-local@1", "mcp-remote@1", "skill@1"].join("\n"))
    throw new Error("profile registry must contain the sorted host profile set exactly once")
  const capabilities = CAPABILITY_REGISTRY_V1.map((capability) => capability.token)
  if (
    capabilities.join("\n") !==
    ["alpha.connection.v1", "alpha.mcp-oauth.v1", "alpha.secret-prerequisite.v1"].join("\n")
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
