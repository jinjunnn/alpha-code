// ExtensionManifestV2 — REQ-099 Phase 1 / ADR-028 §3. Versioned STRICT schema for extension
// packages: unknown top-level keys, unknown nested keys and unknown schema versions are LOUD
// errors (never silently ignored/dropped) — the mechanical gate that replaces the old
// "shallow shape check" catalog discipline (ADR-023 A/C schema-coordination clause).
//
// manifestDigest deliberately does NOT live inside the manifest (self-hash paradox): it is
// computed over the canonical JSON encoding and carried by descriptors / InstallRecordV2
// (ext-receipt-v2.ts) / future signed channel metadata (REQ-101).
//
// Pure module: no electron, no fs, no logging — bun:test exercises it directly (repo test
// discipline: no mock.module for electron/logging in new modules).

import { createHash } from "node:crypto"
import { decodeOwnershipDims, RUNTIME_SURFACES, type OwnershipDims, type RuntimeSurface } from "../shared/ext-ownership"
import { isExtensionName } from "../shared/extension-name"

export const MANIFEST_SCHEMA_VERSION = 2 as const

export type ManifestKind = "skill" | "agent" | "mcp" | "plugin" | "bundle" | "cloud"
export type ManifestPlatform = "darwin" | "win32" | "linux"
// 五维 ownership 的值域真源在 shared/ext-ownership.ts(REQ-103 slice 1);此处 re-export 保持既有导出面。
export type { RuntimeSurface, SupportTier, DistributionChannel } from "../shared/ext-ownership"

/** capability 枚举白名单 —— 名单之外即「越权 capability」,解码期拒绝(AC#1)。
 *  真源上移 shared/ext-capability-authorization(#396:与 renderer 派生共用);此处 re-export
 *  保持既有导出面(ownership 值域 re-export 同款先例)。 */
import { MANIFEST_CAPABILITIES } from "../shared/ext-capability-authorization"
export { MANIFEST_CAPABILITIES }
export type { ManifestCapability } from "../shared/ext-capability-authorization"
import type { ManifestCapability } from "../shared/ext-capability-authorization"

export interface ManifestArtifact {
  /** `sha256:<64 hex>` — 机械格式校验,非法 digest 解码期拒绝。 */
  digest: string
  size: number
  mediaType: string
}

export interface ManifestComponent {
  name: string
  /** 运行位置逐组件声明,数组而非单值(REQ-099 交付②)。 */
  runsIn: RuntimeSurface[]
}

export interface ManifestDependency {
  id: string
  version?: string
  optional?: boolean
}

/** 五维 ownership + support tier(REQ-099 交付①;curated ≠ authored,不得混标)。 */
export type ManifestOwnership = OwnershipDims

export interface ExtensionManifestV2 {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION
  id: string
  name: string
  kind: ManifestKind
  version: string
  compatibility: { platforms: ManifestPlatform[] }
  capabilities: ManifestCapability[]
  dependencies: ManifestDependency[]
  ownership: ManifestOwnership
  components: ManifestComponent[]
  /** 有可寻址字节负载时必填其 digest/size/mediaType;config-only(npm/mcp/cloud)可缺省。 */
  artifact?: ManifestArtifact
}

export type ManifestDecode = { ok: true; manifest: ExtensionManifestV2 } | { ok: false; errors: string[] }

const KINDS = new Set<string>(["skill", "agent", "mcp", "plugin", "bundle", "cloud"])
const PLATFORMS = new Set<string>(["darwin", "win32", "linux"])
// 值域集合从 shared 枚举派生 —— 与 UI/推导层永远同一份(REQ-103 slice 1)。
const SURFACES = new Set<string>(RUNTIME_SURFACES)
const CAPS = new Set<string>(MANIFEST_CAPABILITIES)

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1f\x7f]/

const TOP_KEYS = new Set([
  "schemaVersion",
  "id",
  "name",
  "kind",
  "version",
  "compatibility",
  "capabilities",
  "dependencies",
  "ownership",
  "components",
  "artifact",
])
const ARTIFACT_KEYS = new Set(["digest", "size", "mediaType"])
const COMPAT_KEYS = new Set(["platforms"])
const COMPONENT_KEYS = new Set(["name", "runsIn"])
const DEPENDENCY_KEYS = new Set(["id", "version", "optional"])

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function rejectUnknownKeys(obj: Record<string, unknown>, allowed: Set<string>, at: string, errors: string[]): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) errors.push(`${at}: unknown key "${key}" — refused (strict schema, never silently dropped)`)
  }
}

