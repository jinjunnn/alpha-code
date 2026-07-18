// catalog-curation(shared)— REQ-104 #397:签名目录 `curation` 对象的**消费端契约执行器**。
// 合同 = alpha-web contracts/catalog-intake/CONTRACT.md §3/§4/§5/§7(规范性)。本模块是
// alpha-web scripts/lib/catalog-intake-core.mjs(执行器)+ catalog-channels-core.mjs
// validateSchemaLite(结构面)的 TS 等价移植:错误文案逐字对齐,由 vendored testvectors
// (src/shared/catalog-intake-contract/,45 文件,alpha-web@5c9a29c)钉死防漂移。
//
// 消费端裁决面(§7.1,唯一入口 = decodeEntryCuration,禁止旁路直读 entry.curation):
//   · 无 `curation` 键 → uncurated(未策展,不是错误;走 #395 保守规则)
//   · 存在但未知 schema / 未知键 / 结构或跨字段不变量失败 → invalid(fail-closed:
//     整体不采信 + 如实上报,绝不部分采信)
//   · 全过 → curated(采信,§7.2 决策表生效)
// 签名 / advisory / 撤销面零改动:解码只发生在已验签 payload 之后;advisory 永远赢(§1)。
// 纯模块:无 node 依赖(TextEncoder/TextDecoder),main 与 renderer 共用同一真源。

import curationSchemaJson from "./catalog-intake-contract/curation.v1.schema.json"
import provenanceSchemaJson from "./catalog-intake-contract/intake-provenance.v1.schema.json"

export const CURATION_SCHEMA_ID = "alpha.catalog.curation.v1"
export const INTAKE_PROVENANCE_SCHEMA_ID = "alpha.intake-provenance.v1"

/** 保留命名空间(合同 §2):策展 blob 专用;不进 remoteAsset/seed。 */
export const CURATION_ASSET_NAMESPACE = "alpha-curation"

/** 与发布端 BASE_URL 同源;blob URL 必须由此推导,禁止来自任何运行时输入(合同 §6)。 */
export const CATALOG_BASE_URL = "https://alphacodeone.com/catalog"

/** blob 单文件上限(5 MiB;消费端采信前置之一,合同 §7.3)。 */
export const MAX_CURATION_BLOB_BYTES = 5 * 1024 * 1024

export const CURATION_TIERS = ["core", "precache", "connector", "labs"] as const
export const ACTIVATION_POLICIES = ["default-enabled", "default-disabled", "session-grant"] as const
export const DELIVERY_MODES = ["installable", "connection-only", "aggregate"] as const

export type CurationTier = (typeof CURATION_TIERS)[number]
export type ActivationPolicy = (typeof ACTIVATION_POLICIES)[number]
export type DeliveryMode = (typeof DELIVERY_MODES)[number]

/** 合同 §5 canonical entry id / version(与 alpha-web catalog-channels-core ENTRY_ID_RE/VERSION_RE 逐字一致)。 */
export const CURATION_ENTRY_ID_RE = /^(mcp|skill|plugin|bundle|agent|cloud):[a-z0-9][a-z0-9-]*$/
export const CURATION_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/

export type CurationBlobKind = "sbom" | "intakeProvenance"

export interface CurationBlobRef {
  sha256: string
  bytes: number
  url: string
  format: string
}

export interface Curation {
  schema: typeof CURATION_SCHEMA_ID
  tier: CurationTier
  activationPolicy: ActivationPolicy
  deliveryMode: DeliveryMode
  review: {
    reviewedAt: string
    reviewedBy: string
    upstreamStatus: "active" | "archived" | "unmaintained" | "unknown"
    supportTier: "full" | "best-effort" | "community" | "none"
    reviewBefore: string
  }
  applicability: { frameworks: string[] }
  summaries: {
    capabilities: string[]
    networkDomains: string[]
    requiredSecrets: { name: string; source: "environment" | "connection" }[]
    runtimeDependencies: string[]
    download: { bytes: number | null; basis: "catalog-assets" | "locked-packages" | "aggregate" | "none" | "unknown" }
  }
  refs: { sbom: CurationBlobRef; intakeProvenance: CurationBlobRef }
}

