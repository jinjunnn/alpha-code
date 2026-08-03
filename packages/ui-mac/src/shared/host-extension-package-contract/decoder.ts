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
 * The second asset shape, discriminated by `mediaType` exactly like the first one. Widening
 * `mediaType` to `string` instead would not have "added JavaScript support" — it would have deleted
 * the only thing that stops a producer from shipping bytes of one kind under the media type of
 * another, and left the host with two meanings for `text/markdown`.
 */
export type ScriptAssetRefV1 = {
  sha256: string
  bytes: number
  mediaType: "text/javascript"
  url: string
}

export type SkillPayloadV1 = {
  schema: "alpha.host-extension-package.payload.skill.v1"
  behavior: { targetDir: "alpha-skills" | "global"; asset: MarkdownAssetRefV1 }
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

/**
 * A managed OpenCode Plugin: one content-addressed JavaScript asset the engine will evaluate in its
 * own process. The payload carries no install target, no argv, and no environment — where the bytes
 * land and how the engine is pointed at them are host decisions, not producer declarations.
 */
export type OpencodePluginPayloadV1 = {
  schema: "alpha.host-extension-package.payload.opencode-plugin.v1"
  behavior: { asset: ScriptAssetRefV1 }
}

export type PackageProfilePayloadV1 =
  | SkillPayloadV1
  | AgentPayloadV1
  | McpLocalPayloadV1
  | McpRemotePayloadV1
  | OpencodePluginPayloadV1

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
const MARKDOWN_BEHAVIOR_KEYS = new Set(["targetDir", "asset"])
const OPENCODE_PLUGIN_BEHAVIOR_KEYS = new Set(["asset"])
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
 * `:` is legal here because the host capability vocabulary contains `engine:config` and
 * `engine:plugin` — the renderer's own long-standing spelling, promoted rather than renamed
 * (see `registry.ts`). This regex is a grammar/DoS bound, never the admission gate: whether a token
 * is honoured is decided solely by `isPackageCapabilityV1` registry membership, so widening the
 * character class by one byte does not widen what the host will accept. Keep it byte-identical to
 * `$defs/capabilities.items.pattern` in `alpha-package-envelope-v1.schema.json`; a producer that
 * passes the published schema and then fails this decoder is a contract that lies.
 */
const CAPABILITY_RE = /^[a-z][a-z0-9.:-]{0,95}$/
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
          : profileId === "opencode-plugin"
            ? decodeOpencodePluginPayload(parsed.value)
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
  // A managed plugin discloses both facts unconditionally, because both are unconditionally true:
  // the engine evaluates its JavaScript (`engine:plugin`) and the host has to write the engine's
  // config to point at it (`engine:config`). Deriving only the first would tell the user less than
  // the legacy sideload path already tells them for the identical effect.
  if (payload.schema === "alpha.host-extension-package.payload.opencode-plugin.v1")
    capabilities.push("engine:config", "engine:plugin")
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

function decodeSkillPayload(value: unknown): PackageProfilePayloadDecodeV1 {
  return decodeMarkdownPayload(value, "skill", ["alpha-skills", "global"])
}

function decodeAgentPayload(value: unknown): PackageProfilePayloadDecodeV1 {
  return decodeMarkdownPayload(value, "agent", ["alpha-agents", "global"])
}

function decodeMarkdownPayload(
  value: unknown,
  profileId: "skill" | "agent",
  targets: string[],
): PackageProfilePayloadDecodeV1 {
  const errors: string[] = []
  const behavior = decodePayloadRoot(
    value,
    `alpha.host-extension-package.payload.${profileId}.v1`,
    MARKDOWN_BEHAVIOR_KEYS,
    errors,
  )
  if (!behavior) return { ok: false, errors }
  const targetDir = decodeString(behavior.targetDir, "payload.behavior.targetDir", errors, { max: 32 })
  if (targetDir && !targets.includes(targetDir))
    errors.push(`payload.behavior.targetDir: expected one of [${targets.join(", ")}]`)
  const asset = decodePayloadRef(behavior.asset, "payload.behavior.asset", errors, {
    maxBytes: HOST_EXTENSION_PACKAGE_LIMITS_V1.maxMarkdownAssetBytes,
    mediaType: "text/markdown",
  })
  if (errors.length || !targetDir || !asset) return { ok: false, errors }
  if (profileId === "skill")
    return {
      ok: true,
      payload: {
        schema: "alpha.host-extension-package.payload.skill.v1",
        behavior: { targetDir: targetDir as "alpha-skills" | "global", asset: asset as MarkdownAssetRefV1 },
      },
    }
  return {
    ok: true,
    payload: {
      schema: "alpha.host-extension-package.payload.agent.v1",
      behavior: { targetDir: targetDir as "alpha-agents" | "global", asset: asset as MarkdownAssetRefV1 },
    },
  }
}

function decodeOpencodePluginPayload(value: unknown): PackageProfilePayloadDecodeV1 {
  const errors: string[] = []
  const behavior = decodePayloadRoot(
    value,
    "alpha.host-extension-package.payload.opencode-plugin.v1",
    OPENCODE_PLUGIN_BEHAVIOR_KEYS,
    errors,
  )
  if (!behavior) return { ok: false, errors }
  const asset = decodePayloadRef(behavior.asset, "payload.behavior.asset", errors, {
    maxBytes: HOST_EXTENSION_PACKAGE_LIMITS_V1.maxScriptAssetBytes,
    mediaType: "text/javascript",
  })
  if (errors.length || !asset) return { ok: false, errors }
  return {
    ok: true,
    payload: {
      schema: "alpha.host-extension-package.payload.opencode-plugin.v1",
      behavior: { asset: asset as ScriptAssetRefV1 },
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
