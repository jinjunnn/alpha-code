import {
  HOST_EXTENSION_PACKAGE_LIMITS_V1,
  findPackageProfileV1,
  isPackageCapabilityV1,
  type PackageCapabilityV1,
  type PackageProfileIdV1,
  type PackageProfileRegistrationV1,
} from "./registry"

export const HOST_EXTENSION_PACKAGE_SCHEMA_V1 = "alpha.host-extension-package.v1"

export type PackagePayloadRefV1 = {
  sha256: string
  bytes: number
  mediaType: string
  url: string
}

/**
 * A component exactly as the producer signed it. `profileId`, `profileVersion`, and `capabilities`
 * are deliberately *not* narrowed to the host registry: a skipped leaf is part of the signed
 * envelope precisely because this host does not recognise its profile or capability, and typing it
 * as recognised would be a lie that survives into every consumer. Only
 * `PackageSupportedComponentV1` — produced solely by the support gate — carries the narrow types.
 */
export type PackageComponentV1 = {
  id: string
  required: boolean
  dependencies: string[]
  profileId: string
  profileVersion: number
  capabilities: string[]
  payloadRef: PackagePayloadRefV1
}

export type PackageSupportedComponentV1 = PackageComponentV1 & {
  profileId: PackageProfileIdV1
  profileVersion: 1
  capabilities: PackageCapabilityV1[]
}

export type AlphaPackageEnvelopeV1 = {
  schema: typeof HOST_EXTENSION_PACKAGE_SCHEMA_V1
  prelude: { packageId: string; version: string }
  presentation: { displayName: string; description: string }
  root: string
  components: PackageComponentV1[]
  /**
   * The producer's signed union over **every** component, skipped ones included. It can therefore
   * legitimately contain a token this host does not know, so it is not narrowed.
   */
  capabilities: string[]
}

export type MarkdownAssetRefV1 = {
  sha256: string
  bytes: number
  mediaType: "text/markdown"
  url: string
}

/**
 * `#828`:一个技能载荷里的**一个文件**。
 *
 * 形状不是新发明的:它逐字等于本仓既有的多文件内容寻址清单
 * (`src/renderer/extensions/catalog-types.ts` 的 `remoteAsset.files[]`,由
 * `remote-catalog.ts` 的 `downloadRemoteAsset` 取用)。签名 package 这条路此前只能表达
 * **一个** markdown 资产,而真实语料里 40/162 的技能是多文件目录(实测上界 18 个文件、
 * 总 230,243 字节、单文件 64,768 字节、相对路径深度 2)—— 照旧形状装,这 40 个装完是残件:
 * 安装成功、账本干净、技能能启用,而它引用的脚本与参考资料一个都不在,且**没有任何东西会红**。
 *
 * **没有 `mediaType`**,这是**刻意**的,并且是一次如实登记的取舍:
 *   · 多文件技能里合法地含 `.py` / `.sh` / `.json`,要保留 `mediaType` 就得让发布端按扩展名
 *     派生一张类型表 —— 那正是「替第三方写文法」,本仓最贵的返工形态;
 *   · 旧的 `mediaType: const "text/markdown"` 只是一次**声明值相等比较**,不看任何字节
 *     (生产者声明 `text/markdown` 就能塞二进制)⇒ 它的真实强度是零;
 *   · 顶上来的两条判据都**看字节**:下面 `SKILL_MD_PATH` 锚点(恰好一条),以及
 *     `ext-skill-generations.ts` 的 `skillGenerationProbe` 解析 `SKILL.md` 的 frontmatter。
 *
 * **路径安全不在本层判**(如实登记的降级):`path` 的遍历/可移植性/大小写折叠碰撞由
 * `ext-install-planner.ts` 的 `promotePayloadToCas` 唯一拥有 —— 它是本仓这套文法的单一所有者,
 * 且第一遍纯校验零写入。在这里再抄一份就是第二个真源。非法路径因此在**任何写盘之前**被拒,
 * 只是拒绝点在解码之后。
 */
export type SkillAssetFileV1 = {
  /** 相对技能根的 POSIX 路径。文法归 `promotePayloadToCas`,本层只管存在/唯一/锚点。 */
  path: string
  sha256: string
  bytes: number
  url: string
}

/** 技能的入口文件。它的位置是合同项而不是巧合:`skillGenerationProbe` 读的就是这一条。 */
export const SKILL_MD_PATH = "SKILL.md"

export type SkillPayloadV1 = {
  schema: "alpha.host-extension-package.payload.skill.v1"
  behavior: { targetDir: "alpha-skills" | "global"; files: SkillAssetFileV1[] }
}

export type AgentPayloadV1 = {
  schema: "alpha.host-extension-package.payload.agent.v1"
  behavior: { targetDir: "alpha-agents" | "global"; asset: MarkdownAssetRefV1 }
}

export type McpLocalPayloadV1 = {
  schema: "alpha.host-extension-package.payload.mcp-local.v1"
  behavior: { command: string[]; environment: Record<string, string>; requiredSecrets: string[] }
}

/**
 * The remote-MCP authorization shape is frozen here, not merely tokenised. A capability token by
 * itself only says that some authorization exists; it does not say which bytes a producer may ship,
 * so a later ticket could invent its own field names and this decoder would wave them through.
 *
 * `auth` is therefore a discriminated union rather than a bare enum: each arm names its own
 * required fields and refuses unknown ones, so there is exactly one legal spelling per kind.
 *
 * `connectionHandlerId`'s **grammar** lives here and nowhere else. Main is only ever allowed to
 * look the finished id up in a static allowlist — never to re-derive meaning from its prefix,
 * segments, or namespace. That is the `#737` discipline: one place decides what a token may look
 * like, and everyone downstream consumes that decision instead of re-implementing it.
 */
export type McpRemoteAuthV1 =
  | "none"
  | { kind: "mcp-oauth"; prerequisiteId: string; required: boolean; label?: string }
  | {
      kind: "alpha-connection"
      prerequisiteId: string
      required: boolean
      connectionHandlerId: string
      label?: string
    }

export type McpRemoteBehaviorV1 = {
  url: string
  headersTemplate: Record<string, string>
  requiredSecrets: string[]
  auth: McpRemoteAuthV1
}