// ---------------------------------------------------------------------------
// UTF-8 字节序与 canonical 基元(合同「字节序排序」唯一定义;默认 sort 是 UTF-16 码元序)
// ---------------------------------------------------------------------------

const TE = new TextEncoder()

export function utf8Compare(a: string, b: string): number {
  const ba = TE.encode(a)
  const bb = TE.encode(b)
  const n = Math.min(ba.length, bb.length)
  for (let i = 0; i < n; i++) if (ba[i] !== bb[i]) return ba[i]! < bb[i]! ? -1 : 1
  return ba.length === bb.length ? 0 : ba.length < bb.length ? -1 : 1
}

const isSortedUnique = <T,>(arr: T[], keyOf: (x: T) => string): boolean => {
  for (let i = 1; i < arr.length; i++) if (utf8Compare(keyOf(arr[i - 1]!), keyOf(arr[i]!)) >= 0) return false
  return true
}

function assertSortedUnique<T>(arr: T[], what: string, keyOf: (x: T) => string = (x) => x as unknown as string): void {
  if (!isSortedUnique(arr, keyOf)) throw new Error(`${what} must be unique and byte-order sorted`)
}

function assertWildcardExclusive(arr: string[], what: string): void {
  if (arr.includes("*") && arr.length !== 1) throw new Error(`${what}: "*" must be the only element when present`)
}

/** 严格 UTC 日历校验(合同 §3):纯分量核对,不经 Date/Date.UTC(后者容忍日溢出/重映射 0..99 年)。 */
export function assertCanonicalUtc(value: string, what: string): void {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(value)
  if (!m) throw new Error(`${what} must be canonical UTC "YYYY-MM-DDThh:mm:ssZ", got "${value}"`)
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number]
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  const real = mo >= 1 && mo <= 12 && d >= 1 && d <= monthDays[mo - 1]! && h < 24 && mi < 60 && s < 60
  if (!real) throw new Error(`${what} is not a real calendar date-time: "${value}"`)
}

// ---------------------------------------------------------------------------
// blob 路径 / URL 推导(合同 §2/§6:固定 base + (idDot, version, kind, digest);id/version
// 先过严格 schema 再插值 —— 穿越/注入形态进不了 URL)
// ---------------------------------------------------------------------------

const BLOB_KINDS: Record<CurationBlobKind, { dir: string; ext: string; format: string }> = {
  sbom: { dir: "sbom", ext: ".cdx.json", format: "cyclonedx-1.6+json" },
  intakeProvenance: { dir: "intake-provenance", ext: ".json", format: INTAKE_PROVENANCE_SCHEMA_ID + "+json" },
}

const entryDirName = (id: string): string => id.replace(/:/g, ".")

export function curationBlobRelPath(kind: CurationBlobKind, sha256: string): string {
  const spec = BLOB_KINDS[kind]
  if (!spec) throw new Error(`unknown curation blob kind: ${kind}`)
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`curation blob sha256 must be 64 lowercase hex, got: ${sha256}`)
  return `${CURATION_ASSET_NAMESPACE}/${spec.dir}/${sha256}${spec.ext}`
}

export function curationBlobUrl(catalogId: string, version: string, kind: CurationBlobKind, sha256: string): string {
  if (!CURATION_ENTRY_ID_RE.test(catalogId)) throw new Error(`curationBlobUrl: invalid catalogId "${catalogId}"`)
  if (!CURATION_VERSION_RE.test(String(version))) throw new Error(`curationBlobUrl: invalid version "${version}"`)
  return `${CATALOG_BASE_URL}/assets/${entryDirName(catalogId)}/${version}/${curationBlobRelPath(kind, sha256)}`
}

// ---------------------------------------------------------------------------
// schema-lite(alpha-web catalog-channels-core.mjs validateSchemaLite 的逐字 TS 移植:
// 结构面合同的执行器;支持 type/const/enum/pattern/format(date-time)/required/properties/
// additionalProperties(false)/items/minItems/minimum/minLength/maxLength)
// ---------------------------------------------------------------------------

