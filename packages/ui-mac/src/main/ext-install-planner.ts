// Main-only install planner — REQ-099 Phase 0 (ADR-028 §1/§2) + Phase 1 integration (§3-§5).
//
// The renderer's catalog install request is narrowed to `{ catalogId, scope, grants }` and its
// uninstall request to `{ type, name, scope(, projectDir) }`. EVERY install fact — name, server
// config, npm package, asset key, owned paths — is re-derived here from the VERIFIED catalog
// (ed25519-verified remote/cache → bundled byte snapshot) and from main's own ledger. Forged
// renderer facts have no channel: unknown intent keys are rejected by the strict decoders, and
// grants are validated against what the catalog entry declares (requiredEnvVars / {workspace}).
//
// Phase 1: before any disk side effect the planner synthesizes an ExtensionManifestV2 from the
// verified entry and STRICT-validates it (ext-manifest-v2.ts — unknown key/version/digest/
// capability/cycle/platform all loud-reject pre-disk, AC#1); successful installs write an
// InstallRecordV2 (ext-receipt-v2.ts) with environment (REQ-098), scope identity (fail-closed
// project closure), manifest/payload/grant digests and the generation chain.
//
// REQ-100 seam: `InstallTransactionHooks` (begin/commit/rollback). This module executes directly
// and records `transaction: { id, state: "committed" }`; staging/materialization/health/rollback
// machinery belongs to REQ-100 and plugs into these hooks without touching schema or derivation.
//
// Dependency-injected and electron-free (no electron, no ./logging — repo test discipline):
// ext-ipc.ts wires the real installers/catalog; tests inject fakes.

import * as fs from "node:fs"
import * as path from "node:path"
import * as crypto from "node:crypto"
import { randomUUID } from "node:crypto"
import type { InstallReceiptType } from "../preload/types"
import type { CatalogEntry, McpInstallSpec } from "../renderer/extensions/catalog-types"
import type { AppEnvironment } from "./alpha-environment"
import { alphaRoot } from "./alpha-workdir"
import { officeAdvisoryFor } from "../shared/office-advisories"
import {
  runExtensionTransaction,
  uninstallExtensionTransaction,
  type TxCommitRecord,
  type TxHooks,
  type TxPlan,
  type TxPlanItem,
} from "./ext-transaction"
import { findReceipt } from "./alpha-installs"
import {
  aggregateFilesDigest,
  computeManifestDigest,
  decodeManifestV2,
  findDependencyCycle,
  MANIFEST_SCHEMA_VERSION,
  type DependencyNode,
  type DistributionChannel,
  type ExtensionManifestV2,
  type ManifestCapability,
  type ManifestKind,
  type RuntimeSurface,
  type SupportTier,
} from "./ext-manifest-v2"
import {
  computeGrantDigest,
  findRecordV2,
  lookupForUninstall,
  projectScopeIdentity,
  removeRecordV2,
  setDesiredStateV2,
  upsertRecordV2,
  upsertRecordsV2,
  verifyProjectScope,
  type DesiredState,
  type ScopeIdentity,
  type UpsertInput,
} from "./ext-receipt-v2"
import {
  commitInputFromRecord,
  installSkillGeneration,
  listSkillGenerations,
  rollbackSkillGeneration,
  skillGenerationKey,
  skillGenerationProbe,
  skillStorePaths,
  type SkillGenerationEntry,
  type SkillPayloadFile,
} from "./ext-skill-generations"

// ── renderer intents(严格解码:未知键 = 伪造事实通道,loud 拒绝)─────────────────────────────

export type InstallScope = { scope: "global" } | { scope: "project"; projectDir: string }
export type InstallGrants = {
  /** 值 = 用户刚输入的密钥真值;变量名必须 ⊆ catalog 声明的 requiredEnvVars。 */
  secrets?: Record<string, string>
  /** 非密钥替换值;键同样必须 ⊆ requiredEnvVars。 */
  env?: Record<string, string>
  /** {workspace} 占位替换(条目声明了占位才允许)。 */
  workspace?: string
  /** 中国镜像 env(值为 main 侧常量,renderer 只表达偏好)。 */
  cnMirror?: boolean
}
export type CatalogInstallIntent = { catalogId: string; scope: InstallScope; grants?: InstallGrants }

export type UninstallIntent =
  | { type: InstallReceiptType; name: string; scope: "global" }
  | { type: InstallReceiptType; name: string; scope: "project"; projectDir: string }

export type CatalogInstallOutcome =
  | {
      ok: true
      kind: ManifestKind
      name: string
      files?: string[]
      manifestDigest?: string
      /** MCP:renderer 用于 live sdk.mcp.add 的完整配置(含用户刚输入的密钥真值 —— 该值本就来自 renderer)。 */
      liveMcp?: { name: string; config: Record<string, unknown> }
      /** bundle:main 已验证(存在性/循环依赖/平台)的有序子条目 id。 */
      bundle?: { items: string[] }
      /** bundle:一次原子事务提交的子条目 id(REQ-100 #311)。 */
      installed?: string[]
      /** bundle:跳过的子条目(optional 未选 / 首期 fail-closed 排除;journaled 可审计)。 */
      skipped?: Array<{ id: string; reason: string }>
      warning?: string
    }
  | { ok: false; reason: string }

export type UninstallOutcome = { ok: true; files?: string[]; warning?: string } | { ok: false; reason: string }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const RECEIPT_TYPES = new Set<string>(["mcp", "skill", "agent", "command", "plugin", "bundle", "cloud"])

function decodeStringMap(v: unknown, at: string): { ok: true; map: Record<string, string> } | { ok: false; reason: string } {
  if (!isObj(v)) return { ok: false, reason: `${at}: must be an object of strings` }
  const map: Record<string, string> = {}
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== "string") return { ok: false, reason: `${at}.${k}: must be a string` }
    if (k.length === 0 || k.length > 128) return { ok: false, reason: `${at}: invalid key` }
    map[k] = val
  }
  return { ok: true, map }
}

function decodeScope(v: unknown): { ok: true; scope: InstallScope } | { ok: false; reason: string } {
  if (!isObj(v)) return { ok: false, reason: "intent.scope: required object" }
  if (v.scope === "global") {
    for (const key of Object.keys(v)) if (key !== "scope") return { ok: false, reason: `intent.scope: unknown key "${key}" — refused` }
    return { ok: true, scope: { scope: "global" } }
  }
  if (v.scope === "project") {
    for (const key of Object.keys(v)) if (key !== "scope" && key !== "projectDir") return { ok: false, reason: `intent.scope: unknown key "${key}" — refused` }
    if (typeof v.projectDir !== "string" || !path.isAbsolute(v.projectDir)) return { ok: false, reason: "intent.scope.projectDir: required absolute path" }
    return { ok: true, scope: { scope: "project", projectDir: v.projectDir } }
  }
  return { ok: false, reason: `intent.scope.scope: ${JSON.stringify(v.scope)} not "global" | "project"` }
}