export type McpRemotePayloadV1 = {
  schema: "alpha.host-extension-package.payload.mcp-remote.v1"
  behavior: McpRemoteBehaviorV1
}

export type PackageProfilePayloadV1 =
  | SkillPayloadV1
  | AgentPayloadV1
  | McpLocalPayloadV1
  | McpRemotePayloadV1

/**
 * A curated component this host cannot serve is skipped, never silently dropped. The reason token
 * is produced here once and consumed verbatim by every downstream surface (the safe view today;
 * plan preview and receipt when they land), so the user is told the same thing at every step.
 */
export const PACKAGE_COMPONENT_SKIP_REASONS_V1 = [
  "component-capability-unsupported",
  "component-media-type-mismatch",
  "component-profile-unsupported",
] as const

export type PackageComponentSkipReasonV1 = (typeof PACKAGE_COMPONENT_SKIP_REASONS_V1)[number]

export type PackageComponentDecodeV1 =
  | {
      component: PackageSupportedComponentV1
      role: "root" | "leaf"
      status: "supported"
      profile: PackageProfileRegistrationV1
    }
  | {
      component: PackageComponentV1
      role: "leaf"
      status: "skipped"
      reasonCode: PackageComponentSkipReasonV1
    }

export type PackageEnvelopeHeaderDecodeV1 =
  | {
      ok: true
      status: "accepted"
      envelope: AlphaPackageEnvelopeV1
      /** The root component's profile. Every leaf carries its own inside `components`. */
      profile: PackageProfileRegistrationV1
      components: PackageComponentDecodeV1[]
    }
  | {
      ok: false
      status: "blocked"
      stage: "header" | "support"
      errors: string[]
      presentation?: AlphaPackageEnvelopeV1["presentation"]
    }

export type PackageProfilePayloadDecodeV1 =
  | { ok: true; payload: PackageProfilePayloadV1 }
  | { ok: false; errors: string[] }

const ENVELOPE_KEYS = new Set([
  "schema",
  "prelude",
  "presentation",
  "root",
  "components",
  "capabilities",
])
const PRELUDE_KEYS = new Set(["packageId", "version"])
const PRESENTATION_KEYS = new Set(["displayName", "description"])
const COMPONENT_KEYS = new Set([
  "id",
  "required",
  "dependencies",
  "profileId",
  "profileVersion",
  "capabilities",
  "payloadRef",
])
const PAYLOAD_REF_KEYS = new Set(["sha256", "bytes", "mediaType", "url"])
const PAYLOAD_KEYS = new Set(["schema", "behavior"])
/** agent 的 behavior —— `#828` **刻意没动**:Claude 的 agent 就是单个 `.md`。 */
const MARKDOWN_BEHAVIOR_KEYS = new Set(["targetDir", "asset"])
/** `#828`:skill 的 behavior 与 agent 分家(载荷是一份**有界文件清单**)。 */
const SKILL_BEHAVIOR_KEYS = new Set(["targetDir", "files"])
const SKILL_ASSET_FILE_KEYS = new Set(["path", "sha256", "bytes", "url"])
const MCP_LOCAL_BEHAVIOR_KEYS = new Set(["command", "environment", "requiredSecrets"])
const MCP_REMOTE_BEHAVIOR_KEYS = new Set(["url", "headersTemplate", "requiredSecrets", "auth"])
const MCP_REMOTE_AUTH_KINDS = ["alpha-connection", "mcp-oauth"] as const
const MCP_OAUTH_AUTH_KEYS = new Set(["kind", "prerequisiteId", "required", "label"])
const ALPHA_CONNECTION_AUTH_KEYS = new Set([
  "kind",
  "prerequisiteId",
  "required",
  "connectionHandlerId",
  "label",
])

const PACKAGE_ID_RE = /^[a-z][a-z0-9-]{0,31}:[a-z0-9][a-z0-9._-]{0,127}$/
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/
const PROFILE_ID_RE = /^[a-z][a-z0-9-]{0,31}$/
/**
 * The capability token grammar. It is a grammar/DoS bound and never the admission gate: whether a
 * token is *honoured* is decided solely by `isPackageCapabilityV1` registry membership. What this
 * regex does decide is which **unknown** tokens are well-formed enough to ride along on a
 * component, so widening it is not free — a malformed token on an *optional* leaf is skipped by the
 * membership gate while the package as a whole is still accepted, and the malformed value then
 * surfaces nowhere (`#807` R1/F1; the graph case in `package-envelope-v1.test.ts` pins that the
 * whole package is refused instead).
 *
 * ADR-040 (`#830`) took `engine:config` / `engine:plugin` back out of the registry, so the
 * alternation that admitted those two colon-bearing literals is gone with them and no registered
 * token contains a colon.
 *
 * It is exported because it must stay **byte-identical** to `$defs/capabilities.items.pattern` in
 * `alpha-package-envelope-v1.schema.json`: a producer that passes the published schema and then
 * fails this decoder is a contract that lies. `host-extension-package-artifact.test.ts` asserts
 * that equality on `.source`, and cross-checks both against the same probe strings — hand-comparing
 * the two spellings is what let the divergence exist in the first place.
 */
export const PACKAGE_CAPABILITY_GRAMMAR_V1 = /^[a-z][a-z0-9.-]{0,95}$/
const CAPABILITY_RE = PACKAGE_CAPABILITY_GRAMMAR_V1
const HEX64_RE = /^[0-9a-f]{64}$/
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,127}$/
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,128}$/
const PREREQUISITE_ID_RE = /^[a-z][a-z0-9-]{0,63}$/
const CONNECTION_HANDLER_RE = /^[a-z][a-z0-9-]{0,63}$/
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1f\x7f]/
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"])
const TEXT_ENCODER = new TextEncoder()

export function canonicalPackagePreludeBytesV1(prelude: { packageId: string; version: string }): Uint8Array {
  return TEXT_ENCODER.encode(
    `${JSON.stringify({ packageId: prelude.packageId, version: prelude.version })}\n`,
  )
}

