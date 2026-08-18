// Main-only install planner — REQ-099 Phase 0 (ADR-028 §1/§2) + Phase 1 integration (§3-§5).
//
// The renderer's catalog install request is narrowed to `{ catalogId, scope, grants }` and its
// uninstall request to `{ type, name, scope(, projectDir) }`. EVERY install fact — name, server
// config, npm package, asset key, owned paths — is re-derived here from the VERIFIED catalog
// (ed25519-verified remote/cache → bundled byte snapshot) and from main's own ledger. Forged
// renderer facts have no channel: unknown intent keys are rejected by the strict decoders, and
// grants are validated against what the catalog entry declares (requiredEnvVars).
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
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import type { InstallReceiptType } from "../preload/types"
import type { CatalogEntry, McpInstallSpec } from "../renderer/extensions/catalog-types"
import { isExtensionName } from "../shared/extension-name"
import {
  isAlphaOfficeMcp,
  isWorkspacePolicyMcp,
  retiredCommunityOfficeFor,
} from "../shared/office-advisories"
import type { AppEnvironment } from "./alpha-environment"
import { alphaRoot } from "./alpha-workdir"
import type { AdvisoryGate } from "./ext-advisory-gate"
import { readGenerationReceiptSnapshot } from "./ext-transaction"
import { tryAcquireBundleLock } from "./ext-bundle-lock"
import {
  runExtensionTransaction,
  actionOf,
  uninstallExtensionTransaction,
  type TxAuthorizationDecision,
  type TxCommitRecord,
  type TxFileSpec,
  type TxHooks,
  type TxPlan,
  type TxPlanItem,
  type TxStage,
} from "./ext-transaction"
import { capabilityGrantPath, isSafeCapability, type CapabilityDiff } from "./ext-capability-grants"
import { agentConfigItemKey, agentInstallKey, installAgentFromCas, recoveryReceiptInputs } from "./ext-agent-install"
// #705:plugin 载荷 file 探针与 agent/skill 探针同住 ext-health-probe-router —— 组合点只有一份。
import { collectMcpFileRefPaths, isAbsenceError, newMcpSecretVersionId, pathIdentity, resolveMcpRefPath, substituteMcpSecretRefsPure } from "./alpha-mcp-secrets"

/** `{file:<abs>}` 引用 → 文件路径(非引用形状 = null;#378 r1 锁内在场门与失败清理共用)。 */
function mcpRefPathOf(ref: string): string | null {
  const m = /^\{file:(.+)\}$/.exec(ref)
  return m?.[1] ?? null
}

/** #378 r3(Major):plugin[] 条目按**引擎语义**解析为绝对路径 —— 引擎(config/plugin.ts
 *  isPathPluginSpec/resolvePluginSpec)把 `file://`、`.` 前缀与绝对路径当路径,相对路径按
 *  **config 文件所在目录**解析;词法 `includes`/CWD `resolve` 会漏等价形态(`./plugins/...`、
 *  `file://.../plugin.js`、`/a/./b`)。非路径形态(npm 包名)= null。 */
/** plugin[] 成员的 spec 头(引擎 pluginSpecifier 同判:string 或 [spec, options] 元组)。
 *  #378 r5:校验/等值比较/换元三阶段共用,元组不许再有任何一处按整值与字符串比较。 */
function pluginSpecOf(x: unknown): string | null {
  if (typeof x === "string") return x
  if (Array.isArray(x) && typeof x[0] === "string") return x[0]
  return null
}

function resolvePluginEntryPath(entry: unknown, configDir: string): string | null {
  const spec = pluginSpecOf(entry)
  if (spec === null || spec.length === 0) return null
  let p = spec
  if (p.startsWith("file://")) {
    try {
      p = fileURLToPath(p)
    } catch {
      return null
    }
  } else if (!p.startsWith(".") && !path.isAbsolute(p)) {
    return null // npm 包名形态,非路径(与引擎 isPathPluginSpec 同判)
  }
  return path.resolve(configDir, p)
}

/** #378 r7(Major):escape-hatch 环境(ALPHA_JSONC_TRUTH_DISABLE / ALPHA_LEGACY_INSTALL_ROOT)
 *  把引擎配置真源路由到事务根之外 —— config action 圈禁只能写 <root>/alpha.jsonc,照常提交会
 *  「账本记 active、引擎读不到」谎报成功。诚实 fail-closed:真源不在根内即拒。 */
function configTruthInRootGate(root: string, truthPath: string): { ok: true } | { ok: false; reason: string } {
  if (path.resolve(truthPath) === path.resolve(path.join(root, "alpha.jsonc"))) return { ok: true }
  return {
    ok: false,
    reason: `engine config truth is routed to "${truthPath}" (escape-hatch env) — transactional single-install writes <root>/alpha.jsonc only; refusing to record an install the engine cannot see`,
  }
}

/** REQ-136 C2:the write-channel gate proves D before asynchronous catalog work. Reprove the exact
 * project root and every transaction-owned endpoint immediately before the transaction creates its
 * lock, then repeat inside the lock before config preparation. */
function projectMcpWriteIdentityGate(
  root: string,
  target: string,
): { ok: true } | { ok: false; reason: string } {
  try {
    assertProjectMcpTransactionRootIdentity(root)
  } catch {
    return { ok: false, reason: "project MCP root identity changed before commit — refused" }
  }
  if (path.resolve(target) !== path.resolve(path.join(root, "alpha.jsonc")))
    return { ok: false, reason: "project MCP config target is not D/.alpha/alpha.jsonc — refused" }
  return { ok: true }
}

/** #378 r1(Major):cloud 重装的锁内 desiredState 漂移门 —— plan 快照在锁外读,锁内重读
 *  不一致即拒(否则并发 disable 会被旧快照写回 enabled)。导出供直接单测。 */
export function cloudDesiredStateGate(
  root: string,
  name: string,
  planned: "enabled" | "disabled",
): { ok: true } | { ok: false; reason: string } {
  const rec = findRecordV2(root, "cloud", name)
  const current: "enabled" | "disabled" = rec?.desiredState === "disabled" ? "disabled" : "enabled"
  return current === planned ? { ok: true } : { ok: false, reason: "cloud desiredState changed since plan — retry the install" }
}
import { parse, type ParseError } from "jsonc-parser"
import { capabilitiesForCatalogEntry, type AuthorizationConfirmationWire } from "../shared/ext-capability-authorization"
import {
  curationActivationFacts,
  decodeEntryCuration,
  isCurationArchived,
  isReviewExpired,
  type ActivationPolicy,
  type CurationStatus,
} from "../shared/catalog-curation"
import { nextDesiredState } from "./ext-install-policy"
import { readSessionGrantIdsSync, type SessionGrantOracle } from "./ext-curation-policy"
import type { ChannelName } from "./catalog-channels"
import { findReceipt } from "./alpha-installs"
import {
  aggregateFilesDigest,
  computeManifestDigest,
  decodeManifestV2,
  sha256Hex,
  MANIFEST_SCHEMA_VERSION,
  type ExtensionManifestV2,
  type ManifestCapability,
  type ManifestKind,
} from "./ext-manifest-v2"
import { ownershipFromCatalogEntry, runtimeSurfacesForCatalogEntry } from "../shared/ext-ownership"
import {
  computeGrantDigest,
  findRecordV2,
  lookupForUninstall,
  planDirectUninstall,
  projectScopeIdentity,
  releaseStandaloneClaim,
  removeRecordV2,
  setDesiredStateV2,
  probeLedgerForWrite,
  readLedgerV2,
  readPackageLedgerStateV1,
  reconcileSkillsDerivation,
  upsertRecordsV2,
  verifyProjectScope,
  type DesiredState,
  type InstallRecordV2,
  type ScopeIdentity,
  type UpsertInput,
} from "./ext-receipt-v2"
import type { PackageEnvelopeIdentityV1 } from "./package-installability"
import { parseOwnerToken } from "./ext-package-ledger-v3"
import {
  commitInputFromRecord,
  hasSkillGeneration,
  installSkillGeneration,
  listSkillGenerations,
  rollbackSkillGeneration,
  skillGenerationKey,
  skillGenerationProbe,
  skillStorePaths,
  type SkillGenerationEntry,
  type SkillPayloadFile,
} from "./ext-skill-generations"
import { promoteSeedAssetToCas, readPackagedSeed, verifySeedAsset, type SeedAsset } from "./ext-seed"
import { casBlobPath, materializeFilesFromCas, putCasBlobFromBuffer, readCasBlobVerified } from "./ext-cas"
import { isSafeRelPath } from "./ext-atomic-fs"
import { assertProjectMcpTransactionRootIdentity, validateServer } from "./ext-config"
import { prepareConfigTx, applyConfigImage, type ConfigEdit } from "./ext-config-tx"
import { collectImportSkillPayload, resourcesRoot } from "./ext-fs-installer"
import { checkUncuratedConflict, type UncuratedOrigin } from "./ext-uncurated-record"

// ── renderer intents(严格解码:未知键 = 伪造事实通道,loud 拒绝)─────────────────────────────

export type InstallScope = { scope: "global" } | { scope: "project"; projectDir: string }
export type InstallGrants = {
  /** 值 = 用户刚输入的密钥真值;变量名必须 ⊆ catalog 声明的 requiredEnvVars。 */
  secrets?: Record<string, string>
  /** 非密钥替换值;键同样必须 ⊆ requiredEnvVars。 */
  env?: Record<string, string>
  /** 中国镜像 env(值为 main 侧常量,renderer 只表达偏好)。 */
  cnMirror?: boolean
}
export type CatalogInstallIntent = {
  catalogId: string
  scope: InstallScope
  grants?: InstallGrants
  /** #348:authorize 重驱确认(renderer 只交 confirmed;decidedAt 审计戳由 main 生成)。 */
  authorization?: AuthorizationConfirmationWire
}
/** seed 安装意图(REQ-102 #317):renderer 只表达「选中哪个随包资产」;seedDir/CAS 根/文件清单/版本/
 *  receipt 元数据全部 main-owned。与 catalog 意图判别互斥(source 键在场 = seed 形态)。 */
export type SeedInstallIntent = { source: "seed"; assetId: string; scope: InstallScope; authorization?: AuthorizationConfirmationWire }

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
      /** #395(Codex r8 M4):MCP 因**默认关/当前 disabled** 安装成功但不激活连接。
       *  renderer 据此与「kind 漂移(装错类型)」区分:前者是成功的「装 ≠ 跑」,后者才是失败。 */
      installedDisabled?: true
      /** bundle:main 已验证(存在性/循环依赖/平台)的有序子条目 id。 */
      bundle?: { items: string[] }
      /** bundle:一次原子事务提交的子条目 id(REQ-100 #311)。 */
      installed?: string[]
      /** bundle:跳过的子条目(optional 未选 / 首期 fail-closed 排除)。含安装项的 bundle 会把
       *  skip 记进事务 journal;全 skip 的 bundle 零状态变更、不开事务,审计面 = 本 outcome。 */
      skipped?: Array<{ id: string; reason: string }>
      warning?: string
    }
  /** #348:authorize 暂停判别分支 —— 零权威副作用,携带逐 item diff 等确认后带 authorization
   *  重驱同一入口(Codex 裁决 C1:强制携带 diff,不允许折叠成裸 reason 字符串)。 */
  | { ok: false; stage: "authorize"; reason: string; authorization: CapabilityDiff[] }
  | { ok: false; reason: string; stage?: Exclude<TxStage, "authorize"> }

/** REQ-128 `#706`:`retainedForOwners` = 实物没删,因为它还属于这些 owner(仍在册的 Bundle);
 *  用户自己那份 standalone claim 已释放。缺省 = 走了正常的删实物 + 去账。 */
export type UninstallOutcome =
  | { ok: true; files?: string[]; warning?: string; retainedForOwners?: string[] }
  | { ok: false; reason: string }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
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

/** #348:authorize 确认的严格解码(Codex 裁决 B2 分界:解码层管结构 + 资源边界,引擎管语义 ——
 *  confirmed key ∈ 本次 plan、锁内最新 grants、requested ⊆ confirmed 整集覆盖都在引擎)。
 *  key 用引擎事务 item key 规则(SAFE_KEY/128),不沿用 catalog id 的 200 上限;decidedAt 无通道
 *  (审计戳 main 生成);重建全新 Record,不保留 renderer 对象引用。 */
