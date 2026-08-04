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
  /**
   * `#827`:一个信封能装的组件数上界。**32,不是 16。**
   *
   * 口径必须写清楚,否则这个数下次又会被当成拍脑袋的整数改掉 —— 它数的是**今天合法的四个
   * profile**(`skill` / `agent` / `mcp-local` / `mcp-remote`),`.mcp.json` 里**每个 server**
   * 各算一个组件;`commands` 与 `hooks` 今天没有 profile,**不计**。换一个口径数出来的分布
   * (票面初版的「7/62 超过 16、最大 22」)对这条界毫无约束力。
   *
   * 按上述口径实测本机 62 个真实 Claude 插件(`#826`):超过 16 的 **0 个**,最大 **13**,
   * 中位数 **2**。**但界不能定在 13** —— 那是个偶然值:最大的那个插件
   * (`claude-for-financial-services/.../financial-analysis`)的 `.mcp.json` 不是合法 JSON
   * (缺一个逗号、少一个右括号),所以今天按 0 个 server 计。那份文件的字节里躺着 **12 个
   * https server**,上游一把 JSON 修好,它就是 `13 + 12 = 25` 个组件。
   *
   * **「25 怎么办」的答案就是这条界本身:32 ≥ 25,它装得下,不需要发布端的 `blocked` finding,
   * 也不需要把一个插件拆成多个 Bundle**(后者会打掉「整包装、整包卸」的用户可见语义,
   * ADR-040 已把它划到本票之外)。32 是能容纳 25 的最小常用档,且仍低于事务引擎的 64 items ——
   * 抬到 64 只会把两条界拉平,白白丢掉「信封比事务更严」这层纵深。
   *
   * 两条不是瓶颈的东西(实测,免得下次被误当成约束):32 组件的信封 15,972 字节,
   * 而 `maxEnvelopeBytes` 是 65,536;33 组件 439 个节点,而 `maxHeaderNodes` 是 512 ——
   * 后者正是「+1 时先咬的确实是本界」的原因,由 package-envelope-v1.test.ts 那条
   * 「同一份字节在界+1 时转为接受」的用例证明,不靠这里的算术。
   *
   * ⚠️ 唯一与本界共同起作用的是 `maxHeaderNodes`:每个组件各带满 3 个 capability 时,
   * 32 组件 = 525 个节点 > 512,会先撞节点界。真实目标(25 组件带满 3 个)是 413,**有余量**;
   * 放宽节点界不在本票范围,故如实登记而不顺手改。
   */
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