export function decodePackageEnvelopeHeaderV1(bytes: Uint8Array): PackageEnvelopeHeaderDecodeV1 {
  if (bytes.byteLength > HOST_EXTENSION_PACKAGE_LIMITS_V1.maxEnvelopeBytes)
    return {
      ok: false,
      status: "blocked",
      stage: "header",
      errors: [
        `envelope: ${bytes.byteLength} bytes exceeds ${HOST_EXTENSION_PACKAGE_LIMITS_V1.maxEnvelopeBytes}`,
      ],
    }
  const parsed = parseJsonBytes(bytes, "envelope")
  if (!parsed.ok) return { ok: false, status: "blocked", stage: "header", errors: parsed.errors }
  const limitErrors = inspectStructure(
    parsed.value,
    "envelope",
    HOST_EXTENSION_PACKAGE_LIMITS_V1.maxHeaderDepth,
    HOST_EXTENSION_PACKAGE_LIMITS_V1.maxHeaderNodes,
  )
  if (limitErrors.length)
    return { ok: false, status: "blocked", stage: "header", errors: limitErrors }
  return decodeEnvelopeObject(parsed.value)
}

export function decodePackageProfilePayloadV1(
  profileId: PackageProfileIdV1,
  bytes: Uint8Array,
  capabilities: PackageCapabilityV1[],
): PackageProfilePayloadDecodeV1 {
  if (bytes.byteLength > HOST_EXTENSION_PACKAGE_LIMITS_V1.maxPayloadBytes)
    return {
      ok: false,
      errors: [
        `payload: ${bytes.byteLength} bytes exceeds ${HOST_EXTENSION_PACKAGE_LIMITS_V1.maxPayloadBytes}`,
      ],
    }
  const parsed = parseJsonBytes(bytes, "payload")
  if (!parsed.ok) return parsed
  const limitErrors = inspectStructure(
    parsed.value,
    "payload",
    HOST_EXTENSION_PACKAGE_LIMITS_V1.maxPayloadDepth,
    HOST_EXTENSION_PACKAGE_LIMITS_V1.maxPayloadNodes,
  )
  if (limitErrors.length) return { ok: false, errors: limitErrors }
  const decoded =
    profileId === "skill"
      ? decodeSkillPayload(parsed.value)
      : profileId === "agent"
        ? decodeAgentPayload(parsed.value)
        : profileId === "mcp-local"
          ? decodeMcpLocalPayload(parsed.value)
          : decodeMcpRemotePayload(parsed.value)
  if (!decoded.ok) return decoded
  const expected = derivePayloadCapabilitiesV1(decoded.payload)
  if (expected.join("\n") !== capabilities.join("\n"))
    return {
      ok: false,
      errors: [
        `payload.capabilities: compiler-derived capabilities must be [${expected.join(", ")}], got [${capabilities.join(", ")}]`,
      ],
    }
  return decoded
}

export function derivePayloadCapabilitiesV1(payload: PackageProfilePayloadV1): PackageCapabilityV1[] {
  const capabilities: PackageCapabilityV1[] = []
  if (
    (payload.schema === "alpha.host-extension-package.payload.mcp-local.v1" ||
      payload.schema === "alpha.host-extension-package.payload.mcp-remote.v1") &&
    payload.behavior.requiredSecrets.length
  )
    capabilities.push("alpha.secret-prerequisite.v1")
  if (
    payload.schema === "alpha.host-extension-package.payload.mcp-remote.v1" &&
    payload.behavior.auth !== "none"
  ) {
    if (payload.behavior.auth.kind === "mcp-oauth") capabilities.push("alpha.mcp-oauth.v1")
    if (payload.behavior.auth.kind === "alpha-connection") capabilities.push("alpha.connection.v1")
  }
  return [...new Set(capabilities)].sort()
}

function decodeEnvelopeObject(value: unknown): PackageEnvelopeHeaderDecodeV1 {
  if (!isObject(value))
    return {
      ok: false,
      status: "blocked",
      stage: "header",
      errors: ["envelope: must be an object"],
    }
  if (value.schema !== HOST_EXTENSION_PACKAGE_SCHEMA_V1)
    return {
      ok: false,
      status: "blocked",
      stage: "header",
      errors: [
        `envelope.schema: unsupported version ${JSON.stringify(value.schema)}; expected ${HOST_EXTENSION_PACKAGE_SCHEMA_V1}`,
      ],
    }

  const errors: string[] = []
  rejectUnknownKeys(value, ENVELOPE_KEYS, "envelope", errors)
  const prelude = decodePrelude(value.prelude, errors)
  const presentation = decodePresentation(value.presentation, errors)
  const root = decodeString(value.root, "envelope.root", errors, {
    max: 160,
    pattern: PACKAGE_ID_RE,
  })
  const components = decodeComponentGraph(value.components, root, errors)
  const capabilities = decodeCapabilities(value.capabilities, "envelope.capabilities", errors)
  if (components && capabilities.join("\n") !== unionCapabilities(components).join("\n"))
    errors.push(
      "envelope.capabilities: must equal the sorted union of every component's capabilities",
    )
  if (errors.length || !prelude || !presentation || !root || !components)
    return { ok: false, status: "blocked", stage: "header", errors }

  const supportErrors: string[] = []
  const decoded: PackageComponentDecodeV1[] = []
  for (const [index, component] of components.entries()) {
    const support = supportComponent(component, index)
    if (support.ok) {
      decoded.push({
        component: narrowComponent(component),
        role: component.id === root ? "root" : "leaf",
        status: "supported",
        profile: support.profile,
      })
      continue
    }
    // §4.1 条件 1 保证 root 一定是 required,所以 root 的支持失败必然落进这一支,
    // 也就是说「root 不受支持」永远是整包 blocked,不会退化成一个被跳过的叶子。
    if (component.required) {
      supportErrors.push(...support.errors)
      continue
    }
    decoded.push({
      component,
      role: "leaf",
      status: "skipped",
      reasonCode: support.reasonCode,
    })
  }
  if (supportErrors.length)
    return {
      ok: false,
      status: "blocked",
      stage: "support",
      errors: supportErrors,
      presentation,
    }

  const rootDecoded = decoded.find((entry) => entry.role === "root")
  if (!rootDecoded || rootDecoded.status !== "supported")
    return {
      ok: false,
      status: "blocked",
      stage: "support",
      errors: [`envelope.root: the root component "${root}" must be supported`],
      presentation,
    }

  return {
    ok: true,
    status: "accepted",
    profile: rootDecoded.profile,
    components: decoded,
    envelope: {
      schema: HOST_EXTENSION_PACKAGE_SCHEMA_V1,
      prelude,
      presentation,
      root,
      components: decoded.map((entry) => entry.component),
      capabilities,
    },
  }
}