const TX_ITEM_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
const MAX_CONFIRMED_ITEMS = 64 // 对齐引擎单事务 item 规模;超界 = 伪造面,整体拒绝
function decodeAuthorizationConfirmation(
  v: unknown,
): { ok: true; authorization: AuthorizationConfirmationWire } | { ok: false; reason: string } {
  if (!isObj(v)) return { ok: false, reason: "intent.authorization: must be an object" }
  for (const key of Object.keys(v)) {
    if (key !== "confirmed") return { ok: false, reason: `intent.authorization: unknown key "${key}" — refused` }
  }
  if (!isObj(v.confirmed)) return { ok: false, reason: "intent.authorization.confirmed: required object" }
  const entries = Object.entries(v.confirmed)
  if (entries.length > MAX_CONFIRMED_ITEMS)
    return { ok: false, reason: `intent.authorization.confirmed: too many items (${entries.length} > ${MAX_CONFIRMED_ITEMS})` }
  const confirmed: Record<string, string[]> = {}
  for (const [key, caps] of entries) {
    if (!TX_ITEM_KEY.test(key)) return { ok: false, reason: `intent.authorization.confirmed: invalid item key "${key}"` }
    if (!Array.isArray(caps) || caps.length > 32)
      return { ok: false, reason: `intent.authorization.confirmed["${key}"]: must be an array of ≤32 capabilities` }
    const seen = new Set<string>()
    const clean: string[] = []
    for (const cap of caps) {
      if (!isSafeCapability(cap)) return { ok: false, reason: `intent.authorization.confirmed["${key}"]: unsafe capability` }
      if (seen.has(cap)) return { ok: false, reason: `intent.authorization.confirmed["${key}"]: duplicate capability "${cap}"` }
      seen.add(cap)
      clean.push(cap)
    }
    confirmed[key] = clean
  }
  return { ok: true, authorization: { confirmed } }
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

/** 严格解码 renderer 安装意图:catalog 形态(catalogId + scope + grants)XOR seed 形态(source:"seed"
 *  + assetId + scope),判别互斥、未知键一个都不收(伪造安装事实无通道)。 */
export function decodeCatalogInstallIntent(input: unknown): { ok: true; intent: CatalogInstallIntent | SeedInstallIntent } | { ok: false; reason: string } {
  if (!isObj(input)) return { ok: false, reason: "intent: must be an object" }
  if (input.source !== undefined) {
    if (input.source !== "seed") return { ok: false, reason: `intent.source: ${JSON.stringify(input.source)} not "seed"` }
    for (const key of Object.keys(input)) {
      if (key !== "source" && key !== "assetId" && key !== "scope" && key !== "authorization")
        return { ok: false, reason: `seed intent: unknown key "${key}" — renderer-supplied install facts are refused (ADR-028 §1)` }
    }
    if (typeof input.assetId !== "string" || input.assetId.length === 0 || input.assetId.length > 200)
      return { ok: false, reason: "intent.assetId: required non-empty string" }
    const scope = decodeScope(input.scope)
    if (!scope.ok) return scope
    let seedAuthz: AuthorizationConfirmationWire | undefined
    if (input.authorization !== undefined) {
      const a = decodeAuthorizationConfirmation(input.authorization)
      if (!a.ok) return a
      seedAuthz = a.authorization
    }
    return { ok: true, intent: { source: "seed", assetId: input.assetId, scope: scope.scope, ...(seedAuthz ? { authorization: seedAuthz } : {}) } }
  }
  for (const key of Object.keys(input)) {
    if (key !== "catalogId" && key !== "scope" && key !== "grants" && key !== "authorization")
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
      if (!["secrets", "env", "cnMirror"].includes(key))
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
    if (input.grants.cnMirror !== undefined) {
      if (typeof input.grants.cnMirror !== "boolean") return { ok: false, reason: "intent.grants.cnMirror: must be a boolean" }
      grants.cnMirror = input.grants.cnMirror
    }
  }
  let authorization: AuthorizationConfirmationWire | undefined
  if (input.authorization !== undefined) {
    const a = decodeAuthorizationConfirmation(input.authorization)
    if (!a.ok) return a
    authorization = a.authorization
  }
  return {
    ok: true,
    intent: { catalogId: input.catalogId, scope: scope.scope, ...(grants ? { grants } : {}), ...(authorization ? { authorization } : {}) },
  }
}

/** 严格解码卸载意图:type + name + scope(+ projectDir)。绝对路径/receipt 字段没有通道(ADR-028 §1)。 */
export function decodeUninstallIntent(input: unknown): { ok: true; intent: UninstallIntent } | { ok: false; reason: string } {
  if (!isObj(input)) return { ok: false, reason: "intent: must be an object" }
  for (const key of Object.keys(input)) {
    if (!["type", "name", "scope", "projectDir"].includes(key))
      return { ok: false, reason: `uninstall intent: unknown key "${key}" — renderer-supplied receipts/paths are refused (ADR-028 §1)` }
  }
  if (typeof input.type !== "string" || !RECEIPT_TYPES.has(input.type)) return { ok: false, reason: "intent.type: not a known type" }
  if (typeof input.name !== "string" || !isExtensionName(input.name)) return { ok: false, reason: "intent.name: invalid name" }
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

function capabilitiesFor(entry: CatalogEntry): ManifestCapability[] {
  // #396:派生逻辑上移 shared/ext-capability-authorization —— 确认框(#348)与 Pack 整包事实
  // 同一真源,两处永不漂移(v5 稿硬约束)。本地包一层保住既有调用面与命名。
  return capabilitiesForCatalogEntry(entry)
}

/** 从已验 catalog 条目合成 ManifestV2(五维 ownership 推导 = shared/ext-ownership 真源,REQ-103 slice 1)。 */
export function synthesizeManifest(verified: VerifiedCatalogEntry): unknown {
  const { entry, channel, catalogVersion } = verified
  const surfaces = runtimeSurfacesForCatalogEntry(entry)
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    id: entry.id,
    name: entry.name,
    kind: entry.type,
    version: typeof entry.version === "string" && entry.version ? entry.version : catalogVersion,
    compatibility: { platforms: ["darwin", "win32"] }, // ADR-026 桌面双平台;catalog 无逐条声明时的诚实默认
    capabilities: capabilitiesFor(entry),
    dependencies: (entry.bundleItems ?? []).map((it) => ({ id: it.catalogEntryId, optional: it.optional === true })),
    ownership: ownershipFromCatalogEntry(entry, channel),
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
  alphaResources = resourcesRoot(),
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
  const alphaResourceArgs = command.filter((argument) => argument.includes("{alphaResources}"))
  if (
    alphaResourceArgs.length > 0 &&
    (alphaResourceArgs.length !== 1 || alphaResourceArgs[0] !== "{alphaResources}/office-mcp/server.py" || !isAlphaOfficeMcp("", { type: "local", command }))
  ) {
    return { ok: false, reason: "{alphaResources} is reserved for the bundled Alpha Office server entrypoints — refused" }
  }
  const cmd = command.map((argument) => argument.split("{alphaResources}").join(alphaResources))
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
  /** #378(Codex 裁决 Q2):MCP 写盘策略闸口。REQ-135 retired package denial and REQ-133
   *  Alpha Office resource/workspace canonicalization share this main-owned seam. It may update the
   *  server in place; single-install transactions and uncurated writes consume the same verdict. */
  applyMcpWritePolicy(name: string, server: Record<string, unknown>): ConfigOutcome
  /** #378(Codex 裁决 Q1):版本化密钥原语 —— 引用纯推导(零写盘,planner 先构造 durable config)
   *  与落盘(硬化写:tmp→rename、0600、lstat 圈禁)必须同参;removeMcpSecretVersionDir 只删
   *  **本次尝试**的版本目录(失败/authorize 暂停清理;无引用,惰性);gcMcpSecrets = 提交后在
   *  配置锁内按当前 leaf 引用收未引用且过宽限的旧版本/flat/快照残留(busy 跳过,best-effort)。 */
  mcpSecretRefFor(name: string, verId: string, varName: string): string
  /** r1 Minor:版本目录排他认领 —— 碰撞(exists)换 id 重试,绝不复用既有版本目录。 */
  claimMcpSecretVersionDir(name: string, verId: string): { ok: true } | { ok: false; exists: boolean; reason: string }
  writeMcpSecretVersioned(name: string, verId: string, varName: string, value: string): { ok: true; ref: string } | { ok: false; reason: string }
  removeMcpSecretVersionDir(name: string, verId: string): { ok: true } | { ok: false; reason: string }
  gcMcpSecrets(name: string): { removed: string[]; warnings: string[] }
  /** #378 r10:全部 legacy 源 mcp.<name> leaf 的 {file:} 引用集(失败清理的「仍被引用」判定
   *  必须覆盖合并视图;strict:读不出即失败,调用方保守不删)。 */
  legacyMcpRefPaths(name: string): { ok: true; refs: string[] } | { ok: false; reason: string }
  /** #354(必改 2):可失败的严格 leaf 前像读 —— 「不存在」= 合法 undefined,「不可读/形状异常」
   *  必须写前拒绝(#378 起前像本体由引擎 config action 整文件 image journaled,此读只作产品语义
   *  早拒 + 锁内 precondition 重验)。 */
  readMcpLeafStrict(name: string, targetPath?: string): { ok: true; value: Record<string, unknown> | undefined } | { ok: false; reason: string }
  /** #346:journaled MCP 卸载的 in-lock 原语 —— 仅删配置副本(主+legacy),零账本副作用,
   *  失败如实返回(legacy 不可读也算失败)。**只在 uninstallExtensionTransaction 锁内调用**。 */
  removeMcpConfigInLock(name: string): ConfigOutcome
  /** REQ-136:project MCP 的 root-parametric in-lock 删除原语。只删 `<root>/alpha.jsonc`
   *  的目标 leaf；不触碰 global/legacy 配置、密钥或连接绑定。 */
  removeProjectMcpConfigInLock(root: string, name: string): ConfigOutcome
  /** #346:严格密钥吊销 —— 失败可观察(journal 据此保持非终态);目录缺失 = 幂等成功。
   *  整 server 目录删除,天然覆盖 #378 的全部版本目录 + legacy flat。 */
  removeMcpSecretsStrict(name: string): { ok: true } | { ok: false; reason: string }
  /** `#704`:卸载时**只释放**这个组件对 Alpha Connection 的绑定,绝不 disconnect/revoke。
   *  连接是共享的、且真实副作用在 provider 那边,所以「最后一个绑定消失」不是删除条件 ——
   *  它只是「当前没有已安装的包在用」。释放失败不阻断卸载(陈旧绑定只会让连接被多留一会儿,
   *  那是安全的方向);删除只有显式 disconnect 一条路。 */
  releaseAlphaConnectionBindings(componentId: string): { ok: true } | { ok: false; reason: string }
  /** #378(Codex 裁决 Q5):npm plugin 跨配置源(主 + legacy XDG)同 base 严格检查 —— 任一侧
   *  在场都不是 fresh;任一侧不可读即拒(不能当不存在)。计划前与锁内 precondition 双调。 */
  findPluginBaseConflictStrict(pkg: string): { ok: true; existing: { spec: string; source: "main" | "legacy" } | undefined } | { ok: false; reason: string }
  /** #352:plugin[] 的 strict 快照读(替换的 plan 快照 + 锁内 precondition 重读)。 */
  readPluginArrayStrict(): { ok: true; value: unknown[] } | { ok: false; reason: string }
  /** #378 r6/r7:**全部** legacy 配置源(XDG + retained home 等)plugin[] 的 strict 读 ——
   *  同名路径冲突/GC 引用对账必须看得见每一份;成员形状非法 fail-closed;每源携带 configDir
   *  (相对条目按其所在目录解析)。 */
  readLegacyPluginArrayStrict(): { ok: true; sources: Array<{ value: unknown[]; configDir: string }> } | { ok: false; reason: string }
  /** #378 r7:引擎配置真源路径(escape-hatch 路由后)—— 事务安装前置门比对事务根。 */
  mcpConfigTruthPath(): string
  /** #352:vendored 替换的纯 staging —— 新内容落 versioned 目录,零 config/账本副作用。 */
  stageVendoredPluginVersioned(vendoredAssetKey: string, name: string, precollected?: Array<{ path: string; data: Buffer }>): { ok: true; dir: string; jsPath: string } | { ok: false; reason: string }
  removePlugin(pkg: string): ConfigOutcome
  /** #378:收集 vendored plugin 随包目录为原始载荷(CAS 摄取 → file items 事务;只读零副作用;
   *  symlink/非常规条目拒,srcDir realpath 圈禁 resources 树内)。 */
  collectVendoredPluginPayload(vendoredAssetKey: string, name: string): { ok: true; files: Array<{ path: string; data: Buffer }> } | { ok: false; reason: string }
  removePluginPath(name: string, absJsPath: string): ConfigOutcome
  installBuiltinSkill(builtinAssetKey: string, name: string, target?: TargetArg, meta?: InstallMetaArg): FsOutcome
  /** REQ-100 #310:收集 builtin skill 随包目录为载荷(generation 事务 populate 用;不落 flat 目录)。 */
  collectBuiltinSkillPayload(builtinAssetKey: string, name: string): { ok: true; files: Array<{ path: string; data: Buffer }> } | { ok: false; reason: string }
  /** #361:收集 builtin agent 随包 md 为原始载荷(CAS 摄取 → installAgentFromCas;byte-exact,零副作用)。 */
  collectBuiltinAgentPayload(builtinAssetKey: string, name: string): { ok: true; files: Array<{ path: string; data: Buffer }> } | { ok: false; reason: string }
  installRemoteSkill(name: string, contents: Array<{ path: string; data: Buffer }>, target?: TargetArg, meta?: InstallMetaArg): FsOutcome
  removeFsInstall(type: "skill" | "agent", name: string, target?: TargetArg): FsOutcome
  /** #354(必改 3 替代路径):agent 无更新链 → 写前存在性检查,既有(有账/无账文件)一律拒绝;
   *  由此 agent 安装可证明 fresh,提交面失败补偿 removeFsInstall 不毁旧物。 */
  agentPresent(name: string, target?: TargetArg): boolean
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

/** `#817`:签名 package child 启停闸的 catalog 解析结果。选择必须是 **(packageId, version) 双键**
 *  精确匹配(`validateCatalogPackageShape` 允许同 packageId 多版本并存 —— 单键 `.find` 会错拿
 *  版本,把真实可验证的安装拒掉);`missing.anyVersionPresent` 供拒绝文案区分「整包下架」与
 *  「已装版本不再发布」。 */
export type VerifiedCatalogPackageResolution =
  | { status: "refused"; reason: string }
  | { status: "missing"; channel: "remote" | "cache" | "bundled"; anyVersionPresent: boolean }
  | { status: "found"; channel: "remote" | "cache" | "bundled"; identity: PackageEnvelopeIdentityV1 }

export type PlannerDeps = {
  resolveEntry(catalogId: string): Promise<VerifiedCatalogEntry | null>
  /** `#817`:签名 package child 的启停解析面(已验 catalog `packages[]`,双键精确)。package-managed
   *  记录只走此面,**绝不**回退 `resolveEntry`(legacy `entries[]` 从来不含 package child)。 */
  resolvePackage(packageId: string, version: string): Promise<VerifiedCatalogPackageResolution>
  environment(): AppEnvironment
  platform(): NodeJS.Platform
  globalRoot(): string
  installers: PlannerInstallers
  transaction?: InstallTransactionHooks
  now?(): string
  /** 共享 CAS 基根(CAS 落 <casBaseRoot>/cas;prod/beta/dev 共享,覆盖态 = 覆盖根)。main 注入
   *  冻结环境快照(REQ-098 #303);renderer 无路径通道。 */
  casBaseRoot(): string
  /** #315:advisory 激活闸(每操作冻结视图;main 组合根 makeAdvisoryGate 注入,必填 ——
   *  可选缺省 = fail-open 陷阱)。 */
  advisoryGate: AdvisoryGate
  /** seed 安装通道(REQ-102 #317)。缺席 = 通道不可用,seed 意图 fail-closed 拒。 */
  seed?: {
    /** 随包 seed 目录(main 从 resourcesPath 派生;renderer 无输入权)。null = 未打包/无 seed。 */
    seedDir(): string | null
    /** 回表同包 bundled catalog 快照 —— 绝不走 effective remote/cache(远端可能比随包 seed 新,
     *  语义漂移会让 seed 字节配错安装事实)。 */
    resolveBundledEntry(catalogId: string): VerifiedCatalogEntry | null
  }
}

/** #315:catalog entry → advisory gate 输入(digest 双域:file-sha256 逐文件、aggregate-files 聚合)。 */
function advisoryInputOf(
  entry: { id: string; name?: string; remoteAsset?: { files: Array<{ path: string; sha256: string }> } },
  provenance: "remote" | "cache" | "bundled" | "seed",
) {
  const files = entry.remoteAsset?.files
  return {
    catalogId: entry.id,
    name: entry.name,
    fileDigests: files?.map((f) => f.sha256),
    payloadDigest: files && files.length ? aggregateFilesDigest(files) : undefined,
    provenance,
  }
}

/** #397:安装/落账用 curation 消费事实(合同 §7.1/§7.2)。唯一采信入口 = decodeEntryCuration
 *  (fail-closed:未策展/校验失败 → 空 facts = #395 保守面)。decode 纯且廉价,逐位点就地计算,
 *  不跨函数传递(避免 facts 与 entry 脱钩的错配面)。 */
function curationPolicyFactsOf(
  entry: CatalogEntry,
  nowIso: string,
): { activationPolicy?: ActivationPolicy; reviewExpired?: boolean } {
  return curationActivationFacts(decodeEntryCuration(entry), nowIso)
}

/** #397:entry 级 curation 采信 + loud 上报(invalid = fail-closed 到保守面,绝不部分采信)。 */
function decodeEntryCurationLoud(entry: CatalogEntry): CurationStatus {
  const status = decodeEntryCuration(entry)
  if (status.kind === "invalid")
    console.error(`[req104-397] entry ${entry.id}: curation FAILED validation — fail closed to the uncurated conservative face (${status.reason})`)
  return status
}

// #397(Codex r3):session-grant 非法 prior 的归位 = 账本 upsert 写点例外
// (ext-receipt-v2 UpsertInput.sessionGrantEnforced,与 receipt 同原子)—— 本文件各安装路径
// 只在计划期给 receipt 模板**打标**(纯数据),不做任何计划期/锁内预写。

/** 目标卷可移植的路径碰撞键(Codex review #363 Major 2):darwin/win32 常见大小写不敏感 +
 *  Unicode normalization 折叠 —— 折叠后相同即视为同一物理落点,清单歧义直接拒。 */
const portablePathKey = (p: string): string => p.normalize("NFC").toLowerCase()
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** 段级可移植性拒绝:Windows 保留名、尾随点/空格(NTFS 折叠)。isSafeRelPath 只管结构,这里管卷语义。 */
function portablePathProblem(p: string): string | null {
  for (const seg of p.split("/")) {
    if (WINDOWS_RESERVED_RE.test(seg)) return `reserved filename segment "${seg}"`
    if (seg !== seg.trimEnd() || seg.endsWith(".")) return `trailing dot/space in segment "${seg}"`
  }
  return null
}

/** 载荷 → 验证共享 CAS(REQ-098 #303):严格两遍式 —— 第一遍全量结构校验(载荷与清单按 path 精确
 *  一一对应且不靠数组序、拒重复/缺项/多项/不安全路径/可移植性碰撞、bytes 精确),全部通过后第二遍
 *  才逐文件 putCasBlobFromBuffer(下载/收集层已验一次 digest,put 内再验一次)——校验失败时 CAS
 *  零写入。put 失败 = 整装 fail-closed;已写入 blob 不逆删(可能已被并发/他环境引用),交 GC
 *  grace(#318)。put 自愈损坏在店 blob 的 warnings loud 透传。
 *
 *  REQ-128 Phase 3 `#781`:**导出**给本地 Claude 插件包的安装路径复用(`claude-plugin-install.ts`
 *  要为 N 个技能各提升一份多文件载荷)。逻辑一个字未改 —— 自己写一份「把 buffer 塞进 CAS」的
 *  替身就会漏掉这里的第一遍结构校验(路径安全 / 大小写折叠碰撞 / bytes 精确),而那些正是
 *  「校验失败时 CAS 零写入」这条保证的全部内容。 */
export function promotePayloadToCas(
  casBaseRoot: string,
  payload: Array<{ path: string; data: Buffer }>,
  manifest: Array<{ path: string; sha256: string; bytes: number }>,
): { ok: true; specs: TxFileSpec[]; warnings: string[] } | { ok: false; reason: string } {
  // ── 第一遍:纯校验,零写入 ──
  if (payload.length !== manifest.length)
    return { ok: false, reason: `payload/manifest file count mismatch: ${payload.length} ≠ ${manifest.length} — refusing before CAS write` }
  const byPath = new Map<string, { path: string; sha256: string; bytes: number }>()
  const portable = new Set<string>()
  for (const m of manifest) {
    if (!isSafeRelPath(m.path)) return { ok: false, reason: `unsafe manifest path: ${String(m.path)} — refused` }
    const problem = portablePathProblem(m.path)
    if (problem) return { ok: false, reason: `non-portable manifest path ${m.path}: ${problem} — refused` }
    if (byPath.has(m.path)) return { ok: false, reason: `duplicate manifest path: ${m.path} — refused` }
    const folded = portablePathKey(m.path)
    if (portable.has(folded))
      return { ok: false, reason: `manifest path collision under case/unicode folding: ${m.path} — refused (ambiguous on darwin/win32 volumes)` }
    portable.add(folded)
    byPath.set(m.path, m)
  }
  const seen = new Set<string>()
  const toPut: Array<{ path: string; data: Buffer; sha256: string; bytes: number }> = []
  for (const f of payload) {
    const m = byPath.get(f.path)
    if (!m) return { ok: false, reason: `payload file ${f.path} not in manifest — refused` }
    if (seen.has(f.path)) return { ok: false, reason: `duplicate payload path: ${f.path} — refused` }
    seen.add(f.path)
    if (f.data.length !== m.bytes)
      return { ok: false, reason: `size mismatch for ${f.path}: ${f.data.length} ≠ ${m.bytes} — refusing before CAS write` }
    toPut.push({ path: f.path, data: f.data, sha256: m.sha256, bytes: m.bytes })
  }
  // ── 第二遍:全部校验通过后才写 CAS ──
  const specs: TxFileSpec[] = []
  const warnings: string[] = []
  for (const f of toPut) {
    const put = putCasBlobFromBuffer(casBaseRoot, f.data, f.sha256)
    if (!put.ok) return { ok: false, reason: `CAS promotion failed for ${f.path}: ${put.reason}` }
    warnings.push(...put.warnings)
    specs.push({ path: f.path, sha256: f.sha256, size: f.bytes })
  }
  return { ok: true, specs, warnings }
}

/** #348(Codex 必改 5):remote 载荷的 CAS 复用探测 —— 首驱已把 blob 提升进共享 CAS,authorize
 *  确认重驱不得再次访问网络。逐 blob **读取重验**(readCasBlobVerified:防盘上篡改)+ bytes 精确,
 *  且清单结构过与 promotePayloadToCas 第一遍同源的路径守卫;全部命中才复用,并 touch mtime
 *  (GC #318 的 grace 以 mtime 计,复用即续命);任一缺失/损坏 → cache miss,回下载路径
 *  (下载层继续按清单 digest 验证)。manifest/digest 变化自然 miss。 */
function tryReuseCasPayload(
  casBaseRoot: string,
  manifest: Array<{ path: string; sha256: string; bytes: number }>,
): { hit: true; specs: TxFileSpec[] } | { hit: false } {
  if (manifest.length === 0) return { hit: false }
  const portable = new Set<string>()
  const specs: TxFileSpec[] = []
  for (const m of manifest) {
    if (!isSafeRelPath(m.path) || portablePathProblem(m.path)) return { hit: false }
    const folded = portablePathKey(m.path)
    if (portable.has(folded)) return { hit: false }
    portable.add(folded)
    const read = readCasBlobVerified(casBaseRoot, m.sha256)
    if (!read.ok || read.data.length !== m.bytes) return { hit: false }
    specs.push({ path: m.path, sha256: m.sha256, size: m.bytes })
  }
  const now = new Date()
  for (const m of manifest) {
    const p = casBlobPath(casBaseRoot, m.sha256)
    if (!p) return { hit: false }
    try {
      fs.utimesSync(p, now, now)
    } catch (error) {
      // review minor:读取与 touch 之间 blob 被 GC 删除(ENOENT)= 已知缺失,必须转 cache miss
      // 回下载路径,不得报 hit 让 materialize 晚点才炸;其它失败(权限等)才是 best-effort 续命。
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { hit: false }
    }
  }
  return { hit: true, specs }
}

/** #348:renderer 只交 confirmed;decidedAt 是授权收据的审计事实,由 main 在此打戳(Codex 裁决 B1)。 */
function stampAuthorization(
  wire: AuthorizationConfirmationWire | undefined,
  now: () => string,
): TxAuthorizationDecision | undefined {
  if (!wire) return undefined
  return { confirmed: wire.confirmed, decidedAt: now() }
}

// ── scope 解析(项目闭环:identity fail-closed)──────────────────────────────────────────────────

/** REQ-136:project catalog/seed 的窄例外只属于 main 已验 MCP；其余 kind 仍稳定拒绝。 */
export const PROJECT_INSTALL_UNSUPPORTED_REASON =
  "project-scoped catalog/seed installation supports verified MCP entries only"

/** Project 管理面 allowlist。MCP 仅在 root-parametric config remove + exact-root recovery
 *  与本次变更一同存在后加入；skill/agent 仍只服务历史残留。 */
const LEGACY_PROJECT_MANAGEABLE_KINDS = new Set<string>(["skill", "agent", "mcp"])

function resolveScope(
  scope: InstallScope,
  kind: string,
): { ok: true; root: (deps: PlannerDeps) => string; identity: ScopeIdentity; target: TargetArg } | { ok: false; reason: string } {
  if (scope.scope === "global") return { ok: true, root: (d) => d.globalRoot(), identity: { kind: "global" }, target: { scope: "global" } }
  if (kind !== "mcp") return { ok: false, reason: PROJECT_INSTALL_UNSUPPORTED_REASON }
  const identity = projectScopeIdentity(scope.projectDir)
  if (!identity.ok) return { ok: false, reason: `fail closed: ${identity.reason}` }
  const root = alphaRoot(identity.scope.projectPath)
  if (!root) return { ok: false, reason: `fail closed: invalid project root: ${scope.projectDir}` }
  return {
    ok: true,
    root: () => root,
    identity: identity.scope,
    target: { scope: "project", projectDir: identity.scope.projectPath },
  }
}

// ── install ─────────────────────────────────────────────────────────────────────────────────────

/** bundle 子条目在原子事务里的形态:generation(skill)/config(mcp)/receipt(cloud),或跳过/致命排除。 */
type BundleChildPlan =
  | { status: "install"; id: string; item: TxPlanItem; record: UpsertInput; warnings?: string[] }
  | { status: "skip"; id: string; reason: string }
  | { status: "fatal"; id: string; reason: string }

const bundleKeyFor = (kind: string, name: string): string => `${kind}--${name}`

/**
 * 把一个 bundle 子条目分类为原子事务里的一项。首期(REQ-100 #311)支持 skill(generation)+ 无密钥
 * 且无 workspace policy 的 MCP(config)+ cloud(receipt);agent / vendored·npm plugin / 需密钥或 workspace 的 MCP
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
  // #397(Codex 裁决必改②):bundle fan-out 不走 installCatalog,archived 门必须逐子项落此 ——
  // fatal 语义天然给出「required → 整包失败 / optional → 跳过并如实返回」(见 installBundleAtomic)。
  if (isCurationArchived(decodeEntryCurationLoud(entry)))
    return { status: "fatal", id, reason: `upstream is archived per curation review — new installs are refused (contract §7.2)` }
  const manifestDigest = computeManifestDigest(decoded.manifest)
  // #397:child 自己的有效 curation 声明优先(逐子项解码,纯计算);session-grant 归位 =
  // receipt 写点例外标记(与整包 receipt 批量落账同原子,r3)。
  const childPolicyFacts = curationPolicyFactsOf(entry, deps.now?.() ?? new Date().toISOString())
  const baseRecord = {
    id: entry.id,
    name: entry.name,
    environment,
    scope,
    version: decoded.manifest.version,
    manifestDigest,
    grantDigest: computeGrantDigest({}),
    // #395:bundle 按 child entry source 分别定初始态(#394 裁决),不用 bundle 一刀切;
    // 既有记录当前策略优先。root 恒 global(ADR-030 policy guard 在此前已拒 project 目录装)。
    desiredState: nextDesiredState(deps.globalRoot(), entry.type as InstallReceiptType, entry.name, {
      origin: "catalog",
      source: entry.source,
      ...childPolicyFacts,
    }),
    ...(childPolicyFacts.activationPolicy === "session-grant" ? { sessionGrantEnforced: true as const } : {}),
    origin: "catalog" as const,
    installedAt: new Date().toISOString(),
  }

  if (entry.type === "skill") {
    // REQ-098 #303:child 载荷在 classify/计划期提升进验证共享 CAS(锁外可接受 —— CAS 是可重建
    // 缓存层,不属 bundle 安装态原子边界;失败按 required=fatal / optional=skip 既有语义归置)。
    const fsSpec = entry.installSpec as { source?: string; builtinAssetKey?: string } | undefined
    let payload: SkillPayloadFile[]
    let manifestFiles: Array<{ path: string; sha256: string; bytes: number }>
    let payloadDigest: string | undefined
    if (fsSpec?.source === "remote" && entry.remoteAsset?.files?.length) {
      // #348:与单装同源的重驱缓存 —— CAS 逐 blob 重验命中即免下载(authorize 确认重驱零网络)。
      const cached = tryReuseCasPayload(deps.casBaseRoot(), entry.remoteAsset.files)
      if (cached.hit) {
        const key = bundleKeyFor("skill", entry.name)
        return {
          status: "install",
          id,
          item: { key, files: cached.specs, manifestDigest, capabilities: decoded.manifest.capabilities },
          record: { ...baseRecord, kind: "skill", payloadDigest: aggregateFilesDigest(entry.remoteAsset.files) },
        }
      }
      const dl = await deps.installers.downloadRemoteAsset(entry.remoteAsset.files)
      if (!dl.ok) return { status: "fatal", id, reason: dl.reason }
      payload = dl.contents
      manifestFiles = entry.remoteAsset.files
      payloadDigest = aggregateFilesDigest(entry.remoteAsset.files)
    } else if (fsSpec?.source === "builtin" && fsSpec.builtinAssetKey) {
      const p = deps.installers.collectBuiltinSkillPayload(fsSpec.builtinAssetKey, entry.name)
      if (!p.ok) return { status: "fatal", id, reason: p.reason }
      payload = p.files
      manifestFiles = payload.map((f) => ({ path: f.path, sha256: sha256Hex(f.data), bytes: f.data.length }))
      payloadDigest = aggregateFilesDigest(manifestFiles)
    } else {
      return { status: "fatal", id, reason: "skill declares no installable asset" }
    }
    const promoted = promotePayloadToCas(deps.casBaseRoot(), payload, manifestFiles)
    if (!promoted.ok) return { status: "fatal", id, reason: promoted.reason }
    const key = bundleKeyFor("skill", entry.name)
    return {
      status: "install",
      id,
      // #348:capabilities = 本子项严格解码 manifest 的能力集(逐子项,绝不把 bundle 并集复制给
      // 每个子项 —— grants key 与能力归属必须一一对应)。
      item: { key, files: promoted.specs, manifestDigest, capabilities: decoded.manifest.capabilities },
      record: { ...baseRecord, kind: "skill", ...(payloadDigest ? { payloadDigest } : {}) },
      ...(promoted.warnings.length ? { warnings: promoted.warnings } : {}),
    }
  }

  if (entry.type === "mcp") {
    const spec = entry.installSpec
    if (spec?.kind !== "mcp") return { status: "fatal", id, reason: "mcp entry has no mcp installSpec" }
    // r11 Major:bundle MCP child 与单装同一真源门 —— escape-hatch 路由下写 root/alpha.jsonc
    // 会「账本记 active、引擎读不到」。fatal(required 子项拒整单,与单装一致 fail-closed)。
    const bundleTruth = configTruthInRootGate(deps.globalRoot(), deps.installers.mcpConfigTruthPath())
    if (!bundleTruth.ok) return { status: "fatal", id, reason: bundleTruth.reason }
    // 首期排除需密钥 / workspace-policy 的 MCP —— 它们的 secret 文件写或 REQ-133 Alpha
    // Office workspace canonicalization 不在 config action 的原子边界内。fail-closed。
    if ((spec.requiredEnvVars?.length ?? 0) > 0)
      return { status: "skip", id, reason: "secret-bearing MCP not supported in atomic bundle (phase 1)" }
    if (
      spec.command?.some((argument) => argument.includes("{workspace}")) ||
      isWorkspacePolicyMcp(entry.name, { type: spec.mcpType, ...(spec.command ? { command: spec.command } : {}), ...(spec.url ? { url: spec.url } : {}) })
    )
      return { status: "skip", id, reason: "workspace-policy MCP not supported in atomic bundle (phase 1)" }
    const derived = deriveMcpConfig(spec, {})
    if (!derived.ok) return { status: "skip", id, reason: `MCP needs grants not supported in bundle: ${derived.reason}` }
    if (derived.secretVars.length > 0)
      return { status: "skip", id, reason: "secret-bearing MCP not supported in atomic bundle (phase 1)" }
    const policy = deps.installers.applyMcpWritePolicy(entry.name, derived.config)
    if (!policy.ok) return { status: "fatal", id, reason: `MCP write policy refused: ${policy.reason}` }
    const key = bundleKeyFor("mcp", entry.name)
    return {
      status: "install",
      id,
      item: {
        key,
        // config target 锚定事务根(= 当前环境 alpha.jsonc;与 staging 同卷,原子替换)。
        action: "config",
        config: { target: path.join(deps.globalRoot(), "alpha.jsonc"), edits: [{ keyPath: ["mcp", entry.name], value: baseRecord.desiredState === "disabled" ? { ...derived.config, enabled: false } : derived.config }] },
        manifestDigest,
        capabilities: decoded.manifest.capabilities,
      },
      record: { ...baseRecord, kind: "mcp", configKey: `mcp.${entry.name}` },
    }
  }

  if (entry.type === "cloud") {
    const key = bundleKeyFor("cloud", entry.name)
    return {
      status: "install",
      id,
      item: { key, action: "receipt", manifestDigest, capabilities: decoded.manifest.capabilities },
      record: { ...baseRecord, kind: "cloud" },
    }
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

  // 直接子项解析 + 嵌套 Bundle 门前拒(REQ-128 #705)。
  //
  // 此前这里解析的是**整张传递闭包**:沿嵌套子包逐层回表目录建图、查环,但真正装的只有 direct
  // child —— 嵌套子包在 classifyBundleChild 被判 `type "bundle" not supported`,required 时整单失败、
  // optional 时**静默跳过**。于是同一个嵌套包有两种命运,而用户看到的都是「装好了」,少的那层
  // 只在事后翻账本才看得见。Desktop 不递归 flatten:图就是图,拒绝比半装诚实。
  //
  // 位置是这道门的一半:它落在任何载荷下载(promotePayloadToCas / downloadRemoteAsset)、任何
  // 密钥写入、任何 runExtensionTransaction 之前 —— 被拒的嵌套包在磁盘上零足迹。
  const directItems = verified.entry.bundleItems ?? []
  const resolved = new Map<string, VerifiedCatalogEntry>([[verified.entry.id, verified]])
  for (const it of directItems) {
    if (it.catalogEntryId === verified.entry.id)
      return {
        ok: false,
        reason: `nested bundle refused: "${verified.entry.id}" lists itself as a child — Desktop does not flatten package graphs`,
      }
    if (resolved.has(it.catalogEntryId)) continue
    const sub = await deps.resolveEntry(it.catalogEntryId)
    if (!sub) return { ok: false, reason: `bundle item not in verified catalog: ${it.catalogEntryId}` }
    // 判据取两条互相独立的轴:声明的 type,以及「自己是否还带子项」。任一成立即是图。
    if (sub.entry.type === "bundle" || (sub.entry.bundleItems ?? []).length > 0)
      return {
        ok: false,
        reason: `nested bundle refused: child "${sub.entry.id}" carries its own children — Desktop does not flatten package graphs (install it on its own)`,
      }
    resolved.set(it.catalogEntryId, sub)
  }

  // bundle 自身 manifest 校验(组件 = 逐子条目 runsIn;capability = 子项并集)。
  const items = (verified.entry.bundleItems ?? []).slice().sort((a, b) => a.installOrder - b.installOrder)
  const subEntries = items.map((it) => resolved.get(it.catalogEntryId)!.entry)
  const caps = [...new Set(subEntries.flatMap((e) => capabilitiesFor(e)))]
  const surfaces = [...new Set(subEntries.flatMap((e) => runtimeSurfacesForCatalogEntry(e)))]
  const bundleManifest = {
    ...(synthesizeManifest(verified) as Record<string, unknown>),
    capabilities: caps,
    ownership: { ...(synthesizeManifest(verified) as { ownership: Record<string, unknown> }).ownership, runtimeSurfaces: surfaces },
    components: subEntries.map((e) => ({ name: e.name, runsIn: runtimeSurfacesForCatalogEntry(e) })),
  }
  const bundleDecoded = decodeManifestV2(bundleManifest)
  if (!bundleDecoded.ok) return { ok: false, reason: `bundle manifest invalid: ${bundleDecoded.errors.join("; ")}` }
  if (!(bundleDecoded.manifest.compatibility.platforms as string[]).includes(deps.platform()))
    return { ok: false, reason: `platform ${deps.platform()} not supported by this bundle` }

  const environment = deps.environment()
  const identity: ScopeIdentity = { kind: "global" }

  // 分类每个 required/optional 子条目 → 事务项 / 跳过。required 致命 = 整单拒绝(环境态零写盘;
  // 已提升的 CAS blob 是可重建缓存,交 GC grace,不参加 bundle 回滚)。
  const planItems: TxPlanItem[] = []
  const installedIds: string[] = []
  const skipped: Array<{ id: string; reason: string }> = []
  const bundleWarnings: string[] = []
  for (const it of items) {
    const child = resolved.get(it.catalogEntryId)!
    // #315(并入 REQ-105 静态基线):advisory 命中的子条目绝不经 bundle 通道铺给用户。
    // 归档子项沿用 REQ-105 语义跳过;REQ-135 退役的 required 子项则拒绝整包,
    // 避免旧 Office 包在丢掉 Excel 后仍谎报安装成功。决策落 main(非 renderer)。
    const childAdv = deps.advisoryGate(advisoryInputOf(child.entry, verified.channel))
    if (!childAdv.allowed) {
      if (!it.optional && retiredCommunityOfficeFor({ id: child.entry.id, name: child.entry.name }))
        return {
          ok: false,
          reason: `required bundle child "${child.entry.id}" is retired and cannot be installed: ${childAdv.reason}`,
        }
      skipped.push({ id: child.entry.id, reason: `advisory ${childAdv.advisoryId}: ${childAdv.reason}` })
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
      if (c.warnings?.length) bundleWarnings.push(...c.warnings)
      installedIds.push(c.id)
    }
  }

  // 全 skip:零状态变更 → 不开事务、无 journal(journal 审计的是状态变更);skip 审计随 outcome 返回。
  if (planItems.length === 0)
    return { ok: true, kind: "bundle", name: verified.entry.name, manifestDigest: computeManifestDigest(bundleDecoded.manifest), installed: [], skipped }

  const plan: TxPlan = {
    items: planItems,
    // #348:bundle 一次展示、一次授权、一次 commit —— 确认重驱带回的整集决定进引擎 plan。
    ...(intent.authorization
      ? { authorization: stampAuthorization(intent.authorization, () => deps.now?.() ?? new Date().toISOString())! }
      : {}),
    // journal 的 skippedOptional.key 必须 fs-safe 且有界(引擎 validatePlan 拒冒号/超长/重复)。
    // catalog id 不受 fs-safe 约束(仅非空/无控制字符/≤200),朴素替换非单射(review #363 Major 1:
    // "skill:a:b--c" 与 "skill:a--b:c" 碰撞会被判 duplicate 拒整单)。取 injective-by-hash 编码,
    // 原始 id 保留在 reason 里供审计;该 key 无查找语义(只进 journal/授权收据)。
    skippedOptional: skipped.map((s) => ({ key: `skipped--${sha256Hex(s.id).slice(0, 24)}`, reason: `${s.id}: ${s.reason}` })),
  }
  // Codex r10 B3:bundle child 的 config edit 用 plan 期 baseRecord.desiredState(锁外分类);并发
  // disable 在 bundle 取锁前发生时,旧快照会落无 enabled:false 的 config(批量 upsert 保留锁内 disabled
  // → 账本 disabled / config enabled 复活)。锁内逐 config-backed child 复核 desiredState vs plan,漂移
  // 即拒重试(镜像单装/seed)。收集计划期 (kind,name,plannedState)。
  // #397 r3:forced(sessionGrantEnforced)子项计划值恒 disabled ≠ prior 不是漂移(政策强制,
  // 写点例外落 disabled)—— drift 基线改用计划期观测的 prior 态,只拦真正的并发变化。
  const driftChecks = planItems
    .map((it) => it.receipt as UpsertInput | undefined)
    .filter((r): r is UpsertInput => !!r && (r.kind === "mcp" || r.kind === "agent" || r.kind === "plugin"))
    .map((r) => ({
      kind: r.kind,
      name: r.name,
      planned: r.sessionGrantEnforced === true ? findRecordV2(deps.globalRoot(), r.kind, r.name)?.desiredState : r.desiredState,
    }))
  const hooks: TxHooks = {
    // REQ-098 #303:generation 项统一从验证共享 CAS 物化(读取重验;blob 被 GC/外部删除 → 抛错 =
    // 事务 abort,绝不回退 buffer 直填)。config/receipt 项无 populate。
    populate: (item, stagingDir) => {
      if (actionOf(item) !== "generation") return
      materializeFilesFromCas(deps.casBaseRoot(), item.files ?? [], stagingDir)
    },
    precondition: () => {
      for (const d of driftChecks) {
        const prior = findRecordV2(deps.globalRoot(), d.kind, d.name)
        if ((prior?.desiredState ?? d.planned) !== d.planned)
          return { ok: false, reason: `bundle child ${d.kind} ${d.name}: desired state changed since plan — retry the bundle install` }
      }
      return { ok: true }
    },
    // 类型化健康探测(#312):skill generation 落地后验 SKILL.md 可发现;非 generation 直接健康。
    probe: skillGenerationProbe,
    // 账本写失败即事务失败(#336):bundle 全部 receipt 一次批量落盘,不留半套。从 rec.receipt 模板
    // 重建(与恢复前滚同源,#312)。
    commitReceipt: (recs: TxCommitRecord[]) => {
      const written = upsertRecordsV2(deps.globalRoot(), recs.map((rec) => commitInputFromRecord(rec)))
      if (!written.ok) throw new Error(`bundle receipt commit failed: ${written.reason}`)
      // #336:账本 durable 但 skills 派生允许集发布失败 —— 不 throw(会误触发引擎回滚与已
      // durable 账本分叉),捕获进 bundleWarnings 随成功结果如实上报。
      if (written.projectionLag) bundleWarnings.push(written.projectionLag)
    },
    log: () => {},
  }

  const result = await runExtensionTransaction(deps.globalRoot(), plan, hooks)
  if (!result.ok) {
    // #348:authorize 结构化透传(reason 保留 bundle 上下文,但 stage 不再折叠进字符串)。
    if (result.stage === "authorize") {
      if (result.authorization)
        return { ok: false, stage: "authorize", reason: `bundle "${verified.entry.name}": ${result.reason}`, authorization: result.authorization }
      // 引擎契约保证 authorize 必带 diff;万一缺失按无 stage 的诚实失败返回,绝不谎标其它 stage。
      return { ok: false, reason: `bundle install failed at authorize: ${result.reason}` }
    }
    return { ok: false, reason: `bundle install failed at ${result.stage}: ${result.reason}`, stage: result.stage }
  }
  return {
    ok: true,
    kind: "bundle",
    name: verified.entry.name,
    manifestDigest: computeManifestDigest(bundleDecoded.manifest),
    installed: installedIds,
    skipped,
    ...(bundleWarnings.length ? { warning: bundleWarnings.join("; ") } : {}),
  }
}

/**
 * catalog 安装唯一入口:意图严格解码 → 已验 catalog 解析 → ManifestV2 合成 + 写盘前严格校验
 * → main 重建安装事实执行 → InstallRecordV2 落账。
 */
export async function installCatalog(rawIntent: unknown, deps: PlannerDeps): Promise<CatalogInstallOutcome> {
  const decodedIntent = decodeCatalogInstallIntent(rawIntent)
  if (!decodedIntent.ok) return decodedIntent
  if ("source" in decodedIntent.intent) return installSeedAsset(decodedIntent.intent, deps)
  const intent = decodedIntent.intent

  const verified = await deps.resolveEntry(intent.catalogId)
  if (!verified) return { ok: false, reason: `entry not in verified catalog: ${intent.catalogId}` }
  const entry = verified.entry
  // REQ-136 C1:renderer id/prefix/claimed kind 没有权威性。project carve-out 只在 main 已解析
  // verified catalog entry 后接受真实 `entry.type === "mcp"`；其余类型在任何写/CAS 前拒绝。
  if (intent.scope.scope === "project" && entry.type !== "mcp")
    return { ok: false, reason: PROJECT_INSTALL_UNSUPPORTED_REASON }

  // #315:advisory 激活闸(bundle 本体 id 也在此过;children 在 fan-out 内逐个过)。
  const adv = deps.advisoryGate(advisoryInputOf(entry, verified.channel))
  if (!adv.allowed) return { ok: false, reason: `advisory ${adv.advisoryId}: ${adv.reason} — activation refused (R14)` }

  // ── #397:curation 消费(合同 §7.1 采信分级后于 advisory —— advisory 永远赢;§7.2:
  //    upstreamStatus=archived ⇒ 禁新安装,纵深门,发布端门闸本不应放行;已装项不受影响)。
  if (isCurationArchived(decodeEntryCurationLoud(entry)))
    return { ok: false, reason: `entry ${entry.id}: upstream is archived per curation review — new installs are refused (existing installs unaffected)` }

  if (entry.type === "bundle") return installBundleAtomic(verified, intent, deps)

  // ADR-040(`#825` 第 2/3/4 条):catalog 的 plugin 条目 —— npm 钉版、vendored 载荷、以及它们的
  // 更新链(原子置换)—— 一律**具名拒绝**,而且拒在这里:资产下载、CAS 提升、事务开启、账本探测
  // 之前。plugin 条目意味着把第三方 JS 写进引擎的 `plugin[]` 以同等权限执行,那不再是 Alpha 提供的
  // 能力。静默跳过是票面明令禁止的第三个选项 —— 用户点了「安装」就必须听见「为什么没装」。
  if (entry.type === "plugin")
    return {
      ok: false,
      reason: `entry ${entry.id} installs an engine plugin — Alpha no longer installs executable plugins into the engine (ADR-040); refusing`,
    }

  // Phase 1:写盘前 manifest 严格校验(缺字段/未知键/非法 digest/越权 capability/平台不兼容全在此拒)。
  const decoded = decodeManifestV2(synthesizeManifest(verified))
  if (!decoded.ok) return { ok: false, reason: `manifest invalid — refusing before any disk write: ${decoded.errors.join("; ")}` }
  const manifest = decoded.manifest
  if (!(manifest.compatibility.platforms as string[]).includes(deps.platform()))
    return { ok: false, reason: `platform ${deps.platform()} not supported by this entry — refusing before any disk write` }
  const manifestDigest = computeManifestDigest(manifest)

  const scope = resolveScope(intent.scope, entry.type)
  if (!scope.ok) return scope

  // REQ-103 AC3 的静默扩权阻断由 #348 的 capability→authorize 闸承担(引擎 authorize 阶段,
  // 首装/更新/重装全覆盖,stage="authorize" + CapabilityDiff[] 重驱)—— S50 slice 2a 的
  // confirmedCapabilities 原型已被其取代。
  const grants = intent.grants ?? {}
  const tx = (deps.transaction ?? passthroughTx).begin({ op: "install", kind: entry.type, name: entry.name, scope: intent.scope.scope, manifestDigest })
  const rollback = (reason: string): void => (deps.transaction ?? passthroughTx).rollback(tx.txId, reason)

  // #378:全类型分支自提交并早返回(引擎 commitReceipt 单点)—— #354 时代「提交面补偿闭包 +
  // 密钥快照」随非事务尾部一并退役。
  let payloadDigest: string | undefined

  const spec = entry.installSpec

  // ── #354 写前门(Codex 裁决必改 1/3 + review #379 Major):没有可靠前像的覆盖更新一律显式
  //    拒绝,不静默覆盖、不把无账在场认领为 catalog(agent 无更新链)。在场检查覆盖 v2 record
  //    **与 v1-only receipt**(历史 eager v1 遗物)。
  //    ADR-040:plugin 的三态分发(fresh / 原子置换 / refuse)整段随安装路径退场,见本函数上方的
  //    `entry.type === "plugin"` 具名拒绝 —— 它拒在 tx.begin 之前,这里已不可能看到 plugin。
  if (entry.type === "agent") {
    if (
      findRecordV2(scope.root(deps), "agent", entry.name) ||
      findReceipt(scope.root(deps), "agent", entry.name) ||
      deps.installers.agentPresent(entry.name, scope.target)
    ) {
      rollback("existing agent install")
      return { ok: false, reason: `agent "${entry.name}" already present — agents have no update path; refusing overwrite (unregistered content is not adopted)` }
    }
  }
  // #354(必改 5,review #379 收敛到拒绝分支):损坏/不可读账本**写前拒绝且原文件不动** ——
  // 不给 upsert 的 quarantine 触发机会。由此健康账本 + 原子写失败 = 磁盘零变化,提交面无需
  // 整文件恢复(恢复步骤才是跨进程竞态与「恢复后补偿再改账」的来源)。
  const ledgerProbe = probeLedgerForWrite(scope.root(deps))
  if (!ledgerProbe.ok) {
    rollback(ledgerProbe.reason)
    return { ok: false, reason: ledgerProbe.reason }
  }

  if (entry.type === "mcp") {
    // #378(Codex 裁决 D1):单装 MCP 收进 config action 单事务(bundle/seed 同形态)——
    // capabilities/receipt 挂 item,#348 授权闸随之生效;前像/复原由引擎整文件 image journaled
    // 承担(重装是产品流,允许覆盖,不做 version gate);账本归引擎 commitReceipt 单点。
    if (spec?.kind !== "mcp") {
      rollback("entry has no mcp installSpec")
      return { ok: false, reason: "entry has no mcp installSpec" }
    }
    const projectMcp = intent.scope.scope === "project"
    // REQ-136 C3/C9:project channel is the config-only safety subset. Reject before derive can
    // claim a secret version or the Office policy can canonicalize a workspace-bearing command.
    if (projectMcp && (spec.requiredEnvVars?.length ?? 0) > 0) {
      rollback("secret-bearing project MCP")
      return { ok: false, reason: "project MCP requires zero requiredEnvVars — refused" }
    }
    if (
      projectMcp &&
      (spec.command?.some((argument) => argument.includes("{workspace}")) ||
        isWorkspacePolicyMcp(entry.name, {
          type: spec.mcpType,
          ...(spec.command ? { command: spec.command } : {}),
          ...(spec.url ? { url: spec.url } : {}),
        }))
    ) {
      rollback("workspace-policy project MCP")
      return { ok: false, reason: "workspace-policy MCP is not project-installable — refused" }
    }
    const mcpRoot = scope.root(deps)
    const mcpConfigTarget = path.join(mcpRoot, "alpha.jsonc")
    // r7 Major:escape-hatch 环境下引擎配置真源不在事务根 → fail-closed 拒(不写账谎报 active)。
    // Project discovery is the existing per-instance D/.alpha hook, not the process-wide global
    // truth path. Consulting that global path here would reject D or, worse, redirect D into it.
    if (!projectMcp) {
      const mcpTruth = configTruthInRootGate(mcpRoot, deps.installers.mcpConfigTruthPath())
      if (!mcpTruth.ok) {
        rollback(mcpTruth.reason)
        return mcpTruth
      }
    }
    const derived = deriveMcpConfig(spec, grants)
    if (!derived.ok) {
      rollback(derived.reason)
      return derived
    }
    if (projectMcp && derived.secretVars.length > 0) {
      rollback("secret-bearing project MCP")
      return { ok: false, reason: "project MCP cannot create a secret version — refused" }
    }
    // #354 语义保留(产品早拒):不可读/形状异常的前像写前拒绝(锁内 precondition 重验)。
    const leafBefore = deps.installers.readMcpLeafStrict(entry.name, projectMcp ? mcpConfigTarget : undefined)
    if (!leafBefore.ok) {
      rollback(leafBefore.reason)
      return leafBefore
    }
    const durable = structuredClone(derived.config)
    const secretMap: Record<string, string> = {}
    for (const v of derived.secretVars) {
      const real = grants.secrets?.[v]
      if (typeof real === "string" && real.length > 0) secretMap[v] = real
    }
    // #378(Codex 裁决 Q1):版本化密钥 —— 纯引用替换先行(零写盘);granted 未落到任何字段
    // fail-closed 拒明文持久化(#350 阻断项语义保留);落盘推迟到策略/校验通过之后。
    let verId: string | null = null
    let refs: Record<string, string> = {}
    if (derived.secretVars.length > 0) {
      // r1 Minor:排他认领版本目录(碰撞换 id 重试三次;非碰撞失败即拒 —— 圈禁/权限问题重试无意义)。
      let claimFail = ""
      for (let i = 0; i < 3 && verId === null; i++) {
        const vid = newMcpSecretVersionId()
        const claimed = deps.installers.claimMcpSecretVersionDir(entry.name, vid)
        if (claimed.ok) verId = vid
        else {
          claimFail = claimed.reason
          if (!claimed.exists) break
        }
      }
      if (verId === null) {
        rollback(`secret version dir claim failed: ${claimFail}`)
        return { ok: false, reason: `secret version dir claim failed: ${claimFail}` }
      }
      const vid = verId
      const sub = substituteMcpSecretRefsPure(durable, secretMap, (varName) => deps.installers.mcpSecretRefFor(entry.name, vid, varName))
      if (sub.skipped.length > 0) {
        deps.installers.removeMcpSecretVersionDir(entry.name, vid) // 认领后的空目录随拒绝清理
        rollback(`secrets not routable to {file:} channel: ${sub.skipped.join(", ")}`)
        return {
          ok: false,
          reason: `secret(s) could not be routed to the {file:} channel: ${sub.skipped.join(", ")} — refusing plaintext persist`,
        }
      }
      refs = sub.substituted
    }
    // #378(Codex 裁决 Q2):main-owned write policy checks the retired-package deny and
    // canonicalizes REQ-133 Alpha Office paths before the durable config action is built.
    const pol = deps.installers.applyMcpWritePolicy(entry.name, durable)
    if (!pol.ok) {
      if (verId) deps.installers.removeMcpSecretVersionDir(entry.name, verId) // 已认领的空目录随拒绝清理
      rollback(pol.reason)
      return pol
    }
    // 纯校验门(seed/未策展同一 validateServer;对策略注入后的最终 durable 校验)。
    const validated = validateServer(durable)
    if (!validated.ok) {
      if (verId) deps.installers.removeMcpSecretVersionDir(entry.name, verId)
      rollback(validated.reason)
      return { ok: false, reason: validated.reason }
    }
    // 写本次版本的密钥文件(只增不覆盖:旧版本文件被旧 config 引用,直至新 config 提交前必须
    // 原样可读;本次目录写失败即删,无引用惰性安全)。
    if (verId) {
      for (const [varName, real] of Object.entries(secretMap)) {
        if (refs[varName] === undefined) continue
        const written = deps.installers.writeMcpSecretVersioned(entry.name, verId, varName, real)
        if (!written.ok) {
          const rm = deps.installers.removeMcpSecretVersionDir(entry.name, verId)
          rollback(written.reason)
          return { ok: false, reason: `secret write failed: ${written.reason}${rm.ok ? "" : `; version cleanup failed: ${rm.reason}`}` }
        }
      }
    }
    const mcpNow = deps.now?.() ?? new Date().toISOString()
    // #397(r3):计划期只**计算**消费事实(纯,零账本写);session-grant 的归位 = receipt 写点
    // 例外(UpsertInput.sessionGrantEnforced,与 receipt 同原子)。drift 基线在 forced 场景取
    // **计划期观测的 prior 态**(planned 恒 disabled ≠ prior 不是漂移,是政策强制)。
    const mcpPolicyFacts = curationPolicyFactsOf(entry, mcpNow)
    const mcpSessionGrantForced = mcpPolicyFacts.activationPolicy === "session-grant"
    const mcpPlanObservedPrior = findRecordV2(mcpRoot, "mcp", entry.name)?.desiredState
    const mcpReceipt: UpsertInput = {
      id: entry.id,
      name: entry.name,
      kind: "mcp",
      environment: deps.environment(),
      scope: scope.identity,
      version: manifest.version,
      manifestDigest,
      grantDigest: computeGrantDigest(grants),
      // #395:fresh-intake 初始态按来源分类(alpha=开,其余含 official=关);既有记录当前策略优先。
      // #397:有效 curation 的 activationPolicy 声明优先(session-grant 恒 disabled;纯计算)。
      desiredState: nextDesiredState(mcpRoot, "mcp", entry.name, { origin: "catalog", source: entry.source, ...mcpPolicyFacts }),
      ...(mcpSessionGrantForced ? { sessionGrantEnforced: true as const } : {}), // #397 r3:写点例外标记
      origin: "catalog",
      configKey: `mcp.${entry.name}`,
      installedAt: mcpNow,
    }
    const plan: TxPlan = {
      items: [
        {
          key: `mcp--${entry.name}`,
          action: "config",
          config: { target: mcpConfigTarget, edits: [{ keyPath: ["mcp", entry.name], value: mcpReceipt.desiredState === "disabled" ? { ...durable, enabled: false } : durable }] },
          manifestDigest,
          capabilities: manifest.capabilities,
          receipt: mcpReceipt,
        },
      ],
      ...(intent.authorization ? { authorization: stampAuthorization(intent.authorization, () => deps.now?.() ?? new Date().toISOString())! } : {}),
    }
    const refPaths = Object.values(refs).map(mcpRefPathOf).filter((p): p is string => p !== null)
    const hooks: TxHooks = {
      populate: () => {}, // config action 无 staging 载荷
      // 锁内 precondition(TOCTOU):账本可写 + 前像仍 strict 可读(覆盖合法,不可读拒)+
      // 本次密钥文件仍在场(r1 Major:锁外写文件与取锁之间若被并发 GC/外部清理收走,提交会
      // 落一份引用悬空文件的 config —— 锁内逐引用 lstat 实文件,缺任一即拒,用户重试)。
      precondition: () => {
        if (projectMcp) {
          const identity = projectMcpWriteIdentityGate(mcpRoot, mcpConfigTarget)
          if (!identity.ok) return identity
        }
        const ledger = probeLedgerForWrite(mcpRoot)
        if (!ledger.ok) return { ok: false, reason: `refusing mcp install: ${ledger.reason}` }
        // Codex r9 B2:desiredState 漂移钉死(镜像 plugin replacement)—— config edit 与 live outcome
        // 都用 plan 期 mcpReceipt.desiredState;plan 快照与加锁之间的合法启停(用户 disable)不得被旧
        // 快照静默覆盖(否则账本 disabled 但 config 无 enabled:false → 运行面复活)。
        // 漂移即拒,重试重读 desiredState 后按新态重建 config/outcome。fresh 装无 prior,不进此支。
        // #397 r3:forced(session-grant)场景计划值恒 disabled ≠ prior 不是漂移(政策强制,写点
        // 例外落 disabled)—— 基线改用计划期观测的 prior 态,只拦真正的并发变化。
        const prior = findRecordV2(mcpRoot, "mcp", entry.name)
        const mcpDriftBaseline = mcpSessionGrantForced ? mcpPlanObservedPrior : mcpReceipt.desiredState
        if ((prior?.desiredState ?? mcpDriftBaseline) !== mcpDriftBaseline)
          return { ok: false, reason: `mcp desired state changed since plan — retry the install` }
        const leaf = deps.installers.readMcpLeafStrict(entry.name, projectMcp ? mcpConfigTarget : undefined)
        if (!leaf.ok) return { ok: false, reason: `refusing mcp install: ${leaf.reason}` }
        for (const p of refPaths) {
          try {
            if (!fs.lstatSync(p).isFile()) return { ok: false, reason: `secret file missing or not a regular file: ${path.basename(p)} — retry the install` }
          } catch {
            return { ok: false, reason: `secret file disappeared before commit (gc/external cleanup): ${path.basename(p)} — retry the install` }
          }
        }
        return { ok: true }
      },
      commitReceipt: (records: TxCommitRecord[]) => {
        if (projectMcp) {
          const identity = projectMcpWriteIdentityGate(mcpRoot, mcpConfigTarget)
          if (!identity.ok) throw new Error(identity.reason)
        }
        const written = upsertRecordsV2(mcpRoot, recoveryReceiptInputs(records))
        if (!written.ok) throw new Error(`mcp receipt commit failed: ${written.reason}`)
      },
    }
    if (projectMcp) {
      const identity = projectMcpWriteIdentityGate(mcpRoot, mcpConfigTarget)
      if (!identity.ok) {
        rollback(identity.reason)
        return identity
      }
    }
    const result = await runExtensionTransaction(mcpRoot, plan, hooks)
    if (!result.ok) {
      // 本次版本目录清理(authorize 暂停同路径)。r1 Major:先验当前 live leaf **未引用**本次
      // 版本才删 —— 回滚被旁路改写挡住(journal 保留非终态)等留证形态下 config 可能仍指向
      // 本次版本,删除会制造悬空 {file:} 引用;读不到 leaf 同样保守不删,交 GC 按引用对账收。
      if (verId) {
        const leafNow = deps.installers.readMcpLeafStrict(entry.name)
        // leaf 缺席(fresh 的 authorize 暂停/失败)= 确定零引用,可删;只有**不可读**才保守不删。
        // r3/r4/r5 Major:两侧按**引擎解析语义**规范化(resolveMcpRefPath:~/ 展开 + config
        // 目录基准)—— 旁路等价改写({file:/a/v/./TOKEN}、相对、~/ 形态)不再被误判「未引用」
        // 而删掉 live 仍指向的密钥。
        // r10 Major:「仍被引用」判定覆盖合并视图 —— retained legacy 源引用本次版本(异常旁路
        // 写形态)时删除同样制造悬空;legacy 读不出 = 保守不删。
        const legacyNow = deps.installers.legacyMcpRefPaths(entry.name)
        // r14 Major:引用与本次版本文件都取文件系统身份双形态(symlink 别名不漏判)。
        // r15 Major:任一路径身份不可判(非缺席类 fs 错)= 「未引用」不可证明 —— 与 config
        // 不可读同置(保守不删 + authorize 降级),不得静默回退词法把暂时 EIO 的活体别名删掉。
        let cleanupIdentUnprovable = false
        const identFormsOf = (p: string): string[] => {
          const ident = pathIdentity(p)
          if (!ident.certain) cleanupIdentUnprovable = true
          return ident.forms
        }
        let liveRefs: Set<string> | null = null
        if (leafNow.ok && legacyNow.ok) {
          liveRefs = new Set()
          for (const p of [
            ...(leafNow.value !== undefined ? collectMcpFileRefPaths(leafNow.value) : []).map((q) => resolveMcpRefPath(q, mcpRoot)),
            ...legacyNow.refs,
          ]) {
            for (const form of identFormsOf(p)) liveRefs.add(form)
          }
        }
        const refsHitLive =
          liveRefs !== null && refPaths.some((p) => identFormsOf(resolveMcpRefPath(p, mcpRoot)).some((form) => liveRefs.has(form)))
        const stillReferenced = liveRefs === null || cleanupIdentUnprovable || refsHitLive
        // r5/r6 Major:authorize 暂停承诺「零权威副作用 + 零明文残留」—— 清理必须**可证明**完成
        // (leaf 可读 + 未引用本次版本 + 删除成功)才允许照常返回 authorize;任何一环不成立
        // (不可读无从对账 / 出现引用 = 有旁路写方 / 删除失败)都降级为普通失败,原因如实入
        // reason(明文 0600,GC 兜底),用户处理后重试。非 authorize 失败保持原语义(保守不删
        // 留给 GC,不污染引擎失败原因)。
        let cleanupUnproven: string | null = null
        if (liveRefs === null) {
          cleanupUnproven = `config unreadable — cannot prove the secret version is unreferenced`
          console.error(`[ext-install-planner] mcp ${entry.name}: secret version ${verId} kept — config unreadable`)
        } else if (cleanupIdentUnprovable && !refsHitLive) {
          cleanupUnproven = `a path's filesystem identity is unresolvable (non-absence fs error) — cannot prove the secret version is unreferenced`
          console.error(`[ext-install-planner] mcp ${entry.name}: secret version ${verId} kept — path identity unresolvable`)
        } else if (stillReferenced) {
          cleanupUnproven = `live config references this attempt's secret version (bypass write?)`
          console.error(`[ext-install-planner] mcp ${entry.name}: secret version ${verId} kept — live config still references it (rollback retained?)`)
        } else {
          const rm = deps.installers.removeMcpSecretVersionDir(entry.name, verId)
          if (!rm.ok) {
            cleanupUnproven = rm.reason
            console.error(`[ext-install-planner] mcp ${entry.name}: secret version cleanup failed: ${rm.reason}`)
          }
        }
        if (cleanupUnproven !== null && result.stage === "authorize") {
          rollback(result.reason)
          return {
            ok: false,
            reason: `authorization pause aborted: this attempt's secret version cleanup is not proven (${cleanupUnproven}) — plaintext may remain in version "${verId}" pending gc; resolve and retry`,
          }
        }
      }
      rollback(result.reason)
      if (result.stage === "authorize") {
        if (result.authorization) return { ok: false, stage: "authorize", reason: result.reason, authorization: result.authorization }
        return { ok: false, reason: result.reason }
      }
      return { ok: false, reason: result.reason, ...(result.stage ? { stage: result.stage } : {}) }
    }
    ;(deps.transaction ?? passthroughTx).commit(tx.txId)
    // 提交成功:收未被当前 leaf 引用且过宽限的旧版本/flat/快照残留(锁内对账;busy 跳过)。
    // Project installs never create secrets and must not collect a same-name global server's
    // versions as a side effect of a D-scoped config commit.
    const gc = projectMcp ? { removed: [], warnings: [] } : deps.installers.gcMcpSecrets(entry.name)
    const mcpWarnings = [...result.warnings, ...gc.warnings]
    return {
      ok: true,
      kind: "mcp",
      name: entry.name,
      manifestDigest,
      ...(mcpReceipt.desiredState === "disabled"
        ? { installedDisabled: true as const }
        : {}),
      ...(mcpWarnings.length ? { warning: mcpWarnings.join("; ") } : {}),
    }
  } else if (entry.type === "skill") {
    // REQ-100 #310:skill 走不可变 generation 事务 —— staging→verify→materialize→switch →
    // commitReceipt=upsertRecordV2(写失败即事务失败,#336)。REQ-098 #303:内容一律先提升进
    // 验证共享 CAS(remote 用 catalog 清单钉死,builtin 自算内容地址 —— 摄取后完整性,不主张
    // 上游真实性),staging 由 populateFromCas 物化(读取重验,纵深)。本分支自提交并早返回。
    const fsSpec = spec as { kind?: string; source?: string; builtinAssetKey?: string } | undefined
    let promoted: { specs: TxFileSpec[]; warnings: string[] }
    if (fsSpec?.source === "remote" && entry.remoteAsset?.files?.length) {
      // #348:authorize 确认重驱不得二次下载 —— 首驱已提升进 CAS,逐 blob 读取重验命中即复用。
      const cached = tryReuseCasPayload(deps.casBaseRoot(), entry.remoteAsset.files)
      if (cached.hit) {
        promoted = { specs: cached.specs, warnings: [] }
      } else {
        const dl = await deps.installers.downloadRemoteAsset(entry.remoteAsset.files)
        if (!dl.ok) {
          rollback(dl.reason)
          return dl
        }
        const p = promotePayloadToCas(deps.casBaseRoot(), dl.contents, entry.remoteAsset.files)
        if (!p.ok) {
          rollback(p.reason)
          return { ok: false, reason: p.reason }
        }
        promoted = p
      }
      payloadDigest = aggregateFilesDigest(entry.remoteAsset.files)
    } else if (fsSpec?.source === "builtin" && fsSpec.builtinAssetKey) {
      const c = deps.installers.collectBuiltinSkillPayload(fsSpec.builtinAssetKey, entry.name)
      if (!c.ok) {
        rollback(c.reason)
        return c
      }
      const builtinManifest = c.files.map((f) => ({ path: f.path, sha256: sha256Hex(f.data), bytes: f.data.length }))
      const p = promotePayloadToCas(deps.casBaseRoot(), c.files, builtinManifest)
      if (!p.ok) {
        rollback(p.reason)
        return { ok: false, reason: p.reason }
      }
      promoted = p
      // builtin 也落 payloadDigest(Codex 裁决 #303 B):摄取时内容地址的聚合,补齐安装事实。
      payloadDigest = aggregateFilesDigest(builtinManifest)
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
      source: entry.source, // #395:fresh-intake 初始启用分类输入
      ...curationPolicyFactsOf(entry, deps.now?.() ?? new Date().toISOString()), // #397:有效 curation 声明透传
      casFiles: { specs: promoted.specs, casBaseRoot: deps.casBaseRoot() },
      // #348:能力集取严格解码后的 manifest.capabilities(单一事实,不再二次派生);authorize
      // 重驱决定由 main 打戳 decidedAt(renderer 无审计戳通道)。
      capabilities: manifest.capabilities,
      ...(intent.authorization ? { authorization: stampAuthorization(intent.authorization, () => deps.now?.() ?? new Date().toISOString())! } : {}),
      version: manifest.version,
      manifestDigest,
      ...(payloadDigest ? { payloadDigest } : {}),
      grantDigest: computeGrantDigest(grants),
    })
    if (!gen.ok) {
      // authorize 暂停 = 本次 planner attempt 结束且未 commit(rollback 配对 begin,非引擎写后回滚
      // —— Codex 裁决 C2);判别分支携带 diff 供确认框渲染,其余失败原样透传 stage。
      rollback(gen.reason)
      if (gen.stage === "authorize") return { ok: false, stage: "authorize", reason: gen.reason, authorization: gen.authorization }
      return { ok: false, reason: gen.reason, ...(gen.stage ? { stage: gen.stage } : {}) }
    }
    ;(deps.transaction ?? passthroughTx).commit(tx.txId)
    // #336:projectionLag(账本 durable、允许集发布失败)并入用户可见 warning 通道。
    const skillWarnings = [...promoted.warnings, ...(gen.projectionLag ? [gen.projectionLag] : [])]
    return {
      ok: true,
      kind: "skill",
      name: entry.name,
      ...(gen.files.length ? { files: gen.files } : {}),
      manifestDigest,
      ...(skillWarnings.length ? { warning: skillWarnings.join("; ") } : {}),
    }
  } else if (entry.type === "agent") {
    // #361(Codex 裁决 Q1/Q4):catalog agent 收编 #358 的 file-action 事务载体 —— remote/builtin
    // 内容一律先提升进验证共享 CAS,installAgentFromCas(file md + config 叶单事务、requireAbsent、
    // #348 授权闸、引擎 commitReceipt 单点)。本分支自提交并早返回:账本归引擎,无手工补偿。
    // 身份合同与 seed 同钉(#358 裁决 B):id/name 交叉约束,拒漂移。
    if (entry.id !== `agent:${entry.name}`) {
      rollback("agent identity drift")
      return { ok: false, reason: `catalog entry id "${entry.id}" ≠ "agent:${entry.name}" — refusing (identity drift)` }
    }
    // #361 裁决缺口 2(边界禁用):manifest extension name 允许 "--",但事务 key 方案
    // (agent--<name>[--config])对其歧义 —— 与载体拒绝同源,在 catalog 边界显式拒。
    if (entry.name.includes("--")) {
      rollback("ambiguous agent name")
      return { ok: false, reason: `agent name "${entry.name}" contains "--" — ambiguous with the transaction key scheme (agent--<name>[--config]); refused` }
    }
    const fsSpec = spec as { kind?: string; source?: string; builtinAssetKey?: string } | undefined
    let promoted: { specs: TxFileSpec[]; warnings: string[] }
    if (fsSpec?.source === "remote" && entry.remoteAsset?.files?.length) {
      // #348:authorize 确认重驱不得二次下载 —— 首驱已提升进 CAS,逐 blob 读取重验命中即复用。
      const cached = tryReuseCasPayload(deps.casBaseRoot(), entry.remoteAsset.files)
      if (cached.hit) {
        promoted = { specs: cached.specs, warnings: [] }
      } else {
        const dl = await deps.installers.downloadRemoteAsset(entry.remoteAsset.files)
        if (!dl.ok) {
          rollback(dl.reason)
          return dl
        }
        const p = promotePayloadToCas(deps.casBaseRoot(), dl.contents, entry.remoteAsset.files)
        if (!p.ok) {
          rollback(p.reason)
          return { ok: false, reason: p.reason }
        }
        promoted = p
      }
      payloadDigest = aggregateFilesDigest(entry.remoteAsset.files)
    } else if (fsSpec?.source === "builtin" && fsSpec.builtinAssetKey) {
      const c = deps.installers.collectBuiltinAgentPayload(fsSpec.builtinAssetKey, entry.name)
      if (!c.ok) {
        rollback(c.reason)
        return c
      }
      // builtin 同 skill 先例(#303 裁决 B):自算内容地址进 CAS(摄取后完整性,不主张上游真实性),
      // payloadDigest 补齐安装事实。
      const builtinManifest = c.files.map((f) => ({ path: f.path, sha256: sha256Hex(f.data), bytes: f.data.length }))
      const p = promotePayloadToCas(deps.casBaseRoot(), c.files, builtinManifest)
      if (!p.ok) {
        rollback(p.reason)
        return { ok: false, reason: p.reason }
      }
      promoted = p
      payloadDigest = aggregateFilesDigest(builtinManifest)
    } else {
      rollback("no installable content")
      return { ok: false, reason: "该内容尚未随此版本打包(entry declares no installable asset)" }
    }
    // promotion warnings 产生即落 main 日志(review r5:authorize 暂停会丢弃本次 attempt 的
    // warnings,确认重驱 CAS 命中后不再复现 —— 留痕不依赖后续路径;成功 outcome 仍合并透传)。
    if (promoted.warnings.length)
      console.error(`[ext-install-planner] agent ${entry.name}: CAS promotion warnings: ${promoted.warnings.join("; ")}`)
    const [agentCasSpec] = promoted.specs
    if (promoted.specs.length !== 1 || !agentCasSpec) {
      rollback("agent asset not a single file")
      return { ok: false, reason: `agent asset must contain exactly one file (got ${promoted.specs.length}) — refused` }
    }
    const agentRoot = scope.root(deps)
    const agentConfigTarget = path.join(agentRoot, "alpha.jsonc")
    const agentGen = await installAgentFromCas(agentRoot, {
      name: entry.name,
      id: entry.id,
      environment: deps.environment(),
      scope: scope.identity,
      origin: "catalog",
      source: entry.source, // #395:fresh-intake 初始启用分类输入
      ...curationPolicyFactsOf(entry, deps.now?.() ?? new Date().toISOString()), // #397:有效 curation 声明透传
      casFile: { spec: agentCasSpec, casBaseRoot: deps.casBaseRoot() },
      // #348:能力集取严格解码后的 manifest.capabilities(单一事实);重驱决定由 main 打戳。
      capabilities: manifest.capabilities,
      ...(intent.authorization ? { authorization: stampAuthorization(intent.authorization, () => deps.now?.() ?? new Date().toISOString())! } : {}),
      version: manifest.version,
      manifestDigest,
      ...(payloadDigest ? { payloadDigest } : {}),
      grantDigest: computeGrantDigest(grants),
      // fresh-only 门作为锁内 precondition(agent 无更新链;锁外写前门只是快速拒,锁内重读封 TOCTOU)。
      precondition: () => agentFreshGate(agentRoot, entry.name, agentConfigTarget, "catalog"),
    })
    if (!agentGen.ok) {
      rollback(agentGen.reason)
      if (agentGen.stage === "authorize") return { ok: false, stage: "authorize", reason: agentGen.reason, authorization: agentGen.authorization }
      return { ok: false, reason: agentGen.reason, ...(agentGen.stage ? { stage: agentGen.stage } : {}) }
    }
    ;(deps.transaction ?? passthroughTx).commit(tx.txId)
    // loud 信号不吞(裁决缺口 3 + review r1 Major 2):CAS 自愈 warning 与引擎提交后非致命
    // 失败(grant/授权收据写失败等)一并透传 outcome。
    const agentWarnings = [...promoted.warnings, ...agentGen.warnings]
    return {
      ok: true,
      kind: "agent",
      name: entry.name,
      files: agentGen.files,
      manifestDigest,
      ...(agentWarnings.length ? { warning: agentWarnings.join("; ") } : {}),
    }
  } else if (entry.type === "cloud") {
    // #378(Codex 裁决 Q3/D4):receipts-only 语义(REQ-020 T4)收进 receipt action 单事务
    // (bundle 同形态,零盘副作用)—— capabilities 过 #348 授权闸(扩权 diff 锁内自动触发),
    // 账本归引擎 commitReceipt 单点(exact-replay 已是 upsertRecordsV2 通用合同)。重装显式
    // 继承停用态(裁决 Q3:不得把 disabled 静默写回 enabled;plugin replace 同一纪律)。
    const cloudRoot = scope.root(deps)
    // #395(Codex r1 Major 2):经统一分类器 —— cloud 恒 enabled(无本地运行面 + UI 无启停开关),
    // 与 bundle cloud 子项一致;既有记录当前策略优先(nextDesiredState 内含)。
    // #397:有效 curation 声明优先于 cloud 例外(声明是合同面;当前目录无策展 cloud 条目)。
    const cloudNow = deps.now?.() ?? new Date().toISOString()
    // #397 r3:纯计算;session-grant 归位 = receipt 写点例外标记。forced 场景 drift 基线取
    // 计划期观测态(cloudDesiredStateGate 的 current 语义:无记录/enabled 折叠为 enabled)。
    const cloudPolicyFacts = curationPolicyFactsOf(entry, cloudNow)
    const cloudSessionGrantForced = cloudPolicyFacts.activationPolicy === "session-grant"
    const cloudPlanObserved: DesiredState = findRecordV2(cloudRoot, "cloud", entry.name)?.desiredState === "disabled" ? "disabled" : "enabled"
    const plannedState = nextDesiredState(cloudRoot, "cloud", entry.name, { origin: "catalog", source: entry.source, ...cloudPolicyFacts })
    const cloudReceipt: UpsertInput = {
      id: entry.id,
      name: entry.name,
      kind: "cloud",
      environment: deps.environment(),
      scope: scope.identity,
      version: manifest.version,
      manifestDigest,
      grantDigest: computeGrantDigest(grants),
      desiredState: plannedState,
      ...(cloudSessionGrantForced ? { sessionGrantEnforced: true as const } : {}), // #397 r3:写点例外标记
      origin: "catalog",
      installedAt: cloudNow,
    }
    const plan: TxPlan = {
      items: [
        {
          key: `cloud--${entry.name}`,
          action: "receipt",
          manifestDigest,
          capabilities: manifest.capabilities,
          receipt: cloudReceipt,
        },
      ],
      ...(intent.authorization ? { authorization: stampAuthorization(intent.authorization, () => deps.now?.() ?? new Date().toISOString())! } : {}),
    }
    const hooks: TxHooks = {
      populate: () => {}, // receipt action 无 staging 载荷
      // 锁内 precondition:账本可写 + desiredState 未漂移(r1 Major:继承值在锁外读,并发
      // disable 与本安装交错时旧快照会把 enabled 写回去 —— 锁内重读不一致即拒,用户重试)。
      precondition: () => {
        const ledger = probeLedgerForWrite(cloudRoot)
        if (!ledger.ok) return { ok: false, reason: `refusing cloud install: ${ledger.reason}` }
        // #397 r3:forced 场景计划值恒 disabled ≠ current 不是漂移(写点例外落 disabled)——
        // drift 基线用计划期观测态,只拦真正的并发变化。
        return cloudDesiredStateGate(cloudRoot, entry.name, cloudSessionGrantForced ? cloudPlanObserved : plannedState)
      },
      commitReceipt: (records: TxCommitRecord[]) => {
        const written = upsertRecordsV2(cloudRoot, recoveryReceiptInputs(records))
        if (!written.ok) throw new Error(`cloud receipt commit failed: ${written.reason}`)
      },
    }
    const result = await runExtensionTransaction(cloudRoot, plan, hooks)
    if (!result.ok) {
      rollback(result.reason)
      if (result.stage === "authorize") {
        if (result.authorization) return { ok: false, stage: "authorize", reason: result.reason, authorization: result.authorization }
        return { ok: false, reason: result.reason }
      }
      return { ok: false, reason: result.reason, ...(result.stage ? { stage: result.stage } : {}) }
    }
    ;(deps.transaction ?? passthroughTx).commit(tx.txId)
    return {
      ok: true,
      kind: "cloud",
      name: entry.name,
      manifestDigest,
      ...(result.warnings.length ? { warning: result.warnings.join("; ") } : {}),
    }
  }
  rollback(`unsupported kind: ${entry.type}`)
  return { ok: false, reason: `unsupported kind: ${entry.type}` }
}

// ── seed install(REQ-102 #317:选中 skill seed 经共享 CAS 事务物化;skill/global-only 首期)────

const SEMVER_SEGMENT_RE = /^(0|[1-9]\d*)$/

/** 严格三段 semver 双方都可解析才可比(返回 <0 / 0 / >0);任一侧不可解析 = null(调用方 fail-closed)。
 *  BigInt 逐段比较(Number 会在 2^53 后精度丢失把真 downgrade 判相等,Codex review #360)+ 拒前导零
 *  (SemVer 不允许,且 "01" 与 "1" 判等会造成身份歧义)。 */
export function compareVersionsSafe(a: string, b: string): number | null {
  const pa = a.split(".")
  const pb = b.split(".")
  if (pa.length !== 3 || pb.length !== 3) return null
  for (const seg of [...pa, ...pb]) if (!SEMVER_SEGMENT_RE.test(seg)) return null
  for (let i = 0; i < 3; i++) {
    const da = BigInt(pa[i]!)
    const db = BigInt(pb[i]!)
    if (da !== db) return da > db ? 1 : -1
  }
  return 0
}

/** seed 安装版本门(Codex review #360 两 Blocker 的修复;必须在引擎 Bundle 锁内经 precondition 执行,
 *  锁外判定可被并发安装绕过):账本 strict 四态 —— 损坏 fail-closed;已装(v2 或 v1-only)但无版本 =
 *  不可比 = 拒;可比且 seed 更低 = 拒;absent / 同版本 / seed 更高 = 放行。
 *  #359 裁决 B:按 kind 泛化(skill 之外 mcp 同用;plugin 走 #352 三态,agent 走 fresh-only 门)。 */
function seedInstallVersionGate(root: string, kind: InstallReceiptType, name: string, seedVersion: string): { ok: true } | { ok: false; reason: string } {
  const lookup = lookupForUninstall(root, kind, name)
  if (lookup.status === "corrupt-match" || lookup.status === "ledger-corrupt")
    return { ok: false, reason: `refusing seed install: ${lookup.reason}` }
  let installedVersion: string | undefined
  if (lookup.status === "valid") installedVersion = lookup.record.version
  else if (lookup.status === "v1") installedVersion = lookup.receipt.version
  else return { ok: true }
  if (installedVersion === undefined)
    return { ok: false, reason: `installed ${kind} "${name}" has no recorded version — not comparable to seed ${seedVersion}, refusing (fail closed)` }
  if (installedVersion === seedVersion) return { ok: true }
  const cmp = compareVersionsSafe(seedVersion, installedVersion)
  if (cmp === null)
    return { ok: false, reason: `installed version ${installedVersion} not comparable to seed ${seedVersion} — refusing (no accidental downgrade channel)` }
  if (cmp < 0) return { ok: false, reason: `installed version ${installedVersion} is newer than seed ${seedVersion} — refusing downgrade` }
  return { ok: true }
}

/** agent 的 fresh-only 门(REQ-102 #358 Codex 裁决 Q3:agent 无更新链;#361 起 seed 与 catalog
 *  同门)。**必须在引擎 Bundle 锁内经 precondition 执行**:账本 strict(损坏 fail-closed;v2 或
 *  v1-only 在场 = 拒)+ 写前账本健康探测 + md 文件(含 legacy 单数目录)/ config `agent.<name>` 叶
 *  在场检查 —— 同名任何在场都拒(未策展内容不认领),config 不可读同样 fail-closed。 */
function agentFreshGate(root: string, name: string, configTarget: string, channel: "seed" | "catalog" | "import"): { ok: true } | { ok: false; reason: string } {
  const refuse = `refusing ${channel} install`
  const ledgerProbe = probeLedgerForWrite(root)
  if (!ledgerProbe.ok) return { ok: false, reason: `${refuse}: ${ledgerProbe.reason}` }
  const lookup = lookupForUninstall(root, "agent", name)
  if (lookup.status === "corrupt-match" || lookup.status === "ledger-corrupt")
    return { ok: false, reason: `${refuse}: ${lookup.reason}` }
  if (lookup.status === "valid" || lookup.status === "v1")
    return { ok: false, reason: `agent "${name}" already present — agents have no update path; refusing overwrite` }
  for (const dir of ["agents", "agent"]) {
    if (fs.existsSync(path.join(root, dir, `${name}.md`)))
      return { ok: false, reason: `agent md "${dir}/${name}.md" exists without a ledger record — refusing to overwrite or adopt unregistered content` }
  }
  if (fs.existsSync(configTarget)) {
    let text: string
    try {
      text = fs.readFileSync(configTarget, "utf8")
    } catch {
      return { ok: false, reason: `${refuse}: config ${configTarget} unreadable (fail closed)` }
    }
    const errors: ParseError[] = []
    const cfg: unknown = parse(text, errors)
    if (errors.length > 0) return { ok: false, reason: `${refuse}: config ${configTarget} is not valid jsonc (fail closed)` }
    // #358 review Major 5:合法 jsonc 但形状异常(根非对象 / agent 段非对象)= config 损坏 ——
    // 写盘前 fail-closed 拒,绝不放行到 jsonc modify(异常形状会让 edit 抛错)。
    if (cfg !== undefined && !isObj(cfg))
      return { ok: false, reason: `${refuse}: config ${configTarget} root is not an object (fail closed)` }
    const agentMap = isObj(cfg) ? cfg.agent : undefined
    if (agentMap !== undefined && !isObj(agentMap))
      return { ok: false, reason: `${refuse}: config "agent" section is not an object (fail closed)` }
    if (isObj(agentMap) && agentMap[name] !== undefined)
      return { ok: false, reason: `config entry "agent.${name}" exists without a ledger record — refusing to overwrite or adopt unregistered content` }
  }
  return { ok: true }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// #390(REQ-098):未策展导入(folder/git 技能 + imported agent)走验证共享 CAS + 事务 —— 取代
// flat copy。裁决 A(2026-07-17 Codex DECIDE):flat 路径崩溃留可加载半成品 / agent active-无账本
// fail-open;事务载体(installSkillGeneration / installAgentFromCas)封窗:staging→verify→
// materialize→switch,journal + 崩溃可恢复,commitReceipt 失败回滚+quarantine。scope 限 global
// (ADR-030:project 本地技能维持 `<project>/.alpha/skills` sanctioned flat 路径,不 reopen
// project generation)。capabilities=[](未策展无 manifest 能力);id=`user:<name>` 保留既有账本身份。
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** #390:未策展导入只需环境/根三元(不触 installers/resolveEntry/advisoryGate);PlannerDeps 是其超集,
 *  ext-ipc 直接传 plannerDeps()。单列以便窄测。 */
export type UncuratedImportDeps = {
  globalRoot(): string
  casBaseRoot(): string
  environment(): AppEnvironment
}

export type UncuratedImportOutcome =
  /** #336 r1:projectionLag = 账本已 durable 但 skills 派生允许集发布失败(本次未注入,重启自愈)
   *  —— 独立判别字段(不折叠进 warning),renderer 据此给用户「重启后生效」级呈现。 */
  | { ok: true; kind: "skill" | "agent"; name: string; files?: string[]; warning?: string; projectionLag?: string }
  | { ok: false; reason: string }

/** 未策展 skill 的 fresh-only 门(agent 无更新链,skill 未策展导入同款 fresh-only)—— 与
 *  agentFreshGate 对称:catalog/损坏冲突(checkUncuratedConflict)+ 账本可写 + 任一同名有效/ v1
 *  记录拒 + 无账 flat 目录拒。锁外 preflight 省无谓 CAS 写,锁内 precondition 封 TOCTOU。
 *
 *  REQ-128 Phase 3 `#781`:**导出**给本地 Claude 插件包的安装路径复用(为 N 个 accepted 建
 *  锁内组合 precondition)。逻辑一个字未改 —— **复用同一个闸**是这条要求的全部要点:自己写一个
 *  「查账本 record」的替身会漏掉它已经在查的三样,而那三样各自都是「静默认领用户既有内容」的
 *  入口:损坏账本(`probeLedgerForWrite`)、**无账本的 flat 目录**、**残留 generation store**。 */
export function uncuratedSkillFreshGate(root: string, name: string): { ok: true } | { ok: false; reason: string } {
  const base = checkUncuratedConflict(root, "skill", name)
  if (!base.ok) return base
  const probe = probeLedgerForWrite(root)
  if (!probe.ok) return { ok: false, reason: `refusing import install: ${probe.reason}` }
  const lookup = lookupForUninstall(root, "skill", name)
  if (lookup.status === "valid" || lookup.status === "v1")
    return { ok: false, reason: `skill "${name}" already present — uninstall it first before re-importing` }
  if (fs.existsSync(path.join(root, "skills", name)))
    return { ok: false, reason: `skill dir "skills/${name}" exists without a ledger record — refusing to overwrite or adopt unregistered content` }
  // review r1 Major 2:generation store 在盘即拒 —— checkUncuratedConflict/hasSkillGeneration 只认「可解析
  // 的健康 live generation」,current.json 缺失/损坏/悬空但 ext-store/skill--<name> 已存在时会漏放行,
  // 新事务改写 current 认领残留 store。store 目录在场且无健康 generation = fail-closed(不认领残留)。
  if (fs.existsSync(skillStorePaths(root, name).store) && !hasSkillGeneration(root, name))
    return { ok: false, reason: `skill store for "${name}" exists but is not a healthy generation — refusing to adopt unregistered/dangling store (fail closed)` }
  return { ok: true }
}

/** #390:global 未策展技能导入(folder/git)走 CAS + generation 事务。srcDir 已由调用方(folder =
 *  picker / git = cloneSkillGitToTmp)解析为本地源目录。 */
export async function installUncuratedSkillImport(
  srcDir: string,
  deps: UncuratedImportDeps,
  opts: { origin: UncuratedOrigin },
): Promise<UncuratedImportOutcome> {
  const collected = collectImportSkillPayload(srcDir)
  if (!collected.ok) return { ok: false, reason: collected.reason }
  const { name, files } = collected
  const root = deps.globalRoot()
  const pre = uncuratedSkillFreshGate(root, name)
  if (!pre.ok) return pre
  const manifest = files.map((f) => ({ path: f.path, sha256: sha256Hex(f.data), bytes: f.data.length }))
  const promoted = promotePayloadToCas(deps.casBaseRoot(), files, manifest)
  if (!promoted.ok) return { ok: false, reason: promoted.reason }
  if (promoted.warnings.length)
    console.error(`[ext-install-planner] uncurated skill ${name}: CAS promotion warnings: ${promoted.warnings.join("; ")}`)
  const gen = await installSkillGeneration(root, {
    name,
    id: `user:${name}`,
    environment: deps.environment(),
    scope: { kind: "global" },
    origin: opts.origin,
    casFiles: { specs: promoted.specs, casBaseRoot: deps.casBaseRoot() },
    // 未策展导入无 manifest 能力 —— 显式空集(installSkillGeneration 要求 capabilities 必填,
    // 缺省会被安静遗漏;空集 = authorize 闸静默通过,符合未策展语义)。
    capabilities: [],
    // 不带 payload/manifest/grant digest:#306 不变量 —— 非 catalog 来源的账本禁携供给链摘要
    // (防伪造 catalog provenance)。CAS blob 仍按内容寻址,完整性由事务 verify/probe 保证。
    // 锁内 fresh-only(封锁外 preflight→写盘 TOCTOU;与 agentFreshGate precondition 同纪律)。
    precondition: () => uncuratedSkillFreshGate(root, name),
  })
  if (!gen.ok) return { ok: false, reason: gen.reason }
  // #336 r1:projectionLag 以独立判别字段透传(不折叠进 warning)—— preload/renderer 端到端呈现。
  return {
    ok: true,
    kind: "skill",
    name,
    ...(gen.files.length ? { files: gen.files } : {}),
    ...(promoted.warnings.length ? { warning: promoted.warnings.join("; ") } : {}),
    ...(gen.projectionLag ? { projectionLag: gen.projectionLag } : {}),
  }
}

/** #390:imported agent(preview 确认)走 CAS + file/config 单事务(取代 flat writeAgent 的
 *  active-无账本 fail-open)。composedMd = main 侧留存的 preview 产物(renderer 无写入内容通道)。 */
export async function installUncuratedAgentImport(
  name: string,
  composedMd: string,
  deps: UncuratedImportDeps,
  opts: { origin: UncuratedOrigin },
): Promise<UncuratedImportOutcome> {
  if (!isExtensionName(name)) return { ok: false, reason: "invalid agent name" }
  if (name.includes("--"))
    return { ok: false, reason: `agent name "${name}" contains "--" — ambiguous with the transaction key scheme; refused` }
  const root = deps.globalRoot()
  const configTarget = path.join(root, "alpha.jsonc")
  const pre = agentFreshGate(root, name, configTarget, "import")
  if (!pre.ok) return pre
  // 与 flat writeAgent 同款换行归一;installAgentFromCas 从 CAS 字节重解析(agentMdToEntry fail-closed)。
  const data = Buffer.from(composedMd.endsWith("\n") ? composedMd : `${composedMd}\n`, "utf8")
  const relPath = `${name}.md`
  const manifest = [{ path: relPath, sha256: sha256Hex(data), bytes: data.length }]
  const promoted = promotePayloadToCas(deps.casBaseRoot(), [{ path: relPath, data }], manifest)
  if (!promoted.ok) return { ok: false, reason: promoted.reason }
  if (promoted.warnings.length)
    console.error(`[ext-install-planner] uncurated agent ${name}: CAS promotion warnings: ${promoted.warnings.join("; ")}`)
  const [agentCasSpec] = promoted.specs
  if (promoted.specs.length !== 1 || !agentCasSpec) return { ok: false, reason: "agent asset must contain exactly one file — refused" }
  const agentGen = await installAgentFromCas(root, {
    name,
    id: `user:${name}`,
    environment: deps.environment(),
    scope: { kind: "global" },
    origin: opts.origin,
    casFile: { spec: agentCasSpec, casBaseRoot: deps.casBaseRoot() },
    capabilities: [],
    // #306 不变量:非 catalog 来源账本禁携供给链摘要(见 skill 分支注释)。
    precondition: () => agentFreshGate(root, name, configTarget, "import"),
  })
  if (!agentGen.ok) return { ok: false, reason: agentGen.reason }
  return {
    ok: true,
    kind: "agent",
    name,
    ...(agentGen.files.length ? { files: agentGen.files } : {}),
    ...(agentGen.warnings.length ? { warning: agentGen.warnings.join("; ") } : {}),
  }
}

/** mcp seed 的锁内门(#359 裁决 B/E):账本写前探测 + 版本门(kind 泛化,downgrade/不可比拒)+
 *  无账 config 叶拒认领 + 形状异常 fail-closed(根/mcp 段非对象 —— 合法 jsonc 也可能形状异常,
 *  与 agent 门同款,否则 jsonc modify 会在锁内抛异常)。 */
function mcpSeedGate(root: string, name: string, configTarget: string, seedVersion: string, plannedState: DesiredState): { ok: true } | { ok: false; reason: string } {
  const ledgerProbe = probeLedgerForWrite(root)
  if (!ledgerProbe.ok) return { ok: false, reason: `refusing seed install: ${ledgerProbe.reason}` }
  // Codex r9 B2:desiredState 漂移钉死 —— seed config edit 也用 plan 期 desiredState;并发 disable 后
  // 旧快照会落无 enabled:false 的 config。漂移即拒重试(fresh 无 prior 不进此支)。
  const prior = findRecordV2(root, "mcp", name)
  if ((prior?.desiredState ?? plannedState) !== plannedState)
    return { ok: false, reason: `refusing seed install: mcp desired state changed since plan — retry` }
  const gate = seedInstallVersionGate(root, "mcp", name, seedVersion)
  if (!gate.ok) return gate
  if (fs.existsSync(configTarget)) {
    let text: string
    try {
      text = fs.readFileSync(configTarget, "utf8")
    } catch {
      return { ok: false, reason: `refusing seed install: config ${configTarget} unreadable (fail closed)` }
    }
    const errors: ParseError[] = []
    const cfg: unknown = parse(text, errors)
    if (errors.length > 0) return { ok: false, reason: `refusing seed install: config ${configTarget} is not valid jsonc (fail closed)` }
    if (cfg !== undefined && !isObj(cfg))
      return { ok: false, reason: `refusing seed install: config ${configTarget} root is not an object (fail closed)` }
    const mcpMap = isObj(cfg) ? cfg.mcp : undefined
    if (mcpMap !== undefined && !isObj(mcpMap))
      return { ok: false, reason: `refusing seed install: config "mcp" section is not an object (fail closed)` }
    if (isObj(mcpMap) && mcpMap[name] !== undefined && lookupForUninstall(root, "mcp", name).status === "absent")
      return { ok: false, reason: `config entry "mcp.${name}" exists without a ledger record — refusing to overwrite or adopt unregistered content` }
  }
  return { ok: true }
}

/** 双真源交叉验证(Codex 裁决 C,#317 AC2):seed lock 权威「离线字节」,bundled entry 权威安装语义;
 *  id/type/version/source/逐文件 path+sha256+bytes/聚合 digest 任一不合 = 漂移,返回原因(调用方 fail-closed)。 */
function crossCheckSeedAssetAgainstEntry(asset: SeedAsset, entry: CatalogEntry): string | null {
  if (entry.id !== asset.id) return `entry id ${entry.id} ≠ asset id ${asset.id}`
  if (entry.type !== asset.type) return `entry type ${entry.type} ≠ asset type ${asset.type}`
  // #395(Codex r1 Major 3):source 也交叉核对 —— 分类以 entry.source 为权威,两真源 source 漂移
  // (如 lock=official 但 entry=alpha)会把第三方 seed 误判第一方默认开,fail-closed 拒。
  if (entry.source !== asset.source) return `entry source ${entry.source} ≠ asset source ${asset.source}`
  if (typeof entry.version !== "string" || entry.version !== asset.version)
    return `entry version ${String(entry.version)} ≠ asset version ${asset.version}`
  const files = entry.remoteAsset?.files
  if (!files?.length) return "bundled entry declares no remoteAsset files"
  if (files.length !== asset.files.length) return `file manifest size ${files.length} ≠ ${asset.files.length}`
  const byPath = new Map(files.map((f) => [f.path, f]))
  for (const f of asset.files) {
    const e = byPath.get(f.path)
    if (!e) return `file ${f.path} not in bundled entry remoteAsset`
    if (e.sha256 !== f.sha256) return `sha256 mismatch for ${f.path}`
    if (e.bytes !== f.bytes) return `bytes mismatch for ${f.path}`
  }
  if (aggregateFilesDigest(asset.files) !== aggregateFilesDigest(files)) return "aggregate payload digest mismatch"
  return null
}

/** Resolve the exact recovery root without mutating it. Global intents need only strict wire
 * decoding. Project intents additionally need main-owned verified MCP facts (and complete seed
 * byte verification) before the write channel may replay D's journal. */
export async function resolveCatalogInstallWriteRoot(
  rawIntent: unknown,
  deps: PlannerDeps,
): Promise<{ ok: true; root: string } | { ok: false; reason: string }> {
  if (isObj(rawIntent) && Object.hasOwn(rawIntent, "attemptId")) {
    const allowed = new Set(["catalogId", "scope", "attemptId", "grants", "authorization"])
    const unknown = Object.keys(rawIntent).find((key) => !allowed.has(key))
    if (unknown) return { ok: false, reason: `package admission: renderer-supplied key "${unknown}" is refused` }
    if (!isObj(rawIntent.scope)) return { ok: false, reason: "package admission: invalid scope" }
    if (rawIntent.scope.scope === "global" && Object.keys(rawIntent.scope).every((key) => key === "scope"))
      return { ok: true, root: deps.globalRoot() }
    if (
      rawIntent.scope.scope === "project" &&
      Object.keys(rawIntent.scope).every((key) => key === "scope" || key === "projectDir") &&
      typeof rawIntent.scope.projectDir === "string" &&
      path.isAbsolute(rawIntent.scope.projectDir)
    )
      return { ok: false, reason: PROJECT_INSTALL_UNSUPPORTED_REASON }
    return { ok: false, reason: "package admission: invalid scope" }
  }

  const decoded = decodeCatalogInstallIntent(rawIntent)
  if (!decoded.ok) return decoded
  if (decoded.intent.scope.scope === "global") return { ok: true, root: deps.globalRoot() }

  if ("catalogId" in decoded.intent) {
    const verified = await deps.resolveEntry(decoded.intent.catalogId)
    if (!verified) return { ok: false, reason: `entry not in verified catalog: ${decoded.intent.catalogId}` }
    if (verified.entry.type !== "mcp") return { ok: false, reason: PROJECT_INSTALL_UNSUPPORTED_REASON }
    const scope = resolveScope(decoded.intent.scope, verified.entry.type)
    return scope.ok ? { ok: true, root: scope.root(deps) } : scope
  }

  const seedIntent = "source" in decoded.intent ? decoded.intent : undefined
  if (!seedIntent) return { ok: false, reason: "decoded install intent has no catalog or seed discriminator — refused" }
  const seedDeps = deps.seed
  if (!seedDeps) return { ok: false, reason: "seed install channel not available" }
  const seedDir = seedDeps.seedDir()
  if (!seedDir) return { ok: false, reason: "no packaged seed available" }
  const read = readPackagedSeed(seedDir)
  if (!read.ok) return { ok: false, reason: `packaged seed rejected (fail closed): ${read.error}` }
  const asset = read.seed.assets.find((candidate) => candidate.id === seedIntent.assetId)
  if (!asset) return { ok: false, reason: `asset not in packaged seed: ${seedIntent.assetId}` }
  const verified = seedDeps.resolveBundledEntry(asset.id)
  if (!verified) return { ok: false, reason: `asset ${asset.id} not in bundled catalog — refusing (seed/catalog drift)` }
  if (verified.channel !== "bundled")
    return { ok: false, reason: "seed install must resolve against the bundled catalog snapshot — refused" }
  if (read.seed.lock.catalogVersion !== verified.catalogVersion)
    return {
      ok: false,
      reason: `seed lock catalogVersion ${read.seed.lock.catalogVersion} ≠ bundled catalog ${verified.catalogVersion} — refusing (drift)`,
    }
  const drift = crossCheckSeedAssetAgainstEntry(asset, verified.entry)
  if (drift) return { ok: false, reason: `seed/catalog drift for ${asset.id}: ${drift} — refused` }
  const assetVerified = verifySeedAsset(seedDir, read.seed.lock, asset.id)
  if (!assetVerified.ok) return { ok: false, reason: assetVerified.reason }
  if (asset.type !== "mcp" || verified.entry.type !== "mcp")
    return { ok: false, reason: PROJECT_INSTALL_UNSUPPORTED_REASON }
  const scope = resolveScope(seedIntent.scope, verified.entry.type)
  return scope.ok ? { ok: true, root: scope.root(deps) } : scope
}

/**
 * 选中 seed 资产安装(REQ-102 #317):严格意图 → 随包 seed 读取 → 回表同包 bundled catalog(绝不
 * 用 effective remote/cache)→ 双真源交叉验证。global 载荷提升进共享 CAS 后由 generation/config
 * 事务消费；REQ-136 project 只允许 verified MCP，运行 verifySeedAsset 后直接走 config-only
 * transaction，绝不提升 CAS。互斥:global CAS promotion 在事务锁前(不可变、幂等、同 digest
 * 原子写);写互斥由 runExtensionTransaction 的引擎锁承担 —— 此处不得先拿 bundle 锁。
 */
async function installSeedAsset(intent: SeedInstallIntent, deps: PlannerDeps): Promise<CatalogInstallOutcome> {
  const seedDeps = deps.seed
  if (!seedDeps) return { ok: false, reason: "seed install channel not available" }
  const seedDir = seedDeps.seedDir()
  if (!seedDir) return { ok: false, reason: "no packaged seed available" }

  const read = readPackagedSeed(seedDir)
  if (!read.ok) return { ok: false, reason: `packaged seed rejected (fail closed): ${read.error}` }
  const view = read.seed
  const asset = view.assets.find((a) => a.id === intent.assetId)
  if (!asset) return { ok: false, reason: `asset not in packaged seed: ${intent.assetId}` }
  // ADR-040(`#825` 第 4 条,seed 半场):`plugin` 从可 seed 安装的类型里移除。seed lock 的 type
  // 枚举里至今仍有 `plugin`,且构建器只按「有没有 remoteAsset」筛、零类型闸(ADR-040 §后果 7)——
  // 所以这道拒绝必须落在**装载侧**,不能指望「今天随包里恰好没有可执行载荷」。
  if (intent.scope.scope === "global" && asset.type === "plugin")
    return {
      ok: false,
      reason: `asset ${asset.id} is an engine plugin — Alpha no longer installs executable plugins into the engine (ADR-040); refusing`,
    }
  if (intent.scope.scope === "global" && asset.type !== "skill" && asset.type !== "agent" && asset.type !== "mcp")
    return { ok: false, reason: `seed install for type "${asset.type}" is not installable from seed — refused` }
  if (!asset.platformCompatible) return { ok: false, reason: `asset ${asset.id} is not built for this platform — refused` }

  const verified = seedDeps.resolveBundledEntry(asset.id)
  if (!verified) return { ok: false, reason: `asset ${asset.id} not in bundled catalog — refusing (seed/catalog drift)` }
  if (verified.channel !== "bundled")
    return { ok: false, reason: "seed install must resolve against the bundled catalog snapshot — refused" }
  if (view.lock.catalogVersion !== verified.catalogVersion)
    return { ok: false, reason: `seed lock catalogVersion ${view.lock.catalogVersion} ≠ bundled catalog ${verified.catalogVersion} — refusing (drift)` }
  const entry = verified.entry
  const drift = crossCheckSeedAssetAgainstEntry(asset, entry)
  if (drift) return { ok: false, reason: `seed/catalog drift for ${asset.id}: ${drift} — refused` }
  if (intent.scope.scope === "project") {
    // The packaged lock alone proves metadata, not the selected blob bytes. Project admission
    // therefore verifies the whole selected asset before accepting its MCP kind, while remaining
    // read-only and CAS-free.
    const assetVerified = verifySeedAsset(seedDir, view.lock, asset.id)
    if (!assetVerified.ok) return { ok: false, reason: assetVerified.reason }
    if (asset.type !== "mcp" || entry.type !== "mcp")
      return { ok: false, reason: PROJECT_INSTALL_UNSUPPORTED_REASON }
  }
  // #315:seed(离线随包)激活同样过闸(office 静态基线 + 已验公示若在场)。
  const seedAdv = deps.advisoryGate(advisoryInputOf(entry, "seed"))
  if (!seedAdv.allowed) return { ok: false, reason: `advisory ${seedAdv.advisoryId}: ${seedAdv.reason} — activation refused (R14)` }

  // #397:seed 与直接安装同一 curation 门(bundled 快照当前无 curation → uncurated 直落保守面)。
  if (isCurationArchived(decodeEntryCurationLoud(entry)))
    return { ok: false, reason: `entry ${entry.id}: upstream is archived per curation review — new installs are refused (existing installs unaffected)` }

  // manifest 合成/严格校验与 catalog 安装同源;交付介质是随包 seed → ownership.distributed 如实记
  // bundled(digest 语义 = 安装时刻 manifest 快照,与 remote 安装的 digest 不同是诚实差异)。
  const synthesized = synthesizeManifest(verified) as Record<string, unknown>
  const ownership = synthesized.ownership as Record<string, unknown>
  const decoded = decodeManifestV2({ ...synthesized, ownership: { ...ownership, distributed: "bundled" } })
  if (!decoded.ok) return { ok: false, reason: `manifest invalid — refusing before any disk write: ${decoded.errors.join("; ")}` }
  const manifest = decoded.manifest
  if (!(manifest.compatibility.platforms as string[]).includes(deps.platform()))
    return { ok: false, reason: `platform ${deps.platform()} not supported by this entry — refusing before any disk write` }
  const manifestDigest = computeManifestDigest(manifest)
  const payloadDigest = aggregateFilesDigest(entry.remoteAsset!.files)
  const scope = resolveScope(intent.scope, entry.type)
  if (!scope.ok) return scope
  const installRoot = scope.root(deps)

  const tx = (deps.transaction ?? passthroughTx).begin({ op: "install", kind: entry.type, name: entry.name, scope: intent.scope.scope, manifestDigest })
  const rollback = (reason: string): void => (deps.transaction ?? passthroughTx).rollback(tx.txId, reason)

  // REQ-136 C8:project MCP's verified seed bytes are distribution evidence only. They are not a
  // runtime payload, so no CAS base is even resolved and the plan remains one files:[] config item.
  if (intent.scope.scope === "project")
    return installSeedMcp({
      deps,
      entry,
      manifest,
      manifestDigest,
      payloadDigest,
      intent,
      rollback,
      root: installRoot,
      scope: scope.identity,
      txId: tx.txId,
    })

  // verify-all-then-promote:任一文件校验不过在展开前拒;成功后 blob 进共享 CAS(幂等,失败残留由
  // GC 语义处理 —— 仍属当前 seed 的 digest 本就是 mark root,#318)。
  const casBaseRoot = deps.casBaseRoot()
  const promoted = promoteSeedAssetToCas(seedDir, view.lock, asset.id, casBaseRoot)
  if (!promoted.ok) {
    rollback(promoted.reason)
    return { ok: false, reason: promoted.reason }
  }

  // ── agent seed(REQ-102 #358):file(md)+ config(agent.<name> 叶)双 item 单事务 ——
  //    落盘路径/授权闸/fresh-only 语义按 2026-07-16 Codex 裁决(issue #358 评论)执行。
  if (asset.type === "agent") {
    // 裁决 B:agent 主键由 bundled entry 决定,且必须校验 id/name 一致(双真源交叉不查 id 后缀)。
    if (entry.id !== `agent:${entry.name}`)
      return { ok: false, reason: `bundled entry id "${entry.id}" ≠ "agent:${entry.name}" — refusing (identity drift)` }
    // promotion warnings 产生即落 main 日志(review r5:authorize 暂停丢弃 attempt warnings,
    // 重驱 blob 已复原不再复现;成功 outcome 仍合并透传)。
    if (promoted.warnings.length)
      console.error(`[ext-install-planner] agent seed ${entry.name}: CAS promotion warnings: ${promoted.warnings.join("; ")}`)
    const [casSpec] = promoted.files
    if (promoted.files.length !== 1 || !casSpec) {
      rollback("agent seed asset must contain exactly one file")
      return { ok: false, reason: `agent seed asset must contain exactly one file (got ${promoted.files.length}) — refused` }
    }
    const configTarget = path.join(installRoot, "alpha.jsonc")
    const agentGen = await installAgentFromCas(installRoot, {
      name: entry.name,
      id: entry.id,
      environment: deps.environment(),
      scope: { kind: "global" },
      origin: "catalog",
      source: entry.source, // #395:seed agent 以已验 bundled entry 的 source 为权威
      ...curationPolicyFactsOf(entry, deps.now?.() ?? new Date().toISOString()), // #397:有效 curation 声明透传
      casFile: { spec: casSpec, casBaseRoot },
      capabilities: manifest.capabilities,
      ...(intent.authorization ? { authorization: stampAuthorization(intent.authorization, () => deps.now?.() ?? new Date().toISOString())! } : {}),
      version: manifest.version,
      manifestDigest,
      payloadDigest,
      grantDigest: computeGrantDigest({}),
      // fresh-only 门作为锁内 precondition(裁决 Q3:agent 无更新链,同名任何在场即 fail-closed;
      // 锁内重读封死锁外判定的 TOCTOU)。
      precondition: () => agentFreshGate(deps.globalRoot(), entry.name, configTarget, "seed"),
    })
    if (!agentGen.ok) {
      rollback(agentGen.reason)
      if (agentGen.stage === "authorize") return { ok: false, stage: "authorize", reason: agentGen.reason, authorization: agentGen.authorization }
      return { ok: false, reason: agentGen.reason, ...(agentGen.stage ? { stage: agentGen.stage } : {}) }
    }
    ;(deps.transaction ?? passthroughTx).commit(tx.txId)
    // loud 信号不吞(review #384 r1 Major 2 + r2:CAS 自愈/竞态诊断与引擎提交后非致命失败
    // 一并透传;seed 与 catalog 同合同)。
    const seedAgentWarnings = [...promoted.warnings, ...agentGen.warnings]
    return {
      ok: true,
      kind: "agent",
      name: entry.name,
      files: agentGen.files,
      manifestDigest,
      ...(seedAgentWarnings.length ? { warning: seedAgentWarnings.join("; ") } : {}),
    }
  }

  // ── mcp seed(REQ-102 #359,2026-07-16 Codex 裁决,见 issue 评论)────────────────────────────
  // plugin seed 随 ADR-040 退场,拒绝点在本函数上方(promotion 之前)。
  if (asset.type === "mcp")
    return installSeedMcp({
      deps,
      entry,
      manifest,
      manifestDigest,
      payloadDigest,
      intent,
      rollback,
      root: installRoot,
      scope: scope.identity,
      txId: tx.txId,
    })

  // downgrade 门作为锁内 precondition:持 Bundle 锁后、写盘前重读账本判定(同版本重装 = 幂等允许,
  // generation 追加可回滚)。锁外判定有确定 TOCTOU(并发 catalog 安装可在窗口内提交更高版本)。
  const gen = await installSkillGeneration(installRoot, {
    name: entry.name,
    id: entry.id,
    environment: deps.environment(),
    scope: { kind: "global" },
    origin: "catalog",
    source: entry.source, // #395:seed 以已验 bundled entry 的 source 为权威
    ...curationPolicyFactsOf(entry, deps.now?.() ?? new Date().toISOString()), // #397 r1-1:seed skill 与其余三型同门
    casFiles: { specs: promoted.files, casBaseRoot },
    // #348:seed 与 catalog 单装同一 authorize 契约(能力集 = 严格解码 manifest;重驱决定 main 打戳)。
    capabilities: manifest.capabilities,
    ...(intent.authorization ? { authorization: stampAuthorization(intent.authorization, () => deps.now?.() ?? new Date().toISOString())! } : {}),
    version: manifest.version,
    manifestDigest,
    payloadDigest,
    grantDigest: computeGrantDigest({}),
    precondition: () => seedInstallVersionGate(deps.globalRoot(), "skill", entry.name, manifest.version),
  })
  if (!gen.ok) {
    rollback(gen.reason)
    if (gen.stage === "authorize") return { ok: false, stage: "authorize", reason: gen.reason, authorization: gen.authorization }
    return { ok: false, reason: gen.reason, ...(gen.stage ? { stage: gen.stage } : {}) }
  }
  ;(deps.transaction ?? passthroughTx).commit(tx.txId)
  // #336:projectionLag 并入用户可见 warning 通道(seed 安装入口)。
  return {
    ok: true,
    kind: "skill",
    name: entry.name,
    ...(gen.files.length ? { files: gen.files } : {}),
    manifestDigest,
    ...(gen.projectionLag ? { warning: gen.projectionLag } : {}),
  }
}

/**
 * mcp seed 安装(REQ-102 #359):config action 单事务 —— 安装语义派生自 bundled entry 的
 * installSpec(CAS blob 只是离线携带字节,**不是运行载荷**:本通道只承诺「离线完成配置安装」,
 * local npm/uvx MCP 首次运行仍可能联网)。phase-1 fail-closed(裁决 Q1):seed intent 无 grants
 * 通道 —— 需密钥/workspace/workspace-policy 的一律拒;retired connectors are rejected by the
 * identity advisory first and the package-aware main write policy before a config action is built.
 * The pure validator(validateServer) then runs before a plan is generated (ext-config-tx 只保证
 * JSONC/顶层键)。事务内绝不触 persistMcp/withConfigWriteLock(自锁)。
 */
async function installSeedMcp(args: {
  deps: PlannerDeps
  entry: CatalogEntry
  manifest: ExtensionManifestV2
  manifestDigest: string
  payloadDigest: string
  intent: SeedInstallIntent
  rollback: (reason: string) => void
  root: string
  scope: ScopeIdentity
  txId: string
}): Promise<CatalogInstallOutcome> {
  const { deps, entry, manifest, manifestDigest, payloadDigest, intent, rollback, root, scope } = args
  const spec = entry.installSpec
  if (spec?.kind !== "mcp") {
    rollback("entry has no mcp installSpec")
    return { ok: false, reason: "entry has no mcp installSpec" }
  }
  // #378 r7 Major:真源路由门(seed MCP 同样只写 <root>/alpha.jsonc)。
  if (intent.scope.scope === "global") {
    const seedMcpTruth = configTruthInRootGate(root, deps.installers.mcpConfigTruthPath())
    if (!seedMcpTruth.ok) {
      rollback(seedMcpTruth.reason)
      return seedMcpTruth
    }
  }
  if ((spec.requiredEnvVars?.length ?? 0) > 0) {
    rollback("secret-bearing MCP")
    return { ok: false, reason: "secret-bearing MCP is not seed-installable (seed intent has no grants channel, phase 1) — refused" }
  }
  if (
    spec.command?.some((argument) => argument.includes("{workspace}")) ||
    isWorkspacePolicyMcp(entry.name, { type: spec.mcpType, ...(spec.command ? { command: spec.command } : {}), ...(spec.url ? { url: spec.url } : {}) })
  ) {
    rollback("workspace-policy MCP")
    return { ok: false, reason: "workspace-policy MCP is not seed-installable (managed workspace is outside the config-action boundary) — refused" }
  }
  const derived = deriveMcpConfig(spec, {})
  if (!derived.ok) {
    rollback(derived.reason)
    return derived
  }
  if (derived.secretVars.length > 0) {
    rollback("secret-bearing MCP")
    return { ok: false, reason: "secret-bearing MCP is not seed-installable (phase 1) — refused" }
  }
  const policy = deps.installers.applyMcpWritePolicy(entry.name, derived.config)
  if (!policy.ok) {
    rollback(policy.reason)
    return { ok: false, reason: `seed MCP write policy refused: ${policy.reason}` }
  }
  // 纯 validator(裁决 B):命令头/inline-eval/URL/危险 env 安全门,零写盘。
  const valid = validateServer(derived.config)
  if (!valid.ok) {
    rollback(valid.reason)
    return { ok: false, reason: `seed MCP config failed validation: ${valid.reason} — refused` }
  }
  const configTarget = path.join(root, "alpha.jsonc")
  const projectMcp = scope.kind === "project"
  const now = deps.now?.() ?? new Date().toISOString()
  // #397 r3:纯计算;session-grant 归位 = receipt 写点例外标记,drift 基线取计划期观测 prior 态。
  const seedMcpPolicyFacts = curationPolicyFactsOf(entry, now)
  const seedMcpSessionGrantForced = seedMcpPolicyFacts.activationPolicy === "session-grant"
  const seedMcpPlanObservedPrior = findRecordV2(root, "mcp", entry.name)?.desiredState
  const receiptTemplate: UpsertInput = {
    id: entry.id,
    name: entry.name,
    kind: "mcp",
    environment: deps.environment(),
    scope,
    version: manifest.version,
    manifestDigest,
    payloadDigest,
    grantDigest: computeGrantDigest({}),
    // #395:同上 —— 单装 MCP fresh-intake 按来源分类。#397:有效 curation 声明优先(seed 同接线)。
    desiredState: nextDesiredState(root, "mcp", entry.name, { origin: "catalog", source: entry.source, ...seedMcpPolicyFacts }),
    ...(seedMcpSessionGrantForced ? { sessionGrantEnforced: true as const } : {}), // #397 r3:写点例外标记
    origin: "catalog",
    configKey: `mcp.${entry.name}`,
    installedAt: now,
  }
  const plan: TxPlan = {
    items: [
      {
        key: `mcp--${entry.name}`,
        action: "config",
        config: { target: configTarget, edits: [{ keyPath: ["mcp", entry.name], value: receiptTemplate.desiredState === "disabled" ? { ...derived.config, enabled: false } : derived.config }] },
        manifestDigest,
        capabilities: manifest.capabilities,
        receipt: receiptTemplate,
      },
    ],
    ...(intent.authorization ? { authorization: stampAuthorization(intent.authorization, () => deps.now?.() ?? new Date().toISOString())! } : {}),
  }
  const hooks: TxHooks = {
    populate: () => {}, // config action 无 staging 载荷
    // #397 r3:forced 场景 drift 基线 = 计划期观测 prior 态(无 prior 时用计划值,gate 的
    // `prior ?? planned` 折叠正确处理 fresh);只拦真正的并发变化,归位交 receipt 写点例外。
    precondition: () => {
      if (projectMcp) {
        const identity = projectMcpWriteIdentityGate(root, configTarget)
        if (!identity.ok) return identity
      }
      return mcpSeedGate(
        root,
        entry.name,
        configTarget,
        manifest.version,
        seedMcpSessionGrantForced ? (seedMcpPlanObservedPrior ?? receiptTemplate.desiredState) : receiptTemplate.desiredState,
      )
    },
    commitReceipt: (records: TxCommitRecord[]) => {
      if (projectMcp) {
        const identity = projectMcpWriteIdentityGate(root, configTarget)
        if (!identity.ok) throw new Error(identity.reason)
      }
      const written = upsertRecordsV2(root, recoveryReceiptInputs(records))
      if (!written.ok) throw new Error(`seed mcp receipt commit failed: ${written.reason}`)
    },
  }
  if (projectMcp) {
    const identity = projectMcpWriteIdentityGate(root, configTarget)
    if (!identity.ok) {
      rollback(identity.reason)
      return identity
    }
  }
  const result = await runExtensionTransaction(root, plan, hooks)
  if (!result.ok) {
    rollback(result.reason)
    if (result.stage === "authorize") {
      if (result.authorization) return { ok: false, stage: "authorize", reason: result.reason, authorization: result.authorization }
      return { ok: false, reason: result.reason }
    }
    return { ok: false, reason: result.reason, ...(result.stage ? { stage: result.stage } : {}) }
  }
  ;(deps.transaction ?? passthroughTx).commit(args.txId)
  // #395:默认关的安装显式标 installedDisabled 供 renderer 与 kind 漂移区分。
  // 启用态由 ext-ipc 在 durable commit 后让 engine 重新加载配置并返回 reference + status。
  if (receiptTemplate.desiredState === "disabled") return { ok: true, kind: "mcp", name: entry.name, manifestDigest, installedDisabled: true }
  return { ok: true, kind: "mcp", name: entry.name, manifestDigest }
}

/** #348 合同推论(#358/#359):经事务授权闸安装的类型(agent/mcp/plugin),卸载必须联动清授权账
 *  —— 删除失败 = 卸载失败且**账本不动**(可重试收敛);残留 grant 会让下一次 fresh install 把旧
 *  capability 集判为已授权(requiresConfirmation=false),静默继承授权。幂等(existsSync 门)。 */
export function removeInstallGrants(root: string, keys: string[]): { ok: true; removed: string[] } | { ok: false; reason: string } {
  const removed: string[] = []
  for (const key of keys) {
    const grantFile = capabilityGrantPath(root, key)
    try {
      if (fs.existsSync(grantFile)) {
        fs.unlinkSync(grantFile)
        removed.push(grantFile)
      }
    } catch (error) {
      return {
        ok: false,
        reason: `authorization grant removal failed for "${key}": ${error instanceof Error ? error.message : String(error)} — uninstall not completed (ledger retained; fix and retry)`,
      }
    }
    try {
      fs.rmdirSync(path.dirname(grantFile)) // 只在空时成功;非空/不存在都不算失败
    } catch {
      /* 幂等 */
    }
  }
  return { ok: true, removed }
}

// ── uninstall(main 从自己账本读事实;owned paths 从受控根重新派生)──────────────────────────────

export async function uninstallByKey(rawIntent: unknown, deps: PlannerDeps): Promise<UninstallOutcome> {
  const decodedIntent = decodeUninstallIntent(rawIntent)
  if (!decodedIntent.ok) return decodedIntent
  const intent = decodedIntent.intent

  let root: string
  let target: TargetArg
  if (intent.scope === "project") {
    // ADR-030:遗留管理面(卸载不受新增安装拒绝影响)—— allowlist 与安装策略分离。
    if (!LEGACY_PROJECT_MANAGEABLE_KINDS.has(intent.type))
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
  if (
    intent.scope === "project" &&
    intent.type === "mcp" &&
    typeof deps.installers.removeProjectMcpConfigInLock !== "function"
  )
    return { ok: false, reason: "project MCP removal seam unavailable — refused before journaling" }

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

  // REQ-128 `#706`(R2 Blocker 的直接修法):claim-aware 判决必须在**删任何实物之前**做完。
  // 这条路径的形状是「先删实物、再去账」,而 V3 的 repository 会在仍有 Bundle owner 时拒写 ——
  // 判决放在后面,用户就会看到「卸载失败」而东西真的已经没了。
  // 仍有 Bundle 在用 ⇒ 一件实物都不动,只把用户自己那份 standalone claim 释放掉。
  const claimPlan = planDirectUninstall(root, intent.type, intent.name)
  if (!claimPlan.ok) return { ok: false, reason: claimPlan.reason }
  if (claimPlan.decision === "release-claim-only") {
    const released = releaseStandaloneClaim(root, intent.type, intent.name)
    if (!released.ok) return { ok: false, reason: `${intent.type} uninstall: ${released.reason}` }
    return {
      ok: true,
      retainedForOwners: released.remainingOwners,
      warning: `${intent.type}:${intent.name} is still part of ${released.remainingOwners.join(", ")} — removed your standalone claim and kept the files`,
    }
  }

  const tx = (deps.transaction ?? passthroughTx).begin({ op: "uninstall", kind: intent.type, name: intent.name, scope: intent.scope })
  const rollback = (reason: string): void => (deps.transaction ?? passthroughTx).rollback(tx.txId, reason)

  let removedFiles: string[] | undefined
  if (intent.type === "skill" && fs.existsSync(skillStorePaths(root, intent.name).store)) {
    // REQ-100 #313:generation-backed skill 卸载走锁内 journaled store+ledger teardown(store-first),
    // 不留孤儿 generation,账本删除失败即 fail-closed(不谎报成功)。恢复补偿见 recoverExtensionTransactions。
    // ADR-030(#372):project 根同路 —— 历史 project generation 残留必须删受控 ext-store + 对应账本,
    // 不得落到 flat removeFsInstall(那会去账留店)。
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
    // #358(review Major 4 收紧):事务安装的 agent 授权账随卸载清除,且是**成功前置** ——
    // 删除失败 = 卸载失败且账本不动(record 仍在场 → 重试幂等收敛:removeFsInstall 幂等、
    // grant 删除 existsSync 门、去账最后);崩溃窗口同理由「账本仍在」保证可重试,不谎报完成。
    if (intent.type === "agent") {
      const grants = removeInstallGrants(root, [agentInstallKey(intent.name), agentConfigItemKey(intent.name)])
      if (!grants.ok) {
        rollback(grants.reason)
        return { ok: false, reason: `agent uninstall: ${grants.reason}` }
      }
      if (grants.removed.length) removedFiles = [...(removedFiles ?? []), ...grants.removed]
    }
  } else if (intent.type === "mcp") {
    // #346:journaled 单锁序列 config→secrets→ledger(Codex 裁决:配置先消失,残留密钥不可达;
    // 反序会复现 #351 规避的「配置在、密钥毁」)。任一步失败 = journal 保持 uninstalling,
    // recoverExtensionTransactions 经 uninstallArtifacts seam 幂等前滚 —— 绝不谎报卸载完成。
    if (intent.scope === "project") {
      const identity = projectMcpWriteIdentityGate(root, path.join(root, "alpha.jsonc"))
      if (!identity.ok) {
        rollback(identity.reason)
        return identity
      }
    }
    ;(deps.transaction ?? passthroughTx).commit(tx.txId) // 外层通知钩子无副作用;真事务在引擎内
    const r = await uninstallExtensionTransaction(root, `mcp--${intent.name}`, {
      action: "config",
      removeArtifacts: () => {
        if (intent.scope === "project") {
          // REQ-136 C6:project journals own only D's config leaf and D's authorization record.
          // Global/legacy config, global secret stores and shared connection bindings are
          // deliberately unreachable from this branch.
          const cfg = deps.installers.removeProjectMcpConfigInLock(root, intent.name)
          if (!cfg.ok) throw new Error(cfg.reason)
          const identity = projectMcpWriteIdentityGate(root, path.join(root, "alpha.jsonc"))
          if (!identity.ok) throw new Error(identity.reason)
          const grants = removeInstallGrants(root, [`mcp--${intent.name}`])
          if (!grants.ok) throw new Error(grants.reason)
          return
        }
        const cfg = deps.installers.removeMcpConfigInLock(intent.name)
        if (!cfg.ok) throw new Error(cfg.reason)
        const sec = deps.installers.removeMcpSecretsStrict(intent.name)
        if (!sec.ok) throw new Error(sec.reason)
        // #359:seed/bundle 事务安装过授权闸的 MCP,授权账随 artifact 一并清(失败抛错 →
        // journal 保持 uninstalling 前滚;恢复 seam 同步此语义)。
        const grants = removeInstallGrants(root, [`mcp--${intent.name}`])
        if (!grants.ok) throw new Error(grants.reason)
        // #704:这里是最容易顺手写错的一行 —— 密钥与授权账都是**本次安装拥有**的东西,清掉是对的;
        // Alpha Connection 不是。它是共享的、跨安装的,真实撤销发生在 provider 侧。所以这里
        // **只释放绑定**,而且**不抛错**:释放失败最多让连接看起来还被人用着(保守方向),
        // 而抛错会把一个成功的卸载卡在 uninstalling 上。
        deps.installers.releaseAlphaConnectionBindings(`mcp:${intent.name}`)
      },
      commitLedger: () => {
        if (intent.scope === "project") {
          const identity = projectMcpWriteIdentityGate(root, path.join(root, "alpha.jsonc"))
          if (!identity.ok) throw new Error(identity.reason)
        }
        const rm = removeRecordV2(root, "mcp", intent.name)
        if (!rm.ok) throw new Error(rm.reason)
      },
    })
    if (!r.ok) return { ok: false, reason: r.reason }
    return { ok: true }
  } else if (intent.type === "plugin") {
    if (configKey?.startsWith("plugin-path:")) {
      // vendored:owned path 必须是受控根下 plugins/<name> 或 plugins/<name>@<suffix>(#352
      // versioned 替换落点)里的 plugin.js;其余一律 fail closed(账本路径不可指向树外)。
      const pluginsRoot = path.join(deps.globalRoot(), "plugins")
      const ledgerJs = path.resolve(configKey.slice("plugin-path:".length))
      const ledgerDir = path.dirname(ledgerJs)
      const dirBase = path.basename(ledgerDir)
      const validBase = dirBase === intent.name || dirBase.startsWith(`${intent.name}@`)
      if (path.basename(ledgerJs) !== "plugin.js" || path.dirname(ledgerDir) !== pluginsRoot || !validBase) {
        rollback("ledger plugin path outside derived root")
        return { ok: false, reason: `fail closed: ledger plugin path "${ledgerJs}" is not under "${pluginsRoot}/${intent.name}[@…]" — refusing` }
      }
      const r = deps.installers.removePluginPath(intent.name, ledgerJs)
      if (!r.ok) {
        rollback(r.reason)
        return r
      }
      try {
        fs.rmSync(ledgerDir, { recursive: true, force: true })
      } catch {
        /* best-effort:config 已净除 */
      }
      removedFiles = [ledgerDir]
    } else {
      const pkg = configKey?.startsWith("plugin:") ? configKey.slice("plugin:".length) : intent.name
      const r = deps.installers.removePlugin(pkg)
      if (!r.ok) {
        rollback(r.reason)
        return r
      }
    }
    // #359:经事务授权闸的 plugin(seed 安装 / #352 替换)授权账随卸载清除,成功前置同 agent。
    // r19 Major:grants+record 双删持 bundle 锁,且锁内重读钉 configKey 未漂移 —— 快照与此处
    // 之间的并发替换(#352 持同一锁)已让账本指向新载荷,继续双删会把**新装插件**清成
    // 「已配置但无账无授权」;漂移 = 拒(旧实物已删无妨,本就被替换淘汰),如实报重试。
    const heldPl = tryAcquireBundleLock(root, { txId: `plugin-uninstall-${randomUUID()}` })
    if (!heldPl.ok) {
      rollback(heldPl.reason)
      return { ok: false, reason: `ledger busy: ${heldPl.reason} — retry after the in-flight extension transaction` }
    }
    try {
      const recNow = findRecordV2(root, "plugin", intent.name)
      if ((recNow?.configKey ?? v1?.configKey ?? null) !== (configKey ?? null)) {
        rollback("plugin record drifted during uninstall")
        return { ok: false, reason: `plugin "${intent.name}" changed while uninstalling (concurrent replace?) — ledger/grants untouched; retry` }
      }
      const grants = removeInstallGrants(root, [`plugin--${intent.name}`])
      if (!grants.ok) {
        rollback(grants.reason)
        return { ok: false, reason: `plugin uninstall: ${grants.reason}` }
      }
      if (grants.removed.length) removedFiles = [...(removedFiles ?? []), ...grants.removed]
      const removedPl = removeRecordV2(root, "plugin", intent.name)
      if (!removedPl.ok) {
        rollback(removedPl.reason)
        return { ok: false, reason: `plugin uninstall: ledger removal failed: ${removedPl.reason} — artifacts already removed; retry (idempotent)` }
      }
      ;(deps.transaction ?? passthroughTx).commit(tx.txId)
      return { ok: true, ...(removedFiles ? { files: removedFiles } : {}) }
    } finally {
      heldPl.lock.release()
    }
  } else if (intent.type === "cloud") {
    // #378(Codex 裁决 D4):receipts-only 去账即卸载 —— 经授权闸的 cloud 授权账随卸载清除
    // (成功前置,同 agent/mcp/plugin);且 **ledger 删除失败 = 卸载失败 ok:false**(cloud 无
    // 其他 artifact,账没去=什么都没发生,通用尾部的 ok:true+warning 对 receipts-only 是谎报)。
    // r1 Major:grants+record 双删必须持跨进程 bundle 锁 —— 否则与在途安装事务(锁内先写
    // grant 后 commitReceipt)交错,可产出「record 已删、有效 grant 残留」的非串行化状态。
    const held = tryAcquireBundleLock(root, { txId: `cloud-uninstall-${randomUUID()}` })
    if (!held.ok) {
      rollback(held.reason)
      return { ok: false, reason: `ledger busy: ${held.reason} — retry after the in-flight extension transaction` }
    }
    try {
      const grants = removeInstallGrants(root, [`cloud--${intent.name}`])
      if (!grants.ok) {
        rollback(grants.reason)
        return { ok: false, reason: `cloud uninstall: ${grants.reason}` }
      }
      const removed = removeRecordV2(root, "cloud", intent.name)
      if (!removed.ok) {
        rollback(removed.reason)
        return { ok: false, reason: `cloud uninstall: ledger removal failed: ${removed.reason} — retry (grants already cleared, idempotent)` }
      }
      ;(deps.transaction ?? passthroughTx).commit(tx.txId)
      return { ok: true, ...(grants.removed.length ? { files: grants.removed } : {}) }
    } finally {
      held.lock.release()
    }
  } else {
    rollback(`cannot uninstall type: ${intent.type}`)
    return { ok: false, reason: `cannot uninstall type: ${intent.type}` }
  }

  const removed = removeRecordV2(root, intent.type, intent.name)
  // r18 Major:账本删除失败不得折叠成 warning 报成功 —— 同 key 损坏记录拒删等形态下调用方
  // 会把「记录仍在账」当卸载完成(账实分叉且不再重试)。与 cloud 分支同款 fail-closed:
  // 实物已删,失败原因如实返回,重试幂等。
  if (!removed.ok) {
    rollback(removed.reason)
    return { ok: false, reason: `${intent.type} uninstall: ledger removal failed: ${removed.reason} — artifacts already removed; retry (idempotent)` }
  }
  ;(deps.transaction ?? passthroughTx).commit(tx.txId)
  return { ok: true, ...(removedFiles ? { files: removedFiles } : {}) }
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
  deps: Pick<PlannerDeps, "globalRoot" | "advisoryGate">,
): Promise<GenerationRollbackOutcome> {
  const decoded = decodeUninstallIntent(rawIntent)
  if (!decoded.ok) return decoded
  const intent = decoded.intent
  if (intent.type !== "skill") return { ok: false, reason: `rollback: unsupported type "${intent.type}" — skill only` }
  if (intent.scope !== "global") return { ok: false, reason: "rollback: global scope only" }
  if (typeof rawGenId !== "string" || rawGenId.length === 0 || rawGenId.length > 64) return { ok: false, reason: "rollback: invalid generation id" }
  // #315(review M1/M2):rollback = 激活**目标代**内容 —— 闸必须按目标代 receipt 快照的
  // 身份(id/payloadDigest)评估,不是当前 record(当前代可能是不同 id/digest);快照缺失/
  // 损坏 = fail closed(rollbackGenerationTransaction 反正也需要它,先闸后动)。
  const snap = readGenerationReceiptSnapshot(deps.globalRoot(), skillGenerationKey(intent.name), rawGenId)
  if (!snap) return { ok: false, reason: `rollback: target generation receipt snapshot unavailable — refusing (advisory gate cannot evaluate the target identity)` }
  const target = snap.receipt as { id?: string; name?: string; payloadDigest?: string; origin?: string }
  if (typeof target.id !== "string") return { ok: false, reason: "rollback: target receipt snapshot lacks identity — refusing" }
  const adv = deps.advisoryGate({
    catalogId: target.id,
    name: target.name,
    payloadDigest: target.payloadDigest,
    provenance: target.origin === "catalog" ? "cache" : "bundled",
  })
  if (!adv.allowed) return { ok: false, reason: `advisory ${adv.advisoryId}: ${adv.reason} — rollback activation refused (R14)` }
  return rollbackSkillGeneration(deps.globalRoot(), intent.name, rawGenId)
}

// ── desired state(Hub 项目上下文「禁用」;main 侧真源,引擎生效面由消费方处理)──────────────────

export type SetStateIntent = UninstallIntent & {
  state: DesiredState
  /** #397:curated 条目复审过期(排他截止)后的 enable 显式确认位(合同 §7.2:新启用需
   *  显式确认并展示过期事实)。renderer 在用户确认对话后重发意图携带 true。 */
  confirmExpiredReview?: boolean
}

/** 严格解码同卸载意图(key 面完全一致 + state 枚举);伪造 receipt/路径同样无通道。 */
export function decodeSetStateIntent(input: unknown): { ok: true; intent: SetStateIntent } | { ok: false; reason: string } {
  if (!isObj(input)) return { ok: false, reason: "intent: must be an object" }
  const { state, confirmExpiredReview, ...rest } = input
  if (state !== "enabled" && state !== "disabled") return { ok: false, reason: `intent.state: ${JSON.stringify(state)} not "enabled" | "disabled"` }
  if (confirmExpiredReview !== undefined && typeof confirmExpiredReview !== "boolean")
    return { ok: false, reason: `intent.confirmExpiredReview: ${JSON.stringify(confirmExpiredReview)} not a boolean` }
  const base = decodeUninstallIntent(rest)
  if (!base.ok) return base
  return { ok: true, intent: { ...base.intent, state, ...(confirmExpiredReview !== undefined ? { confirmExpiredReview } : {}) } }
}

/** #397 enable 闸的机器可判别拒绝码(renderer 据此路由确认对话/诚实文案,不解析 reason 字符串)。
 *  PR-B 增 curation-unverifiable:catalog 不可得/身份失配的两类拒绝共用(用户语言文案同一句 ——
 *  「暂时无法核实审核数据」;细分原因留在 reason 供日志)。 */
export type SetStateRefusalCode =
  | "session-grant-persistent-enable"
  | "expired-review-confirmation-required"
  | "curation-unverifiable"


// ── `#817`:package-managed 判定与 exact 候选(纯读,零写)────────────────────────────────────

/** 一个 exact 候选 = 图节点身份与 record **逐项相等**(componentId + manifestDigest)的那张图。 */
type PackageManagedFacts =
  | { ok: true; managed: false }
  | { ok: true; managed: true; candidates: Array<{ packageId: string; envelopeDigest: string }> }
  | { ok: false; reason: string }

/**
 * `#817` 分类规则(Codex 裁决,两个信号任一成立即 package-managed):
 *   ① 任一 packageGraph 节点命中 (kind,name);② 该 (kind,name) 的 claim 含 `bundle:` owner。
 * package-managed 时启停**只走** `resolvePackage`;exact 候选为 0 = fail-closed,**绝不**回退
 * `resolveEntry`。两个信号都不在场才走既有 legacy `entries` 路径(逐字语义保留)。
 *
 * exact 候选判据:节点 `componentId === record.id` 且 `manifestDigest === record.manifestDigest`。
 * 可多候选(跨包共有 child 是准入期允许的 canonical permutation,条件 = 同 manifestDigest,
 * 见 `ext-package-lifecycle.planPackageChildConflictsV1`;而 manifestDigest 覆盖整个 component
 * 对象含 id,故合法共有节点恒同 componentId)。候选按 packageId 升序,仅为遍历确定性 ——
 * 判据是独立精确谓词的存在量词,结果与顺序无关。
 */
function packageManagedFactsFor(
  root: string,
  record: { kind: InstallReceiptType; name: string; id: string; manifestDigest?: string },
): PackageManagedFacts {
  const state = readPackageLedgerStateV1(root, { sideEffectFree: true })
  if (!state.ok) return { ok: false, reason: state.reason }
  const named = state.packageGraphs.filter((graph) =>
    [graph.root, ...graph.children].some((node) => node.kind === record.kind && node.name === record.name),
  )
  const claim = state.claims.find((c) => c.kind === record.kind && c.name === record.name)
  const claimHasBundleOwner = claim !== undefined && claim.owners.some((owner) => parseOwnerToken(owner)?.kind === "bundle")
  if (named.length === 0 && !claimHasBundleOwner) return { ok: true, managed: false }
  const candidates = named
    .filter((graph) =>
      [graph.root, ...graph.children].some(
        (node) =>
          node.kind === record.kind &&
          node.name === record.name &&
          node.componentId === record.id &&
          record.manifestDigest !== undefined &&
          node.manifestDigest === record.manifestDigest,
      ),
    )
    .map((graph) => ({ packageId: graph.packageId, envelopeDigest: graph.envelopeDigest }))
    .sort((a, b) => (a.packageId < b.packageId ? -1 : a.packageId > b.packageId ? 1 : 0))
  return { ok: true, managed: true, candidates }
}

/** 单候选核对(锁内消费冻结的 resolution;每条谓词独立,失败给具名理由)。 */
function verifyPackageCandidate(
  candidate: { packageId: string; envelopeDigest: string },
  resolution: VerifiedCatalogPackageResolution,
  record: { kind: InstallReceiptType; name: string; id: string; version?: string; payloadDigest?: string },
): { ok: true } | { ok: false; reason: string } {
  if (resolution.status === "refused")
    return { ok: false, reason: `cannot verify signed package ${candidate.packageId}: ${resolution.reason}` }
  if (resolution.status === "missing") {
    if (resolution.channel === "bundled")
      return {
        ok: false,
        reason: `signed package ${candidate.packageId} cannot be verified: the live verified catalog is unavailable and the bundled snapshot carries no signed packages`,
      }
    return resolution.anyVersionPresent
      ? {
          ok: false,
          reason: `signed package ${candidate.packageId}@${record.version ?? "unversioned"} is no longer published in the verified catalog (other versions exist) — update or reinstall first`,
        }
      : { ok: false, reason: `signed package ${candidate.packageId} is not present in the verified catalog (delisted)` }
  }
  const identity = resolution.identity
  if (identity.packageId !== candidate.packageId || identity.version !== record.version)
    return {
      ok: false,
      reason: `verified catalog package identity ${identity.packageId}@${identity.version} does not match this install (${candidate.packageId}@${record.version ?? "unversioned"})`,
    }
  if (identity.envelopeDigest !== candidate.envelopeDigest)
    return {
      ok: false,
      reason: `verified catalog package ${candidate.packageId}@${identity.version} content does not match the installed package (installed ${candidate.envelopeDigest} vs catalog ${identity.envelopeDigest}) — update or reinstall first`,
    }
  const component = identity.components.find((c) => c.id === record.id)
  if (!component)
    return {
      ok: false,
      reason: `component ${record.id} is not part of verified catalog package ${candidate.packageId}@${identity.version}`,
    }
  if (record.payloadDigest === undefined || `sha256:${component.payloadSha256}` !== record.payloadDigest)
    return {
      ok: false,
      reason: `component ${record.id} payload digest does not match the verified catalog (installed ${record.payloadDigest ?? "<absent>"} vs catalog sha256:${component.payloadSha256})`,
    }
  return { ok: true }
}

/** desiredState 翻转:scope 独立(global/各项目账本物理分域),项目 identity fail-closed 同卸载。
 *  #395(持久化 config 投影,非事务):锁内 record 重读 + advisory(闭 TOCTOU)→ **两方向都账本先写**
 *  (durable intent;更新读账本重投影自愈,禁用不被更新复活)→ config 原子写(applyConfigImage;
 *  抛错回滚账本,回滚失败如实报真实状态)。mcp 写 `enabled:false`、agent 写 `disable:true`、plugin
 *  从 `plugin[]` 缺席(引擎 import 早于 config-hook);skill 无 config 面(投影经 ext 注入门);cloud/
 *  project 记录纯账本翻转。本函数自持 Bundle 锁,调用方不得预持(防与内锁互斥死锁)。 */
export async function setInstallStateByKey(
  rawIntent: unknown,
  deps: Pick<PlannerDeps, "globalRoot" | "advisoryGate" | "resolveEntry" | "resolvePackage">,
): Promise<{ ok: true; warning?: string } | { ok: false; reason: string; code?: SetStateRefusalCode }> {
  const decoded = decodeSetStateIntent(rawIntent)
  if (!decoded.ok) return decoded
  const intent = decoded.intent
  let root: string
  if (intent.scope === "project") {
    if (!LEGACY_PROJECT_MANAGEABLE_KINDS.has(intent.type)) return { ok: false, reason: `kind "${intent.type}" cannot be project-scoped` }
    const identity = projectScopeIdentity(intent.projectDir)
    if (!identity.ok) return { ok: false, reason: `fail closed: ${identity.reason}` }
    const projectRoot = alphaRoot(identity.scope.projectPath)
    if (!projectRoot) return { ok: false, reason: `fail closed: invalid project root: ${intent.projectDir}` }
    root = projectRoot
  } else {
    root = deps.globalRoot()
  }
  // #1017 owns project controls/consent-aware activation. Until that path can re-prove the
  // verified safe subset, this generic state channel may disable a project MCP but never enable
  // one (including a legacy or externally modified workspace/secret-bearing leaf).
  if (intent.scope === "project" && intent.type === "mcp" && intent.state === "enabled")
    return { ok: false, reason: "project MCP enable is unavailable until consent-aware scoped activation — refused" }
  // ── #397(Codex 裁决必改⑤ + r1-5):enable 方向的 curation 闸,resolveEntry 是异步 → **锁外**
  //    冻结决策(已验 entry 身份 + 解码结果),锁内重读 record 并要求 record 与**已验 entry**
  //    身份四元组(id/kind/name/version)精确相等才采信;不一致拒绝重试 —— 既有锁内 TOCTOU
  //    闭合(record 重读 + advisory 在锁内)不被破坏。
  //    r1-5 裁定:resolveEntry null(条目下架 / 离线无 LKG / security browse-only)或身份不匹配
  //    (含同 ID 异版本:装 v1 不得套用 v2 策略)一律**拒绝 enable**,绝不降格 uncurated 放行;
  //    只有真正已验且同身份的 entry 无 curation 时才继续走 #395 保守面。
  let frozenCuration: {
    verified: { id: string; type: string; name: string; version: string | undefined } | null
    status: CurationStatus | null
  } | null = null
  // ── `#817`:package-managed child 的冻结解析(与 legacy 冻结互斥)。判定信号 = 图节点命中
  //    (kind,name) 或 claim 含 bundle owner(packageManagedFactsFor);package-managed 只走
  //    resolvePackage(双键精确),**绝不**调用 resolveEntry —— legacy `entries[]` 从来不含
  //    package child,回退等于在错误的表里找。
  let frozenPackage:
    | { kind: "ledger-unreadable"; reason: string }
    | {
        kind: "managed"
        probes: Array<{ packageId: string; envelopeDigest: string; resolution: VerifiedCatalogPackageResolution }>
      }
    | null = null
  if (intent.state === "enabled") {
    const pre = findRecordV2(root, intent.type, intent.name)
    if (pre && pre.origin === "catalog") {
      const managedPre = packageManagedFactsFor(root, pre)
      if (!managedPre.ok) {
        frozenPackage = { kind: "ledger-unreadable", reason: managedPre.reason }
      } else if (managedPre.managed) {
        const probes: Array<{ packageId: string; envelopeDigest: string; resolution: VerifiedCatalogPackageResolution }> = []
        if (pre.version !== undefined)
          for (const candidate of managedPre.candidates)
            probes.push({ ...candidate, resolution: await deps.resolvePackage(candidate.packageId, pre.version) })
        frozenPackage = { kind: "managed", probes }
      } else {
        const verified = await deps.resolveEntry(pre.id)
        frozenCuration = verified
          ? {
              verified: {
                id: verified.entry.id,
                type: verified.entry.type,
                name: verified.entry.name,
                // 安装面 record.version = manifest.version = entry.version ?? catalogVersion(synthesizeManifest)
                // —— 身份比较用同一派生,免得无条目级版本的 bundled 条目恒假失配。
                version: typeof verified.entry.version === "string" && verified.entry.version ? verified.entry.version : verified.catalogVersion,
              },
              status: decodeEntryCurationLoud(verified.entry),
            }
          : { verified: null, status: null }
      }
    }
  }
  // Codex r2/r3 重设计:启停 = **持久化 config 投影 + 账本翻转**(锁内;disabled plugin 必须从磁盘
  // config 缺席,因引擎 import 插件早于 config-hook)。skill 无 config 面(投影 = 引擎侧账本注入门)。
  // record 重读 + advisory 全部**在锁内**(闭 TOCTOU)。两写按方向排序保证安全侧不因崩溃/错误破窗
  // (Codex r3 Blocker):disable → config 先(运行立即禁用,即便账本随后失败也已禁);enable → 账本
  // 先(账本写失败即止,不动 config → 保持 disabled)。config apply 抛错则回滚已翻的账本(错误路径原子)。
  if (intent.scope === "project" && intent.type === "mcp") {
    const identity = projectMcpWriteIdentityGate(root, path.join(root, "alpha.jsonc"))
    if (!identity.ok) return identity
  }
  const held = tryAcquireBundleLock(root, { txId: `set-state-${randomUUID()}` })
  if (!held.ok) return { ok: false, reason: `ledger busy: ${held.reason} — retry after the in-flight transaction` }
  try {
    if (intent.scope === "project" && intent.type === "mcp") {
      const identity = projectMcpWriteIdentityGate(root, path.join(root, "alpha.jsonc"))
      if (!identity.ok) return identity
    }
    const record = findRecordV2(root, intent.type, intent.name)
    if (!record) return { ok: false, reason: `no v2 record for ${intent.type}:${intent.name} in this scope — fail closed (v1-only installs have no desired-state channel)` }
    // Codex r12 Major3:command/bundle 无禁用生效面(引擎 config.command/bundle 无 disable 键,alpha 无
    // 投影/注入面)—— 翻 desiredState 会谎报「已禁用」而 command 仍可执行。有生效面的仅 mcp/agent(注入)、
    // plugin(alpha.jsonc plugin[])、skill(允许集);cloud 无本地运行面(UI 本就不给开关)。一律拒。
    if (record.kind === "command" || record.kind === "bundle" || record.kind === "cloud")
      return { ok: false, reason: `${record.kind} "${record.name}" has no enable/disable surface — refusing to flip desired state (would misreport)` }
    if (record.scope.kind === "project") {
      if (intent.scope !== "project") return { ok: false, reason: "fail closed: record is project-scoped but intent is global" }
      const verified = verifyProjectScope(record, intent.projectDir)
      if (!verified.ok) return verified
    }
    if (intent.state === "enabled") {
      const adv = deps.advisoryGate({
        catalogId: record.id,
        name: record.name,
        payloadDigest: record.payloadDigest,
        provenance: record.origin === "catalog" ? "cache" : "bundled",
      })
      if (!adv.allowed) return { ok: false, reason: `advisory ${adv.advisoryId}: ${adv.reason} — re-enable refused (R14)` }
      // #397 curation 闸(advisory 之后 —— 权威排序 §1;仅 catalog 记录有 curation 面)。
      if (record.origin === "catalog") {
        // ── `#817`:锁内先判 package-managed(权威判定;信号 = 图节点命中 (kind,name) 或 claim
        //    含 bundle owner)。package-managed 只走冻结的 resolvePackage 探测,**绝不**回退
        //    resolveEntry;exact 候选为 0 = fail-closed。两个信号都不在场才走下方 legacy 路径
        //    (逐字保留)。冻结/锁内判定不一致 = 记录或图在两点之间漂移 → 拒绝重试。
        const managedNow = packageManagedFactsFor(root, record)
        if (!managedNow.ok)
          return {
            ok: false,
            code: "curation-unverifiable",
            reason: `${record.kind} ${record.name}: cannot determine package management state (${managedNow.reason}) — enable refused (fail closed)`,
          }
        if (managedNow.managed) {
          if (!frozenPackage)
            return { ok: false, reason: `${record.kind} ${record.name}: record became package-managed while its state was being resolved — retry` }
          if (frozenPackage.kind === "ledger-unreadable")
            return {
              ok: false,
              code: "curation-unverifiable",
              reason: `${record.kind} ${record.name}: cannot determine package management state (${frozenPackage.reason}) — enable refused (fail closed)`,
            }
          if (record.version === undefined)
            return {
              ok: false,
              code: "curation-unverifiable",
              reason: `${record.kind} ${record.name}: install record carries no version — cannot match it against the verified catalog; reinstall first (fail closed)`,
            }
          // exact 候选 = 0:图/claim 表明 package-managed,但节点身份(componentId/manifestDigest)
          // 与 record 漂移 —— 无法证明这份安装对应任何已验 package,fail-closed,绝不回退 entries。
          if (managedNow.candidates.length === 0)
            return {
              ok: false,
              code: "curation-unverifiable",
              reason: `${record.kind} ${record.name}: a package graph names this child but its identity (componentId/manifestDigest) does not match the install record — enable refused (fail closed; update or reinstall the package)`,
            }
          // 存在量词 over 精确谓词:至少一个候选全匹配才放行;每次探测都是 (packageId, version)
          // 双键 + envelope/component/payload/manifest 逐项核对,结果与遍历顺序无关。
          const failures: string[] = []
          let anyVerified = false
          for (const candidate of managedNow.candidates) {
            const probe = frozenPackage.probes.find(
              (p) => p.packageId === candidate.packageId && p.envelopeDigest === candidate.envelopeDigest,
            )
            if (!probe)
              return { ok: false, reason: `${record.kind} ${record.name}: package graph changed while its state was being resolved — retry` }
            const verdict = verifyPackageCandidate(candidate, probe.resolution, record)
            if (verdict.ok) {
              anyVerified = true
              break
            }
            failures.push(verdict.reason)
          }
          if (!anyVerified)
            return {
              ok: false,
              code: "curation-unverifiable",
              reason: `${record.kind} ${record.name}: ${failures.join("; ")} (fail closed)`,
            }
          // 全匹配 ⇒ 诚实 uncurated(package envelope 今天没有 curation 字段)——直接落既有 #395
          // 保守启用面;不发明 package curation,session-grant / 复审过期分支按构造不触发。
        } else {
        // 「锁外无记录、锁内出现」的窗口 → 拒绝重试(下轮重新冻结)。
        if (!frozenCuration)
          return { ok: false, reason: `${record.kind} ${record.name}: record appeared while curation was being resolved — retry` }
        const v = frozenCuration.verified
        // r1-5:取不到已验 entry(下架/离线/security browse-only)= 无法证明策展状态 → 拒,
        // 绝不降格 uncurated 放行(fail closed)。
        if (!v)
          return {
            ok: false,
            code: "curation-unverifiable",
            reason: `${record.kind} ${record.name}: cannot verify curation — the entry is not resolvable from the verified catalog (delisted/offline/security state); enable refused (fail closed)`,
          }
        // r1-5:身份四元组逐项相等(锁内 record vs **已验 entry**)—— 同时覆盖锁外/锁内 record
        // 漂移与「同 ID 异版本」(装 v1 不得套用 v2 的策展策略);record 无 version(v1 遗留)
        // 即无法自证身份,同拒。
        if (record.version === undefined || v.id !== record.id || v.type !== record.kind || v.name !== record.name || v.version !== record.version)
          return {
            ok: false,
            code: "curation-unverifiable",
            reason: `${record.kind} ${record.name}: verified catalog entry identity does not match this install (installed ${record.version ?? "unversioned"} vs catalog ${v.version ?? "unversioned"}) — refusing to apply its curation; update or reinstall first (fail closed)`,
          }
        const status = frozenCuration.status!
        if (status.kind === "curated") {
          // session-grant:持久账本 enabled 本身非法(会话级启用 = #408);任何路径不得借
          // setInstallState 把它落成跨会话启用。
          if (status.curation.activationPolicy === "session-grant")
            return {
              ok: false,
              code: "session-grant-persistent-enable",
              reason: `${record.kind} ${record.name}: activationPolicy is "session-grant" — persistent enable refused (per-session activation ships with #408)`,
            }
          // 复审过期(排他截止):enable 需显式确认(合同 §7.2「新启用需显式确认并展示过期事实」;
          // 覆盖一切 enable 路径,不只已装行 toggle —— Codex 裁决必改②)。消费端时钟仅用于本比较。
          if (isReviewExpired(status.curation, new Date().toISOString()) && intent.confirmExpiredReview !== true)
            return {
              ok: false,
              code: "expired-review-confirmation-required",
              reason: `${record.kind} ${record.name}: security review expired at ${status.curation.review.reviewBefore} — enable requires explicit user confirmation (contract §7.2)`,
            }
        }
        }
      }
    }
    const hasConfig = record.kind === "mcp" || record.kind === "agent" || record.kind === "plugin"

    // config edit 预计算(不写盘;image 校验含 jsonc 合法性)。skill = 无 config 面。
    let configApply: (() => void) | null = null
    if (hasConfig) {
      const target = path.join(root, "alpha.jsonc")
      let text: string
      try {
        text = fs.readFileSync(target, "utf8")
      } catch (error) {
        // #395(Codex r5):只容缺席(ENOENT/ENOTDIR)—— EACCES/EIO 等「读不出」≠「不存在」,
        // 当缺席会让 disable 谎报成功(config 可能仍留启用叶/条目)。其余错误双向 fail-closed。
        if (!isAbsenceError(error))
          return {
            ok: false,
            reason: `${record.kind} ${record.name}: alpha.jsonc unreadable (${(error as NodeJS.ErrnoException).code ?? String(error)}) — fail closed, enable state unchanged`,
          }
        // config 确证缺席:disable = 投影本就不在(成功,仅翻账本);enable = 无生效面重建(拒)。
        if (intent.state === "enabled") return { ok: false, reason: `${record.kind} ${record.name}: alpha.jsonc absent — cannot enable (reinstall to repair)` }
        text = ""
      }
      {
        // #395(r11 pivot):mcp/agent 的 disable 权威由 sidecar 注入 OPENCODE_CONFIG_CONTENT 保证
        // (引擎最后加载,mergeDeep 压过一切 in-scope 源),不再逐源探测 legacy 残留。alpha.jsonc 投影
        // 仍写(consistency;plugin 的 disable = 从 plugin[] 移除,alpha.jsonc 是其唯一生效面)。
        const errors: ParseError[] = []
        const cfg = text !== "" ? parse(text, errors) : {}
        if (text !== "" && errors.length > 0) return { ok: false, reason: `alpha.jsonc is not valid jsonc — refusing to change enable state (fail closed)` }
        const proj = computeEnableProjectionEdit(isObj(cfg) ? cfg : {}, root, record, intent.state)
        if (!proj.ok) return proj
        if (proj.edit) {
          const prepared = prepareConfigTx(target, [proj.edit], text === "" ? "{}" : text)
          if (!prepared.ok) return prepared
          configApply = () => applyConfigImage(prepared.image)
        }
      }
    }

    // **两方向都账本先写**(Codex r4 Blocker):账本是启停的 durable intent,更新/重装读账本
    // desiredState 当前策略优先 —— 账本先写,则崩溃在账本↔config 之间时,后续更新按账本重投影
    // config 自愈,disabled 绝不被更新复活(config-first 会留「config 禁/账本启」→ 更新读启用复活)。
    //   1. 账本翻转;失败即止,config 从未触碰(安全侧:enable 未启 / disable 保持原态)。
    //   2. config 原子写(applyConfigImage:writeFileAtomicSync,要么整替换要么原文件不变);抛错 →
    //      config 未变(opts 等原样保留),回滚账本到原态使两面一致,回滚失败如实带回真实状态。
    // 残余:账本↔config 之间的崩溃留下短暂运行态与账本不符(disable 后扩展续跑到下次重建/更新、
    // enable 后未即生效),durable intent 恒正确,下次更新/重开即收敛(见 extension-install-ledger.md §5)。
    const prevState: DesiredState = record.desiredState
    const led = setDesiredStateV2(root, intent.type, intent.name, intent.state)
    if (!led.ok) return led
    // #336:skill enable 的派生允许集发布失败(账本已 durable、注入待 boot 自愈)—— 经既有
    // warning 通道如实上报(用户可见开关入口)。
    const projectionLag = led.projectionLag
    if (configApply) {
      try {
        configApply()
      } catch (error) {
        const rb = setDesiredStateV2(root, intent.type, intent.name, prevState)
        const base = `${intent.state === "enabled" ? "enable" : "disable"} config write failed for ${record.kind} ${record.name}: ${error instanceof Error ? error.message : String(error)}`
        return { ok: false, reason: rb.ok ? `${base} (ledger rolled back to ${prevState})` : `${base}; ledger rollback ALSO failed: ${rb.reason} — ledger now ${intent.state}, config unchanged (manual repair needed)` }
      }
    }
    return projectionLag ? { ok: true, warning: projectionLag } : { ok: true }
  } finally {
    held.lock.release()
  }
}


/** #395:把 mcp/agent/plugin 的启用态投影进持久化 config —— 计算 config edit(不写盘,供调用方按方向
 *  排序 config↔ledger 写入 + 失败回滚)。字段用**引擎真实消费的键**(Codex r3 Blocker):
 *    · mcp:`enabled:false`(引擎查 mcp.enabled === false);enable 剥离 enabled 键。
 *    · agent:`disable:true`(引擎查 value.disable);enable 剥离 disable 键。
 *    · plugin:从 `plugin[]` 移除(disable)/ 按 configKey 补回(enable)。移除按**解析路径身份**匹配
 *      (resolvePluginEntryPath:绝对/相对/file:// 等价形态同判,Codex r3 Blocker),npm 按 spec 等值。
 *  返回 { noop } = 投影已是目标态(无需写);enable 缺生效面(config 叶/条目无从重建)= fail-closed。
 *  受管归一化:enable 按 configKey 补回受管条目形态(受管安装从不写 [spec,opts] 元组,故 opts 不丢;
 *  用户对受管条目手加的 opts 不随启停往返 —— 显式契约,非静默,见 extension-install-ledger.md §5)。 */
/** npm plugin 规格的 base(去尾部 @version;scoped `@s/n@v`→`@s/n`,unscoped `n@v`→`n`)。 */
function pluginBaseOf(spec: string): string {
  const at = spec.lastIndexOf("@")
  return at > 0 ? spec.slice(0, at) : spec
}

function computeEnableProjectionEdit(
  cfgObj: Record<string, unknown>,
  root: string,
  record: InstallRecordV2,
  state: DesiredState,
): { ok: true; edit?: ConfigEdit } | { ok: false; reason: string } {
  const disable = state === "disabled"
  if (record.kind === "plugin") {
    const ck = record.configKey ?? ""
    const isPath = ck.startsWith("plugin-path:")
    const elem = isPath ? ck.slice("plugin-path:".length) : ck.startsWith("plugin:") ? ck.slice("plugin:".length) : ""
    if (!elem) return { ok: false, reason: `plugin ${record.name}: no configKey on record — cannot project enable state (reinstall to repair)` }
    const arr = Array.isArray(cfgObj.plugin) ? [...(cfgObj.plugin as unknown[])] : []
    // vendored:按**文件系统身份**匹配(pathIdentity realpath 双形态 —— symlink/大小写/NFD 别名同判,
    //   与 replace 路径 findSameNamePluginPathEntry 同强度;身份不可判 = fail-closed 视为匹配,宁可
    //   拒继续也不漏移除禁用项);npm:spec 头等值(npm 规格非路径,不经 realpath)。Codex r4 Blocker。
    const targetIdent = isPath ? pathIdentity(resolvePluginEntryPath(elem, root) ?? elem) : null
    let identUnprovable = false
    const matchesIn = (x: unknown, configDir: string): boolean => {
      if (!isPath) {
        // Codex r7 M2:npm 按 **base** 匹配 —— 账本 disabled `@x/p@2` 时主 config 残留 `@x/p@1`(同
        // base 旧钉版,崩溃/旁路残留)也须命中移除,否则旧 pin 仍被引擎加载。
        const spec = pluginSpecOf(x)
        return spec !== null && pluginBaseOf(spec) === pluginBaseOf(elem)
      }
      const r = resolvePluginEntryPath(x, configDir)
      if (r === null) return false
      const ident = pathIdentity(r)
      if (targetIdent && ident.forms.some((f) => targetIdent.forms.includes(f))) return true
      if (!ident.certain || !targetIdent?.certain) identUnprovable = true
      return false
    }
    const matches = (x: unknown): boolean => matchesIn(x, root)
    if (disable) {
      // 本函数只算主 alpha.jsonc 的禁用投影(移除条目)。引擎额外合并的 legacy/XDG 源(plugin[] concat、
      // mcp/agent 深合并覆盖)由调用方经 legacyEnableResidueStrict 统一 fail-closed 探测(Codex r6 B1 →
      // r7 B1/M1/M3 收敛到一处,不再在此逐源比对)。
      const next = arr.filter((x) => !matches(x))
      // 身份不可判(非缺席类 fs 错)= 无法证明该条目不是禁用目标 → fail-closed 拒(不静默漏禁用)。
      if (identUnprovable) return { ok: false, reason: `plugin ${record.name}: a plugin[] entry's filesystem identity is unresolvable — cannot prove disable removal (retry after resolving)` }
      if (next.length === arr.length) return { ok: true } // 本就缺席
      return { ok: true, edit: { keyPath: ["plugin"], value: next } }
    }
    // ADR-040(`#825` 第 6 条):**enable 臂已删除**。plugin 的「启用」按定义就是「把 spec 写回
    // `plugin[]`」—— 与安装是同一个动作换了个入口,安装口全关而这里留着,等于留了一条默认放行的
    // 新路径(枚举对新成员默认放行的那个形态)。所以这里是具名拒绝,不是静默 no-op:静默会让
    // 账本翻成 enabled 而运行面没有任何变化,那是谎报。
    // **disable 臂原样保留**(上面那半):它是清理方向 —— 从 `plugin[]` 移除,是 ADR-040 要的减法。
    return {
      ok: false,
      reason: `plugin ${record.name}: enabling a plugin means writing it back into the engine plugin[], which extension installs are no longer allowed to do (ADR-040) — refused`,
    }
  }
  // mcp / agent:引擎消费键分别为 enabled(false=禁)/ disable(true=禁)。
  const field = record.kind === "mcp" ? "enabled" : "disable"
  const disabledValue = record.kind !== "mcp" // mcp: enabled=false 表禁;agent: disable=true 表禁
  const map = cfgObj[record.kind]
  const leaf = isObj(map) ? map[record.name] : undefined
  if (!isObj(leaf)) {
    return disable ? { ok: true } : { ok: false, reason: `${record.kind} ${record.name}: config entry missing — cannot enable (reinstall to repair)` }
  }
  if (disable) {
    if (leaf[field] === disabledValue) return { ok: true }
    return { ok: true, edit: { keyPath: [record.kind, record.name], value: { ...leaf, [field]: disabledValue } } }
  }
  if (leaf[field] === undefined) return { ok: true }
  return { ok: true, edit: { keyPath: [record.kind, record.name], value: Object.fromEntries(Object.entries(leaf).filter(([k]) => k !== field)) } }
}

// ── #395 startup reconcile:账本 desiredState → alpha.jsonc 权威重投影 ─────────────────────────────

export type BootReconcileOutcome = {
  /** false = reconcile 整体未完成(skipped 带因,config 保持原样);true 时 warnings 仍可能非空(单条跳过)。 */
  ok: boolean
  /** 实际投影修复的记录(`kind:name→state`);无残留时为空。 */
  applied: string[]
  warnings: string[]
  skipped?: string
  /** 非空 = 有本应禁用的项未能保证不被引擎加载 —— 调用方(index.ts)须 fail-closed 阻断 sidecar。
   *  r11 pivot 后:mcp/agent 由 sidecar 主权注入(OPENCODE_CONFIG_CONTENT)保证,唯 **plugin 无法从
   *  alpha.jsonc plugin[] 落盘移除**(config 写失败/读不出/非法 jsonc)、**账本损坏/不可读**(注入会拿到
   *  空 records,Codex r12 B2)、skills 陈旧允许集入此列。enable 失败只记 warning(功能缺失非安全洞)。 */
  enforcementGap?: string[]
}

/** 主进程启动 reconcile(引擎首次 fork 读 config 之前调用)。r11 pivot:mcp/agent 的 disable 由 sidecar
 *  `injectDisabledOverrides` 注入 OPENCODE_CONFIG_CONTENT 权威保证(引擎最后加载 override),本函数对
 *  mcp/agent 只做 alpha.jsonc consistency 投影;**plugin** 的 disable 生效面 = 从 alpha.jsonc `plugin[]`
 *  移除(无用户=无他源),是 enforcementGap 的唯一 config 面。skills 派生允许集自愈同锁内做。
 *  边界(全部 loud,不 throw;gap = fail-closed 阻断 sidecar):
 *    · 锁忙(真持有)→ skip 非 gap(在途事务自保一致)。
 *    · **账本损坏/不可读(probeLedgerForWrite 非 ok)→ gap**(注入落空,Codex r12 B2)。
 *    · alpha.jsonc ENOENT/ENOTDIR = 缺席:plugin 天然不在 plugin[](安全);enabled 缺生效面 warning。
 *      其余读错(EACCES/EIO)/非法 jsonc → plugin disable 无法落盘 → gap;config 不动。
 *    · 单条 enable 缺生效面 / plugin 身份不可判 → warning + 跳过该条,不 abort 其余。
 *  project-scope 记录不在此对账(引擎启动只读 global alpha.jsonc;项目残留由 set-state/更新路径自愈)。 */
export function reconcileDesiredStateAtBoot(
  root: string,
  opts: {
    userDataPath: string
    channel: ChannelName
    /** 仅测试注入;缺省 = 生产 oracle(ext-curation-policy 已验 catalog 同步读)。 */
    sessionGrantIds?: (userDataPath: string, channel: ChannelName) => SessionGrantOracle
  },
): BootReconcileOutcome {
  const warnings: string[] = []
  const applied: string[] = []
  const gap: string[] = []
  const done = (o: Omit<BootReconcileOutcome, "enforcementGap">): BootReconcileOutcome =>
    gap.length > 0 ? { ...o, enforcementGap: gap } : o
  const held = tryAcquireBundleLock(root, { txId: `boot-reconcile-${randomUUID()}` })
  if (!held.ok) {
    // Codex r7 B2:启动期(sidecar 未起、IPC 未接)本不该有其他事务持锁 —— 拿不到锁 = 锁文件 EACCES/EIO
    // 或有事务正处于「账本已写、config 未写」中间态,都无法保证禁用已生效 → fail-closed(gap),绝不
    // 放行 sidecar 用可能过时的 config 启动。
    gap.push(`bundle lock unavailable at startup: ${held.reason} — cannot verify extension disable state`)
    return { ok: false, applied, warnings, skipped: `ledger lock unavailable: ${held.reason}`, enforcementGap: gap }
  }
  try {
    // ── #397(Codex r1-3/r1-4):session-grant 归位**先行**,且在 skills 派生之前 ──
    // session-grant 记录的持久 enabled 非法(会话级启用 = #408)。此处直接把账本归位为
    // disabled(setDesiredStateV2,锁内)—— 归位后 skills 派生允许集、config 投影、sidecar
    // 注入全部从合法账本重建,skill 面(skills-enabled.json)由此天然覆盖(r1-3)。
    // oracle 不可判定(无已验 LKG/v1 缓存)= fail-closed:存在已启用 catalog 记录时置
    // enforcementGap 阻断 sidecar(「无法判定」绝不当「确定没有」,r1-4);随包快照可识别的
    // 部分集仍尽力归位。归位写失败同样 gap(识别出的非法启用无法执行 = 不放行)。
    const oracle = (opts.sessionGrantIds ?? readSessionGrantIdsSync)(opts.userDataPath, opts.channel)
    {
      const pre = readLedgerV2(root)
      const enforceableKinds = new Set(["mcp", "agent", "plugin", "skill"])
      const catalogEnabled = pre.records.filter(
        (r) => r.scope.kind === "global" && r.origin === "catalog" && r.desiredState !== "disabled" && enforceableKinds.has(r.kind),
      )
      if (!oracle.ok && catalogEnabled.length > 0)
        gap.push(
          `session-grant determination unavailable (${oracle.reason}) while ${catalogEnabled.length} catalog extension(s) are enabled — cannot prove none is session-grant; blocking sidecar (fail closed)`,
        )
      const ids = oracle.ok ? oracle.ids : oracle.partialIds
      for (const r of catalogEnabled) {
        if (!ids.has(r.id)) continue
        const w = setDesiredStateV2(root, r.kind, r.name, "disabled")
        if (w.ok)
          warnings.push(
            `${r.kind} ${r.name}: session-grant per curation but the ledger said enabled — forced disabled (persistent enable is illegal; per-session activation = #408)`,
          )
        else gap.push(`${r.kind} ${r.name}: session-grant record could not be forced disabled: ${w.reason}`)
      }
    }
    // #395 步骤5:skills 派生允许集自愈(升级首启 backfill / 扩容失败残留收敛 / 账本损坏时撤陈旧
    // 允许集)—— 在 config 投影之前,与其共享同一把锁。r6 B3:陈旧允许集(可能仍列已禁 skill)= gap。
    const deriv = reconcileSkillsDerivation(root)
    if (!deriv.ok) {
      warnings.push(`skills derivation: ${deriv.reason}`)
      if (deriv.staleAllowList) gap.push(`skills allow-list may still enable disabled skills: ${deriv.reason}`)
    }
    // Codex r12 B2:账本损坏/不可读(非缺席)→ 主权注入会拿到空 records、disabled mcp/agent 无从注入,
    // fail-open。此处 fail-closed:probeLedgerForWrite 区分缺席(ENOENT=ok,无记录=安全)与损坏/EACCES/EIO
    // (可能藏 disabled 记录,注入落空)→ 后者 enforcementGap 阻断 sidecar(不放行可能加载已禁扩展的引擎)。
    const health = probeLedgerForWrite(root)
    if (!health.ok) {
      gap.push(`installs.json corrupt/unreadable: ${health.reason} — cannot enforce disabled extensions (injection would be empty)`)
      return done({ ok: false, applied, warnings, skipped: `ledger unusable: ${health.reason}` })
    }
    const ledger = readLedgerV2(root)
    warnings.push(...ledger.warnings)
    // Codex 增量 r13 Blocker:probeLedgerForWrite 只验文件级信封,不严格解码 records。若有 record 因
    // 损坏/重复/混合归属被排除(hasExcludedRecords),被排除的可能是 disabled mcp/agent —— 不进 records、
    // injection 拿不到 → disable 无从执行 → fail-closed gap 阻断 sidecar(宁可不起,不放行可能加载已禁项)。
    if (ledger.hasExcludedRecords) {
      gap.push(`installs.json has excluded (corrupt/duplicate) records — an excluded disabled mcp/agent cannot be enforced by injection; blocking sidecar`)
      return done({ ok: false, applied, warnings, skipped: "ledger has excluded records — fail closed" })
    }
    const configBacked = ledger.records.filter(
      (r) => r.scope.kind === "global" && (r.kind === "mcp" || r.kind === "agent" || r.kind === "plugin"),
    )
    // #395(r11 pivot):mcp/agent disable 由 sidecar 主权注入保证;唯 **plugin** disable 生效面 =
    // 从 alpha.jsonc plugin[] 移除(无用户 = 无他源),故 enforcementGap 只在 plugin disable 无法落盘时置位。
    // #397:session-grant 已在本函数开头归位进账本(readLedgerV2 此处读的已是合法态)。
    const disabledPlugins = configBacked.filter((r) => r.desiredState === "disabled" && r.kind === "plugin")
    if (configBacked.length === 0) return done({ ok: true, applied, warnings })
    const target = path.join(root, "alpha.jsonc")
    let text: string
    try {
      text = fs.readFileSync(target, "utf8")
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ENOENT" || code === "ENOTDIR") {
        // config 缺席:disabled plugin 天然不在 plugin[](安全);mcp/agent 注入保证;enabled 缺生效面 warning。
        for (const r of configBacked)
          if (r.desiredState === "enabled")
            warnings.push(`${r.kind} ${r.name}: ledger says enabled but alpha.jsonc is absent — no effect surface (reinstall to repair)`)
        return done({ ok: true, applied, warnings })
      }
      for (const r of disabledPlugins) gap.push(`plugin ${r.name}: alpha.jsonc unreadable (${code ?? String(error)}) — cannot remove from plugin[]`)
      return done({ ok: false, applied, warnings, skipped: `alpha.jsonc unreadable (${code ?? String(error)}) — fail closed, config untouched` })
    }
    const parseErrors: ParseError[] = []
    const cfg = parse(text, parseErrors)
    if (parseErrors.length > 0) {
      for (const r of disabledPlugins) gap.push(`plugin ${r.name}: alpha.jsonc not valid jsonc — cannot remove from plugin[]`)
      return done({ ok: false, applied, warnings, skipped: "alpha.jsonc is not valid jsonc — fail closed, config untouched" })
    }
    // r6 B1:plugin[] 是引擎 concat 合并,从 alpha.jsonc 移除挡不住 legacy/XDG 源同名条目被 concat
    // 加载 — disable 必须确认这些源无同名残留。仅当存在 disabled plugin 才读;读不出 = 无法确认。
    // legacy/XDG 探测已统一进下方循环的 legacyEnableResidueStrict(覆盖 plugin/mcp/agent,r7 B1/M3)。
    // 工作副本上逐条累积(多条 plugin 记录共享 plugin[] 键路径,后算必须看见先算的结果);
    // edits 按 keyPath 去重 last-wins(每个键路径只落最终累积值,免得整值 edit 互相覆盖)。
    const working = isObj(cfg) ? (structuredClone(cfg) as Record<string, unknown>) : {}
    const byPath = new Map<string, ConfigEdit>()
    const pluginDisableEdited: string[] = [] // 真产生 plugin disable edit 的记录(prepare/write 失败只 gap 这些)
    for (const record of configBacked) {
      const effState = record.desiredState // #397:session-grant 已在函数开头归位,账本即合法态
      const proj = computeEnableProjectionEdit(working, root, record, effState)
      if (!proj.ok) {
        warnings.push(`${record.kind} ${record.name}: ${proj.reason}`)
        // plugin disable 失败 = 无法从 plugin[] 移除 → gap;mcp/agent 注入兜底;enable 失败仅功能缺失。
        if (effState === "disabled" && record.kind === "plugin") gap.push(`plugin ${record.name}: ${proj.reason}`)
        continue
      }
      if (!proj.edit) continue
      if (effState === "disabled" && record.kind === "plugin") pluginDisableEdited.push(`plugin ${record.name}`)
      setAtKeyPath(working, proj.edit.keyPath, proj.edit.value)
      byPath.set(proj.edit.keyPath.join("\u0000"), proj.edit)
      applied.push(`${record.kind}:${record.name}→${effState}`)
    }
    if (byPath.size === 0) return done({ ok: true, applied, warnings })
    const prepared = prepareConfigTx(target, [...byPath.values()], text)
    if (!prepared.ok) {
      for (const d of pluginDisableEdited) gap.push(`${d}: config tx prepare failed — plugin not removed`)
      return done({ ok: false, applied: [], warnings, skipped: `config tx prepare failed: ${prepared.reason}` })
    }
    try {
      applyConfigImage(prepared.image)
    } catch (error) {
      for (const d of pluginDisableEdited) gap.push(`${d}: config write failed — plugin not removed`)
      return done({ ok: false, applied: [], warnings, skipped: `config write failed: ${error instanceof Error ? error.message : String(error)}` })
    }
    return done({ ok: true, applied, warnings })
  } finally {
    held.lock.release()
  }
}

/** 把值写进工作副本的 keyPath(缺失/非对象中间层重建为空对象 —— 与 jsonc modify 的落点语义对齐)。 */
function setAtKeyPath(obj: Record<string, unknown>, keyPath: string[], value: unknown): void {
  let cur = obj
  for (let i = 0; i < keyPath.length - 1; i++) {
    const next = cur[keyPath[i]]
    if (isObj(next)) {
      cur = next
    } else {
      const fresh: Record<string, unknown> = {}
      cur[keyPath[i]] = fresh
      cur = fresh
    }
  }
  cur[keyPath[keyPath.length - 1]] = value
}