type SchemaLite = {
  type?: string
  const?: unknown
  enum?: unknown[]
  pattern?: string
  format?: string
  required?: string[]
  properties?: Record<string, SchemaLite>
  additionalProperties?: boolean
  items?: SchemaLite
  minItems?: number
  minimum?: number
  minLength?: number
  maxLength?: number
}

export function validateSchemaLite(doc: unknown, schema: SchemaLite, at = "$"): string[] {
  const errs: string[] = []
  const typeOf = (v: unknown): string =>
    Array.isArray(v) ? "array" : v === null ? "null" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v
  const walk = (val: unknown, sch: SchemaLite, p: string): void => {
    if (sch.const !== undefined && val !== sch.const) {
      errs.push(`${p}: expected const ${JSON.stringify(sch.const)}, got ${JSON.stringify(val)}`)
      return
    }
    if (sch.enum && !sch.enum.includes(val)) {
      errs.push(`${p}: ${JSON.stringify(val)} not in enum ${JSON.stringify(sch.enum)}`)
      return
    }
    if (sch.type) {
      const t = typeOf(val)
      const ok = sch.type === "number" ? t === "number" || t === "integer" : t === sch.type
      if (!ok) {
        errs.push(`${p}: expected type ${sch.type}, got ${t}`)
        return
      }
    }
    if (typeof val === "string") {
      if (sch.pattern && !new RegExp(sch.pattern).test(val)) errs.push(`${p}: "${val}" fails pattern ${sch.pattern}`)
      if (sch.format === "date-time" && (!/^\d{4}-\d{2}-\d{2}T/.test(val) || Number.isNaN(Date.parse(val))))
        errs.push(`${p}: "${val}" is not a valid date-time`)
      if (sch.minLength !== undefined && val.length < sch.minLength) errs.push(`${p}: shorter than minLength ${sch.minLength}`)
      if (sch.maxLength !== undefined && val.length > sch.maxLength) errs.push(`${p}: longer than maxLength ${sch.maxLength}`)
    }
    if (typeof val === "number" && sch.minimum !== undefined && val < sch.minimum) errs.push(`${p}: ${val} < minimum ${sch.minimum}`)
    if (Array.isArray(val)) {
      if (sch.minItems !== undefined && val.length < sch.minItems) errs.push(`${p}: fewer than minItems ${sch.minItems}`)
      if (sch.items) val.forEach((item, i) => walk(item, sch.items!, `${p}[${i}]`))
    }
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const rec = val as Record<string, unknown>
      for (const req of sch.required ?? []) if (!(req in rec)) errs.push(`${p}: missing required "${req}"`)
      for (const [k, v] of Object.entries(rec)) {
        const sub = sch.properties?.[k]
        if (sub) walk(v, sub, `${p}.${k}`)
        else if (sch.additionalProperties === false) errs.push(`${p}: unknown property "${k}" (additionalProperties: false)`)
      }
    }
  }
  walk(doc, schema, at)
  return errs
}

const CURATION_SCHEMA = curationSchemaJson as SchemaLite
const PROVENANCE_SCHEMA = provenanceSchemaJson as SchemaLite

// ---------------------------------------------------------------------------
// 跨字段不变量(合同 §3;catalog-intake-core.mjs assertCurationCoherent 的逐字移植)
// ---------------------------------------------------------------------------

export type CurationCtx = { catalogId: string; version: string; entryType: string; hasPayloadAssets: boolean }

function requireCtx(ctx: Partial<CurationCtx> | undefined, keys: (keyof CurationCtx)[], fn: string): void {
  for (const k of keys)
    if (ctx?.[k] === undefined) throw new Error(`${fn}: ctx.${k} is required (bindings must never be silently skipped)`)
}