function supportComponent(
  component: DecodedComponent,
  index: number,
):
  | { ok: true; profile: PackageProfileRegistrationV1 }
  | { ok: false; reasonCode: PackageComponentSkipReasonV1; errors: string[] } {
  const at = `envelope.components[${index}]`
  const profile = findPackageProfileV1(component.profileId, component.profileVersion)
  if (!profile)
    return {
      ok: false,
      reasonCode: "component-profile-unsupported",
      errors: [`${at}: unsupported profile ${component.profileId}@${component.profileVersion}`],
    }
  const unsupported = component.capabilities.filter(
    (capability) => !isPackageCapabilityV1(capability),
  )
  if (unsupported.length)
    return {
      ok: false,
      reasonCode: "component-capability-unsupported",
      errors: unsupported.map(
        (capability) => `${at}.capabilities: unsupported capability "${capability}"`,
      ),
    }
  if (profile.mediaType !== component.payloadRef.mediaType)
    return {
      ok: false,
      reasonCode: "component-media-type-mismatch",
      errors: [
        `${at}.payloadRef.mediaType: expected "${profile.mediaType}" for ${profile.profileId}@${profile.profileVersion}`,
      ],
    }
  return { ok: true, profile }
}

function narrowComponent(component: DecodedComponent): PackageSupportedComponentV1 {
  return {
    ...component,
    profileId: component.profileId as PackageProfileIdV1,
    profileVersion: 1,
    capabilities: component.capabilities as PackageCapabilityV1[],
  }
}

function unionCapabilities(components: DecodedComponent[]): string[] {
  return [...new Set(components.flatMap((component) => component.capabilities))].sort()
}

function decodePrelude(
  value: unknown,
  errors: string[],
): AlphaPackageEnvelopeV1["prelude"] | undefined {
  if (!isObject(value)) {
    errors.push("envelope.prelude: required object")
    return
  }
  rejectUnknownKeys(value, PRELUDE_KEYS, "envelope.prelude", errors)
  const packageId = decodeString(value.packageId, "envelope.prelude.packageId", errors, {
    max: 160,
    pattern: PACKAGE_ID_RE,
  })
  const version = decodeString(value.version, "envelope.prelude.version", errors, {
    max: 64,
    pattern: VERSION_RE,
  })
  if (packageId && version) return { packageId, version }
}

function decodePresentation(
  value: unknown,
  errors: string[],
): AlphaPackageEnvelopeV1["presentation"] | undefined {
  if (!isObject(value)) {
    errors.push("envelope.presentation: required object")
    return
  }
  rejectUnknownKeys(value, PRESENTATION_KEYS, "envelope.presentation", errors)
  const displayName = decodeString(value.displayName, "envelope.presentation.displayName", errors, {
    max: 120,
  })
  const description = decodeString(value.description, "envelope.presentation.description", errors, {
    max: 500,
  })
  if (displayName && description) return { displayName, description }
}

type DecodedComponent = PackageComponentV1

/**
 * The only definition of a legal component graph. It is stated as an equality rather than as a
 * traversal, because a traversal invites "one more rule" patches: R1 found a graph that satisfied
 * unique-id + closure + acyclic + depth-1 and still contained a second, orphaned root.
 *
 *   1. `root` names a component of this envelope, and that component is `required`;
 *   2. the root's `dependencies` are exactly the set of every non-root id — no duplicate, no
 *      omission (an omitted id is an orphan), no id from outside the envelope, no self-reference;
 *   3. every non-root component declares an empty `dependencies` array;
 *   4. component ids are globally unique.
 *
 * Together these already imply acyclic, depth 1, no orphan, and exactly one root, so none of those
 * is checked separately.
 */
function decodeComponentGraph(
  value: unknown,
  root: string | undefined,
  errors: string[],
): DecodedComponent[] | undefined {
  if (!Array.isArray(value)) {
    errors.push("envelope.components: required array")
    return
  }
  if (value.length < 1 || value.length > HOST_EXTENSION_PACKAGE_LIMITS_V1.maxComponents) {
    errors.push(
      `envelope.components: requires 1..${HOST_EXTENSION_PACKAGE_LIMITS_V1.maxComponents} components`,
    )
    return
  }
  const before = errors.length
  const components = value.map((component, index) => decodeComponent(component, index, errors))
  if (errors.length !== before || components.some((component) => !component)) return
  const decoded = components as DecodedComponent[]

  const ids = decoded.map((component) => component.id)
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))]
  duplicates.forEach((id) => errors.push(`envelope.components: duplicate component id "${id}"`))
  if (duplicates.length) return

  if (!root) return
  const rootIndex = ids.indexOf(root)
  if (rootIndex === -1) {
    errors.push(`envelope.root: "${root}" is not one of envelope.components[].id`)
    return
  }
  const rootComponent = decoded[rootIndex]!
  if (!rootComponent.required)
    errors.push(`envelope.root: the root component "${root}" must be required`)

  const rootAt = `envelope.components[${rootIndex}].dependencies`
  const declared = new Set<string>()
  rootComponent.dependencies.forEach((dependency, index) => {
    if (declared.has(dependency)) {
      errors.push(`${rootAt}[${index}]: duplicate id "${dependency}"`)
      return
    }
    declared.add(dependency)
    if (dependency === root) {
      errors.push(`${rootAt}[${index}]: the root component must not depend on itself`)
      return
    }
    if (!ids.includes(dependency))
      errors.push(`${rootAt}[${index}]: "${dependency}" is not a component of this package`)
  })
  ids
    .filter((id) => id !== root && !declared.has(id))
    .forEach((id) =>
      errors.push(`${rootAt}: component "${id}" is not depended on by the root (orphan)`),
    )

  decoded.forEach((component, index) => {
    if (component.id === root || component.dependencies.length === 0) return
    errors.push(
      `envelope.components[${index}].dependencies: only the root component may declare dependencies`,
    )
  })

  if (errors.length !== before) return
  return decoded
}