/** 严格解码 renderer 安装意图:catalogId + scope + grants,一个多余键都不收(伪造安装事实无通道)。 */
export function decodeCatalogInstallIntent(input: unknown): { ok: true; intent: CatalogInstallIntent } | { ok: false; reason: string } {
  if (!isObj(input)) return { ok: false, reason: "intent: must be an object" }
  for (const key of Object.keys(input)) {
    if (key !== "catalogId" && key !== "scope" && key !== "grants")
      return { ok: false, reason: `intent: unknown key "${key}" — renderer-supplied install facts are refused (ADR-028 §1)` }
  }
  if (typeof input.catalogId !== "string" || input.catalogId.length === 0 || input.catalogId.length > 200)
    return { ok: false, reason: "intent.catalogId: required non-empty string" }
  const scope = decodeScope(input.scope)
  if (!scope.ok) return scope
  let grants: InstallGrants | undefined
  if (input.grants !== undefined) {
    if (!isObj(input.grants)) return { ok: false, reason: "intent.grants: must be an object" }
    for (const key of Object.keys(input.grants)) {
      if (!["secrets", "env", "workspace", "cnMirror"].includes(key))
        return { ok: false, reason: `intent.grants: unknown key "${key}" — refused` }
    }
    grants = {}
    if (input.grants.secrets !== undefined) {
      const m = decodeStringMap(input.grants.secrets, "intent.grants.secrets")
      if (!m.ok) return m
      grants.secrets = m.map
    }
    if (input.grants.env !== undefined) {
      const m = decodeStringMap(input.grants.env, "intent.grants.env")
      if (!m.ok) return m
      grants.env = m.map
    }
    if (input.grants.workspace !== undefined) {
      if (typeof input.grants.workspace !== "string" || !path.isAbsolute(input.grants.workspace))
        return { ok: false, reason: "intent.grants.workspace: must be an absolute path" }
      grants.workspace = input.grants.workspace
    }
    if (input.grants.cnMirror !== undefined) {
      if (typeof input.grants.cnMirror !== "boolean") return { ok: false, reason: "intent.grants.cnMirror: must be a boolean" }
      grants.cnMirror = input.grants.cnMirror
    }
  }
  return { ok: true, intent: { catalogId: input.catalogId, scope: scope.scope, ...(grants ? { grants } : {}) } }
}

/** 严格解码卸载意图:type + name + scope(+ projectDir)。绝对路径/receipt 字段没有通道(ADR-028 §1)。 */
export function decodeUninstallIntent(input: unknown): { ok: true; intent: UninstallIntent } | { ok: false; reason: string } {
  if (!isObj(input)) return { ok: false, reason: "intent: must be an object" }
  for (const key of Object.keys(input)) {
    if (!["type", "name", "scope", "projectDir"].includes(key))
      return { ok: false, reason: `uninstall intent: unknown key "${key}" — renderer-supplied receipts/paths are refused (ADR-028 §1)` }
  }
  if (typeof input.type !== "string" || !RECEIPT_TYPES.has(input.type)) return { ok: false, reason: "intent.type: not a known type" }
  if (typeof input.name !== "string" || !SAFE_NAME.test(input.name)) return { ok: false, reason: "intent.name: invalid name" }
  if (input.scope === "global") {
    if (input.projectDir !== undefined) return { ok: false, reason: "intent.projectDir: not allowed for global scope" }
    return { ok: true, intent: { type: input.type as InstallReceiptType, name: input.name, scope: "global" } }
  }
  if (input.scope === "project") {
    if (typeof input.projectDir !== "string" || !path.isAbsolute(input.projectDir))
      return { ok: false, reason: "intent.projectDir: required absolute path for project scope" }
    return { ok: true, intent: { type: input.type as InstallReceiptType, name: input.name, scope: "project", projectDir: input.projectDir } }
  }
  return { ok: false, reason: `intent.scope: ${JSON.stringify(input.scope)} not "global" | "project"` }
}

// ── verified catalog resolution + ManifestV2 synthesis ─────────────────────────────────────────

export type VerifiedCatalogEntry = {
  entry: CatalogEntry
  /** remote/cache = ed25519 验签通过;bundled = 随包字节快照(app 签名背书)。 */
  channel: "remote" | "cache" | "bundled"
  catalogVersion: string
}

function surfacesFor(entry: CatalogEntry): RuntimeSurface[] {
  if (entry.type === "mcp") {
    const spec = entry.installSpec
    return spec?.kind === "mcp" && spec.mcpType === "remote" ? ["remote-service"] : ["local-subprocess"]
  }
  if (entry.type === "plugin") return ["engine-process"]
  if (entry.type === "cloud") return ["cloud-pipeline"]
  return ["model-context"]
}

function capabilitiesFor(entry: CatalogEntry): ManifestCapability[] {
  if (entry.type === "mcp") {
    const spec = entry.installSpec
    return spec?.kind === "mcp" && spec.mcpType === "remote" ? ["network:remote", "engine:config"] : ["process:spawn", "engine:config"]
  }
  if (entry.type === "plugin") return ["engine:plugin", "engine:config"]
  if (entry.type === "agent") return ["prompt:context", "engine:config"]
  if (entry.type === "skill") return ["prompt:context"]
  if (entry.type === "cloud") return ["cloud:dispatch"]
  return []
}

function distributedFor(entry: CatalogEntry, channel: VerifiedCatalogEntry["channel"]): DistributionChannel {
  if (entry.type === "mcp") return "engine-config"
  if (entry.type === "cloud") return "cloud"
  if (entry.type === "plugin") {
    const spec = entry.installSpec
    return spec?.kind === "plugin" && spec.vendoredAssetKey ? "bundled" : "npm"
  }
  const spec = entry.installSpec as { source?: string } | undefined
  if (spec?.source === "remote" || entry.remoteAsset) return "remote-catalog"
  if (spec?.source === "builtin") return "bundled"
  return channel === "bundled" ? "bundled" : "remote-catalog"
}

function supportTierFor(source: CatalogEntry["source"]): SupportTier {
  if (source === "alpha") return "alpha"
  if (source === "official") return "curated"
  if (source === "community") return "community"
  return "user"
}

/** 从已验 catalog 条目合成 ManifestV2(五维 ownership:authored = 条目来源,curated = alpha,不混标)。 */
export function synthesizeManifest(verified: VerifiedCatalogEntry): unknown {
  const { entry, channel, catalogVersion } = verified
  const surfaces = surfacesFor(entry)
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    id: entry.id,
    name: entry.name,
    kind: entry.type,
    version: typeof entry.version === "string" && entry.version ? entry.version : catalogVersion,
    compatibility: { platforms: ["darwin", "win32"] }, // ADR-026 桌面双平台;catalog 无逐条声明时的诚实默认
    capabilities: capabilitiesFor(entry),
    dependencies: (entry.bundleItems ?? []).map((it) => ({ id: it.catalogEntryId, optional: it.optional === true })),
    ownership: {
      authored: entry.source ?? "user",
      curated: "alpha",
      distributed: distributedFor(entry, channel),
      runtimeSurfaces: surfaces,
      supportTier: supportTierFor(entry.source),
    },
    components: [{ name: entry.name, runsIn: surfaces }],
    ...(entry.remoteAsset?.files?.length
      ? {
          artifact: {
            digest: aggregateFilesDigest(entry.remoteAsset.files),
            size: entry.remoteAsset.files.reduce((n, f) => n + (typeof f.bytes === "number" ? f.bytes : 0), 0),
            mediaType: "application/vnd.alpha.remote-asset",
          },
        }
      : {}),
  }
}