function assertBlobRefBound(ref: CurationBlobRef, ctx: CurationCtx, kind: CurationBlobKind, what: string): void {
  const spec = BLOB_KINDS[kind]
  if (ref.format !== spec.format) throw new Error(`${what}.format must be "${spec.format}", got "${ref.format}"`)
  if (!Number.isInteger(ref.bytes) || ref.bytes < 1 || ref.bytes > MAX_CURATION_BLOB_BYTES)
    throw new Error(`${what}.bytes must be an integer in 1..${MAX_CURATION_BLOB_BYTES}, got ${ref.bytes}`)
  const expected = curationBlobUrl(ctx.catalogId, ctx.version, kind, ref.sha256)
  if (ref.url !== expected) throw new Error(`${what}.url must be exactly "${expected}", got "${ref.url}"`)
}

/** 跨字段不变量执行器(schema 结构面之外的另一半契约;ctx 四项全部必给)。 */
export function assertCurationCoherent(curation: Curation, ctx: CurationCtx): void {
  requireCtx(ctx, ["catalogId", "version", "entryType", "hasPayloadAssets"], "assertCurationCoherent")
  if (typeof ctx.hasPayloadAssets !== "boolean")
    throw new Error(`assertCurationCoherent: ctx.hasPayloadAssets must be boolean, got ${JSON.stringify(ctx.hasPayloadAssets)}`)

  if (curation.tier === "labs" && curation.activationPolicy !== "session-grant")
    throw new Error(`tier "labs" requires activationPolicy "session-grant", got "${curation.activationPolicy}"`)
  if (curation.activationPolicy === "default-enabled" && curation.tier !== "core")
    throw new Error(`activationPolicy "default-enabled" is only allowed on tier "core", got tier "${curation.tier}"`)

  const dl = curation.summaries.download
  if (curation.deliveryMode === "connection-only") {
    if (!(dl.bytes === 0 && dl.basis === "none"))
      throw new Error(`deliveryMode "connection-only" requires download {bytes:0, basis:"none"}`)
    if (ctx.hasPayloadAssets === true)
      throw new Error(`deliveryMode "connection-only" forbids payload assets on the entry (connection description only)`)
    for (const s of curation.summaries.requiredSecrets)
      if (s.source !== "connection")
        throw new Error(`deliveryMode "connection-only" requires all requiredSecrets to have source "connection", got "${s.name}" with source "${s.source}"`)
  }
  if ((dl.bytes === null) !== (dl.basis === "unknown"))
    throw new Error(`download.bytes null <=> download.basis "unknown" (got bytes=${dl.bytes}, basis="${dl.basis}")`)
  if (dl.bytes !== null && (!Number.isInteger(dl.bytes) || dl.bytes < 0))
    throw new Error(`download.bytes must be null or an integer >= 0, got ${JSON.stringify(dl.bytes)}`)

  if ((curation.deliveryMode === "aggregate") !== (ctx.entryType === "bundle"))
    throw new Error(`deliveryMode "aggregate" <=> entry type "bundle" (got deliveryMode="${curation.deliveryMode}", type="${ctx.entryType}")`)

  assertCanonicalUtc(curation.review.reviewedAt, "review.reviewedAt")
  assertCanonicalUtc(curation.review.reviewBefore, "review.reviewBefore")
  if (!(curation.review.reviewBefore > curation.review.reviewedAt)) throw new Error(`review.reviewBefore must be after review.reviewedAt`)

  assertSortedUnique(curation.applicability.frameworks, "applicability.frameworks")
  assertWildcardExclusive(curation.applicability.frameworks, "applicability.frameworks")
  assertSortedUnique(curation.summaries.capabilities, "summaries.capabilities")
  assertSortedUnique(curation.summaries.networkDomains, "summaries.networkDomains")
  assertWildcardExclusive(curation.summaries.networkDomains, "summaries.networkDomains")
  assertSortedUnique(curation.summaries.runtimeDependencies, "summaries.runtimeDependencies")
  assertSortedUnique(curation.summaries.requiredSecrets, "summaries.requiredSecrets", (s) => s.name)

  assertBlobRefBound(curation.refs.sbom, ctx, "sbom", "refs.sbom")
  assertBlobRefBound(curation.refs.intakeProvenance, ctx, "intakeProvenance", "refs.intakeProvenance")
}