function decodeComponent(
  value: unknown,
  index: number,
  errors: string[],
): DecodedComponent | undefined {
  const at = `envelope.components[${index}]`
  if (!isObject(value)) {
    errors.push(`${at}: must be an object`)
    return
  }
  rejectUnknownKeys(value, COMPONENT_KEYS, at, errors)
  const id = decodeString(value.id, `${at}.id`, errors, {
    max: 160,
    pattern: PACKAGE_ID_RE,
  })
  if (typeof value.required !== "boolean") errors.push(`${at}.required: required boolean`)
  const dependencies = decodeDependencies(value.dependencies, `${at}.dependencies`, errors)
  const profileId = decodeString(value.profileId, `${at}.profileId`, errors, {
    max: 32,
    pattern: PROFILE_ID_RE,
  })
  if (
    typeof value.profileVersion !== "number" ||
    !Number.isInteger(value.profileVersion) ||
    value.profileVersion < 1 ||
    value.profileVersion > 2147483647
  )
    errors.push(`${at}.profileVersion: required positive 32-bit integer`)
  const capabilities = decodeCapabilities(value.capabilities, `${at}.capabilities`, errors)
  const payloadRef = decodePayloadRef(value.payloadRef, `${at}.payloadRef`, errors)
  if (
    id &&
    typeof value.required === "boolean" &&
    dependencies &&
    profileId &&
    typeof value.profileVersion === "number" &&
    Number.isInteger(value.profileVersion) &&
    value.profileVersion >= 1 &&
    value.profileVersion <= 2147483647 &&
    payloadRef
  )
    return {
      id,
      required: value.required,
      dependencies,
      profileId,
      profileVersion: value.profileVersion,
      capabilities,
      payloadRef,
    }
}

function decodeDependencies(value: unknown, at: string, errors: string[]): string[] | undefined {
  if (!Array.isArray(value)) {
    errors.push(`${at}: required array`)
    return
  }
  const max = HOST_EXTENSION_PACKAGE_LIMITS_V1.maxComponents - 1
  if (value.length > max) {
    errors.push(`${at}: exceeds ${max} items`)
    return
  }
  const decoded = value.map((item, index) =>
    decodeString(item, `${at}[${index}]`, errors, { max: 160, pattern: PACKAGE_ID_RE }),
  )
  if (decoded.some((item) => item === undefined)) return
  return decoded as string[]
}

function decodeCapabilities(value: unknown, at: string, errors: string[]): string[] {
  if (!Array.isArray(value)) {
    errors.push(`${at}: required array`)
    return []
  }
  if (value.length > HOST_EXTENSION_PACKAGE_LIMITS_V1.maxCapabilities)
    errors.push(`${at}: exceeds ${HOST_EXTENSION_PACKAGE_LIMITS_V1.maxCapabilities} items`)
  const decoded = value.flatMap((token, index) => {
    const value = decodeString(token, `${at}[${index}]`, errors, {
      max: 96,
      pattern: CAPABILITY_RE,
    })
    return value ? [value] : []
  })
  if (decoded.some((token, index) => index > 0 && token <= decoded[index - 1]!))
    errors.push(`${at}: must be unique and byte-order sorted`)
  return decoded
}

function decodePayloadRef(
  value: unknown,
  at: string,
  errors: string[],
  options: { maxBytes?: number; mediaType?: string } = {},
): PackagePayloadRefV1 | undefined {
  if (!isObject(value)) {
    errors.push(`${at}: required object`)
    return
  }
  rejectUnknownKeys(value, PAYLOAD_REF_KEYS, at, errors)
  const sha256 = decodeString(value.sha256, `${at}.sha256`, errors, {
    pattern: HEX64_RE,
  })
  const maxBytes = options.maxBytes ?? HOST_EXTENSION_PACKAGE_LIMITS_V1.maxPayloadBytes
  if (
    typeof value.bytes !== "number" ||
    !Number.isInteger(value.bytes) ||
    value.bytes < 1 ||
    value.bytes > maxBytes
  )
    errors.push(`${at}.bytes: required integer in 1..${maxBytes}`)
  const mediaType = decodeString(value.mediaType, `${at}.mediaType`, errors, { max: 128 })
  if (mediaType && options.mediaType && mediaType !== options.mediaType)
    errors.push(`${at}.mediaType: expected "${options.mediaType}"`)
  const url = decodeHttpsUrl(value.url, `${at}.url`, errors)
  if (
    sha256 &&
    typeof value.bytes === "number" &&
    Number.isInteger(value.bytes) &&
    value.bytes >= 1 &&
    value.bytes <= maxBytes &&
    mediaType &&
    (!options.mediaType || mediaType === options.mediaType) &&
    url
  )
    return { sha256, bytes: value.bytes, mediaType, url }
}

/**
 * `#828`:skill 的载荷是一份**有界文件清单**,不再是一个 markdown 资产。
 *
 * 本层负责、且只负责下面四件**结构**事实(路径文法归 `promotePayloadToCas`,见
 * `SkillAssetFileV1` 的注释):
 *   ① 条数 1..`maxComponentAssetFiles`;
 *   ② `path` 两两不同 —— 重复路径会让「装完盘上是哪份字节」取决于写入顺序;
 *   ③ **恰好一条** `path === "SKILL.md"` —— 这条此前是 `buildSkillTxItems` 里那个硬编码
 *      **偶然**保证的;把它写成合同项,于是缺它时在**取任何字节之前**就被拒,而不是
 *      下载完、提升完 CAS、materialize 完之后才被 pre-switch probe 判不健康;
 *   ④ `sum(bytes) ≤ maxMarkdownAssetBytes` —— 该键自 `#828` 起是**组件资产总预算**
 *      (见 `registry.ts` 的字段注释)。只有一条文件时它与旧的单文件上限恒等 ⇒ 单文件语义未变。
 */
function decodeSkillPayload(value: unknown): PackageProfilePayloadDecodeV1 {
  const errors: string[] = []
  const behavior = decodePayloadRoot(
    value,
    "alpha.host-extension-package.payload.skill.v1",
    SKILL_BEHAVIOR_KEYS,
    errors,
  )
  if (!behavior) return { ok: false, errors }
  const targetDir = decodeString(behavior.targetDir, "payload.behavior.targetDir", errors, { max: 32 })
  if (targetDir && !["alpha-skills", "global"].includes(targetDir))
    errors.push("payload.behavior.targetDir: expected one of [alpha-skills, global]")
  const files = decodeSkillAssetFiles(behavior.files, "payload.behavior.files", errors)
  if (errors.length || !targetDir || !files) return { ok: false, errors }
  return {
    ok: true,
    payload: {
      schema: "alpha.host-extension-package.payload.skill.v1",
      behavior: { targetDir: targetDir as "alpha-skills" | "global", files },
    },
  }
}