// ── grants → MCP config 派生(main 重建安装事实;renderer 只供用户输入)────────────────────────

/** 中国镜像 env(main 侧常量 —— renderer 只表达 cnMirror 偏好,值无通道可改)。 */
const CN_MIRROR_ENV: Record<string, string> = {
  UV_DEFAULT_INDEX: "https://pypi.tuna.tsinghua.edu.cn/simple",
  PIP_INDEX_URL: "https://pypi.tuna.tsinghua.edu.cn/simple",
  npm_config_registry: "https://registry.npmmirror.com",
}

export function deriveMcpConfig(
  spec: McpInstallSpec,
  grants: InstallGrants,
): { ok: true; config: Record<string, unknown>; secretVars: string[] } | { ok: false; reason: string } {
  const declared = new Set(spec.requiredEnvVars ?? [])
  for (const k of Object.keys(grants.secrets ?? {})) {
    if (!declared.has(k)) return { ok: false, reason: `grant "${k}" not declared by the catalog entry (requiredEnvVars) — refused` }
  }
  for (const k of Object.keys(grants.env ?? {})) {
    if (!declared.has(k)) return { ok: false, reason: `grant "${k}" not declared by the catalog entry (requiredEnvVars) — refused` }
  }
  // REQ-099 #305(Codex review 高危):引擎 ConfigVariable.substitute 对整份 config 文本替换
  // {file:}/{env:} —— renderer 值含该语法即等于任意本地文件读 / main 进程 env 外泄通道,一律拒绝。
  for (const [k, v] of Object.entries({ ...(grants.env ?? {}), ...(grants.secrets ?? {}) })) {
    if (/\{(file|env):/.test(v)) return { ok: false, reason: `grant "${k}" contains config substitution syntax ({file:}/{env:}) — refused` }
  }
  const subst: Record<string, string> = { ...(grants.env ?? {}), ...(grants.secrets ?? {}) }
  if (spec.mcpType === "remote") {
    if (typeof spec.url !== "string" || !spec.url) return { ok: false, reason: "catalog entry has no url" }
    let headers: Record<string, string> | undefined
    if (spec.headersTemplate) {
      headers = {}
      for (const [k, v] of Object.entries(spec.headersTemplate)) headers[k] = v.replace(/\{(\w+)\}/g, (_, name) => subst[name] ?? "")
    }
    return {
      ok: true,
      config: { type: "remote", url: spec.url, ...(headers ? { headers } : {}) },
      secretVars: Object.keys(grants.secrets ?? {}).filter((k) => (grants.secrets![k] ?? "").length > 0),
    }
  }
  const command = spec.command ?? []
  if (command.length === 0) return { ok: false, reason: "catalog entry has no command" }
  const needsWorkspace = command.some((a) => a.includes("{workspace}"))
  if (needsWorkspace && !grants.workspace) return { ok: false, reason: "workspace grant required by this entry" }
  if (!needsWorkspace && grants.workspace) return { ok: false, reason: "workspace grant not used by this entry — refused" }
  const cmd = command.map((a) => (grants.workspace ? a.split("{workspace}").join(grants.workspace) : a))
  const environment = { ...(grants.cnMirror ? CN_MIRROR_ENV : {}), ...subst }
  return {
    ok: true,
    config: { type: "local", command: cmd, ...(Object.keys(environment).length ? { environment } : {}) },
    secretVars: Object.keys(grants.secrets ?? {}).filter((k) => (grants.secrets![k] ?? "").length > 0),
  }
}

// ── deps(注入面;ext-ipc 接真机器,测试接假)────────────────────────────────────────────────

export type ConfigOutcome = { ok: true } | { ok: false; reason: string }
export type FsOutcome = { ok: true; files?: string[] } | { ok: false; reason: string }
export type RemoteFiles = Array<{ path: string; sha256: string; bytes: number; url: string }>
export type DownloadOutcome = { ok: true; contents: Array<{ path: string; data: Buffer }> } | { ok: false; reason: string }
export type InstallMetaArg = { catalogId?: string; version?: string }
export type TargetArg = { scope: "global" } | { scope: "project"; projectDir: string }

export type PlannerInstallers = {
  persistMcp(name: string, server: Record<string, unknown>, meta?: InstallMetaArg): ConfigOutcome
  /** REQ-099 #305:密钥深路由(environment 键 + headers 内嵌真值 → {file:} 引用);skipped 非空
   *  = 有密钥没能进文件通道,调用方必须 fail-closed,绝不明文持久化。refs 供 live 真值回填。 */
  fileifyMcpSecrets(name: string, server: Record<string, unknown>, secrets: Record<string, string>): { fileified: string[]; skipped: string[]; refs: Record<string, string> }
  removeMcpSecrets(name: string): void
  removeMcp(name: string): ConfigOutcome
  persistPlugin(pkg: string, meta?: InstallMetaArg): ConfigOutcome
  removePlugin(pkg: string): ConfigOutcome
  installVendoredPlugin(vendoredAssetKey: string, name: string, meta?: InstallMetaArg): FsOutcome
  removePluginPath(name: string, absJsPath: string): ConfigOutcome
  installBuiltinSkill(builtinAssetKey: string, name: string, target?: TargetArg, meta?: InstallMetaArg): FsOutcome
  installBuiltinAgent(builtinAssetKey: string, name: string, target?: TargetArg, meta?: InstallMetaArg): FsOutcome
  /** REQ-100 #310:收集 builtin skill 随包目录为载荷(generation 事务 populate 用;不落 flat 目录)。 */
  collectBuiltinSkillPayload(builtinAssetKey: string, name: string): { ok: true; files: Array<{ path: string; data: Buffer }> } | { ok: false; reason: string }
  installRemoteSkill(name: string, contents: Array<{ path: string; data: Buffer }>, target?: TargetArg, meta?: InstallMetaArg): FsOutcome
  installRemoteAgent(name: string, contents: Array<{ path: string; data: Buffer }>, target?: TargetArg, meta?: InstallMetaArg): FsOutcome
  removeFsInstall(type: "skill" | "agent", name: string, target?: TargetArg): FsOutcome
  downloadRemoteAsset(files: RemoteFiles): Promise<DownloadOutcome>
}

/** REQ-100 接缝:staging/materialization/rollback 机器在这三个钩子内落位(ADR-028 §6)。 */
export interface InstallTransactionHooks {
  begin(plan: { op: "install" | "uninstall"; kind: string; name: string; scope: "global" | "project"; manifestDigest?: string }): { txId: string }
  commit(txId: string): void
  rollback(txId: string, reason: string): void
}

const passthroughTx: InstallTransactionHooks = {
  begin: () => ({ txId: randomUUID() }),
  commit: () => {},
  rollback: () => {},
}

export type PlannerDeps = {
  resolveEntry(catalogId: string): Promise<VerifiedCatalogEntry | null>
  environment(): AppEnvironment
  platform(): NodeJS.Platform
  globalRoot(): string
  installers: PlannerInstallers
  transaction?: InstallTransactionHooks
  now?(): string
}

// ── scope 解析(项目闭环:identity fail-closed;mcp/plugin/cloud 不进项目 scope)─────────────────

const PROJECT_SCOPED_KINDS = new Set<string>(["skill", "agent"])

function resolveScope(
  scope: InstallScope,
  kind: string,
): { ok: true; root: (deps: PlannerDeps) => string; identity: ScopeIdentity; target: TargetArg } | { ok: false; reason: string } {
  if (scope.scope === "global") return { ok: true, root: (d) => d.globalRoot(), identity: { kind: "global" }, target: { scope: "global" } }
  if (!PROJECT_SCOPED_KINDS.has(kind))
    return { ok: false, reason: `kind "${kind}" cannot be project-scoped (engine config is global; project executables go through the project trust gate, REQ-060)` }
  const identity = projectScopeIdentity(scope.projectDir)
  if (!identity.ok) return { ok: false, reason: `fail closed: ${identity.reason}` }
  const root = alphaRoot(identity.scope.projectPath)
  if (!root) return { ok: false, reason: `fail closed: invalid project root: ${scope.projectDir}` }
  return { ok: true, root: () => root, identity: identity.scope, target: { scope: "project", projectDir: identity.scope.projectPath } }
}

// ── install ─────────────────────────────────────────────────────────────────────────────────────

/** bundle 子条目在原子事务里的形态:generation(skill)/config(mcp)/receipt(cloud),或跳过/致命排除。 */
type BundleChildPlan =
  | { status: "install"; id: string; item: TxPlanItem; record: UpsertInput; payload?: SkillPayloadFile[] }
  | { status: "skip"; id: string; reason: string }
  | { status: "fatal"; id: string; reason: string }

const bundleKeyFor = (kind: string, name: string): string => `${kind}--${name}`

function txSpecsOf(payload: SkillPayloadFile[]): TxPlanItem["files"] {
  return payload.map((f) => ({ path: f.path, sha256: crypto.createHash("sha256").update(f.data).digest("hex"), size: f.data.length }))
}

/**
 * 把一个 bundle 子条目分类为原子事务里的一项。首期(REQ-100 #311)支持 skill(generation)+ 无密钥
 * 非-Excel MCP(config)+ cloud(receipt);agent / vendored·npm plugin / 需密钥或 workspace 的 MCP
 * 一律 fail-closed(它们不在现有 generation/config action 的原子边界内)。 */
async function classifyBundleChild(
  child: VerifiedCatalogEntry,
  environment: AppEnvironment,
  scope: ScopeIdentity,
  deps: PlannerDeps,
): Promise<BundleChildPlan> {
  const entry = child.entry
  const id = entry.id
  const decoded = decodeManifestV2(synthesizeManifest(child))
  if (!decoded.ok) return { status: "fatal", id, reason: `manifest invalid: ${decoded.errors.join("; ")}` }
  if (!(decoded.manifest.compatibility.platforms as string[]).includes(deps.platform()))
    return { status: "skip", id, reason: `platform ${deps.platform()} not supported` }
  const manifestDigest = computeManifestDigest(decoded.manifest)
  const baseRecord = {
    id: entry.id,
    name: entry.name,
    environment,
    scope,
    version: decoded.manifest.version,
    manifestDigest,
    grantDigest: computeGrantDigest({}),
    desiredState: "enabled" as const,
    origin: "catalog" as const,
    installedAt: new Date().toISOString(),
  }

  if (entry.type === "skill") {
    const fsSpec = entry.installSpec as { source?: string; builtinAssetKey?: string } | undefined
    let payload: SkillPayloadFile[]
    let payloadDigest: string | undefined
    if (fsSpec?.source === "remote" && entry.remoteAsset?.files?.length) {
      const dl = await deps.installers.downloadRemoteAsset(entry.remoteAsset.files)
      if (!dl.ok) return { status: "fatal", id, reason: dl.reason }
      payload = dl.contents
      payloadDigest = aggregateFilesDigest(entry.remoteAsset.files)
    } else if (fsSpec?.source === "builtin" && fsSpec.builtinAssetKey) {
      const p = deps.installers.collectBuiltinSkillPayload(fsSpec.builtinAssetKey, entry.name)
      if (!p.ok) return { status: "fatal", id, reason: p.reason }
      payload = p.files
    } else {
      return { status: "fatal", id, reason: "skill declares no installable asset" }
    }
    const key = bundleKeyFor("skill", entry.name)
    return {
      status: "install",
      id,
      payload,
      item: { key, files: txSpecsOf(payload), manifestDigest },
      record: { ...baseRecord, kind: "skill", ...(payloadDigest ? { payloadDigest } : {}) },
    }
  }

  if (entry.type === "mcp") {
    const spec = entry.installSpec
    if (spec?.kind !== "mcp") return { status: "fatal", id, reason: "mcp entry has no mcp installSpec" }
    // 首期排除需密钥 / workspace / Excel 的 MCP —— 它们的 secret 文件写、workspace 沙箱不在 config
    // action 的原子边界内(REQ-105 Excel 闸口、fileifyMcpSecrets 独立文件)。fail-closed。
    if ((spec.requiredEnvVars?.length ?? 0) > 0)
      return { status: "skip", id, reason: "secret-bearing MCP not supported in atomic bundle (phase 1)" }
    const derived = deriveMcpConfig(spec, {})
    if (!derived.ok) return { status: "skip", id, reason: `MCP needs grants not supported in bundle: ${derived.reason}` }
    // Excel MCP(workspace 沙箱走 REQ-105 闸口,不在 config action 边界内)= fail-closed。
    const cmd = Array.isArray(derived.config.command) ? (derived.config.command as unknown[]) : []
    const touchesExcel = entry.name === "excel-mcp-server" || cmd.some((a) => typeof a === "string" && a.includes("excel-mcp-server"))
    if (derived.secretVars.length > 0 || touchesExcel)
      return { status: "skip", id, reason: "secret/Excel MCP not supported in atomic bundle (phase 1)" }
    const key = bundleKeyFor("mcp", entry.name)
    return {
      status: "install",
      id,
      item: {
        key,
        // config target 锚定事务根(= 生产 ~/.alpha/alpha.jsonc;与 staging 同卷,原子替换)。
        action: "config",
        config: { target: path.join(deps.globalRoot(), "alpha.jsonc"), edits: [{ keyPath: ["mcp", entry.name], value: derived.config }] },
        manifestDigest,
      },
      record: { ...baseRecord, kind: "mcp", configKey: `mcp.${entry.name}` },
    }
  }

  if (entry.type === "cloud") {
    const key = bundleKeyFor("cloud", entry.name)
    return { status: "install", id, item: { key, action: "receipt", manifestDigest }, record: { ...baseRecord, kind: "cloud" } }
  }

  // agent / plugin(vendored·npm)/ 嵌套 bundle:不在首期原子边界内。
  return { status: "skip", id, reason: `type "${entry.type}" not supported in atomic bundle (phase 1)` }
}

/**
 * Bundle 原子安装(REQ-100 #311):把子条目组装成一次异构事务(generation + config + receipt),
 * required 全提交或全回滚;不支持项按 required→fatal(整单失败)/ optional→skipped(journaled)。
 * 首期限 global scope(锁/journal 按单 root),项目 bundle 预检拒绝。 */
async function installBundleAtomic(
  verified: VerifiedCatalogEntry,
  intent: CatalogInstallIntent,
  deps: PlannerDeps,
): Promise<CatalogInstallOutcome> {
  if (intent.scope.scope !== "global")
    return { ok: false, reason: "bundle install is global-scoped only (project bundles rejected — single-root atomicity)" }

  // 解析整张(传递闭包)依赖图:存在性 + 循环依赖在计划期拒绝(AC#1)。
  const nodes: DependencyNode[] = []
  const resolved = new Map<string, VerifiedCatalogEntry>([[verified.entry.id, verified]])
  const queue = [verified.entry.id]
  while (queue.length > 0) {
    const id = queue.shift()!
    const current = resolved.get(id)!
    const deps2 = (current.entry.bundleItems ?? []).map((it) => it.catalogEntryId)
    nodes.push({ id, deps: deps2 })
    for (const depId of deps2) {
      if (resolved.has(depId)) continue
      const sub = await deps.resolveEntry(depId)
      if (!sub) return { ok: false, reason: `bundle item not in verified catalog: ${depId}` }
      resolved.set(depId, sub)
      queue.push(depId)
    }
  }
  const cycle = findDependencyCycle(nodes)
  if (cycle) return { ok: false, reason: `dependency cycle refused: ${cycle.join(" → ")}` }

  // bundle 自身 manifest 校验(组件 = 逐子条目 runsIn;capability = 子项并集)。
  const items = (verified.entry.bundleItems ?? []).slice().sort((a, b) => a.installOrder - b.installOrder)
  const subEntries = items.map((it) => resolved.get(it.catalogEntryId)!.entry)
  const caps = [...new Set(subEntries.flatMap((e) => capabilitiesFor(e)))]
  const surfaces = [...new Set(subEntries.flatMap((e) => surfacesFor(e)))]
  const bundleManifest = {
    ...(synthesizeManifest(verified) as Record<string, unknown>),
    capabilities: caps,
    ownership: { ...(synthesizeManifest(verified) as { ownership: Record<string, unknown> }).ownership, runtimeSurfaces: surfaces },
    components: subEntries.map((e) => ({ name: e.name, runsIn: surfacesFor(e) })),
  }
  const bundleDecoded = decodeManifestV2(bundleManifest)
  if (!bundleDecoded.ok) return { ok: false, reason: `bundle manifest invalid: ${bundleDecoded.errors.join("; ")}` }
  if (!(bundleDecoded.manifest.compatibility.platforms as string[]).includes(deps.platform()))
    return { ok: false, reason: `platform ${deps.platform()} not supported by this bundle` }

  const environment = deps.environment()
  const identity: ScopeIdentity = { kind: "global" }

  // 分类每个 required/optional 子条目 → 事务项 / 跳过。required 致命 = 整单拒绝(零写盘)。
  const planItems: TxPlanItem[] = []
  const payloads = new Map<string, SkillPayloadFile[]>()
  const installedIds: string[] = []
  const skipped: Array<{ id: string; reason: string }> = []
  for (const it of items) {
    const child = resolved.get(it.catalogEntryId)!
    // REQ-105:归档 office 连接器绝不经 bundle 通道重新铺给用户 —— 恒跳过(即使 required),
    // 条目本身仍可在带警示的详情页单独安装(legacy optional 语义)。跳过决策落 main(非 renderer)。
    if (officeAdvisoryFor({ id: child.entry.id, name: child.entry.name })) {
      skipped.push({ id: child.entry.id, reason: "archived office connector (REQ-105)" })
      continue
    }
    const c = await classifyBundleChild(child, environment, identity, deps)
    if (c.status === "fatal") {
      if (!it.optional) return { ok: false, reason: `required bundle child "${c.id}" cannot install atomically: ${c.reason}` }
      skipped.push({ id: c.id, reason: c.reason })
    } else if (c.status === "skip") {
      if (!it.optional) return { ok: false, reason: `required bundle child "${c.id}" unsupported: ${c.reason}` }
      skipped.push({ id: c.id, reason: c.reason })
    } else {
      // receipt 模板嵌进 plan item(持久化进 journal)→ crash-recovery 前滚可自足落账(#312)。
      planItems.push({ ...c.item, receipt: c.record })
      if (c.payload) payloads.set(c.item.key, c.payload)
      installedIds.push(c.id)
    }
  }

  if (planItems.length === 0)
    return { ok: true, kind: "bundle", name: verified.entry.name, manifestDigest: computeManifestDigest(bundleDecoded.manifest), installed: [], skipped }

  const plan: TxPlan = {
    items: planItems,
    skippedOptional: skipped.map((s) => ({ key: s.id, reason: s.reason })),
  }
  const hooks: TxHooks = {
    populate: (item, stagingDir) => {
      const payload = payloads.get(item.key)
      if (!payload) return // config/receipt 项无 populate
      for (const f of payload) {
        const dst = path.join(stagingDir, ...f.path.split("/"))
        fs.mkdirSync(path.dirname(dst), { recursive: true })
        fs.writeFileSync(dst, f.data)
      }
    },
    // 类型化健康探测(#312):skill generation 落地后验 SKILL.md 可发现;非 generation 直接健康。
    probe: skillGenerationProbe,
    // 账本写失败即事务失败(#336):bundle 全部 receipt 一次批量落盘,不留半套。从 rec.receipt 模板
    // 重建(与恢复前滚同源,#312)。
    commitReceipt: (recs: TxCommitRecord[]) => {
      const written = upsertRecordsV2(deps.globalRoot(), recs.map((rec) => commitInputFromRecord(rec)))
      if (!written.ok) throw new Error(`bundle receipt commit failed: ${written.reason}`)
    },
    log: () => {},
  }

  const result = await runExtensionTransaction(deps.globalRoot(), plan, hooks)
  if (!result.ok) return { ok: false, reason: `bundle install failed at ${result.stage}: ${result.reason}` }
  return {
    ok: true,
    kind: "bundle",
    name: verified.entry.name,
    manifestDigest: computeManifestDigest(bundleDecoded.manifest),
    installed: installedIds,
    skipped,
  }
}

/**
 * catalog 安装唯一入口:意图严格解码 → 已验 catalog 解析 → ManifestV2 合成 + 写盘前严格校验
 * → main 重建安装事实执行 → InstallRecordV2 落账。
 */
export async function installCatalog(rawIntent: unknown, deps: PlannerDeps): Promise<CatalogInstallOutcome> {
  const decodedIntent = decodeCatalogInstallIntent(rawIntent)
  if (!decodedIntent.ok) return decodedIntent
  const intent = decodedIntent.intent

  const verified = await deps.resolveEntry(intent.catalogId)
  if (!verified) return { ok: false, reason: `entry not in verified catalog: ${intent.catalogId}` }
  const entry = verified.entry

  if (entry.type === "bundle") return installBundleAtomic(verified, intent, deps)

  // Phase 1:写盘前 manifest 严格校验(缺字段/未知键/非法 digest/越权 capability/平台不兼容全在此拒)。
  const decoded = decodeManifestV2(synthesizeManifest(verified))
  if (!decoded.ok) return { ok: false, reason: `manifest invalid — refusing before any disk write: ${decoded.errors.join("; ")}` }
  const manifest = decoded.manifest
  if (!(manifest.compatibility.platforms as string[]).includes(deps.platform()))
    return { ok: false, reason: `platform ${deps.platform()} not supported by this entry — refusing before any disk write` }
  const manifestDigest = computeManifestDigest(manifest)

  const scope = resolveScope(intent.scope, entry.type)
  if (!scope.ok) return scope
  const grants = intent.grants ?? {}
  const meta: InstallMetaArg = { catalogId: entry.id, version: manifest.version }
  const tx = (deps.transaction ?? passthroughTx).begin({ op: "install", kind: entry.type, name: entry.name, scope: intent.scope.scope, manifestDigest })
  const rollback = (reason: string): void => (deps.transaction ?? passthroughTx).rollback(tx.txId, reason)

  let files: string[] | undefined
  let configKey: string | undefined
  let payloadDigest: string | undefined
  let liveMcp: { name: string; config: Record<string, unknown> } | undefined

  const spec = entry.installSpec
  if (entry.type === "mcp") {
    if (spec?.kind !== "mcp") {
      rollback("entry has no mcp installSpec")
      return { ok: false, reason: "entry has no mcp installSpec" }
    }
    const derived = deriveMcpConfig(spec, grants)
    if (!derived.ok) {
      rollback(derived.reason)
      return derived
    }
    // durable 配置先把密钥(environment 键 + headers 内嵌真值)全部路由进 {file:} 通道再落盘;
    // 任一密钥没能转换(写文件失败 / granted 却没落到任何字段)即 fail-closed —— 绝不明文持久化
    // (Codex review #350 阻断项:此前 remote MCP 的 header 密钥明文进 alpha.jsonc)。
    const durable = JSON.parse(JSON.stringify(derived.config)) as Record<string, unknown>
    const secretMap: Record<string, string> = {}
    for (const v of derived.secretVars) secretMap[v] = grants.secrets![v]!
    let refs: Record<string, string> = {}
    if (derived.secretVars.length > 0) {
      const f = deps.installers.fileifyMcpSecrets(entry.name, durable, secretMap)
      if (f.skipped.length > 0) {
        deps.installers.removeMcpSecrets(entry.name)
        rollback(`secrets not routable to {file:} channel: ${f.skipped.join(", ")}`)
        return { ok: false, reason: `secret(s) could not be routed to the {file:} channel: ${f.skipped.join(", ")} — refusing plaintext persist` }
      }
      refs = f.refs
    }
    // persistMcp(=persistMcpWithPolicy)会**原地**注入 main 策略(如 Excel 受管 EXCEL_FILES_PATH),
    // live 必须在 persist 之后从 durable 派生,否则 renderer 拿去 sdk.mcp.add 的 live 配置缺策略字段。
    const persisted = deps.installers.persistMcp(entry.name, durable, meta)
    if (!persisted.ok) {
      if (derived.secretVars.length > 0) deps.installers.removeMcpSecrets(entry.name) // 不留孤儿密钥文件
      rollback(persisted.reason)
      return persisted
    }
    configKey = `mcp.${entry.name}`
    // live = 策略后配置 + 密钥真值回填(environment 与 headers 里的 {file:} 引用换回 renderer 刚交
    // 的真值 —— 该值本就来自本次 grants;契约:绝不回传任何 main/keychain 来源的密钥)。
    const liveCfg = JSON.parse(JSON.stringify(durable)) as Record<string, unknown>
    for (const [varName, ref] of Object.entries(refs)) {
      const real = secretMap[varName]!
      const liveEnv = liveCfg.environment
      if (liveEnv && typeof liveEnv === "object" && !Array.isArray(liveEnv) && (liveEnv as Record<string, unknown>)[varName] === ref)
        (liveEnv as Record<string, unknown>)[varName] = real
      const liveHeaders = liveCfg.headers
      if (liveHeaders && typeof liveHeaders === "object" && !Array.isArray(liveHeaders)) {
        const h = liveHeaders as Record<string, unknown>
        for (const [hk, hv] of Object.entries(h)) {
          if (typeof hv === "string" && hv.includes(ref)) h[hk] = hv.split(ref).join(real)
        }
      }
    }
    liveMcp = { name: entry.name, config: liveCfg }
  } else if (entry.type === "plugin") {
    if (spec?.kind !== "plugin") {
      rollback("entry has no plugin installSpec")
      return { ok: false, reason: "entry has no plugin installSpec" }
    }
    if (spec.vendoredAssetKey) {
      const r = deps.installers.installVendoredPlugin(spec.vendoredAssetKey, entry.name, meta)
      if (!r.ok) {
        rollback(r.reason)
        return r
      }
      files = r.files
      configKey = files?.[0] ? `plugin-path:${path.join(files[0], "plugin.js")}` : undefined
    } else if (typeof spec.package === "string" && spec.package) {
      const pinned = spec.version && spec.package.indexOf("@", 1) === -1 ? `${spec.package}@${spec.version}` : spec.package
      const r = deps.installers.persistPlugin(pinned, meta)
      if (!r.ok) {
        rollback(r.reason)
        return r
      }
      configKey = `plugin:${pinned}`
    } else {
      rollback("entry has no plugin package")
      return { ok: false, reason: "entry has no plugin package" }
    }
  } else if (entry.type === "skill") {
    // REQ-100 #310:skill 走不可变 generation 事务 —— 纯 staging 填充(去 receipt 化)→ 引擎
    // staging→verify→materialize→switch → commitReceipt=upsertRecordV2(写失败即事务失败,#336)。
    // 不再直写 ~/.alpha/skills/<name> + 单独 upsert;本分支自提交并早返回,不落共享 upsert。
    const fsSpec = spec as { kind?: string; source?: string; builtinAssetKey?: string } | undefined
    let payload: Array<{ path: string; data: Buffer }>
    if (fsSpec?.source === "remote" && entry.remoteAsset?.files?.length) {
      const dl = await deps.installers.downloadRemoteAsset(entry.remoteAsset.files)
      if (!dl.ok) {
        rollback(dl.reason)
        return dl
      }
      payload = dl.contents
      payloadDigest = aggregateFilesDigest(entry.remoteAsset.files)
    } else if (fsSpec?.source === "builtin" && fsSpec.builtinAssetKey) {
      const p = deps.installers.collectBuiltinSkillPayload(fsSpec.builtinAssetKey, entry.name)
      if (!p.ok) {
        rollback(p.reason)
        return p
      }
      payload = p.files
    } else {
      rollback("no installable content")
      return { ok: false, reason: "该内容尚未随此版本打包(entry declares no installable asset)" }
    }
    const gen = await installSkillGeneration(scope.root(deps), {
      name: entry.name,
      id: entry.id,
      environment: deps.environment(),
      scope: scope.identity,
      origin: "catalog",
      files: payload,
      version: manifest.version,
      manifestDigest,
      ...(payloadDigest ? { payloadDigest } : {}),
      grantDigest: computeGrantDigest(grants),
    })
    if (!gen.ok) {
      rollback(gen.reason)
      return { ok: false, reason: gen.reason }
    }
    ;(deps.transaction ?? passthroughTx).commit(tx.txId)
    return { ok: true, kind: "skill", name: entry.name, ...(gen.files.length ? { files: gen.files } : {}), manifestDigest }
  } else if (entry.type === "agent") {
    const fsSpec = spec as { kind?: string; source?: string; builtinAssetKey?: string } | undefined
    if (fsSpec?.source === "remote" && entry.remoteAsset?.files?.length) {
      const dl = await deps.installers.downloadRemoteAsset(entry.remoteAsset.files)
      if (!dl.ok) {
        rollback(dl.reason)
        return dl
      }
      const r = deps.installers.installRemoteAgent(entry.name, dl.contents, scope.target, meta)
      if (!r.ok) {
        rollback(r.reason)
        return r
      }
      files = r.files
      payloadDigest = aggregateFilesDigest(entry.remoteAsset.files)
    } else if (fsSpec?.source === "builtin" && fsSpec.builtinAssetKey) {
      const r = deps.installers.installBuiltinAgent(fsSpec.builtinAssetKey, entry.name, scope.target, meta)
      if (!r.ok) {
        rollback(r.reason)
        return r
      }
      files = r.files
    } else {
      rollback("no installable content")
      return { ok: false, reason: "该内容尚未随此版本打包(entry declares no installable asset)" }
    }
  } else if (entry.type === "cloud") {
    // receipts-only 语义(REQ-020 T4):不落文件、不写引擎 config —— 只记账。
    configKey = undefined
  } else {
    rollback(`unsupported kind: ${entry.type}`)
    return { ok: false, reason: `unsupported kind: ${entry.type}` }
  }

  const now = deps.now?.() ?? new Date().toISOString()
  const written = upsertRecordV2(scope.root(deps), {
    id: entry.id,
    name: entry.name,
    kind: entry.type,
    environment: deps.environment(),
    scope: scope.identity,
    version: manifest.version,
    manifestDigest,
    ...(payloadDigest ? { payloadDigest } : {}),
    grantDigest: computeGrantDigest(grants),
    desiredState: "enabled",
    origin: "catalog",
    ...(files ? { files } : {}),
    ...(configKey ? { configKey } : {}),
    transaction: { id: tx.txId, state: "committed" },
    installedAt: now,
  })
  ;(deps.transaction ?? passthroughTx).commit(tx.txId)
  // 账本写失败不谎报安装失败(内容已可用),但 loud 返回警告(卸载/更新将失真)。
  const warning = written.ok
    ? written.warnings.length
      ? written.warnings.join("; ")
      : undefined
    : `installed but v2 record failed: ${written.reason}`
  return {
    ok: true,
    kind: entry.type,
    name: entry.name,
    ...(files ? { files } : {}),
    manifestDigest,
    ...(liveMcp ? { liveMcp } : {}),
    ...(warning ? { warning } : {}),
  }
}

// ── uninstall(main 从自己账本读事实;owned paths 从受控根重新派生)──────────────────────────────

export async function uninstallByKey(rawIntent: unknown, deps: PlannerDeps): Promise<UninstallOutcome> {
  const decodedIntent = decodeUninstallIntent(rawIntent)
  if (!decodedIntent.ok) return decodedIntent
  const intent = decodedIntent.intent

  let root: string
  let target: TargetArg
  if (intent.scope === "project") {
    if (!PROJECT_SCOPED_KINDS.has(intent.type))
      return { ok: false, reason: `kind "${intent.type}" cannot be project-scoped` }
    const identity = projectScopeIdentity(intent.projectDir)
    if (!identity.ok) return { ok: false, reason: `fail closed: ${identity.reason}` }
    const projectRoot = alphaRoot(identity.scope.projectPath)
    if (!projectRoot) return { ok: false, reason: `fail closed: invalid project root: ${intent.projectDir}` }
    root = projectRoot
    target = { scope: "project", projectDir: identity.scope.projectPath }
  } else {
    root = deps.globalRoot()
    target = { scope: "global" }
  }

  // main 自己的账本才是事实源;renderer 只提供了 key。单次解析、单次决策:损坏 v2 record 绝不
  // 静默回退同账本 v1 receipt(REQ-099 #256 fail-closed)。
  const lookup = lookupForUninstall(root, intent.type, intent.name)
  if (lookup.status === "corrupt-match" || lookup.status === "ledger-corrupt") return { ok: false, reason: lookup.reason }
  if (lookup.status === "absent")
    return { ok: false, reason: `not installed: ${intent.type}:${intent.name} (no receipt in this scope's ledger)` }
  const record = lookup.status === "valid" ? lookup.record : null
  const v1 = lookup.status === "v1" ? lookup.receipt : null
  if (record && record.scope.kind === "project") {
    if (intent.scope !== "project") return { ok: false, reason: "fail closed: record is project-scoped but intent is global" }
    const verified = verifyProjectScope(record, intent.projectDir)
    if (!verified.ok) return verified // 项目被移动/identity 不符 → 拒绝,绝不退化为 global 卸载(AC#4)
  }
  const configKey = record?.configKey ?? v1?.configKey

  const tx = (deps.transaction ?? passthroughTx).begin({ op: "uninstall", kind: intent.type, name: intent.name, scope: intent.scope })
  const rollback = (reason: string): void => (deps.transaction ?? passthroughTx).rollback(tx.txId, reason)

  let removedFiles: string[] | undefined
  if (intent.type === "skill" && intent.scope !== "project" && fs.existsSync(skillStorePaths(root, intent.name).store)) {
    // REQ-100 #313:generation-backed skill 卸载走锁内 journaled store+ledger teardown(store-first),
    // 不留孤儿 generation,账本删除失败即 fail-closed(不谎报成功)。恢复补偿见 recoverExtensionTransactions。
    ;(deps.transaction ?? passthroughTx).commit(tx.txId) // 外层通知钩子无副作用;真事务在引擎内
    const r = await uninstallExtensionTransaction(root, skillGenerationKey(intent.name), {
      commitLedger: () => {
        const rm = removeRecordV2(root, "skill", intent.name)
        if (!rm.ok) throw new Error(rm.reason)
      },
    })
    if (!r.ok) return { ok: false, reason: r.reason }
    return { ok: true, ...(r.removed.length ? { files: r.removed } : {}) }
  }
  if (intent.type === "skill" || intent.type === "agent") {
    const r = deps.installers.removeFsInstall(intent.type, intent.name, target)
    if (!r.ok) {
      rollback(r.reason)
      return r
    }
    removedFiles = r.files
  } else if (intent.type === "mcp") {
    deps.installers.removeMcpSecrets(intent.name)
    const r = deps.installers.removeMcp(intent.name)
    if (!r.ok) {
      rollback(r.reason)
      return r
    }
  } else if (intent.type === "plugin") {
    if (configKey?.startsWith("plugin-path:")) {
      // vendored:owned path 从受控根 + name 重新派生;账本路径必须落在派生目录内,否则 fail closed。
      const derivedDir = path.join(deps.globalRoot(), "plugins", intent.name)
      const ledgerJs = configKey.slice("plugin-path:".length)
      if (path.resolve(ledgerJs) !== path.join(derivedDir, "plugin.js")) {
        rollback("ledger plugin path outside derived root")
        return { ok: false, reason: `fail closed: ledger plugin path "${ledgerJs}" does not match derived "${path.join(derivedDir, "plugin.js")}" — refusing` }
      }
      const r = deps.installers.removePluginPath(intent.name, ledgerJs)
      if (!r.ok) {
        rollback(r.reason)
        return r
      }
      try {
        fs.rmSync(derivedDir, { recursive: true, force: true })
      } catch {
        /* best-effort:config 已净除 */
      }
      removedFiles = [derivedDir]
    } else {
      const pkg = configKey?.startsWith("plugin:") ? configKey.slice("plugin:".length) : intent.name
      const r = deps.installers.removePlugin(pkg)
      if (!r.ok) {
        rollback(r.reason)
        return r
      }
    }
  } else if (intent.type === "cloud") {
    // receipts-only:去账即卸载。
  } else {
    rollback(`cannot uninstall type: ${intent.type}`)
    return { ok: false, reason: `cannot uninstall type: ${intent.type}` }
  }

  const removed = removeRecordV2(root, intent.type, intent.name)
  ;(deps.transaction ?? passthroughTx).commit(tx.txId)
  const warning = removed.ok ? undefined : `uninstalled but ledger removal failed: ${removed.reason}`
  return { ok: true, ...(removedFiles ? { files: removedFiles } : {}), ...(warning ? { warning } : {}) }
}

// ── generation history(REQ-100 #313:列代 + 两版离线回滚;key 面与卸载同一信任边界)─────────────

export type GenerationListOutcome = { ok: true; generations: SkillGenerationEntry[] } | { ok: false; reason: string }

/** 列某 skill 的 generation 历史。只透安全元数据(genId/current/version/digest/installedAt/eligible),
 *  绝对目录不出 main;generation store 仅 global 域(与 uninstallByKey 的 generation 路径同界)。 */
export function listGenerationsByKey(rawIntent: unknown, deps: Pick<PlannerDeps, "globalRoot">): GenerationListOutcome {
  const decoded = decodeUninstallIntent(rawIntent)
  if (!decoded.ok) return decoded
  const intent = decoded.intent
  if (intent.type !== "skill") return { ok: false, reason: `generation history: unsupported type "${intent.type}" — skill only` }
  if (intent.scope !== "global") return { ok: false, reason: "generation history: global scope only" }
  return { ok: true, generations: listSkillGenerations(deps.globalRoot(), intent.name) }
}

export type GenerationRollbackOutcome = { ok: true; previous: string | null } | { ok: false; reason: string }

/** 两版离线回滚:renderer 只提供 key + 目标 genId;健康门/快照校验/锁内翻指针全在引擎侧 fail-closed
 *  (rollbackGenerationTransaction),任一前置失败零变更。 */
export async function rollbackGenerationByKey(
  rawIntent: unknown,
  rawGenId: unknown,
  deps: Pick<PlannerDeps, "globalRoot">,
): Promise<GenerationRollbackOutcome> {
  const decoded = decodeUninstallIntent(rawIntent)
  if (!decoded.ok) return decoded
  const intent = decoded.intent
  if (intent.type !== "skill") return { ok: false, reason: `rollback: unsupported type "${intent.type}" — skill only` }
  if (intent.scope !== "global") return { ok: false, reason: "rollback: global scope only" }
  if (typeof rawGenId !== "string" || rawGenId.length === 0 || rawGenId.length > 64) return { ok: false, reason: "rollback: invalid generation id" }
  return rollbackSkillGeneration(deps.globalRoot(), intent.name, rawGenId)
}

// ── desired state(Hub 项目上下文「禁用」;main 侧真源,引擎生效面由消费方处理)──────────────────

export type SetStateIntent = UninstallIntent & { state: DesiredState }

/** 严格解码同卸载意图(key 面完全一致 + state 枚举);伪造 receipt/路径同样无通道。 */
export function decodeSetStateIntent(input: unknown): { ok: true; intent: SetStateIntent } | { ok: false; reason: string } {
  if (!isObj(input)) return { ok: false, reason: "intent: must be an object" }
  const { state, ...rest } = input
  if (state !== "enabled" && state !== "disabled") return { ok: false, reason: `intent.state: ${JSON.stringify(state)} not "enabled" | "disabled"` }
  const base = decodeUninstallIntent(rest)
  if (!base.ok) return base
  return { ok: true, intent: { ...base.intent, state } }
}

/** desiredState 翻转:scope 独立(global/各项目账本物理分域),项目 identity fail-closed 同卸载。 */
export function setInstallStateByKey(rawIntent: unknown, deps: Pick<PlannerDeps, "globalRoot">): { ok: true } | { ok: false; reason: string } {
  const decoded = decodeSetStateIntent(rawIntent)
  if (!decoded.ok) return decoded
  const intent = decoded.intent
  let root: string
  if (intent.scope === "project") {
    if (!PROJECT_SCOPED_KINDS.has(intent.type)) return { ok: false, reason: `kind "${intent.type}" cannot be project-scoped` }
    const identity = projectScopeIdentity(intent.projectDir)
    if (!identity.ok) return { ok: false, reason: `fail closed: ${identity.reason}` }
    const projectRoot = alphaRoot(identity.scope.projectPath)
    if (!projectRoot) return { ok: false, reason: `fail closed: invalid project root: ${intent.projectDir}` }
    root = projectRoot
  } else {
    root = deps.globalRoot()
  }
  const record = findRecordV2(root, intent.type, intent.name)
  if (!record) return { ok: false, reason: `no v2 record for ${intent.type}:${intent.name} in this scope — fail closed (v1-only installs have no desired-state channel)` }
  if (record.scope.kind === "project") {
    if (intent.scope !== "project") return { ok: false, reason: "fail closed: record is project-scoped but intent is global" }
    const verified = verifyProjectScope(record, intent.projectDir)
    if (!verified.ok) return verified
  }
  return setDesiredStateV2(root, intent.type, intent.name, intent.state)
}