/** 完整契约检查(供给侧 tests/catalog-intake-contract.test.mjs checkCuration 同构):
 *  schema 结构面 + 跨字段不变量;返回全部错误文本("" = 通过)。 */
export function checkCurationContract(curation: unknown, ctx: CurationCtx): string {
  const errs = validateSchemaLite(curation, CURATION_SCHEMA)
  if (errs.length) return errs.join("\n")
  try {
    assertCurationCoherent(curation as Curation, ctx)
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
  return ""
}

// ---------------------------------------------------------------------------
// intake provenance(合同 §5;assertProvenanceCoherent + per-kind canonical 语法移植)
// ---------------------------------------------------------------------------

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

function isCanonicalHostPath(rest: string): boolean {
  const slash = rest.indexOf("/")
  if (slash <= 0) return false
  const host = rest.slice(0, slash)
  if (!HOST_RE.test(host)) return false
  const segs = rest.slice(slash + 1).split("/")
  return segs.length > 0 && segs.every((s) => /^[A-Za-z0-9._-]+$/.test(s) && s !== "." && s !== "..")
}

/** npm integrity:sha512 = 64 字节 ⇒ base64 恰 86 字符 + "=="(定长,拒截断/坏填充)。 */
const NPM_INTEGRITY_RE = /^sha512:[A-Za-z0-9+/]{86}==$/

/** base64 解码字节长(纯 JS,无 Buffer):86 字符 + "==" 恒 64 字节,仍按 mjs 语义显式核对。 */
function base64ByteLength(b64: string): number {
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0
  return (b64.length * 3) / 4 - padding
}

type SourceGrammar = { locator: (l: string) => boolean; resolved: (r: string) => boolean; resolvedHint: string }

const PROV_SOURCE_GRAMMAR: Record<string, SourceGrammar> = {
  git: {
    locator: (l) => l.startsWith("git+https://") && isCanonicalHostPath(l.slice("git+https://".length)),
    resolved: (r) => /^([a-f0-9]{40}|[a-f0-9]{64})$/.test(r),
    resolvedHint: "a 40/64-hex commit digest",
  },
  npm: {
    locator: (l) => /^npm:(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(l),
    resolved: (r) => NPM_INTEGRITY_RE.test(r) && base64ByteLength(r.slice(7)) === 64,
    resolvedHint: 'an "sha512:<86-char base64>==" integrity digest (64 bytes)',
  },
  pypi: {
    locator: (l) => /^pypi:[a-z0-9][a-z0-9._-]*$/.test(l),
    resolved: (r) => /^sha256:[a-f0-9]{64}$/.test(r),
    resolvedHint: 'an "sha256:<64hex>" artifact digest',
  },
  https: {
    locator: (l) => l.startsWith("https://") && isCanonicalHostPath(l.slice("https://".length)),
    resolved: (r) => /^sha256:[a-f0-9]{64}$/.test(r),
    resolvedHint: 'an "sha256:<64hex>" content digest',
  },
}

export type ProvenanceSource = { kind: string; locator: string; requestedRef: string; resolved: string }

export function assertSourceGrammar(source: ProvenanceSource): void {
  const grammar = PROV_SOURCE_GRAMMAR[source?.kind]
  if (!grammar) throw new Error(`source.kind "${source?.kind}" has no canonical grammar`)
  if (!grammar.locator(source.locator))
    throw new Error(
      `source.locator "${source.locator}" is not canonical for kind "${source.kind}" (no query/fragment/credentials/uppercase hosts/dot segments/local paths)`,
    )
  if (!grammar.resolved(source.resolved))
    throw new Error(`source.resolved for kind "${source.kind}" must be ${grammar.resolvedHint}, got "${source.resolved}"`)
}

export interface IntakeProvenance {
  schema: typeof INTAKE_PROVENANCE_SCHEMA_ID
  catalogId: string
  version: string
  source: ProvenanceSource
  manifest: { sha256: string; bytes: number }
  lockDigests: { name: string; sha256: string }[]
  artifactDigests: { name: string; sha256: string }[]
}

export function assertProvenanceCoherent(prov: IntakeProvenance, ctx: { catalogId: string; version: string }): void {
  requireCtx(ctx as Partial<CurationCtx>, ["catalogId", "version"], "assertProvenanceCoherent")
  if (prov.catalogId !== ctx.catalogId)
    throw new Error(`provenance.catalogId "${prov.catalogId}" does not match entry "${ctx.catalogId}"`)
  if (prov.version !== String(ctx.version)) throw new Error(`provenance.version "${prov.version}" does not match entry "${ctx.version}"`)

  assertSourceGrammar(prov.source)

  assertSortedUnique(prov.lockDigests, "lockDigests", (d) => d.name)
  assertSortedUnique(prov.artifactDigests, "artifactDigests", (d) => d.name)
}

/** 完整 provenance 契约检查(schema 全量严格结构 + 不变量;"" = 通过)。 */
export function checkProvenanceContract(prov: unknown, ctx: { catalogId: string; version: string }): string {
  const errs = validateSchemaLite(prov, PROVENANCE_SCHEMA)
  if (errs.length) return errs.join("\n")
  try {
    assertProvenanceCoherent(prov as IntakeProvenance, ctx)
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
  return ""
}

// ---------------------------------------------------------------------------
// SBOM 剖面执行器(合同 §4:CycloneDX 1.6 确定性子集;assertSbomProfile 逐字移植)
// ---------------------------------------------------------------------------

const SBOM_TOP_KEYS = new Set(["bomFormat", "specVersion", "metadata", "components", "dependencies"])
const SBOM_METADATA_KEYS = new Set(["component"])
const SBOM_COMPONENT_KEYS = new Set(["bom-ref", "type", "name", "version", "purl", "hashes"])
const SBOM_COMPONENT_TYPES = new Set(["application", "library", "framework", "file"])
const SBOM_HASH_KEYS = new Set(["alg", "content"])
const SBOM_DEPENDENCY_KEYS = new Set(["ref", "dependsOn"])

type SbomComponent = Record<string, unknown>

const componentKey = (c: SbomComponent): string => (c["bom-ref"] as string) ?? (c.purl as string) ?? `${c.name}@${c.version}`

function assertSbomComponent(c: unknown, at: string, refs: Set<string>): void {
  if (c === null || typeof c !== "object" || Array.isArray(c)) throw new Error(`${at} must be an object`)
  const comp = c as SbomComponent
  for (const k of Object.keys(comp)) if (!SBOM_COMPONENT_KEYS.has(k)) throw new Error(`${at}: forbidden key "${k}"`)
  if (typeof comp.name !== "string" || !comp.name) throw new Error(`${at}.name is required`)
  if (typeof comp.version !== "string" || !comp.version) throw new Error(`${at}.version is required`)
  if (comp.type !== undefined && !SBOM_COMPONENT_TYPES.has(comp.type as string))
    throw new Error(`${at}.type must be one of ${[...SBOM_COMPONENT_TYPES].join("/")}, got ${JSON.stringify(comp.type)}`)
  if (comp["bom-ref"] !== undefined && (typeof comp["bom-ref"] !== "string" || !comp["bom-ref"]))
    throw new Error(`${at}.bom-ref must be a non-empty string`)
  if (comp.purl !== undefined && (typeof comp.purl !== "string" || !comp.purl.startsWith("pkg:")))
    throw new Error(`${at}.purl must be a "pkg:" package URL`)
  if (comp.hashes !== undefined) {
    if (!Array.isArray(comp.hashes)) throw new Error(`${at}.hashes must be an array`)
    for (const h of comp.hashes as unknown[]) {
      if (h === null || typeof h !== "object" || Array.isArray(h)) throw new Error(`${at}.hashes items must be objects`)
      const hash = h as Record<string, unknown>
      for (const k of Object.keys(hash)) if (!SBOM_HASH_KEYS.has(k)) throw new Error(`${at}.hashes: forbidden key "${k}"`)
      if (hash.alg !== "SHA-256") throw new Error(`${at}.hashes: alg must be "SHA-256"`)
      if (!/^[a-f0-9]{64}$/.test((hash.content as string) ?? "")) throw new Error(`${at}.hashes: content must be 64 lowercase hex`)
    }
  }
  if (comp["bom-ref"] !== undefined) refs.add(comp["bom-ref"] as string)
}

export function assertSbomProfile(sbom: unknown): void {
  if (sbom === null || typeof sbom !== "object" || Array.isArray(sbom)) throw new Error("sbom must be an object")
  const doc = sbom as Record<string, unknown>
  for (const k of Object.keys(doc))
    if (!SBOM_TOP_KEYS.has(k)) throw new Error(`sbom: forbidden or unknown top-level key "${k}" (deterministic profile)`)
  if (doc.bomFormat !== "CycloneDX") throw new Error(`sbom.bomFormat must be "CycloneDX"`)
  if (doc.specVersion !== "1.6") throw new Error(`sbom.specVersion must be "1.6"`)
  if (!Array.isArray(doc.components)) throw new Error("sbom.components must be an array (empty allowed)")

  const refs = new Set<string>()
  if (doc.metadata !== undefined) {
    if (doc.metadata === null || typeof doc.metadata !== "object" || Array.isArray(doc.metadata))
      throw new Error("sbom.metadata must be an object when present")
    const meta = doc.metadata as Record<string, unknown>
    for (const k of Object.keys(meta))
      if (!SBOM_METADATA_KEYS.has(k)) throw new Error(`sbom.metadata.${k} is forbidden (deterministic profile: only "component")`)
    if (meta.component !== undefined) assertSbomComponent(meta.component, "sbom.metadata.component", refs)
  }

  const components = doc.components as unknown[]
  for (const [i, c] of components.entries()) assertSbomComponent(c, `sbom.components[${i}]`, refs)
  assertSortedUnique(components as SbomComponent[], "sbom.components", componentKey)

  if (doc.dependencies !== undefined) {
    if (!Array.isArray(doc.dependencies)) throw new Error("sbom.dependencies must be an array")
    for (const [i, d] of (doc.dependencies as unknown[]).entries()) {
      const at = `sbom.dependencies[${i}]`
      if (d === null || typeof d !== "object" || Array.isArray(d)) throw new Error(`${at} must be an object`)
      const dep = d as Record<string, unknown>
      for (const k of Object.keys(dep)) if (!SBOM_DEPENDENCY_KEYS.has(k)) throw new Error(`${at}: forbidden key "${k}"`)
      if (!refs.has(dep.ref as string)) throw new Error(`${at}.ref "${dep.ref}" does not resolve to a component bom-ref`)
      if (!Array.isArray(dep.dependsOn)) throw new Error(`${at}.dependsOn must be an array`)
      for (const r of dep.dependsOn as string[])
        if (!refs.has(r)) throw new Error(`${at}.dependsOn: "${r}" does not resolve to a component bom-ref`)
      assertSortedUnique(dep.dependsOn as string[], `${at}.dependsOn`)
    }
    assertSortedUnique(doc.dependencies as Record<string, unknown>[], "sbom.dependencies", (d) => d.ref as string)
  }
}

/** SBOM 剖面契约检查("" = 通过)。 */
export function checkSbomContract(sbom: unknown): string {
  try {
    assertSbomProfile(sbom)
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
  return ""
}

// ---------------------------------------------------------------------------
// canonical 序列化执行器(合同 §4/§6:blob 字节级可再生;消费端逐字节复验,不省略)
// ---------------------------------------------------------------------------

function sortValueDeep(value: unknown, at: string): unknown {
  if (typeof value === "string") {
    if (value !== value.normalize("NFC")) throw new Error(`${at}: string is not NFC-normalized`)
    return value
  }
  if (Array.isArray(value)) return value.map((v, i) => sortValueDeep(v, `${at}[${i}]`))
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value).sort(utf8Compare)) {
      if (k !== k.normalize("NFC")) throw new Error(`${at}: property name ${JSON.stringify(k)} is not NFC-normalized`)
      out[k] = sortValueDeep((value as Record<string, unknown>)[k], `${at}.${k}`)
    }
    return out
  }
  return value
}

/** canonical JSON 字节:键 UTF-8 字节序递归排序、2 空格缩进、LF、尾随换行、NFC。 */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  return TE.encode(JSON.stringify(sortValueDeep(value, "$"), null, 2) + "\n")
}

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** blob 原始字节的 canonical 校验(合同 §4/§6,CONTRACT.md「字节校验」行):严格 UTF-8 解码 →
 *  parse → canonical 重序列化 → 字节比对;通过返回解析对象,任何一步不符即 fail-closed。 */