function decodeString(v: unknown, at: string, errors: string[], opts?: { max?: number; re?: RegExp; reMsg?: string }): string | undefined {
  if (typeof v !== "string" || v.length === 0) {
    errors.push(`${at}: required non-empty string`)
    return undefined
  }
  if (CONTROL_RE.test(v)) {
    errors.push(`${at}: control characters not allowed`)
    return undefined
  }
  if (opts?.max && v.length > opts.max) {
    errors.push(`${at}: exceeds ${opts.max} chars`)
    return undefined
  }
  if (opts?.re && !opts.re.test(v)) {
    errors.push(`${at}: ${opts.reMsg ?? `must match ${opts.re}`}`)
    return undefined
  }
  return v
}

function decodeEnumArray(v: unknown, allowed: Set<string>, at: string, errors: string[], opts?: { nonEmpty?: boolean }): string[] {
  if (!Array.isArray(v)) {
    errors.push(`${at}: required array`)
    return []
  }
  if (opts?.nonEmpty && v.length === 0) errors.push(`${at}: must not be empty`)
  const out: string[] = []
  const seen = new Set<string>()
  for (let i = 0; i < v.length; i++) {
    const item = v[i]
    if (typeof item !== "string" || !allowed.has(item)) {
      errors.push(`${at}[${i}]: "${String(item)}" not in allowlist [${[...allowed].join(", ")}]`)
      continue
    }
    if (seen.has(item)) {
      errors.push(`${at}[${i}]: duplicate "${item}"`)
      continue
    }
    seen.add(item)
    out.push(item)
  }
  return out
}

/**
 * STRICT decoder — collects every violation with a locatable path (AC#1: missing fields, unknown
 * top-level keys, illegal digests, out-of-allowlist capabilities all rejected BEFORE any disk I/O;
 * callers must not touch disk unless this returns ok).
 */
