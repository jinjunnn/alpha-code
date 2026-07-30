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

export type AlphaPackageEnvelopeV1 = {
  schema: typeof HOST_EXTENSION_PACKAGE_SCHEMA_V1
  prelude: { packageId: string; version: string }
  presentation: { displayName: string; description: string }
  components: [
    {
      id: string
      required: boolean
      dependencies: []
      profileId: PackageProfileIdV1
      profileVersion: 1
      capabilities: PackageCapabilityV1[]
      payloadRef: PackagePayloadRefV1
    },
  ]
  capabilities: PackageCapabilityV1[]
}

export type MarkdownAssetRefV1 = {
  sha256: string
  bytes: number
  mediaType: "text/markdown"
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

export type McpRemotePayloadV1 = {
  schema: "alpha.host-extension-package.payload.mcp-remote.v1"
  behavior: {
    url: string
    headersTemplate: Record<string, string>
    requiredSecrets: string[]
    auth: "none"
  }
}

export type PackageProfilePayloadV1 =
  | SkillPayloadV1
  | AgentPayloadV1
  | McpLocalPayloadV1
  | McpRemotePayloadV1

export type PackageEnvelopeHeaderDecodeV1 =
  | {
      ok: true
      status: "accepted"
      envelope: AlphaPackageEnvelopeV1
      profile: PackageProfileRegistrationV1
    }
  | {
      ok: false
      status: "blocked" | "skipped"
      stage: "header" | "support"
      errors: string[]
    }

export type PackageProfilePayloadDecodeV1 =
  | { ok: true; payload: PackageProfilePayloadV1 }
  | { ok: false; errors: string[] }

const ENVELOPE_KEYS = new Set(["schema", "prelude", "presentation", "components", "capabilities"])
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
const MCP_LOCAL_BEHAVIOR_KEYS = new Set(["command", "environment", "requiredSecrets"])
const MCP_REMOTE_BEHAVIOR_KEYS = new Set(["url", "headersTemplate", "requiredSecrets", "auth"])

const PACKAGE_ID_RE = /^[a-z][a-z0-9-]{0,31}:[a-z0-9][a-z0-9._-]{0,127}$/
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/
const PROFILE_ID_RE = /^[a-z][a-z0-9-]{0,31}$/
const CAPABILITY_RE = /^[a-z][a-z0-9.-]{0,95}$/
const HEX64_RE = /^[0-9a-f]{64}$/
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,127}$/
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,128}$/
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
  return capabilities.sort()
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
  const component = decodeSingleComponent(value.components, errors)
  const capabilities = decodeCapabilities(value.capabilities, "envelope.capabilities", errors)
  if (
    component &&
    capabilities.join("\n") !== component.capabilities.join("\n")
  )
    errors.push(
      "envelope.capabilities: must equal the sorted union of component capabilities (Phase 1 has exactly one component)",
    )
  if (errors.length || !prelude || !presentation || !component)
    return { ok: false, status: "blocked", stage: "header", errors }

  const supportErrors: string[] = []
  const profile = findPackageProfileV1(component.profileId, component.profileVersion)
  if (!profile)
    supportErrors.push(
      `envelope.components[0]: unsupported profile ${component.profileId}@${component.profileVersion}`,
    )
  component.capabilities.forEach((capability) => {
    if (!isPackageCapabilityV1(capability))
      supportErrors.push(`envelope.components[0].capabilities: unsupported capability "${capability}"`)
  })
  if (profile && profile.mediaType !== component.payloadRef.mediaType)
    supportErrors.push(
      `envelope.components[0].payloadRef.mediaType: expected "${profile.mediaType}" for ${profile.profileId}@${profile.profileVersion}`,
    )
  if (supportErrors.length)
    return {
      ok: false,
      status: component.required ? "blocked" : "skipped",
      stage: "support",
      errors: supportErrors,
    }

  return {
    ok: true,
    status: "accepted",
    profile: profile!,
    envelope: {
      schema: HOST_EXTENSION_PACKAGE_SCHEMA_V1,
      prelude,
      presentation,
      components: [
        {
          ...component,
          profileId: component.profileId as PackageProfileIdV1,
          profileVersion: 1,
          capabilities: component.capabilities as PackageCapabilityV1[],
        },
      ],
      capabilities: capabilities as PackageCapabilityV1[],
    },
  }
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

type DecodedComponent = {
  id: string
  required: boolean
  dependencies: []
  profileId: string
  profileVersion: number
  capabilities: string[]
  payloadRef: PackagePayloadRefV1
}

function decodeSingleComponent(value: unknown, errors: string[]): DecodedComponent | undefined {
  if (!Array.isArray(value) || value.length !== 1) {
    errors.push("envelope.components: Phase 1 requires exactly one component")
    return
  }
  const component = value[0]
  if (!isObject(component)) {
    errors.push("envelope.components[0]: must be an object")
    return
  }
  rejectUnknownKeys(component, COMPONENT_KEYS, "envelope.components[0]", errors)
  const id = decodeString(component.id, "envelope.components[0].id", errors, {
    max: 160,
    pattern: PACKAGE_ID_RE,
  })
  if (typeof component.required !== "boolean")
    errors.push("envelope.components[0].required: required boolean")
  if (!Array.isArray(component.dependencies) || component.dependencies.length !== 0)
    errors.push("envelope.components[0].dependencies: Phase 1 requires an empty array")
  const profileId = decodeString(component.profileId, "envelope.components[0].profileId", errors, {
    max: 32,
    pattern: PROFILE_ID_RE,
  })
  if (
    typeof component.profileVersion !== "number" ||
    !Number.isInteger(component.profileVersion) ||
    component.profileVersion < 1 ||
    component.profileVersion > 2147483647
  )
    errors.push("envelope.components[0].profileVersion: required positive 32-bit integer")
  const capabilities = decodeCapabilities(
    component.capabilities,
    "envelope.components[0].capabilities",
    errors,
  )
  const payloadRef = decodePayloadRef(component.payloadRef, "envelope.components[0].payloadRef", errors)
  if (
    id &&
    typeof component.required === "boolean" &&
    Array.isArray(component.dependencies) &&
    component.dependencies.length === 0 &&
    profileId &&
    typeof component.profileVersion === "number" &&
    Number.isInteger(component.profileVersion) &&
    component.profileVersion >= 1 &&
    component.profileVersion <= 2147483647 &&
    payloadRef
  )
    return {
      id,
      required: component.required,
      dependencies: [],
      profileId,
      profileVersion: component.profileVersion,
      capabilities,
      payloadRef,
    }
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
    maxBytes: 5 * 1024 * 1024,
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
  const auth = decodeString(behavior.auth, "payload.behavior.auth", errors, { max: 32 })
  if (auth && auth !== "none") errors.push('payload.behavior.auth: expected "none"')
  if (errors.length || !url || !headersTemplate || !auth) return { ok: false, errors }
  return {
    ok: true,
    payload: {
      schema: "alpha.host-extension-package.payload.mcp-remote.v1",
      behavior: {
        url,
        headersTemplate,
        requiredSecrets,
        auth: auth as McpRemotePayloadV1["behavior"]["auth"],
      },
    },
  }
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