export function assertCanonicalBlobBytes(buf: Uint8Array, what = "blob"): unknown {
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf)
  } catch {
    throw new Error(`${what}: not valid UTF-8`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${what}: not valid JSON`)
  }
  if (!bytesEqual(canonicalJsonBytes(parsed), buf))
    throw new Error(`${what}: bytes are not canonical (key order / indentation / NFC / trailing newline)`)
  return parsed
}

// ---------------------------------------------------------------------------
// 消费端裁决面(§7.1 行 3/4/5 的唯一入口)
// ---------------------------------------------------------------------------

export type CurationStatus =
  | { kind: "curated"; curation: Curation }
  | { kind: "uncurated" }
  | { kind: "invalid"; reason: string }

export type CurationEntryLike = {
  id: string
  type: string
  version?: string
  curation?: unknown
  remoteAsset?: { files?: unknown[] }
}

/** entry.curation 的消费端裁决(fail-closed):缺席 = 未策展(不是错误);存在但 entry 无
 *  version(blob URL 绑定无法成立)/ 结构或不变量任一失败 = invalid,整体不采信。 */
export function decodeEntryCuration(entry: CurationEntryLike): CurationStatus {
  if (entry.curation === undefined) return { kind: "uncurated" }
  if (typeof entry.version !== "string" || entry.version.length === 0)
    return { kind: "invalid", reason: `entry "${entry.id}" carries curation but no entry-level version — blob URL binding cannot be established (fail closed)` }
  let reason: string
  try {
    reason = checkCurationContract(entry.curation, {
      catalogId: entry.id,
      version: entry.version,
      entryType: entry.type,
      hasPayloadAssets: (entry.remoteAsset?.files?.length ?? 0) > 0,
    })
  } catch (e) {
    // curationBlobUrl 对非法 id/version 抛错(穿越/注入形态)—— 同属 fail-closed 面。
    reason = e instanceof Error ? e.message : String(e)
  }
  if (reason) return { kind: "invalid", reason }
  return { kind: "curated", curation: entry.curation as Curation }
}

/** 复审期限比较(合同 §7.2:**排他**截止 —— 恰好等于即已过期;消费端时钟仅用于本比较)。 */
export function isReviewExpired(curation: Curation, nowIso: string): boolean {
  return Date.parse(curation.review.reviewBefore) <= Date.parse(nowIso)
}

/** 安装/启用策略消费事实(#397 接线面):仅 curated 产出;uncurated/invalid 返回空对象
 *  (= #395 保守规则兜底,合同 §7.1 行 3/4)。 */
export function curationActivationFacts(
  status: CurationStatus,
  nowIso: string,
): { activationPolicy?: ActivationPolicy; reviewExpired?: boolean } {
  if (status.kind !== "curated") return {}
  return {
    activationPolicy: status.curation.activationPolicy,
    ...(isReviewExpired(status.curation, nowIso) ? { reviewExpired: true as const } : {}),
  }
}

/** upstreamStatus=archived(合同 §7.2:禁新安装;纵深 —— 发布端门闸本不应放行)。 */
export function isCurationArchived(status: CurationStatus): boolean {
  return status.kind === "curated" && status.curation.review.upstreamStatus === "archived"
}