export function decodeManifestV2(input: unknown): ManifestDecode {
  const errors: string[] = []
  if (!isObj(input)) return { ok: false, errors: ["manifest: must be an object"] }

  // Version gate FIRST — a different schemaVersion is a distinct loud error, never best-effort parsed.
  const version = input.schemaVersion
  if (version !== MANIFEST_SCHEMA_VERSION) {
    return {
      ok: false,
      errors: [
        `manifest.schemaVersion: unsupported version ${JSON.stringify(version)} — this build only decodes schemaVersion ${MANIFEST_SCHEMA_VERSION} (refusing to guess)`,
      ],
    }
  }

  rejectUnknownKeys(input, TOP_KEYS, "manifest", errors)

  const id = decodeString(input.id, "manifest.id", errors, { max: 200 })
  const name = decodeString(input.name, "manifest.name", errors, { max: 64 })
  if (name !== undefined && !isExtensionName(name))
    errors.push("manifest.name: must be 1-64 chars of [a-zA-Z0-9._-] starting alphanumeric")
  const kindStr = decodeString(input.kind, "manifest.kind", errors)
  if (kindStr !== undefined && !KINDS.has(kindStr)) errors.push(`manifest.kind: "${kindStr}" not a known kind`)
  const versionStr = decodeString(input.version, "manifest.version", errors, { max: 64 })

  // compatibility
  let platforms: string[] = []
  if (!isObj(input.compatibility)) {
    errors.push("manifest.compatibility: required object")
  } else {
    rejectUnknownKeys(input.compatibility, COMPAT_KEYS, "manifest.compatibility", errors)
    platforms = decodeEnumArray(input.compatibility.platforms, PLATFORMS, "manifest.compatibility.platforms", errors, { nonEmpty: true })
  }

  const capabilities = decodeEnumArray(input.capabilities, CAPS, "manifest.capabilities", errors)

  // dependencies
  const dependencies: ManifestDependency[] = []
  if (!Array.isArray(input.dependencies)) {
    errors.push("manifest.dependencies: required array")
  } else {
    const seen = new Set<string>()
    input.dependencies.forEach((dep, i) => {
      if (!isObj(dep)) {
        errors.push(`manifest.dependencies[${i}]: must be an object`)
        return
      }
      rejectUnknownKeys(dep, DEPENDENCY_KEYS, `manifest.dependencies[${i}]`, errors)
      const depId = decodeString(dep.id, `manifest.dependencies[${i}].id`, errors, { max: 200 })
      if (dep.version !== undefined && typeof dep.version !== "string") errors.push(`manifest.dependencies[${i}].version: must be a string`)
      if (dep.optional !== undefined && typeof dep.optional !== "boolean") errors.push(`manifest.dependencies[${i}].optional: must be a boolean`)
      if (depId) {
        if (depId === id) errors.push(`manifest.dependencies[${i}]: self-dependency "${depId}" (trivial cycle)`)
        if (seen.has(depId)) errors.push(`manifest.dependencies[${i}]: duplicate dependency "${depId}"`)
        seen.add(depId)
        dependencies.push({ id: depId, ...(typeof dep.version === "string" ? { version: dep.version } : {}), ...(typeof dep.optional === "boolean" ? { optional: dep.optional } : {}) })
      }
    })
  }

  // ownership(五维)—— 严格解码委托 shared 真源(REQ-103 slice 1;同一套值域与校验)。
  let ownership: ManifestOwnership | undefined
  {
    const decoded = decodeOwnershipDims(input.ownership, "manifest.ownership")
    if (decoded.ok) ownership = decoded.dims
    else errors.push(...decoded.errors)
  }

  // components(逐组件 runsIn)
  const components: ManifestComponent[] = []
  if (!Array.isArray(input.components)) {
    errors.push("manifest.components: required array")
  } else {
    if (input.components.length === 0) errors.push("manifest.components: must declare at least one component")
    input.components.forEach((comp, i) => {
      if (!isObj(comp)) {
        errors.push(`manifest.components[${i}]: must be an object`)
        return
      }
      rejectUnknownKeys(comp, COMPONENT_KEYS, `manifest.components[${i}]`, errors)
      const compName = decodeString(comp.name, `manifest.components[${i}].name`, errors, { max: 128 })
      const runsIn = decodeEnumArray(comp.runsIn, SURFACES, `manifest.components[${i}].runsIn`, errors, { nonEmpty: true })
      if (compName) components.push({ name: compName, runsIn: runsIn as RuntimeSurface[] })
    })
  }

  // artifact(可选;出现即严格)
  let artifact: ManifestArtifact | undefined
  if (input.artifact !== undefined) {
    if (!isObj(input.artifact)) {
      errors.push("manifest.artifact: must be an object")
    } else {
      rejectUnknownKeys(input.artifact, ARTIFACT_KEYS, "manifest.artifact", errors)
      const digest = decodeString(input.artifact.digest, "manifest.artifact.digest", errors, {
        re: DIGEST_RE,
        reMsg: 'must be "sha256:<64 lowercase hex>"',
      })
      const size = input.artifact.size
      if (typeof size !== "number" || !Number.isInteger(size) || size < 0) errors.push("manifest.artifact.size: must be a non-negative integer")
      const mediaType = decodeString(input.artifact.mediaType, "manifest.artifact.mediaType", errors, { max: 128 })
      if (digest && typeof size === "number" && Number.isInteger(size) && size >= 0 && mediaType) {
        artifact = { digest, size, mediaType }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    manifest: {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      id: id!,
      name: name!,
      kind: kindStr as ManifestKind,
      version: versionStr!,
      compatibility: { platforms: platforms as ManifestPlatform[] },
      capabilities: capabilities as ManifestCapability[],
      dependencies,
      ownership: ownership!,
      components,
      ...(artifact ? { artifact } : {}),
    },
  }
}

// ── canonical JSON + digest ─────────────────────────────────────────────────────────────────────

/** Deterministic JSON: object keys sorted recursively — digest 不受序列化键序影响。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex")
}

/** manifestDigest = sha256 of canonical JSON;落 descriptor/receipt,不进 manifest 本体(ADR-028 §3)。 */
export function computeManifestDigest(manifest: ExtensionManifestV2): string {
  return `sha256:${sha256Hex(canonicalJson(manifest))}`
}

/** 文件清单的聚合 payload digest(路径+sha256 排序聚合为单一可比对值)。信任语义随输入来源:
 *  remote = 已验 catalog 清单(逐文件 sha256 由下载层钉死);builtin = 摄取时自算内容地址
 *  (REQ-098 #303,一致性标识而非上游真实性证明)。 */
export function aggregateFilesDigest(files: Array<{ path: string; sha256: string }>): string {
  const lines = files
    .map((f) => `${f.path}\u0000${f.sha256}`)
    .sort()
    .join("\n")
  return `sha256:${sha256Hex(lines)}`
}

// ── dependency cycle detection(计划期,AC#1「循环依赖拒绝」)──────────────────────────────────

export type DependencyNode = { id: string; deps: string[] }

/** 返回一条循环路径(如 ["a","b","a"]),无环返回 null。缺失节点(依赖指向不存在的 id)不算环 —— 由调用方另行拒绝。 */
export function findDependencyCycle(nodes: DependencyNode[]): string[] | null {
  const graph = new Map(nodes.map((n) => [n.id, n.deps]))
  const visiting = new Set<string>()
  const done = new Set<string>()
  const stack: string[] = []
  const visit = (id: string): string[] | null => {
    if (done.has(id)) return null
    if (visiting.has(id)) return [...stack.slice(stack.indexOf(id)), id]
    if (!graph.has(id)) return null
    visiting.add(id)
    stack.push(id)
    for (const dep of graph.get(id)!) {
      const cycle = visit(dep)
      if (cycle) return cycle
    }
    stack.pop()
    visiting.delete(id)
    done.add(id)
    return null
  }
  for (const n of nodes) {
    const cycle = visit(n.id)
    if (cycle) return cycle
  }
  return null
}