function decodeSkillAssetFiles(
  value: unknown,
  at: string,
  errors: string[],
): SkillAssetFileV1[] | undefined {
  const max = HOST_EXTENSION_PACKAGE_LIMITS_V1.maxComponentAssetFiles
  if (!Array.isArray(value)) {
    errors.push(`${at}: required array`)
    return
  }
  if (value.length < 1) {
    errors.push(`${at}: required at least 1 file`)
    return
  }
  if (value.length > max) {
    errors.push(`${at}: ${value.length} files exceeds the host limit of ${max}`)
    return
  }
  const files: SkillAssetFileV1[] = []
  const seen = new Set<string>()
  let total = 0
  value.forEach((entry, index) => {
    const where = `${at}[${index}]`
    if (!isObject(entry)) {
      errors.push(`${where}: required object`)
      return
    }
    rejectUnknownKeys(entry, SKILL_ASSET_FILE_KEYS, where, errors)
    const path = decodeString(entry.path, `${where}.path`, errors, { max: 1024 })
    const sha256 = decodeString(entry.sha256, `${where}.sha256`, errors, { pattern: HEX64_RE })
    const perFileMax = HOST_EXTENSION_PACKAGE_LIMITS_V1.maxMarkdownAssetBytes
    // 下界是 **0**,这是一条决定,不是从单资产那边抄漏的:真实语料里
    // `claude-plugins-official/.../skills/skill-creator` 带一个 **0 字节的
    // `scripts/__init__.py`**(Python 包必需的空文件)。写 `>= 1` 会让这个真实技能的整个
    // payload 解不出来 ⇒ 整包 blocked —— 那不是"少拦一个坏输入",是**拒载真实配置**,
    // 也正是这张票要杀的"装完是残件"从另一扇门回来(发布端为了过闸只能把空文件丢掉)。
    // 同一个技能走 Phase 3 本地导入那条路今天装得上(`claude-plugin-intake.ts` 只求和、
    // 无 per-file 下界),两条路对同一份输入必须给同一个答案。
    // DoS 由**条数界**封住(空条目吃的是条数不是字节),不需要再拿下界当补偿。
    // 单资产的 `decodePayloadRef` 保持 `>= 1`:那里一份 SKILL.md 恒非空,合理。
    const bytesOk =
      typeof entry.bytes === "number" &&
      Number.isInteger(entry.bytes) &&
      entry.bytes >= 0 &&
      entry.bytes <= perFileMax
    if (!bytesOk) errors.push(`${where}.bytes: required integer in 0..${perFileMax}`)
    const url = decodeHttpsUrl(entry.url, `${where}.url`, errors)
    if (path !== undefined) {
      if (seen.has(path)) errors.push(`${where}.path: duplicate path "${path}" — refused`)
      seen.add(path)
    }
    if (bytesOk) total += entry.bytes as number
    if (path !== undefined && sha256 && bytesOk && url)
      files.push({ path, sha256, bytes: entry.bytes as number, url })
  })
  const budget = HOST_EXTENSION_PACKAGE_LIMITS_V1.maxMarkdownAssetBytes
  if (total > budget) errors.push(`${at}: declared bytes ${total} exceed the component budget ${budget}`)
  const entries = files.filter((file) => file.path === SKILL_MD_PATH).length
  if (entries !== 1) errors.push(`${at}: exactly one file must be "${SKILL_MD_PATH}" (found ${entries})`)
  if (errors.length) return
  return files
}

function decodeAgentPayload(value: unknown): PackageProfilePayloadDecodeV1 {
  const errors: string[] = []
  const behavior = decodePayloadRoot(
    value,
    "alpha.host-extension-package.payload.agent.v1",
    MARKDOWN_BEHAVIOR_KEYS,
    errors,
  )
  if (!behavior) return { ok: false, errors }
  const targetDir = decodeString(behavior.targetDir, "payload.behavior.targetDir", errors, { max: 32 })
  if (targetDir && !["alpha-agents", "global"].includes(targetDir))
    errors.push("payload.behavior.targetDir: expected one of [alpha-agents, global]")
  const asset = decodePayloadRef(behavior.asset, "payload.behavior.asset", errors, {
    maxBytes: HOST_EXTENSION_PACKAGE_LIMITS_V1.maxMarkdownAssetBytes,
    mediaType: "text/markdown",
  })
  if (errors.length || !targetDir || !asset) return { ok: false, errors }
  return {
    ok: true,
    payload: {
      schema: "alpha.host-extension-package.payload.agent.v1",
      behavior: { targetDir: targetDir as "alpha-agents" | "global", asset: asset as MarkdownAssetRefV1 },
    },
  }
}

function decodeMcpLocalPayload(value: unknown): PackageProfilePayloadDecodeV1 {
  const errors: string[] = []
  const behavior = decodePayloadRoot(
    value,
    "alpha.host-extension-package.payload.mcp-local.v1",
    MCP_LOCAL_BEHAVIOR_KEYS,
    errors,
  )
  if (!behavior) return { ok: false, errors }
  const command = decodeStringArray(behavior.command, "payload.behavior.command", errors, {
    min: 1,
    max: 16,
    itemMax: 512,
  })
  const environment = decodeStringRecord(
    behavior.environment,
    "payload.behavior.environment",
    ENV_NAME_RE,
    errors,
  )
  const requiredSecrets = decodeSortedStringArray(
    behavior.requiredSecrets,
    "payload.behavior.requiredSecrets",
    ENV_NAME_RE,
    errors,
  )
  if (errors.length || !environment) return { ok: false, errors }
  return {
    ok: true,
    payload: {
      schema: "alpha.host-extension-package.payload.mcp-local.v1",
      behavior: { command, environment, requiredSecrets },
    },
  }
}

function decodeMcpRemotePayload(value: unknown): PackageProfilePayloadDecodeV1 {
  const errors: string[] = []
  const behavior = decodePayloadRoot(
    value,
    "alpha.host-extension-package.payload.mcp-remote.v1",
    MCP_REMOTE_BEHAVIOR_KEYS,
    errors,
  )
  if (!behavior) return { ok: false, errors }
  const url = decodeHttpsUrl(behavior.url, "payload.behavior.url", errors)
  const headersTemplate = decodeStringRecord(
    behavior.headersTemplate,
    "payload.behavior.headersTemplate",
    HEADER_NAME_RE,
    errors,
  )
  const requiredSecrets = decodeSortedStringArray(
    behavior.requiredSecrets,
    "payload.behavior.requiredSecrets",
    ENV_NAME_RE,
    errors,
  )
  const auth = decodeMcpRemoteAuth(behavior.auth, errors)
  if (headersTemplate) checkMcpRemotePlaceholdersV1(headersTemplate, requiredSecrets, errors)
  if (auth && auth !== "none" && headersTemplate)
    checkMcpRemoteAuthInvariantsV1(auth, headersTemplate, requiredSecrets, errors)
  if (errors.length || !url || !headersTemplate || !auth) return { ok: false, errors }
  return {
    ok: true,
    payload: {
      schema: "alpha.host-extension-package.payload.mcp-remote.v1",
      behavior: { url, headersTemplate, requiredSecrets, auth },
    },
  }
}

function decodeMcpRemoteAuth(value: unknown, errors: string[]): McpRemoteAuthV1 | undefined {
  if (value === "none") return "none"
  if (!isObject(value)) {
    errors.push('payload.behavior.auth: required "none" or an authorization object')
    return
  }
  const kind = decodeString(value.kind, "payload.behavior.auth.kind", errors, { max: 32 })
  if (!kind) return
  if (kind !== "mcp-oauth" && kind !== "alpha-connection") {
    errors.push(`payload.behavior.auth.kind: expected one of [${MCP_REMOTE_AUTH_KINDS.join(", ")}]`)
    return
  }
  rejectUnknownKeys(
    value,
    kind === "mcp-oauth" ? MCP_OAUTH_AUTH_KEYS : ALPHA_CONNECTION_AUTH_KEYS,
    "payload.behavior.auth",
    errors,
  )
  const prerequisiteId = decodeString(
    value.prerequisiteId,
    "payload.behavior.auth.prerequisiteId",
    errors,
    { max: 64, pattern: PREREQUISITE_ID_RE },
  )
  if (typeof value.required !== "boolean")
    errors.push("payload.behavior.auth.required: required boolean")
  const hasLabel = Object.hasOwn(value, "label")
  const label = hasLabel
    ? decodeString(value.label, "payload.behavior.auth.label", errors, { max: 120 })
    : undefined
  if (!prerequisiteId || typeof value.required !== "boolean" || (hasLabel && !label)) return
  if (kind === "mcp-oauth")
    return { kind, prerequisiteId, required: value.required, ...(label ? { label } : {}) }
  const connectionHandlerId = decodeString(
    value.connectionHandlerId,
    "payload.behavior.auth.connectionHandlerId",
    errors,
    { max: 64, pattern: CONNECTION_HANDLER_RE },
  )
  if (!connectionHandlerId) return
  return {
    kind,
    prerequisiteId,
    required: value.required,
    connectionHandlerId,
    ...(label ? { label } : {}),
  }
}

/**
 * Invariant 4: every `{VAR}` placeholder in `headersTemplate` must be declared in
 * `requiredSecrets`, **for all three auth kinds alike** — an undeclared placeholder is a header the
 * host would ship with a literal `{VAR}` in it, and nobody would ever be asked for the value.
 *
 * This lives here and only here. Main used to restate it while projecting the secret prerequisite
 * profile, which is the `#737` class exactly: the host deciding what the contract's grammar means.
 * Declaring the rule here also subsumes the malformed-name case for free — `requiredSecrets` entries
 * are already `ENV_NAME_RE`, so `{lowercase}` cannot be declared and is therefore refused.
 */
function checkMcpRemotePlaceholdersV1(
  headersTemplate: Record<string, string>,
  requiredSecrets: string[],
  errors: string[],
): void {
  const declared = new Set(requiredSecrets)
  for (const [header, template] of Object.entries(headersTemplate))
    for (const match of template.matchAll(/\{([^{}]+)\}/g))
      if (!declared.has(match[1]!))
        errors.push(
          `payload.behavior.headersTemplate: "${header}" references undeclared secret placeholder "${match[1]!}"`,
        )
}

/**
 * Cross-field invariants the payload decoder owns outright. Main must not restate them: a rule
 * enforced in two places is a rule that drifts, and the second copy is always the one that forgets
 * a case.
 *
 * 1. `mcp-oauth` forbids an `Authorization` header template, case-insensitively. Token injection
 *    belongs to the engine's token store; a publisher shipping its own `Authorization` template is
 *    routing around it. HTTP header names are case-insensitive, so `authorization` is the same
 *    bypass spelled differently and must fail the same way.
 * 2. A component's prerequisites must stay distinguishable to the person approving them. The
 *    authorization prerequisite is compared against the secret prerequisites after folding case
 *    and `_`/`-`, because `A_KEY` and `a-key` render as the same row in the approval list even
 *    though they are different byte strings.
 *
 * Note what is deliberately *not* here: `auth !== "none"` does not exempt `requiredSecrets`. OAuth
 * plus an extra API key is a legitimate shape, and both prerequisites must be collected.
 */
function checkMcpRemoteAuthInvariantsV1(
  auth: Exclude<McpRemoteAuthV1, "none">,
  headersTemplate: Record<string, string>,
  requiredSecrets: string[],
  errors: string[],
): void {
  if (auth.kind === "mcp-oauth")
    Object.keys(headersTemplate)
      .filter((header) => header.toLowerCase() === "authorization")
      .forEach((header) =>
        errors.push(
          `payload.behavior.headersTemplate: "${header}" is refused when auth.kind is "mcp-oauth" — the engine owns token injection`,
        ),
      )
  const folded = foldPrerequisiteTokenV1(auth.prerequisiteId)
  requiredSecrets
    .filter((variable) => foldPrerequisiteTokenV1(variable) === folded)
    .forEach((variable) =>
      errors.push(
        `payload.behavior.auth.prerequisiteId: "${auth.prerequisiteId}" collides with requiredSecrets entry "${variable}" after case/separator folding`,
      ),
    )
}

function foldPrerequisiteTokenV1(token: string): string {
  return token.toLowerCase().replaceAll("_", "-")
}

function decodePayloadRoot(
  value: unknown,
  schema: string,
  behaviorKeys: Set<string>,
  errors: string[],
): Record<string, unknown> | undefined {
  if (!isObject(value)) {
    errors.push("payload: must be an object")
    return
  }
  rejectUnknownKeys(value, PAYLOAD_KEYS, "payload", errors)
  if (value.schema !== schema) errors.push(`payload.schema: expected "${schema}"`)
  if (!isObject(value.behavior)) {
    errors.push("payload.behavior: required object")
    return
  }
  rejectUnknownKeys(value.behavior, behaviorKeys, "payload.behavior", errors)
  return value.behavior
}

function decodeStringArray(
  value: unknown,
  at: string,
  errors: string[],
  options: { min: number; max: number; itemMax: number },
): string[] {
  if (!Array.isArray(value)) {
    errors.push(`${at}: required array`)
    return []
  }
  if (value.length < options.min || value.length > options.max)
    errors.push(`${at}: requires ${options.min}..${options.max} items`)
  return value.flatMap((item, index) => {
    const decoded = decodeString(item, `${at}[${index}]`, errors, { max: options.itemMax })
    return decoded ? [decoded] : []
  })
}

function decodeSortedStringArray(
  value: unknown,
  at: string,
  pattern: RegExp,
  errors: string[],
): string[] {
  const decoded = decodeStringArray(value, at, errors, {
    min: 0,
    max: 16,
    itemMax: 128,
  })
  decoded.forEach((item, index) => {
    if (!pattern.test(item)) errors.push(`${at}[${index}]: invalid name`)
  })
  if (decoded.some((item, index) => index > 0 && item <= decoded[index - 1]!))
    errors.push(`${at}: must be unique and byte-order sorted`)
  return decoded
}

function decodeStringRecord(
  value: unknown,
  at: string,
  keyPattern: RegExp,
  errors: string[],
): Record<string, string> | undefined {
  if (!isObject(value)) {
    errors.push(`${at}: required object`)
    return
  }
  const keys = Object.keys(value)
  if (keys.length > 32) errors.push(`${at}: exceeds 32 properties`)
  const decoded = Object.fromEntries(
    keys.flatMap((key) => {
      if (!keyPattern.test(key)) {
        errors.push(`${at}: invalid key "${key}"`)
        return []
      }
      const item = decodeString(value[key], `${at}.${key}`, errors, { max: 2048, allowEmpty: true })
      return item === undefined ? [] : [[key, item]]
    }),
  )
  return decoded
}

function decodeString(
  value: unknown,
  at: string,
  errors: string[],
  options: { max?: number; pattern?: RegExp; allowEmpty?: boolean } = {},
): string | undefined {
  if (typeof value !== "string" || (!options.allowEmpty && value.length === 0)) {
    errors.push(`${at}: required ${options.allowEmpty ? "" : "non-empty "}string`)
    return
  }
  if (options.max && value.length > options.max) {
    errors.push(`${at}: exceeds ${options.max} characters`)
    return
  }
  if (options.pattern && !options.pattern.test(value)) {
    errors.push(`${at}: invalid format`)
    return
  }
  return value
}

function decodeHttpsUrl(value: unknown, at: string, errors: string[]): string | undefined {
  const decoded = decodeString(value, at, errors, { max: 2048 })
  if (!decoded) return
  try {
    const url = new URL(decoded)
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.href !== decoded
    ) {
      errors.push(`${at}: required canonical HTTPS URL without credentials`)
      return
    }
  } catch {
    errors.push(`${at}: required canonical HTTPS URL without credentials`)
    return
  }
  return decoded
}

function parseJsonBytes(
  bytes: Uint8Array,
  at: string,
): { ok: true; value: unknown } | { ok: false; errors: string[] } {
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return { ok: false, errors: [`${at}: not valid UTF-8`] }
  }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false, errors: [`${at}: not valid JSON`] }
  }
}

function inspectStructure(
  value: unknown,
  at: string,
  maxDepth: number,
  maxNodes: number,
): string[] {
  const errors: string[] = []
  const state = { nodes: 0 }
  inspectValue(value, at, 1, maxDepth, maxNodes, state, errors)
  return errors
}

function inspectValue(
  value: unknown,
  at: string,
  depth: number,
  maxDepth: number,
  maxNodes: number,
  state: { nodes: number },
  errors: string[],
): void {
  state.nodes++
  if (state.nodes > maxNodes) {
    if (!errors.some((error) => error.includes("node limit")))
      errors.push(`${at}: node limit ${maxNodes} exceeded`)
    return
  }
  if (depth > maxDepth) {
    errors.push(`${at}: depth ${depth} exceeds ${maxDepth}`)
    return
  }
  if (typeof value === "string") {
    if (CONTROL_RE.test(value)) errors.push(`${at}: control characters not allowed`)
    if (TEXT_ENCODER.encode(value).byteLength > HOST_EXTENSION_PACKAGE_LIMITS_V1.maxStringBytes)
      errors.push(
        `${at}: string exceeds ${HOST_EXTENSION_PACKAGE_LIMITS_V1.maxStringBytes} UTF-8 bytes`,
      )
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      inspectValue(item, `${at}[${index}]`, depth + 1, maxDepth, maxNodes, state, errors),
    )
    return
  }
  if (!isObject(value)) return
  Object.keys(value).forEach((key) => {
    if (DANGEROUS_KEYS.has(key)) errors.push(`${at}: prototype-pollution key "${key}" refused`)
    if (CONTROL_RE.test(key)) errors.push(`${at}: control characters in property names not allowed`)
    if (TEXT_ENCODER.encode(key).byteLength > HOST_EXTENSION_PACKAGE_LIMITS_V1.maxStringBytes)
      errors.push(`${at}: property name exceeds ${HOST_EXTENSION_PACKAGE_LIMITS_V1.maxStringBytes} UTF-8 bytes`)
    inspectValue(value[key], `${at}.${key}`, depth + 1, maxDepth, maxNodes, state, errors)
  })
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  at: string,
  errors: string[],
): void {
  Object.keys(value).forEach((key) => {
    if (!allowed.has(key))
      errors.push(`${at}: unknown key "${key}" — refused (additionalProperties: false)`)
  })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
