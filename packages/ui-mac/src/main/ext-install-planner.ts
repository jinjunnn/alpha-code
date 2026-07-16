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
import { fileURLToPath } from "node:url"
import type { InstallReceiptType } from "../preload/types"
import type { CatalogEntry, McpInstallSpec } from "../renderer/extensions/catalog-types"
import type { AppEnvironment } from "./alpha-environment"
import { alphaRoot } from "./alpha-workdir"
import type { AdvisoryGate } from "./ext-advisory-gate"
import { readGenerationReceiptSnapshot, readTransactionJournal } from "./ext-transaction"
import { confineFileTarget } from "./ext-file-tx"
import { tryAcquireBundleLock } from "./ext-bundle-lock"
import {
  runExtensionTransaction,
  actionOf,
  uninstallExtensionTransaction,
  type HealthProbe,
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
import { collectMcpFileRefPaths, newMcpSecretVersionId, pathIdentity, resolveMcpRefPath, substituteMcpSecretRefsPure } from "./alpha-mcp-secrets"

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
/** npm spec 的包名 base(保留 @scope,剥尾部 @version;与 ext-config.pkgBase 同判)。 */
function pkgBaseOf(spec: string): string {
  const at = spec.lastIndexOf("@")
  return at > 0 ? spec.slice(0, at) : spec
}

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

/** #378 r2(Major):plugin fresh/replace 的 config 在场扫描 —— plugin[] 里任何解析为本名派生
 *  落点(<root>/plugins/<name>/plugin.js 或 <root>/plugins/<name>@<suffix>/plugin.js)的条目
 *  都算在场:无账不认领(有账早被三态分发送去 replace);只查恰好的本次 jsPath 会漏掉其他
 *  内容寻址版本的未策展残留 —— 追加第二条同名路径后引擎会把两份 plugin 都加载。
 *  r3:解析走 resolvePluginEntryPath(相对/file:// 等价形态同样命中);树外条目不误伤。 */
function findSameNamePluginPathEntry(list: unknown[], root: string, name: string, entryBaseDir: string = root): string | null {
  // r14 Major:条目可经 symlink 别名到达 plugins/<name>[@…]/plugin.js —— 词法父目录判定漏判,
  // 追加 realpath 身份形态(pluginsRoot 同双形态)。
  const pluginsRootIdent = pathIdentity(path.join(root, "plugins"))
  for (const p of list) {
    // r4:元组成员取 spec 头;r6:legacy 源的相对条目按 **legacy 文件所在目录** 解析(entryBaseDir)。
    const resolved = resolvePluginEntryPath(p, entryBaseDir)
    if (resolved === null) continue
    const ident = pathIdentity(resolved)
    // r15 Major:任一侧身份不可判(非缺席类 fs 错)= 无法证明该条目不是本名别名 —— fail-closed
    // 按在场处理(拒继续安装,报词法形态),不得静默按词法比较放行。
    if (!pluginsRootIdent.certain || !ident.certain) return path.resolve(resolved)
    for (const form of ident.forms) {
      if (path.basename(form) !== "plugin.js") continue
      const dir = path.dirname(form)
      if (!pluginsRootIdent.forms.includes(path.dirname(dir))) continue
      const base = path.basename(dir)
      if (base === name || base.startsWith(`${name}@`)) return form
    }
  }
  return null
}

/** #378 r6/r7(Blocker/Major):fresh/replace 的同名派生路径检查必须覆盖**全部 legacy 源**
 *  (引擎合并 XDG 与 retained home 等历史位置)—— 任一源里指向 <root>/plugins/<name>[@…] 的
 *  条目在场时,继续安装/置换会双载。每源相对条目按其 configDir 解析;任一源不可读/形状非法 =
 *  fail-closed 拒(引擎会拒整份合并配置)。 */
function legacySameNamePluginGate(
  readLegacy: () => { ok: true; sources: Array<{ value: unknown[]; configDir: string }> } | { ok: false; reason: string },
  root: string,
  name: string,
): { ok: true } | { ok: false; reason: string } {
  const legacy = readLegacy()
  if (!legacy.ok) return legacy
  for (const src of legacy.sources) {
    const hit = findSameNamePluginPathEntry(src.value, root, name, src.configDir)
    if (hit) return { ok: false, reason: `legacy config contains "${hit}" without a ledger record — refusing to double-load an unregistered plugin` }
  }
  return { ok: true }
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
import type { AuthorizationConfirmationWire } from "../shared/ext-capability-authorization"
import { findReceipt } from "./alpha-installs"
import {
  aggregateFilesDigest,
  computeManifestDigest,
  decodeManifestV2,
  findDependencyCycle,
  sha256Hex,
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
  probeLedgerForWrite,
  readLedgerV2,
  upsertRecordV2,
  upsertRecordsV2,
  verifyProjectScope,
  type DesiredState,
  type InstallRecordV2,
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
import { promoteSeedAssetToCas, readPackagedSeed, type SeedAsset } from "./ext-seed"
import { casBlobPath, materializeFilesFromCas, putCasBlobFromBuffer, readCasBlobVerified } from "./ext-cas"
import { confinedExistingPath, isSafeRelPath } from "./ext-atomic-fs"
import { pluginRecordName, validateServer } from "./ext-config"

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
      /** MCP:renderer 用于 live sdk.mcp.add 的完整配置(含用户刚输入的密钥真值 —— 该值本就来自 renderer)。 */
      liveMcp?: { name: string; config: Record<string, unknown> }
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
  /** #378(Codex 裁决 Q2):MCP 写盘策略注入(Excel 受管 workspace mkdir+realpath+fail-closed
   *  校验;**非权威 provisioning** —— authorize 暂停后残留的只是一个空受管目录,零 config/账本/
   *  密钥副作用)。原地修改 server;单装事务与未策展通道共用同一闸口。 */
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
  readMcpLeafStrict(name: string): { ok: true; value: Record<string, unknown> | undefined } | { ok: false; reason: string }
  /** #346:journaled MCP 卸载的 in-lock 原语 —— 仅删配置副本(主+legacy),零账本副作用,
   *  失败如实返回(legacy 不可读也算失败)。**只在 uninstallExtensionTransaction 锁内调用**。 */
  removeMcpConfigInLock(name: string): ConfigOutcome
  /** #346:严格密钥吊销 —— 失败可观察(journal 据此保持非终态);目录缺失 = 幂等成功。
   *  整 server 目录删除,天然覆盖 #378 的全部版本目录 + legacy flat。 */
  removeMcpSecretsStrict(name: string): { ok: true } | { ok: false; reason: string }
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

export type PlannerDeps = {
  resolveEntry(catalogId: string): Promise<VerifiedCatalogEntry | null>
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
 *  grace(#318)。put 自愈损坏在店 blob 的 warnings loud 透传。 */
function promotePayloadToCas(
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

// ── #352:catalog 插件原子替换(Codex 裁决:复用 journaled 事务引擎,不新增通道)────────────────────

type PluginReplaceFacts = {
  record: InstallRecordV2
  form: { kind: "npm"; oldPinned: string } | { kind: "vendored"; oldJsPath: string; oldDir: string }
}
type PluginDispatch = { mode: "fresh" } | { mode: "replace"; facts: PluginReplaceFacts } | { mode: "refuse"; reason: string }

/** #352(必改 2):替换前的严格旧事实查询 —— 恰一条 kind=plugin、origin=catalog、id=catalogId、
 *  global scope、名字与新 manifest 一致;v1-only / 损坏 / 双键 / configKey 与实际 config 不符
 *  全部显式拒绝(refuse ≠ fresh:模糊状态绝不当首装装)。absent 双名皆无 → fresh。 */
function resolvePluginDispatch(
  root: string,
  entry: CatalogEntry,
  spec: { package?: string; vendoredAssetKey?: string } | undefined,
  readPluginArrayStrict: () => { ok: true; value: unknown[] } | { ok: false; reason: string },
  // #378 r11 Major:npm 兄弟 pin 检查必须覆盖 legacy 源(引擎合并后按包名去重,legacy 的
  // 同包 pin 可能胜出 —— 置换后账本与实际加载版本背离)。strict:读不出即拒。
  readLegacyPluginArray: () => { ok: true; sources: Array<{ value: unknown[]; configDir: string }> } | { ok: false; reason: string },
): PluginDispatch {
  const names = [entry.name]
  if (typeof spec?.package === "string" && spec.package) {
    const normalized = pluginRecordName(spec.package)
    if (normalized !== entry.name) names.push(normalized)
  }
  const hits: Array<{ name: string; lookup: ReturnType<typeof lookupForUninstall> }> = []
  for (const n of names) {
    const lk = lookupForUninstall(root, "plugin", n)
    if (lk.status === "ledger-corrupt" || lk.status === "corrupt-match")
      return { mode: "refuse", reason: `plugin ledger state for "${n}" is corrupt — refusing replace and refusing fresh-install (${lk.reason})` }
    if (lk.status === "v1")
      return { mode: "refuse", reason: `plugin "${n}" has a v1-only record — cannot atomically replace; uninstall explicitly, then reinstall` }
    if (lk.status === "valid") hits.push({ name: n, lookup: lk })
  }
  // review #381 Major:名字集合重建不了历史 —— package 改名前的 eager-v1 名无法从当前 spec 派生。
  // 按 catalog **id** 扫全账兜底:同 id 的 v2 record 名不在集合 = 名变更(拒);同 id 的 v1-only
  // receipt = 历史遗物(拒),绝不误走 fresh 造成新旧并存。
  const ledger = readLedgerV2(root)
  const strayRecord = ledger.records.find((r) => r.kind === "plugin" && r.id === entry.id && !names.includes(r.name))
  if (strayRecord)
    return { mode: "refuse", reason: `installed plugin record name "${strayRecord.name}" ≠ catalog entry name "${entry.name}" — name changes are refused in this phase` }
  const strayV1 = ledger.v1Only.find((r) => r.type === "plugin" && r.id === entry.id && !names.includes(r.name))
  if (strayV1)
    return { mode: "refuse", reason: `plugin "${strayV1.name}" (same catalog id, historical package name) has a v1-only record — cannot atomically replace; uninstall explicitly, then reinstall` }
  if (hits.length === 0) return { mode: "fresh" }
  if (hits.length > 1) return { mode: "refuse", reason: `plugin has records under both "${hits[0]!.name}" and "${hits[1]!.name}" — duplicate keys, refusing (resolve manually)` }
  const hit = hits[0]!
  const record = (hit.lookup as Extract<ReturnType<typeof lookupForUninstall>, { status: "valid" }>).record
  if (record.name !== entry.name)
    return { mode: "refuse", reason: `installed plugin record name "${record.name}" ≠ catalog entry name "${entry.name}" — name changes are refused in this phase` }
  if (record.id !== entry.id) return { mode: "refuse", reason: `installed plugin record id "${record.id}" ≠ catalog id "${entry.id}" — identity mismatch, refusing replace` }
  if (record.origin !== "catalog") return { mode: "refuse", reason: `installed plugin origin "${record.origin}" is not catalog-managed — refusing replace` }
  if (record.scope.kind !== "global") return { mode: "refuse", reason: "installed plugin record is not global-scoped — refusing replace" }
  const cfg = readPluginArrayStrict()
  if (!cfg.ok) return { mode: "refuse", reason: cfg.reason }
  const configKey = record.configKey ?? ""
  if (configKey.startsWith("plugin:")) {
    const oldPinned = configKey.slice("plugin:".length)
    // r5 Major:元组成员按 spec 头对账。r10 Major:①恰 pin 的等价重复 = 引擎同一 load 身份,
    // 不再按原始条目数误判 drift(replace 收敛为单条);②**同包其他 pin 在场即拒** —— 引擎按
    // 包名去重,兄弟 pin 可能胜出,置换后账本记新 pin 而引擎实际加载别的版本。
    const specs = cfg.value.map(pluginSpecOf).filter((x): x is string => x !== null)
    const base = pkgBaseOf(oldPinned)
    const sameBase = specs.filter((x) => pkgBaseOf(x) === base)
    const exact = sameBase.filter((x) => x === oldPinned)
    if (exact.length < 1)
      return { mode: "refuse", reason: `ledger configKey "${configKey}" not found in config plugin[] — ledger/config drift, refusing replace` }
    if (sameBase.length !== exact.length)
      return { mode: "refuse", reason: `config plugin[] contains other pins of "${base}" besides the ledger pin — ambiguous engine load identity, refusing replace` }
    // r11 Major:legacy 源的同包任何 pin 在场同拒(引擎合并去重时 later 源可能胜出)。
    const legacy = readLegacyPluginArray()
    if (!legacy.ok) return { mode: "refuse", reason: legacy.reason }
    for (const src of legacy.sources) {
      const legacyHit = src.value.map(pluginSpecOf).find((x): x is string => x !== null && pkgBaseOf(x) === base)
      if (legacyHit !== undefined)
        return { mode: "refuse", reason: `legacy config contains pin "${legacyHit}" of "${base}" — engine dedup may load it instead of the replacement, refusing (clean the legacy entry first)` }
    }
    return { mode: "replace", facts: { record, form: { kind: "npm", oldPinned } } }
  }
  if (configKey.startsWith("plugin-path:")) {
    // review #381 Major:configKey 只作对账参考,删除路径必须重新圈禁 —— 与卸载同一约束:
    // 必须恰为 <root>/plugins/<name 或 name@suffix>/plugin.js,否则后续旧目录 GC 的递归删除
    // 会被漂移账本导向任意目录。圈禁失败 = 拒绝(不是 fresh)。
    const oldJsPath = path.resolve(configKey.slice("plugin-path:".length))
    const pluginsRoot = path.join(root, "plugins")
    const oldDir = path.dirname(oldJsPath)
    const dirBase = path.basename(oldDir)
    const confined =
      path.basename(oldJsPath) === "plugin.js" &&
      path.dirname(oldDir) === pluginsRoot &&
      (dirBase === entry.name || dirBase.startsWith(`${entry.name}@`))
    if (!confined)
      return { mode: "refuse", reason: `ledger plugin path "${oldJsPath}" is not under "${pluginsRoot}/${entry.name}[@…]" — refusing replace (uncontrolled removal target)` }
    // r9 Major:对账按引擎解析语义 —— 合法等价改写(相对/file:///元组)不得被词法比较误判
    // 成 ledger drift。r10 Major:等价重复条目解析为同一路径 = 引擎去重后同一 load 身份,
    // 按解析身份计数(≥1 即对账成立;replace 把全部匹配收敛为单条)。r15 Major:比较按文件系统
    // 身份双形态(symlink 别名条目不得误判 drift);任一侧身份不可判 = 对账不可证明,拒。
    const oldIdent = pathIdentity(oldJsPath)
    let identUnprovable = false
    const hits = cfg.value.filter((x) => {
      const r = resolvePluginEntryPath(x, root)
      if (r === null) return false
      const ident = pathIdentity(r)
      if (ident.forms.some((f) => oldIdent.forms.includes(f))) return true
      if (!ident.certain || !oldIdent.certain) identUnprovable = true
      return false
    })
    if (identUnprovable)
      return { mode: "refuse", reason: `a plugin[] entry's filesystem identity is unresolvable (non-absence fs error) — cannot prove ledger/config reconciliation, refusing replace` }
    if (hits.length < 1)
      return { mode: "refuse", reason: `ledger configKey "${configKey}" not found in config plugin[] — ledger/config drift, refusing replace` }
    return { mode: "replace", facts: { record, form: { kind: "vendored", oldJsPath, oldDir } } }
  }
  return { mode: "refuse", reason: `installed plugin record has no recognizable configKey ("${configKey}") — refusing replace` }
}

/** #352 替换本体:同一 journaled 事务内「config 精确换元 + receipt 落账」——
 *  失败由引擎整文件 before-image rollback(config)+ 不落 receipt(账本)收敛;崩溃恢复前滚
 *  幂等(commitReceipt 重放走 upsert 的 exact-replay,#352 必改 4)。vendored 新内容先落
 *  versioned 目录(staging,锁外零权威副作用),事务只切 config 路径,旧目录提交成功后 GC。 */
async function replacePluginViaTransaction(args: {
  deps: PlannerDeps
  entry: CatalogEntry
  manifest: ExtensionManifestV2
  manifestDigest: string
  /** catalog 全意图或 seed 意图的授权/grants 子集(seed 无 grants 通道)。 */
  intent: Pick<CatalogInstallIntent, "grants" | "authorization">
  facts: PluginReplaceFacts
  rollback: (reason: string) => void
  txId: string
  /** #359:seed 通道的内容源覆盖 —— 载荷以 file items 进同一事务(#358 引擎),不做锁外
   *  staging;config 读器同覆盖(seed 路径不触 installers)。缺省 = catalog 的
   *  installers.stageVendoredPluginVersioned(resources 源,锁外 staging,#352 原样)。
   *  specs = 期望清单(同版本幂等早退的实物严格校验用,review r2 Major)。 */
  seedPayload?: { dir: string; dirRel: string; jsPath: string; items: TxPlanItem[]; specs: TxFileSpec[]; probe: HealthProbe }
  /** r16 Minor:载荷内容地址(seed/CAS 通道由调用方供给;catalog vendored 分支内部自算)——
   *  置换 receipt 不落 payloadDigest 会抹掉内容身份,advisory 聚合 digest 闸对缺失值保守放行/
   *  误拦。npm 无载荷,合法缺省。 */
  payloadDigest?: string
  readPluginArray?: () => { ok: true; value: unknown[] } | { ok: false; reason: string }
}): Promise<CatalogInstallOutcome> {
  const { deps, entry, manifest, manifestDigest, intent, facts, rollback } = args
  const readPluginArray = args.readPluginArray ?? (() => deps.installers.readPluginArrayStrict())
  const root = deps.globalRoot()
  // r7 Major:真源路由门(replace 同样只写 <root>/alpha.jsonc)。
  const replaceTruth = configTruthInRootGate(root, deps.installers.mcpConfigTruthPath())
  if (!replaceTruth.ok) {
    rollback(replaceTruth.reason)
    return replaceTruth
  }
  const spec = entry.installSpec as { kind?: string; package?: string; version?: string; vendoredAssetKey?: string }

  // 新目标派生 + 幂等早退(同钉版/同 digest = 无事可做,零副作用)。
  let newElem: string
  let newConfigKey: string
  let replacePayloadDigest = args.payloadDigest
  let stagedDir: string | null = null
  if (facts.form.kind === "npm") {
    if (typeof spec.package !== "string" || !spec.package) {
      rollback("entry has no plugin package")
      return { ok: false, reason: "entry has no plugin package" }
    }
    const pinned = spec.version && spec.package.indexOf("@", 1) === -1 ? `${spec.package}@${spec.version}` : spec.package
    // review #381 Major:幂等早退必须证明目标安装**完整**(digest 相等只证身份)—— receipt 版本、
    // 事务终态任一不符即走完整替换(替换本身就是修复路径),绝不把坏状态报成功。
    const npmHealthy =
      pinned === facts.form.oldPinned &&
      facts.record.manifestDigest === manifestDigest &&
      facts.record.version === manifest.version &&
      facts.record.transaction?.state === "committed"
    if (npmHealthy) {
      rollback("already at target version")
      return { ok: true, kind: "plugin", name: entry.name, manifestDigest, warning: `already pinned at ${pinned} — nothing to replace` }
    }
    newElem = pinned
    newConfigKey = `plugin:${pinned}`
    // r13 Major:换包名置换(新 base ≠ 旧 base)时,legacy 源已有**新 base** pin 同样拒 ——
    // dispatch 只查旧 base;引擎按包名去重,legacy 新 base pin 可能胜出。
    if (pkgBaseOf(pinned) !== pkgBaseOf(facts.form.oldPinned)) {
      // npm form 无 staging(cleanupStaged 定义在后且无事可清)。
      const legacyPre = deps.installers.readLegacyPluginArrayStrict()
      if (!legacyPre.ok) {
        rollback(legacyPre.reason)
        return legacyPre
      }
      const newBase = pkgBaseOf(pinned)
      for (const src of legacyPre.sources) {
        const hit = src.value.map(pluginSpecOf).find((x): x is string => x !== null && pkgBaseOf(x) === newBase)
        if (hit !== undefined) {
          rollback("legacy pin of the new package base present")
          return { ok: false, reason: `legacy config contains pin "${hit}" of "${newBase}" — engine dedup may load it instead of the replacement, refusing (clean the legacy entry first)` }
        }
      }
    }
  } else {
    if (!args.seedPayload && !spec.vendoredAssetKey) {
      rollback("entry has no vendored asset")
      return { ok: false, reason: "entry has no vendored asset" }
    }
    // vendored 另须实物在场 —— 目录丢失时同 digest 也要重 staging(修复)。
    const recordHealthy =
      facts.record.manifestDigest === manifestDigest &&
      facts.record.version === manifest.version &&
      facts.record.transaction?.state === "committed"
    if (args.seedPayload) {
      // seed 幂等早退(review r2 Major + r3 收紧):必须**持 bundle 锁**做实物严格逐文件校验 +
      // 账本锁内重读 —— 锁外验证可被并发替换骗过(TOCTOU),existsSync 只证存在不证内容。
      // 锁忙或任一不健康 = 不早退,落完整 journaled replace(修复路径;引擎锁内串行化)。
      if (recordHealthy && facts.form.oldDir === args.seedPayload.dir) {
        const held = tryAcquireBundleLock(root, { txId: `tx-pluginidem-${crypto.randomBytes(4).toString("hex")}` })
        if (held.ok) {
          try {
            const rec = findRecordV2(root, "plugin", entry.name)
            const still =
              rec !== null &&
              rec.manifestDigest === manifestDigest &&
              rec.version === manifest.version &&
              rec.transaction?.state === "committed" &&
              rec.configKey === `plugin-path:${args.seedPayload.jsPath}`
            if (still && verifySeedPluginDirExact(root, args.seedPayload.dirRel, args.seedPayload.specs).ok) {
              rollback("already at target version")
              return { ok: true, kind: "plugin", name: entry.name, manifestDigest, warning: "already at this version — nothing to replace" }
            }
          } finally {
            held.lock.release()
          }
        }
      }
      stagedDir = args.seedPayload.dir
      newElem = args.seedPayload.jsPath
      newConfigKey = `plugin-path:${args.seedPayload.jsPath}`
    } else {
      const assetKey = spec.vendoredAssetKey
      if (assetKey === undefined) {
        rollback("entry has no vendored asset")
        return { ok: false, reason: "entry has no vendored asset" }
      }
      // r16 Major:update/repair 与 fresh 同一硬化收集合同 —— 收集器拒绝(身份漂移/symlink 源/
      // 超帽/非常规条目)= 置换拒绝,绝不落回原样复制;digest 同源补齐 receipt payloadDigest。
      const payload = deps.installers.collectVendoredPluginPayload(assetKey, entry.name)
      if (!payload.ok) {
        rollback(payload.reason)
        return payload
      }
      replacePayloadDigest = aggregateFilesDigest(payload.files.map((f) => ({ path: f.path, sha256: sha256Hex(f.data), bytes: f.data.length })))
      // r15 Major:existsSync 只证 plugin.js 在场不证内容 —— 载荷截断/篡改/缺文件时同版本重装
      // 必须落修复(staging + 完整 replace),不得「nothing to replace」空转。镜像 seed 幂等早退:
      // 持 bundle 锁逐文件精确校验 + 账本锁内重读(锁外验证可被并发替换骗过);锁忙/任一不健康 =
      // 不早退,走修复路径。
      if (recordHealthy) {
        const held = tryAcquireBundleLock(root, { txId: `tx-pluginidem-${crypto.randomBytes(4).toString("hex")}` })
        if (held.ok) {
          try {
            const rec = findRecordV2(root, "plugin", entry.name)
            const still =
              rec !== null &&
              rec.manifestDigest === manifestDigest &&
              rec.version === manifest.version &&
              rec.transaction?.state === "committed" &&
              rec.configKey === `plugin-path:${facts.form.oldJsPath}`
            if (still && verifyVendoredPluginDirExact(facts.form.oldDir, payload.files).ok) {
              rollback("already at target version")
              return { ok: true, kind: "plugin", name: entry.name, manifestDigest, warning: "already at this version — nothing to replace" }
            }
          } finally {
            held.lock.release()
          }
        }
      }
      // r17 Major:staging 直用本次收集的字节 —— 与上方 receipt digest 同一来源,杜绝两次独立
      // 收集之间源变化造成「载荷 B + digest A」。
      const staged = deps.installers.stageVendoredPluginVersioned(assetKey, entry.name, payload.files)
      if (!staged.ok) {
        rollback(staged.reason)
        return staged
      }
      stagedDir = staged.dir
      newElem = staged.jsPath
      newConfigKey = `plugin-path:${staged.jsPath}`
    }
  }
  const cleanupStaged = (txId?: string) => {
    // seed 载荷是事务 file items:失败由引擎逐文件恢复,这里只在 journal 终态 rolled-back 时
    // 收空壳目录(圈禁 + lstat 遍历;retained 现场与 symlink 一律不碰,review r2 Blocker)。
    if (args.seedPayload) {
      removeEmptyDirTreeConfined(root, args.seedPayload.dirRel, txId)
      return
    }
    if (!stagedDir) return
    // #378 r2 Major:retained(恢复被挡)形态下 live config 可能已指向 staged jsPath ——
    // 此时删除会制造「config 指向缺失载荷」。live 引用在场或读不出 = 保守不删(孤儿目录
    // 无害,按 runbook 人工收);未被引用才收。
    const live = readPluginArray()
    // r3/r14 Major:引用比较按引擎解析语义 + 文件系统身份双形态(相对/file:///symlink 别名
    // 都不得被词法比较误判「未引用」而删掉 live 仍指向的载荷)。r15 Major:任一侧身份不可判
    // (非缺席类 fs 错)= 视为引用(保守不删),不得静默回退词法。
    const newElemIdent = pathIdentity(newElem)
    const refsStaged = (e: unknown, baseDir: string): boolean => {
      const resolved = resolvePluginEntryPath(e, baseDir)
      if (resolved === null) return false
      const ident = pathIdentity(resolved)
      if (!newElemIdent.certain || !ident.certain) return true
      return ident.forms.some((f) => newElemIdent.forms.includes(f))
    }
    if (!live.ok || live.value.some((e) => refsStaged(e, root))) {
      console.error(
        `[ext-install-planner] plugin ${entry.name}: staged dir kept — ${live.ok ? "live config still references it (retained rollback?)" : `config unreadable: ${live.reason}`}`,
      )
      return
    }
    // r8 Major:legacy 源(引擎合并)引用 staged jsPath 时同样保留 —— 只查主数组会在
    // 「legacy 已引用 staged、replace 被门拒」的现场删掉引擎仍会加载的载荷。读不出 = 保守不删。
    const legacyLive = deps.installers.readLegacyPluginArrayStrict()
    if (!legacyLive.ok || legacyLive.sources.some((src) => src.value.some((e) => refsStaged(e, src.configDir)))) {
      console.error(
        `[ext-install-planner] plugin ${entry.name}: staged dir kept — ${legacyLive.ok ? "a legacy config source references it" : `legacy config unreadable: ${legacyLive.reason}`}`,
      )
      return
    }
    try {
      fs.rmSync(stagedDir, { recursive: true, force: true })
    } catch {
      /* staging 残留无 config 引用,无害;GC 语义外的孤儿目录 */
    }
  }

  // plan 快照(锁外)+ 锁内 precondition 重读钉死 TOCTOU:config 与账本旧事实任一漂移即拒,用户重试。
  const snapshot = readPluginArray()
  if (!snapshot.ok) {
    cleanupStaged()
    rollback(snapshot.reason)
    return snapshot
  }
  const oldElem = facts.form.kind === "npm" ? facts.form.oldPinned : facts.form.oldJsPath
  // r5/r9 Major:等值与换元按引擎语义 —— npm 按 spec 头(包名非路径);vendored 按解析路径
  // (相对/file:///元组等价形态都命中)。否则合法配置被误报 drift 永远无法更新。
  // r15 Major:vendored 按文件系统身份双形态(symlink 别名条目不得误判 drift/漏换元);
  // 任一侧身份不可判(非缺席类 fs 错)= 换元集不可证明,拒(否则不可判别名残留会双载)。
  const oldElemIdent = facts.form.kind === "npm" ? null : pathIdentity(path.resolve(oldElem))
  let matchIdentUnprovable = false
  const matchesOld = (x: unknown): boolean => {
    if (oldElemIdent === null) return pluginSpecOf(x) === oldElem
    const r = resolvePluginEntryPath(x, root)
    if (r === null) return false
    const ident = pathIdentity(r)
    if (ident.forms.some((f) => oldElemIdent.forms.includes(f))) return true
    if (!ident.certain || !oldElemIdent.certain) matchIdentUnprovable = true
    return false
  }
  // r10 Major:等价重复(同一引擎 load 身份)≥1 即对账成立,置换时收敛为单条;0 条才是 drift。
  const oldMatchCount = snapshot.value.filter(matchesOld).length
  if (matchIdentUnprovable) {
    cleanupStaged()
    rollback("plugin entry identity unresolvable")
    return { ok: false, reason: "a plugin[] entry's filesystem identity is unresolvable (non-absence fs error) — cannot prove the replacement set, refusing (retry after resolving)" }
  }
  if (oldMatchCount < 1) {
    cleanupStaged()
    rollback("plugin config drifted before plan")
    return { ok: false, reason: "plugin config changed while planning — retry the update" }
  }
  // #378 r2(Major,fresh 同款对称):oldElem 之外的同名派生路径 = 未策展残留 —— 置换后它会
  // 留在数组里与新元素双载同名插件;拒绝而非静默带过(与 fresh 的不认领语义一致)。
  const strayEntry = findSameNamePluginPathEntry(
    snapshot.value.filter((x) => !matchesOld(x)),
    root,
    entry.name,
  )
  if (strayEntry) {
    cleanupStaged()
    rollback("unregistered plugin path present")
    return { ok: false, reason: `config also contains "${strayEntry}" without a ledger record — refusing to update into a double-load` }
  }
  // r14 Major:换包名置换(新 base ≠ 旧 base)时,**主配置**未策展的新 base 同包条目同样拒 ——
  // 置换后 [newpkg@2, newpkg@9] 引擎 later-wins 加载未策展 pin 而账本记新 pin(旧 base 兄弟
  // 已由 dispatch sameBase 检查拒;锁内 canon 快照等值保证本检查在计划后持续有效)。
  if (facts.form.kind === "npm" && pkgBaseOf(newElem) !== pkgBaseOf(facts.form.oldPinned)) {
    const newBase = pkgBaseOf(newElem)
    const mainHit = snapshot.value.map(pluginSpecOf).find((x): x is string => x !== null && pkgBaseOf(x) === newBase)
    if (mainHit !== undefined) {
      cleanupStaged()
      rollback("unregistered pin of the new package base present")
      return { ok: false, reason: `config already contains pin "${mainHit}" of "${newBase}" — engine dedup may load it instead of the replacement, refusing (clean it first)` }
    }
  }
  // r6 Major:legacy XDG 源的同名派生路径同判(置换后 legacy 旧路径仍被引擎合并加载 = 双载)。
  const replaceLegacyGate = legacySameNamePluginGate(() => deps.installers.readLegacyPluginArrayStrict(), root, entry.name)
  if (!replaceLegacyGate.ok) {
    cleanupStaged()
    rollback("legacy plugin conflict")
    return replaceLegacyGate
  }
  // r10/r11:等价重复收敛为单条;保留**最后一条**匹配的形态/options —— 引擎对重复解析身份
  // 取后者为准(config/plugin.ts later-wins),保首条会丢弃真正生效的 options。
  const lastMatchIdx = snapshot.value.reduce((acc, x, i) => (matchesOld(x) ? i : acc), -1)
  const nextArray: unknown[] = []
  for (const [i, x] of snapshot.value.entries()) {
    if (!matchesOld(x)) {
      nextArray.push(x)
      continue
    }
    if (i !== lastMatchIdx) continue
    nextArray.push(Array.isArray(x) ? [newElem, x[1]] : newElem)
  }
  const snapshotCanon = JSON.stringify(snapshot.value)

  const now = deps.now?.() ?? new Date().toISOString()
  const receiptTemplate: UpsertInput = {
    id: entry.id,
    name: entry.name,
    kind: "plugin",
    environment: deps.environment(),
    scope: { kind: "global" },
    version: manifest.version,
    manifestDigest,
    grantDigest: computeGrantDigest(intent.grants ?? {}),
    // 可选裁决采纳:更新默认保留旧 desiredState —— 更新 disabled 插件不得静默重新启用。
    desiredState: facts.record.desiredState,
    origin: "catalog",
    ...(stagedDir ? { files: [stagedDir] } : {}),
    // r16 Minor:置换 receipt 落载荷内容地址 —— upsert 是整记录替换,缺省会抹掉旧值,
    // advisory 聚合 digest 闸对缺失 payloadDigest 保守判中,升级后的无关载荷被误拦。
    ...(replacePayloadDigest ? { payloadDigest: replacePayloadDigest } : {}),
    configKey: newConfigKey,
    installedAt: now,
  }
  const plan: TxPlan = {
    items: [
      // #359:seed 载荷 file items 与 config 换元同事务(全提交或全回滚;capabilities/receipt
      // 只挂 config 逻辑主 item)。catalog 路径无载荷 items(#352 原样)。
      ...(args.seedPayload?.items ?? []),
      {
        key: `plugin--${entry.name}`,
        action: "config",
        config: { target: path.join(root, "alpha.jsonc"), edits: [{ keyPath: ["plugin"], value: nextArray }] },
        manifestDigest,
        // #348:替换同样过 authorize 闸(能力扩张时弹确认;renderer 拦截已就绪)。
        capabilities: manifest.capabilities,
        receipt: receiptTemplate,
      },
    ],
    ...(intent.authorization ? { authorization: stampAuthorization(intent.authorization, () => deps.now?.() ?? new Date().toISOString())! } : {}),
  }
  const hooks: TxHooks = {
    populate: () => {}, // config/file action 无 populate 载荷(file 的 staging 由引擎适配器落)
    ...(args.seedPayload ? { probe: args.seedPayload.probe } : {}),
    // 锁内前置(TOCTOU 钉死):config 数组与账本旧事实必须仍如 plan 时,任一漂移 = 拒绝重试。
    // review #383 Major:desiredState 也在漂移面上 —— plan 快照与加锁之间的合法启停不得被
    // 旧快照静默覆盖(receipt 模板取的是 plan 期值)。
    precondition: () => {
      const cur = readPluginArray()
      if (!cur.ok) return cur
      if (JSON.stringify(cur.value) !== snapshotCanon) return { ok: false, reason: "plugin config changed since plan — retry the update" }
      const rec = findRecordV2(root, "plugin", entry.name)
      if (!rec || rec.generation !== facts.record.generation || rec.manifestDigest !== facts.record.manifestDigest)
        return { ok: false, reason: "plugin ledger changed since plan — retry the update" }
      if (rec.desiredState !== facts.record.desiredState)
        return { ok: false, reason: "plugin desired state changed since plan — retry the update" }
      // r12 Major:legacy 源不在主 canon 快照覆盖内 —— 锁内重跑两个 legacy 门(同名派生路径 +
      // npm 同包 pin),与「计划前 + 锁内双查」合同一致;否则计划后写入 retained 源的同包 pin
      // 会让引擎 later-wins 加载 legacy 版本而账本记新 pin。
      const legacyGateNow = legacySameNamePluginGate(() => deps.installers.readLegacyPluginArrayStrict(), root, entry.name)
      if (!legacyGateNow.ok) return legacyGateNow
      if (facts.form.kind === "npm") {
        const legacyNow = deps.installers.readLegacyPluginArrayStrict()
        if (!legacyNow.ok) return legacyNow
        // r13 Major:catalog 更新可换包名(同 entry 名)—— 旧/新两个 base 都要复核,否则
        // 计划后写入 legacy 的**新 base** pin 会在引擎 later-wins 时胜出而账本记新 pin。
        const bases = new Set([pkgBaseOf(facts.form.oldPinned), pkgBaseOf(newElem)])
        for (const src of legacyNow.sources) {
          const hit = src.value.map(pluginSpecOf).find((x): x is string => x !== null && bases.has(pkgBaseOf(x)))
          if (hit !== undefined) return { ok: false, reason: `legacy config gained pin "${hit}" since plan — retry the update` }
        }
      }
      // review r2 Blocker:异 payload 的新内容寻址目录必须缺席(锁内判;r3:壳容忍 —— recovery
      // 回滚遗留的纯空目录树不阻断重试,文件/symlink 在场才拒;preAbsent 的最终强制在引擎
      // file prepare 的 requireAbsent 断言 + switch 前紧邻重断言)。
      if (args.seedPayload && facts.form.kind === "vendored" && args.seedPayload.dir !== facts.form.oldDir && seedDirBlocksInstall(root, args.seedPayload.dirRel))
        return { ok: false, reason: `plugin dir "${path.basename(args.seedPayload.dir)}" exists without a ledger record — refusing to overwrite or adopt unregistered content (remove it and retry)` }
      // review r4 Major:同目录 repair 只重写清单文件 —— 目录里存在清单外文件/symlink 时修复
      // **不可收敛**(落账成功但永不 healthy),锁内分类为 blocked 即拒,人工核对后删除重试。
      if (args.seedPayload && facts.form.kind === "vendored" && args.seedPayload.dir === facts.form.oldDir) {
        const cls = classifySeedPluginDir(root, args.seedPayload.dirRel, args.seedPayload.specs)
        if (cls.cls === "blocked")
          return { ok: false, reason: `plugin dir "${path.basename(args.seedPayload.dir)}" contains unmanifested content (${cls.reason}) — repair cannot converge; remove/diagnose it and retry` }
      }
      return { ok: true }
    },
    commitReceipt: (records: TxCommitRecord[]) => {
      const written = upsertRecordsV2(root, recoveryReceiptInputs(records))
      if (!written.ok) throw new Error(`plugin replace receipt commit failed: ${written.reason}`)
    },
    log: () => {},
  }
  const result = await runExtensionTransaction(root, plan, hooks)
  if (!result.ok) {
    cleanupStaged(result.txId)
    rollback(`plugin replace failed at ${result.stage}: ${result.reason}`)
    if (result.stage === "authorize") {
      if (result.authorization) return { ok: false, stage: "authorize", reason: result.reason, authorization: result.authorization }
      return { ok: false, reason: result.reason }
    }
    return { ok: false, reason: `plugin replace failed at ${result.stage}: ${result.reason}`, stage: result.stage }
  }
  // 提交成功:vendored 旧目录 GC。review #383 r2 Blocker:事务返回时锁已释放,直接 rmSync 有
  // 跨事务 ABA(另一事务可能已把同 payload 目录重新引用)—— 改为重新持锁、锁内重读 config/账本
  // 引用、圈禁后才删(gcVendoredPluginDirLocked);同 payload 新旧目录相同时跳过。锁忙/被重新
  // 引用 = 保留(孤儿有 runbook 处置),绝不误删已提交运行载荷。
  let warning: string | undefined
  if (facts.form.kind === "vendored" && facts.form.oldDir !== stagedDir) {
    const gc = gcVendoredPluginDirLocked(root, entry.name, facts.form.oldDir, readPluginArray, () => deps.installers.readLegacyPluginArrayStrict())
    if (!gc.removed) warning = gc.warning
  }
  ;(deps.transaction ?? passthroughTx).commit(args.txId)
  return {
    ok: true,
    kind: "plugin",
    name: entry.name,
    manifestDigest,
    ...(stagedDir ? { files: [stagedDir] } : {}),
    ...(warning ? { warning } : {}),
  }
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

/** ADR-030(#372):新增 project-scope catalog/seed 受管安装已收回 —— 稳定拒绝 reason(wire 形状
 *  保留,decode 不拒;语义层统一拒)。项目本地技能走 `<project>/.alpha/skills` + project config
 *  hook 的非 generation 路径(importExternalSkills / registerProjectSkillsPath)。 */
export const PROJECT_INSTALL_UNSUPPORTED_REASON =
  "project-scoped catalog/seed installation is unsupported — use project-local import/register"

/** ADR-030:遗留可管理 kind(历史残留的卸载/禁用/清理通道)。这是**管理面**的 allowlist,
 *  与「新增安装策略 = 无 project kind」分离 —— 清空它会封死残留清理,绝不与安装策略共用。 */
const LEGACY_PROJECT_MANAGEABLE_KINDS = new Set<string>(["skill", "agent"])

function resolveScope(
  scope: InstallScope,
  _kind: string,
): { ok: true; root: (deps: PlannerDeps) => string; identity: ScopeIdentity; target: TargetArg } | { ok: false; reason: string } {
  if (scope.scope === "global") return { ok: true, root: (d) => d.globalRoot(), identity: { kind: "global" }, target: { scope: "global" } }
  // ADR-030 防御性拒绝:权威拒绝点在 installCatalog 的 decode 后 policy guard(seed/bundle 分支
  // 不经过本函数,不能只靠这里);任何 kind 一律拒,不再有 project 安装根。
  return { ok: false, reason: PROJECT_INSTALL_UNSUPPORTED_REASON }
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

  // 分类每个 required/optional 子条目 → 事务项 / 跳过。required 致命 = 整单拒绝(环境态零写盘;
  // 已提升的 CAS blob 是可重建缓存,交 GC grace,不参加 bundle 回滚)。
  const planItems: TxPlanItem[] = []
  const installedIds: string[] = []
  const skipped: Array<{ id: string; reason: string }> = []
  const bundleWarnings: string[] = []
  for (const it of items) {
    const child = resolved.get(it.catalogEntryId)!
    // #315(并入 REQ-105 静态基线):advisory 命中的子条目绝不经 bundle 通道铺给用户 ——
    // 恒跳过(即使 required,沿用 REQ-105 语义);跳过决策落 main(非 renderer)。
    const childAdv = deps.advisoryGate(advisoryInputOf(child.entry, verified.channel))
    if (!childAdv.allowed) {
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
  const hooks: TxHooks = {
    // REQ-098 #303:generation 项统一从验证共享 CAS 物化(读取重验;blob 被 GC/外部删除 → 抛错 =
    // 事务 abort,绝不回退 buffer 直填)。config/receipt 项无 populate。
    populate: (item, stagingDir) => {
      if (actionOf(item) !== "generation") return
      materializeFilesFromCas(deps.casBaseRoot(), item.files ?? [], stagingDir)
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
  // ADR-030(#372)权威拒绝点:decode 后、resolveEntry/seed 分流与任何副作用之前 —— catalog、
  // seed、bundle 三形态同一合同,任何 catalog 拉取/CAS promotion/事务/写盘都不会为 project 发生。
  if (decodedIntent.intent.scope.scope === "project") return { ok: false, reason: PROJECT_INSTALL_UNSUPPORTED_REASON }
  if ("source" in decodedIntent.intent) return installSeedAsset(decodedIntent.intent, deps)
  const intent = decodedIntent.intent

  const verified = await deps.resolveEntry(intent.catalogId)
  if (!verified) return { ok: false, reason: `entry not in verified catalog: ${intent.catalogId}` }
  const entry = verified.entry

  // #315:advisory 激活闸(bundle 本体 id 也在此过;children 在 fan-out 内逐个过)。
  const adv = deps.advisoryGate(advisoryInputOf(entry, verified.channel))
  if (!adv.allowed) return { ok: false, reason: `advisory ${adv.advisoryId}: ${adv.reason} — activation refused (R14)` }

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
  const tx = (deps.transaction ?? passthroughTx).begin({ op: "install", kind: entry.type, name: entry.name, scope: intent.scope.scope, manifestDigest })
  const rollback = (reason: string): void => (deps.transaction ?? passthroughTx).rollback(tx.txId, reason)

  // #378:全类型分支自提交并早返回(引擎 commitReceipt 单点)—— #354 时代「提交面补偿闭包 +
  // 密钥快照」随非事务尾部一并退役。
  let payloadDigest: string | undefined

  const spec = entry.installSpec

  // ── #354 写前门(Codex 裁决必改 1/3 + review #379 Major):没有可靠前像的覆盖更新一律显式
  //    拒绝,不静默覆盖、不把无账在场认领为 catalog(plugin 更新链 = #352 原子替换;agent 无
  //    更新链)。在场检查覆盖 v2 record **与 v1-only receipt**(历史 eager v1 遗物)。
  if (entry.type === "plugin") {
    // #378 r6(Major):vendored 内容身份交叉在**分发之前**(fresh 收集器的绑定会被 replace
    // 分支绕过 —— 已有 victim 记录 + 配错 vendoredAssetKey 的新 entry 会把别的资产按 victim
    // 的名称/账本/授权身份置换进运行)。与 collectVendoredPluginPayload/#361 agent 同一合同。
    if (spec?.kind === "plugin" && spec.vendoredAssetKey && spec.vendoredAssetKey !== `plugins/${entry.name}`) {
      rollback("plugin content identity drift")
      return { ok: false, reason: `catalog entry vendoredAssetKey "${spec.vendoredAssetKey}" ≠ "plugins/${entry.name}" — refusing (content identity drift)` }
    }
    // #352:fresh / replace / refuse 三态分发(main 从自己账本裁决,复用同一 catalog 通道)——
    // 有效 catalog 旧账 → journaled 原子替换;v1-only/损坏/双键/漂移 → 显式拒绝;absent → fresh。
    const dispatch = resolvePluginDispatch(
      scope.root(deps),
      entry,
      spec?.kind === "plugin" ? spec : undefined,
      deps.installers.readPluginArrayStrict,
      () => deps.installers.readLegacyPluginArrayStrict(),
    )
    if (dispatch.mode === "refuse") {
      rollback(dispatch.reason)
      return { ok: false, reason: dispatch.reason }
    }
    if (dispatch.mode === "replace") {
      return replacePluginViaTransaction({
        deps,
        entry,
        manifest,
        manifestDigest,
        intent,
        facts: dispatch.facts,
        rollback,
        txId: tx.txId,
      })
    }
    if (spec?.kind === "plugin" && spec.vendoredAssetKey && fs.existsSync(path.join(deps.globalRoot(), "plugins", entry.name))) {
      rollback("unregistered plugin dir present")
      return { ok: false, reason: `plugin dir "plugins/${entry.name}" exists without a ledger record — refusing to overwrite or adopt unregistered content` }
    }
  }
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
    // r7 Major:escape-hatch 环境下引擎配置真源不在事务根 → fail-closed 拒(不写账谎报 active)。
    const mcpTruth = configTruthInRootGate(scope.root(deps), deps.installers.mcpConfigTruthPath())
    if (!mcpTruth.ok) {
      rollback(mcpTruth.reason)
      return mcpTruth
    }
    const derived = deriveMcpConfig(spec, grants)
    if (!derived.ok) {
      rollback(derived.reason)
      return derived
    }
    // #354 语义保留(产品早拒):不可读/形状异常的前像写前拒绝(锁内 precondition 重验)。
    const leafBefore = deps.installers.readMcpLeafStrict(entry.name)
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
    // #378(Codex 裁决 Q2):Excel 受管 workspace 策略注入(原 persistMcpWithPolicy 闸口,持久化
    // 剥离)—— mkdir/realpath 属非权威 provisioning:authorize 暂停残留的只是空受管目录,零
    // config/账本/密钥副作用(测试钉)。live 从策略后 durable 派生,不缺策略字段。
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
    const mcpRoot = scope.root(deps)
    const mcpConfigTarget = path.join(mcpRoot, "alpha.jsonc")
    const mcpNow = deps.now?.() ?? new Date().toISOString()
    const mcpReceipt: UpsertInput = {
      id: entry.id,
      name: entry.name,
      kind: "mcp",
      environment: deps.environment(),
      scope: scope.identity,
      version: manifest.version,
      manifestDigest,
      grantDigest: computeGrantDigest(grants),
      desiredState: "enabled",
      origin: "catalog",
      configKey: `mcp.${entry.name}`,
      installedAt: mcpNow,
    }
    const plan: TxPlan = {
      items: [
        {
          key: `mcp--${entry.name}`,
          action: "config",
          config: { target: mcpConfigTarget, edits: [{ keyPath: ["mcp", entry.name], value: durable }] },
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
        const ledger = probeLedgerForWrite(mcpRoot)
        if (!ledger.ok) return { ok: false, reason: `refusing mcp install: ${ledger.reason}` }
        const leaf = deps.installers.readMcpLeafStrict(entry.name)
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
        const written = upsertRecordsV2(mcpRoot, recoveryReceiptInputs(records))
        if (!written.ok) throw new Error(`mcp receipt commit failed: ${written.reason}`)
      },
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
    const gc = deps.installers.gcMcpSecrets(entry.name)
    // live = 策略后配置 + 密钥真值回填({file:} 引用换回本次 grants 真值;契约:绝不回传任何
    // main/keychain 来源的密钥)。
    const liveCfg = structuredClone(durable)
    const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
    for (const [varName, ref] of Object.entries(refs)) {
      const real = secretMap[varName]
      if (typeof real !== "string") continue
      const liveEnv = liveCfg.environment
      if (isRec(liveEnv) && liveEnv[varName] === ref) liveEnv[varName] = real
      const liveHeaders = liveCfg.headers
      if (isRec(liveHeaders)) {
        for (const [hk, hv] of Object.entries(liveHeaders)) {
          if (typeof hv === "string" && hv.includes(ref)) liveHeaders[hk] = hv.split(ref).join(real)
        }
      }
    }
    const mcpWarnings = [...result.warnings, ...gc.warnings]
    return {
      ok: true,
      kind: "mcp",
      name: entry.name,
      manifestDigest,
      liveMcp: { name: entry.name, config: liveCfg },
      ...(mcpWarnings.length ? { warning: mcpWarnings.join("; ") } : {}),
    }
  } else if (entry.type === "plugin") {
    // #378(Codex 裁决 D2/D3):plugin fresh 收进事务 —— replace 已由上方 #352 三态分发走
    // journaled 替换(capabilities/authorization 在 plan 上,已过闸),此处只剩 fresh:
    // vendored = 随包载荷自算内容地址进 CAS → #359 seed 同一事务载体(constraints/探针/
    // precondition 全复用,目录 = 内容寻址 plugins/<name>@<digest16>);npm = config action
    // 单事务(整数组换元)。两路 authorize 闸随 plan capabilities 生效,账本归引擎单点。
    if (spec?.kind !== "plugin") {
      rollback("entry has no plugin installSpec")
      return { ok: false, reason: "entry has no plugin installSpec" }
    }
    if (spec.vendoredAssetKey) {
      const c = deps.installers.collectVendoredPluginPayload(spec.vendoredAssetKey, entry.name)
      if (!c.ok) {
        rollback(c.reason)
        return c
      }
      // 自算内容地址进 CAS(#303 builtin 先例:摄取后完整性,不主张上游真实性)。
      const vendManifest = c.files.map((f) => ({ path: f.path, sha256: sha256Hex(f.data), bytes: f.data.length }))
      const p = promotePayloadToCas(deps.casBaseRoot(), c.files, vendManifest)
      if (!p.ok) {
        rollback(p.reason)
        return { ok: false, reason: p.reason }
      }
      // promotion warnings 产生即落 main 日志(#361 r5 同款:authorize 暂停不丢证据)。
      if (p.warnings.length)
        console.error(`[ext-install-planner] plugin ${entry.name}: CAS promotion warnings: ${p.warnings.join("; ")}`)
      return installPluginFromCas({
        deps,
        entry,
        manifest,
        manifestDigest,
        payloadDigest: aggregateFilesDigest(vendManifest),
        promotedSpecs: p.specs,
        casBaseRoot: deps.casBaseRoot(),
        auth: { ...(intent.grants ? { grants: intent.grants } : {}), ...(intent.authorization ? { authorization: intent.authorization } : {}) },
        rollback,
        txId: tx.txId,
      })
    }
    if (typeof spec.package === "string" && spec.package) {
      const pinned = spec.version && spec.package.indexOf("@", 1) === -1 ? `${spec.package}@${spec.version}` : spec.package
      // #378(Codex 裁决 Q5):跨配置源同 base 严格检查 —— 主配置在场 = 未策展拒认领(#354 语义)
      // 或版本漂移拒;legacy XDG 在场 = 引擎会合并两份 plugin 数组,绝不是 fresh;任一侧不可读拒。
      const conflict = deps.installers.findPluginBaseConflictStrict(pinned)
      if (!conflict.ok) {
        rollback(conflict.reason)
        return conflict
      }
      if (conflict.existing) {
        rollback("plugin base already configured")
        return {
          ok: false,
          reason: `plugin "${pinned}" already configured as "${conflict.existing.spec}" in the ${conflict.existing.source} config without a matching catalog record — refusing to adopt or double-install`,
        }
      }
      const npmSnapshot = deps.installers.readPluginArrayStrict()
      if (!npmSnapshot.ok) {
        rollback(npmSnapshot.reason)
        return npmSnapshot
      }
      const npmRoot = scope.root(deps)
      // r7 Major:真源路由门(同 MCP)。
      const npmTruth = configTruthInRootGate(npmRoot, deps.installers.mcpConfigTruthPath())
      if (!npmTruth.ok) {
        rollback(npmTruth.reason)
        return npmTruth
      }
      // r2 Major(对称):同名派生 vendored 路径的未策展残留同样拒 —— 引擎合并 plugin[] 全量
      // 加载,追加 npm 钉版会与残留路径双载同名插件。
      const sameNamePath = findSameNamePluginPathEntry(npmSnapshot.value, npmRoot, entry.name)
      if (sameNamePath) {
        rollback("unregistered plugin path present")
        return { ok: false, reason: `config already contains "${sameNamePath}" without a ledger record — refusing to adopt or double-install an unregistered plugin` }
      }
      // r6 Major:legacy XDG 源的同名派生路径同样拒(引擎合并两源)。
      const npmLegacyGate = legacySameNamePluginGate(() => deps.installers.readLegacyPluginArrayStrict(), npmRoot, entry.name)
      if (!npmLegacyGate.ok) {
        rollback("legacy plugin conflict")
        return npmLegacyGate
      }
      const npmConfigTarget = path.join(npmRoot, "alpha.jsonc")
      const npmCanon = JSON.stringify(npmSnapshot.value)
      const npmNow = deps.now?.() ?? new Date().toISOString()
      const npmReceipt: UpsertInput = {
        id: entry.id,
        name: entry.name,
        kind: "plugin",
        environment: deps.environment(),
        scope: scope.identity,
        version: manifest.version,
        manifestDigest,
        grantDigest: computeGrantDigest(grants),
        desiredState: "enabled",
        origin: "catalog",
        configKey: `plugin:${pinned}`,
        installedAt: npmNow,
      }
      const plan: TxPlan = {
        items: [
          {
            key: `plugin--${entry.name}`,
            action: "config",
            config: { target: npmConfigTarget, edits: [{ keyPath: ["plugin"], value: [...npmSnapshot.value, pinned] }] },
            manifestDigest,
            capabilities: manifest.capabilities,
            receipt: npmReceipt,
          },
        ],
        ...(intent.authorization ? { authorization: stampAuthorization(intent.authorization, () => deps.now?.() ?? new Date().toISOString())! } : {}),
      }
      const hooks: TxHooks = {
        populate: () => {}, // config action 无 staging 载荷
        // 锁内前置(TOCTOU):三态整体重跑 + 跨源冲突重查 + config 数组未漂移 + 账本可写。
        precondition: () => {
          const ledger = probeLedgerForWrite(npmRoot)
          if (!ledger.ok) return { ok: false, reason: `refusing plugin install: ${ledger.reason}` }
          const redispatch = resolvePluginDispatch(npmRoot, entry, spec, deps.installers.readPluginArrayStrict, () => deps.installers.readLegacyPluginArrayStrict())
          if (redispatch.mode !== "fresh") return { ok: false, reason: "plugin ledger changed since plan — retry the install" }
          const re = deps.installers.findPluginBaseConflictStrict(pinned)
          if (!re.ok) return re
          if (re.existing) return { ok: false, reason: `plugin base appeared in the ${re.existing.source} config since plan — retry the install` }
          const legacyRe = legacySameNamePluginGate(() => deps.installers.readLegacyPluginArrayStrict(), npmRoot, entry.name)
          if (!legacyRe.ok) return legacyRe
          const cur = deps.installers.readPluginArrayStrict()
          if (!cur.ok) return cur
          if (JSON.stringify(cur.value) !== npmCanon) return { ok: false, reason: "plugin config changed since plan — retry the install" }
          return { ok: true }
        },
        commitReceipt: (records: TxCommitRecord[]) => {
          const written = upsertRecordsV2(npmRoot, recoveryReceiptInputs(records))
          if (!written.ok) throw new Error(`plugin receipt commit failed: ${written.reason}`)
        },
      }
      const result = await runExtensionTransaction(npmRoot, plan, hooks)
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
        kind: "plugin",
        name: entry.name,
        manifestDigest,
        ...(result.warnings.length ? { warning: result.warnings.join("; ") } : {}),
      }
    }
    rollback("entry has no plugin package")
    return { ok: false, reason: "entry has no plugin package" }
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
    return {
      ok: true,
      kind: "skill",
      name: entry.name,
      ...(gen.files.length ? { files: gen.files } : {}),
      manifestDigest,
      ...(promoted.warnings.length ? { warning: promoted.warnings.join("; ") } : {}),
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
    // #361 裁决缺口 2(边界禁用):manifest SAFE_NAME 允许 "--",但事务 key 方案
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
    const prior = findRecordV2(cloudRoot, "cloud", entry.name)
    const plannedState: "enabled" | "disabled" = prior?.desiredState === "disabled" ? "disabled" : "enabled"
    const cloudNow = deps.now?.() ?? new Date().toISOString()
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
        return cloudDesiredStateGate(cloudRoot, entry.name, plannedState)
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
function agentFreshGate(root: string, name: string, configTarget: string, channel: "seed" | "catalog"): { ok: true } | { ok: false; reason: string } {
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

/** target 参数化的 strict plugin[] 读(#359 seed 路径专用 —— 不触 installers;语义对齐
 *  ext-config.readPluginArrayStrict,外加根形状 fail-closed)。 */
function readPluginArrayStrictAt(configTarget: string): { ok: true; value: unknown[] } | { ok: false; reason: string } {
  try {
    if (!fs.existsSync(configTarget)) return { ok: true, value: [] }
    const errors: ParseError[] = []
    const parsed: unknown = parse(fs.readFileSync(configTarget, "utf8"), errors)
    if (errors.length > 0) return { ok: false, reason: `config unparseable (${errors.length} syntax error(s)) — refusing (fail closed)` }
    if (parsed !== undefined && !isObj(parsed)) return { ok: false, reason: "config root is not an object — refusing (fail closed)" }
    const v = isObj(parsed) ? parsed.plugin : undefined
    if (v === undefined) return { ok: true, value: [] }
    if (!Array.isArray(v)) return { ok: false, reason: "config plugin key is not an array — refusing (fail closed)" }
    // #378 r4/r5:与 ext-config.readPluginArrayStrict 同判 —— 引擎合法成员 = string 或**恰**
    // [string, Record] 元组;元组不许误拒(假阳性回归),["x"]/["x", null] 等非法形状仍拒。
    const legalEntry = (x: unknown): boolean =>
      typeof x === "string" ||
      (Array.isArray(x) && x.length === 2 && typeof x[0] === "string" && !!x[1] && typeof x[1] === "object" && !Array.isArray(x[1]))
    if (!v.every(legalEntry))
      return { ok: false, reason: "config plugin[] contains invalid entries (neither string nor [spec, options]) — refusing (fix the config first)" }
    return { ok: true, value: v }
  } catch (error) {
    return { ok: false, reason: `config unreadable: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** mcp seed 的锁内门(#359 裁决 B/E):账本写前探测 + 版本门(kind 泛化,downgrade/不可比拒)+
 *  无账 config 叶拒认领 + 形状异常 fail-closed(根/mcp 段非对象 —— 合法 jsonc 也可能形状异常,
 *  与 agent 门同款,否则 jsonc modify 会在锁内抛异常)。 */
function mcpSeedGate(root: string, name: string, configTarget: string, seedVersion: string): { ok: true } | { ok: false; reason: string } {
  const ledgerProbe = probeLedgerForWrite(root)
  if (!ledgerProbe.ok) return { ok: false, reason: `refusing seed install: ${ledgerProbe.reason}` }
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

/** #359(合并前 review r1 结构性修正):plugin 载荷不再锁外 staging —— 每个载荷文件是同一事务里的
 *  **file action item**(#358 引擎:锁内前像、staging 0600、digest 校验、圈禁重验、原子 apply、
 *  崩溃恢复按 digest 判翻转、失据保留非终态),目录名 = 内容寻址 `plugins/<name>@<digest 前 16 hex>`
 *  (payloadDigest 剥 `sha256:` 前缀 —— review r1 Major:带前缀切片只剩 20 bit 且含 `:` 非法字符)。
 *  由此并发清理误删、tmp 孤儿、fsync 缺口、恢复前滚不验载荷四类问题在构造上不存在。 */
function seedPluginDirName(name: string, payloadDigest: string): string {
  const hex = payloadDigest.startsWith("sha256:") ? payloadDigest.slice("sha256:".length) : payloadDigest
  return `${name}@${hex.slice(0, 16)}`
}

/** 严格的 plugin 载荷 item key 形状(review r2 Minor:前后缀宽匹配会放行非法名/内嵌 "--" 的 key):
 *  plugin--<name>--f<i>,name 过 SAFE_NAME 且不含 "--"(与 installSeedPlugin 的名称拒绝对齐)。 */
function isSeedPluginItemKey(key: string): boolean {
  const m = /^plugin--(.+)--f\d+$/.exec(key)
  const name = m?.[1]
  return typeof name === "string" && SAFE_NAME.test(name) && !name.includes("--")
}

/** plugin 载荷 file item 的类型化探测(#359;对标 agentFileProbe 的 generic 形态):digest 走引擎
 *  透传的 journal 真源(fileDigest)。非本方案 key 的 file item = fail-closed 不健康(与 #358
 *  agentFileProbe 同纪律:file 消费方必须自带探针,绝不静默放行)。 */
export function seedPluginFileProbe(): HealthProbe {
  return (input) => {
    if (input.action !== "file") return { healthy: true }
    if (!isSeedPluginItemKey(input.key))
      return { healthy: false, reason: `no typed probe for file item "${input.key}" — refusing (fail closed)` }
    const p = input.phase === "pre-switch" ? input.stagedFile : input.fileTarget
    if (!p) return { healthy: false, reason: `plugin payload probe: path missing from probe input (${input.key})` }
    let data: Buffer
    try {
      data = fs.readFileSync(p)
    } catch {
      return { healthy: false, reason: `plugin payload file not readable (${input.key})` }
    }
    if (input.fileDigest && crypto.createHash("sha256").update(data).digest("hex") !== input.fileDigest)
      return { healthy: false, reason: `plugin payload digest mismatch (${input.key})` }
    return { healthy: true }
  }
}

/** 引擎单事务 64 item 上限 → 载荷文件 ≤63(+1 个 config item)。策展 seed 现实远小于此;
 *  超界 = 显式拒(诚实边界,与 seed 预算 maxFilesPerAsset=512 的差距在契约记录)。 */
const SEED_PLUGIN_MAX_FILES = 63

/** 载荷 file items 构造:逐 blob 从 CAS 读取重验(缺失/篡改 fail-closed),relTarget 圈禁交由
 *  引擎(isSafeRelPath + confineFileTarget 双位点)。capabilities/receipt 不挂载荷 item
 *  (逻辑主 item = config item,#358 单授权 key 纪律)。 */
function seedPluginPayloadItems(
  name: string,
  dirName: string,
  specs: TxFileSpec[],
  casBaseRoot: string,
  requireAbsent: boolean,
): { ok: true; items: TxPlanItem[] } | { ok: false; reason: string } {
  if (specs.length > SEED_PLUGIN_MAX_FILES)
    return { ok: false, reason: `seed plugin payload has ${specs.length} files > ${SEED_PLUGIN_MAX_FILES} (single-transaction item bound) — refused` }
  const items: TxPlanItem[] = []
  const folded = new Set<string>()
  for (const [i, fileSpec] of specs.entries()) {
    const relTarget = `plugins/${dirName}/${fileSpec.path}`
    // review r2 Minor:seed 合同允许 32 段/1024 字符,加两段前缀后要到引擎 validate 才被拒 ——
    // 这里显式前置(fail-closed 语义相同,边界错位收口 + 原因可读)。
    if (!isSafeRelPath(relTarget))
      return { ok: false, reason: `seed plugin payload path "${fileSpec.path}" exceeds installable bounds after "plugins/${dirName}/" prefixing — refused` }
    // review r2 Major:目标卷大小写/Unicode 折叠碰撞(portablePathKey 同引擎 promotion 纪律)——
    // 折叠后同一物理落点的两个清单项会互相覆盖却双双探测通过,清单歧义直接拒。
    const key = portablePathKey(relTarget)
    if (folded.has(key)) return { ok: false, reason: `seed plugin payload has case/Unicode-colliding paths (${fileSpec.path}) — refused` }
    folded.add(key)
    const blob = readCasBlobVerified(casBaseRoot, fileSpec.sha256)
    if (!blob.ok) return { ok: false, reason: `seed plugin content unavailable: ${blob.reason}` }
    if (fileSpec.size !== undefined && blob.data.length !== fileSpec.size)
      return { ok: false, reason: `seed plugin content size mismatch for ${fileSpec.path} — refused` }
    // requireAbsent(r3 Major):fresh 与异 payload replace 的目标必须缺席 —— 引擎锁内 file
    // prepare 断言(前像在场即结构化拒),把「未策展不认领」钉进执行层。
    items.push({ key: `plugin--${name}--f${i}`, action: "file", file: { relTarget, next: blob.data, requireAbsent } })
  }
  return { ok: true, items }
}

/** seed plugin 目录的严格实物校验(review r2 Major + r3 收紧):根与逐条目 **lstat**(Dirent 不可
 *  信赖竞态;根是 symlink 直接不健康)、confineFileTarget 圈禁、结构精确(缺/多/哈希不符即不健康)。
 *  不健康 ≠ 拒装 —— 调用方按「修复路径」走完整 journaled replace 重写清单文件。 */
type SeedPluginDirClass =
  /** 结构与逐文件 hash 精确一致。 */
  | { cls: "healthy" }
  /** 只差清单内文件(缺失/哈希不符)或整目录缺席 —— journaled replace 重写清单文件即可收敛。 */
  | { cls: "repairable"; reason: string }
  /** 清单外文件/symlink/不可读/圈禁不过 —— 修复不可收敛(review r4 Major:repair 只写清单文件,
   *  留着清单外内容会「落账成功但永不 healthy」),必须人工核对后删除重试。 */
  | { cls: "blocked"; reason: string }

/** 无断言 errno 提取(cast-free)。 */
function errnoCodeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined
  return typeof error.code === "string" ? error.code : undefined
}

/** 最终组件 O_NOFOLLOW 读(review r5 Major:lstat→read 的路径级窗口 —— 判定后被换成 symlink
 *  时绝不沿新 symlink 读树外内容;fd 上 fstat 再验常规文件)。win32 无 O_NOFOLLOW 时退化为
 *  普通打开(该平台 symlink 需特权,残余面契约记录)。 */
function readFileNoFollowSync(p: string): Buffer {
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0
  const fd = fs.openSync(p, fs.constants.O_RDONLY | noFollow)
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error("not a regular file")
    return fs.readFileSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

function classifySeedPluginDir(root: string, relDir: string, specs: TxFileSpec[]): SeedPluginDirClass {
  if (!isSafeRelPath(relDir) || !confineFileTarget(root, relDir).ok) return { cls: "blocked", reason: "dir confinement failed" }
  const dir = path.join(root, relDir)
  try {
    const st = fs.lstatSync(dir)
    if (st.isSymbolicLink() || !st.isDirectory()) return { cls: "blocked", reason: "dir is not a regular directory" }
  } catch (error) {
    // review r5 Major:只有 ENOENT 才是「目录缺席 = 可修复重建」;权限/IO/形状错误一律 blocked。
    if (errnoCodeOf(error) === "ENOENT") return { cls: "repairable", reason: "dir missing" }
    return { cls: "blocked", reason: `dir unreadable: ${error instanceof Error ? error.message : String(error)}` }
  }
  const expected = new Map(specs.map((f) => [f.path, f]))
  const seen = new Set<string>()
  let repairReason: string | null = null
  const walk = (rel: string): SeedPluginDirClass | null => {
    const abs = rel ? path.join(dir, rel) : dir
    let names: string[]
    try {
      names = fs.readdirSync(abs)
    } catch (error) {
      return { cls: "blocked", reason: error instanceof Error ? error.message : "unreadable dir" }
    }
    for (const name of names) {
      const childRel = rel ? `${rel}/${name}` : name
      const childAbs = path.join(dir, childRel)
      let st: fs.Stats
      try {
        st = fs.lstatSync(childAbs) // 逐条目 lstat(r3:不信 Dirent,拒竞态换入的 symlink)
      } catch {
        return { cls: "blocked", reason: `unreadable entry: ${childRel}` }
      }
      if (st.isSymbolicLink()) return { cls: "blocked", reason: `symlink present: ${childRel}` }
      if (st.isDirectory()) {
        // review r5 Major:清单期望文件、现场是同名目录 —— prepareFileTx 无法把目录覆盖成
        // 文件,repair 不可收敛,必须 blocked(此前会被当 missing 判 repairable 死循环)。
        if (expected.has(childRel)) return { cls: "blocked", reason: `expected file is a directory: ${childRel}` }
        const verdict = walk(childRel)
        if (verdict) return verdict
      } else if (st.isFile()) {
        const fileSpec = expected.get(childRel)
        if (!fileSpec) return { cls: "blocked", reason: `unexpected file: ${childRel}` }
        try {
          // O_NOFOLLOW 读(r5:lstat 判定后被换 symlink 时拒读,不沿 symlink 出树)。
          if (crypto.createHash("sha256").update(readFileNoFollowSync(childAbs)).digest("hex") !== fileSpec.sha256)
            repairReason = repairReason ?? `sha256 mismatch: ${childRel}`
        } catch {
          return { cls: "blocked", reason: `unreadable file: ${childRel}` }
        }
        seen.add(childRel)
      } else {
        return { cls: "blocked", reason: `unsupported entry: ${childRel}` }
      }
    }
    return null
  }
  const verdict = walk("")
  if (verdict) return verdict
  for (const p of expected.keys()) if (!seen.has(p)) repairReason = repairReason ?? `missing expected file: ${p}`
  return repairReason ? { cls: "repairable", reason: repairReason } : { cls: "healthy" }
}

/** 严格实物校验(healthy ⇔ classify 判 healthy;签名保留供幂等早退)。 */
function verifySeedPluginDirExact(root: string, relDir: string, specs: TxFileSpec[]): { ok: true } | { ok: false; reason: string } {
  const c = classifySeedPluginDir(root, relDir, specs)
  return c.cls === "healthy" ? { ok: true } : { ok: false, reason: c.reason }
}

/** #378 r15/r16(Major):catalog vendored 同版本幂等早退的严格实物校验 —— 与 seed 同一契约:
 *  期望载荷逐文件字节等值 + 零多余条目(文件**与目录**)+ 零 symlink/非常规文件;任何偏差
 *  (截断/篡改/缺文件/夹带)= 不健康,早退失效走修复(staging + 完整 replace)。任何读失败
 *  一律不健康(fail closed)。r16:根目录本身 lstat 圈禁(整目录被换成指向外部等值内容的
 *  symlink 时不得判健康 —— 否则活体继续从不受控外部路径执行);文件读取走 O_NOFOLLOW fd
 *  (lstat→read 窗口内 file→symlink 调包不可乘)。 */
function verifyVendoredPluginDirExact(dir: string, files: Array<{ path: string; data: Buffer }>): { ok: true } | { ok: false; reason: string } {
  const expected = new Map(files.map((f) => [f.path, f.data]))
  const expectedDirs = new Set<string>()
  for (const p of expected.keys()) {
    const segs = p.split("/")
    for (let i = 1; i < segs.length; i++) expectedDirs.add(segs.slice(0, i).join("/"))
  }
  // r18:目录**身份**钉住(dev+ino)—— 终态复验若只验「仍是真实目录」,被换成另一棵真实目录树
  // 依旧漏判;首访身份与终态身份必须同一 inode。
  const visitedDirs: Array<{ rel: string; dev: number; ino: number }> = []
  try {
    const rootSt = fs.lstatSync(dir)
    if (rootSt.isSymbolicLink() || !rootSt.isDirectory()) return { ok: false, reason: "plugin dir is not a real directory (symlink swap?)" }
    visitedDirs.push({ rel: "", dev: rootSt.dev, ino: rootSt.ino })
  } catch {
    return { ok: false, reason: "plugin dir unstatable" }
  }
  // r18:定长读 + 增长探测 —— fstat 后 inode 仍可增长,readFileSync(fd) 会按当前大小无界分配;
  // 只读期望字节数,读毕再探 1 字节,有余量 = 文件在变,拒。
  const readFdBounded = (fd: number, size: number): Buffer | null => {
    const buf = Buffer.alloc(size)
    let off = 0
    while (off < size) {
      const n = fs.readSync(fd, buf, off, size - off, off)
      if (n <= 0) return null
      off += n
    }
    const probe = Buffer.alloc(1)
    return fs.readSync(fd, probe, 0, 1, size) > 0 ? null : buf
  }
  const readRegularNoFollow = (abs: string, wantBytes: number): Buffer | null => {
    let fd: number
    try {
      fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    } catch {
      return null
    }
    try {
      const st = fs.fstatSync(fd)
      // r17 Major:尺寸前置 —— 期望路径被放超大常规文件时不得无界读入内存(先判不等即拒)。
      if (!st.isFile() || st.size !== wantBytes) return null
      return readFdBounded(fd, wantBytes)
    } catch {
      return null
    } finally {
      fs.closeSync(fd)
    }
  }
  const seen = new Set<string>()
  const walk = (rel: string): string | null => {
    let names: string[]
    try {
      names = fs.readdirSync(rel === "" ? dir : path.join(dir, rel))
    } catch {
      return `unreadable dir: ${rel === "" ? "." : rel}`
    }
    for (const name of names) {
      const childRel = rel === "" ? name : `${rel}/${name}`
      let st: fs.Stats
      try {
        st = fs.lstatSync(path.join(dir, childRel))
      } catch {
        return `unstatable entry: ${childRel}`
      }
      if (st.isDirectory()) {
        if (!expectedDirs.has(childRel)) return `unexpected directory: ${childRel}`
        visitedDirs.push({ rel: childRel, dev: st.dev, ino: st.ino })
        const verdict = walk(childRel)
        if (verdict !== null) return verdict
        continue
      }
      if (!st.isFile()) return `non-regular entry: ${childRel}`
      const want = expected.get(childRel)
      if (want === undefined) return `unexpected file: ${childRel}`
      const got = readRegularNoFollow(path.join(dir, childRel), want.length)
      if (got === null) return `unreadable/oversized file (symlink swap?): ${childRel}`
      if (!got.equals(want)) return `content mismatch: ${childRel}`
      seen.add(childRel)
    }
    return null
  }
  const verdict = walk("")
  if (verdict !== null) return { ok: false, reason: verdict }
  for (const p of expected.keys()) if (!seen.has(p)) return { ok: false, reason: `missing expected file: ${p}` }
  // r17/r18 Major:祖先目录 TOCTOU 终态复验 —— readdir 按路径进行,根/中间目录在 lstat 后被换
  // 会让整个校验「看别人的树」。走完后逐个重验访问过的目录**同一 inode**(dev+ino;r18:换成
  // 另一棵真实目录树同样捕获):持续存在的调包必被捕获;瞬时换回 = 盘上留下的是首访那棵合法树。
  for (const d of visitedDirs) {
    try {
      const st = fs.lstatSync(d.rel === "" ? dir : path.join(dir, d.rel))
      if (st.isSymbolicLink() || !st.isDirectory() || st.dev !== d.dev || st.ino !== d.ino)
        return { ok: false, reason: `directory swapped during verification: ${d.rel === "" ? "." : d.rel}` }
    } catch {
      return { ok: false, reason: `directory unstatable after walk: ${d.rel === "" ? "." : d.rel}` }
    }
  }
  return { ok: true }
}

/** seed 安装目标目录的「在场阻断」判定(review r3 Major 4:recovery 回滚只 unlink 文件,遗留的
 *  空壳目录不得永久卡死重试):缺席 = 不阻断;symlink/非目录 = 阻断;目录 = 深扫(逐条目 lstat),
 *  任一文件或 symlink 在场即阻断,**纯空目录树 = 不阻断**(引擎 apply 会原样写入其中)。 */
function seedDirBlocksInstall(root: string, relDir: string): boolean {
  if (!isSafeRelPath(relDir) || !confineFileTarget(root, relDir).ok) return true // 圈禁不过 = 阻断
  const dir = path.join(root, relDir)
  let st: fs.Stats
  try {
    st = fs.lstatSync(dir)
  } catch {
    return false // 缺席 = 不阻断
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return true
  const walk = (abs: string): boolean => {
    let names: string[]
    try {
      names = fs.readdirSync(abs)
    } catch {
      return true // 不可读 = 阻断(fail closed)
    }
    for (const name of names) {
      let child: fs.Stats
      try {
        child = fs.lstatSync(path.join(abs, name))
      } catch {
        return true
      }
      if (child.isDirectory()) {
        if (walk(path.join(abs, name))) return true
      } else {
        return true // 文件/symlink/其它 = 阻断
      }
    }
    return false
  }
  return walk(dir)
}

/** replace 提交成功后的旧目录 GC(review r2 Blocker + r3 收紧):
 *  · 重新持 bundle 锁 → 锁内重读引用(跨事务 ABA:另一事务可能已把同 payload 目录重新引用);
 *  · 引用扫描 fail-closed(r3 Major):先 probeLedgerForWrite(损坏账本 = 保留,绝不把「读不出
 *    记录」当「无引用」),再扫**全账本** records 与 v1Only 的 configKey/files(不限同名记录),
 *    加 config plugin[] 全元素;
 *  · 删除前真实圈禁(r3 Blocker):词法父目录/basename 之外,confineFileTarget 逐段 lstat 拒
 *    symlink 祖先 + confinedExistingPath realpath 容器重验(与引擎 removeDirGuarded 同原语;
 *    residual = 单次 lstat→rm 的微秒级窗口,与 GC promote 窗口同类)。
 *  锁忙/引用/圈禁不过/账本失据 = 保留(孤儿有 runbook 处置)。 */
export function gcVendoredPluginDirLocked(
  root: string,
  name: string,
  oldDir: string,
  readPluginArray: () => { ok: true; value: unknown[] } | { ok: false; reason: string },
  // #378 r6/r7 Blocker:引擎合并全部 legacy 源(XDG + retained home)plugin[] —— 引用对账必须
  // 逐源覆盖,否则任一 legacy 源仍引用的旧目录被当孤儿递归删除(下一次加载即悬空)。
  readLegacyPluginArray: () => { ok: true; sources: Array<{ value: unknown[]; configDir: string }> } | { ok: false; reason: string },
): { removed: boolean; warning?: string } {
  const pluginsRoot = path.join(root, "plugins")
  const dirBase = path.basename(oldDir)
  if (path.dirname(oldDir) !== pluginsRoot || !(dirBase === name || dirBase.startsWith(`${name}@`)))
    return { removed: false, warning: `old plugin dir "${oldDir}" outside confinement — retained` }
  const acquired = tryAcquireBundleLock(root, { txId: `tx-plugingc-${crypto.randomBytes(4).toString("hex")}` })
  if (!acquired.ok) return { removed: false, warning: `old plugin dir retained (bundle lock busy) — orphan without config reference, see runbook` }
  try {
    const cfg = readPluginArray()
    if (!cfg.ok) return { removed: false, warning: `old plugin dir retained (config unreadable: ${cfg.reason})` }
    // r5 Blocker:引用扫描按引擎语义解析(元组 spec 头/相对/file://)—— 词法「绝对字符串前缀」
    // 会漏等价形态,把 live config 仍引用的旧目录当孤儿递归删除(插件启动即失败)。
    const oldDirResolved = path.resolve(oldDir)
    // r13 Major:引用可能经 symlink 别名指向旧目录 —— 词法前缀之外补 realpath 身份比较。
    // r15 Major:非缺席类 realpath 失败 = 身份不可判,视为仍被引用(保留目录),不得静默回退词法。
    const oldDirIdent = pathIdentity(oldDirResolved)
    const refsDirFrom = (baseDir: string) => (x: unknown): boolean => {
      const resolved = resolvePluginEntryPath(x, baseDir)
      if (resolved === null) return false
      const ident = pathIdentity(resolved)
      if (!oldDirIdent.certain || !ident.certain) return true
      return ident.forms.some((f) => oldDirIdent.forms.some((o) => f === o || f.startsWith(o + path.sep)))
    }
    const refsDir = refsDirFrom(root)
    if (cfg.value.some(refsDir)) return { removed: false, warning: "old plugin dir re-referenced by config — retained (concurrent update)" }
    // r6/r7 Blocker:全部 legacy 源逐一同判;不可读/形状非法 = 无法证明无引用 = 保留(fail-closed)。
    const legacy = readLegacyPluginArray()
    if (!legacy.ok) return { removed: false, warning: `old plugin dir retained (legacy config not provably reference-free: ${legacy.reason})` }
    for (const src of legacy.sources) {
      if (src.value.some(refsDirFrom(src.configDir)))
        return { removed: false, warning: "old plugin dir re-referenced by a legacy config source — retained" }
    }
    // 账本引用 fail-closed:损坏账本 = 无法证明无引用 = 保留。
    const ledgerProbe = probeLedgerForWrite(root)
    if (!ledgerProbe.ok) return { removed: false, warning: `old plugin dir retained (ledger not provably reference-free: ${ledgerProbe.reason})` }
    const ledger = readLedgerV2(root)
    // review r4 Major:合法 JSON 里严格解码失败的记录会被过滤进 warnings —— 「读不出的记录」
    // 同样无法证明不含引用,任何 warning 在场即保留。
    if (ledger.warnings.length > 0)
      return { removed: false, warning: `old plugin dir retained (ledger contains undecodable entries: ${ledger.warnings[0]})` }
    const keyRefs = (configKey: string | undefined, files: string[] | undefined): boolean => {
      if (configKey?.startsWith("plugin-path:") && refsDir(path.resolve(configKey.slice("plugin-path:".length)))) return true
      return (files ?? []).some(refsDir)
    }
    if (ledger.records.some((r) => keyRefs(r.configKey, r.files)) || ledger.v1Only.some((r) => keyRefs(r.configKey, r.files)))
      return { removed: false, warning: "old plugin dir re-referenced by ledger — retained (concurrent update)" }
    // 真实圈禁重验后才删(rmSync 前紧邻)。
    const relOld = `plugins/${dirBase}`
    if (!confineFileTarget(root, relOld).ok || !confinedExistingPath(root, oldDir))
      return { removed: false, warning: `old plugin dir "${oldDir}" failed real-path confinement — retained` }
    try {
      fs.rmSync(oldDir, { recursive: true, force: true })
      return { removed: true }
    } catch (error) {
      return { removed: false, warning: `old plugin dir not removed (${error instanceof Error ? error.message : String(error)}) — orphan without config reference` }
    }
  } finally {
    acquired.lock.release()
  }
}

/** 失败路径的空壳目录清理(review r2 Blocker 收紧):
 *  1. 只在事务 journal 已终态 **rolled-back** 时运行 —— retained 非终态的现场是证据,一动不动;
 *  2. 圈禁:目标必须过 confineFileTarget(逐段 lstat 拒 symlink 祖先),遍历用 lstat、
 *     symlink 条目既不递归也不删 —— 绝不沿并发换入的 symlink 越出 root;
 *  3. 只 rmdir 空目录(引擎回滚已逐文件恢复缺席态;含文件的目录保留)。 */
function removeEmptyDirTreeConfined(root: string, relDir: string, txId: string | undefined): void {
  if (!txId) return
  const journal = readTransactionJournal(root, txId)
  if (journal?.state !== "rolled-back") return // aborted/authorize 未建目录;retained 现场不碰
  if (!isSafeRelPath(relDir) || !confineFileTarget(root, relDir).ok) return
  // r3 Blocker 收紧:两阶段 —— ①整树预扫(逐条目 lstat;发现任何 symlink/文件/不可读 = 整棵
  // 零修改放弃,不存在「先删兄弟再发现 symlink」);②确认纯空目录树后,自底向上 rmdir
  // (rmdir 对最终组件不跟随 symlink,检查后被换入 symlink 只会 ENOTDIR 失败,无越界删除面)。
  const base = path.join(root, relDir)
  const dirs: string[] = []
  const scan = (abs: string): boolean => {
    let st: fs.Stats
    try {
      st = fs.lstatSync(abs)
    } catch {
      return false // 缺席 = 无事可清(顶层);中途缺席 = 竞态,放弃
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return false
    let names: string[]
    try {
      names = fs.readdirSync(abs)
    } catch {
      return false
    }
    for (const name of names) {
      let child: fs.Stats
      try {
        child = fs.lstatSync(path.join(abs, name))
      } catch {
        return false
      }
      if (!child.isDirectory()) return false // 文件/symlink/其它 = 整棵放弃
      if (!scan(path.join(abs, name))) return false
    }
    dirs.push(abs) // 后序入栈 = 自底向上删除序
    return true
  }
  if (!fs.existsSync(base)) return
  if (!scan(base)) return
  for (const d of dirs) {
    try {
      fs.rmdirSync(d) // 只在空时成功;symlink 目标 ENOTDIR 失败 = 安全
    } catch {
      /* 竞态非空 = 保留 */
    }
  }
}

/** 双真源交叉验证(Codex 裁决 C,#317 AC2):seed lock 权威「离线字节」,bundled entry 权威安装语义;
 *  id/type/version/逐文件 path+sha256+bytes/聚合 digest 任一不合 = 漂移,返回原因(调用方 fail-closed)。 */
function crossCheckSeedAssetAgainstEntry(asset: SeedAsset, entry: CatalogEntry): string | null {
  if (entry.id !== asset.id) return `entry id ${entry.id} ≠ asset id ${asset.id}`
  if (entry.type !== asset.type) return `entry type ${entry.type} ≠ asset type ${asset.type}`
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

/**
 * 选中 seed 资产安装(REQ-102 #317):严格意图 → 随包 seed 读取 → 回表同包 bundled catalog(绝不
 * 用 effective remote/cache)→ 双真源交叉验证 → blob 提升进共享 CAS → generation 事务从 CAS 物化
 * (populateFromCas)。skill-only + global-only 首期(agent → #358,mcp/plugin → #359);不 pin
 * (generation content rehash 即 GC mark root);已装更高/不可比版本 fail-closed 拒(downgrade 无
 * 偶然通道)。互斥:CAS promotion 在事务锁前(不可变、幂等、同 digest 原子写);写互斥由
 * runExtensionTransaction 的引擎锁承担 —— 此处不得先拿 bundle 锁(非重入会自锁)。
 */
async function installSeedAsset(intent: SeedInstallIntent, deps: PlannerDeps): Promise<CatalogInstallOutcome> {
  if (intent.scope.scope !== "global")
    return { ok: false, reason: "seed install is global-only in this phase (project generation lifecycle is not closed yet) — refused" }
  const seedDeps = deps.seed
  if (!seedDeps) return { ok: false, reason: "seed install channel not available" }
  const seedDir = seedDeps.seedDir()
  if (!seedDir) return { ok: false, reason: "no packaged seed available" }

  const read = readPackagedSeed(seedDir)
  if (!read.ok) return { ok: false, reason: `packaged seed rejected (fail closed): ${read.error}` }
  const view = read.seed
  const asset = view.assets.find((a) => a.id === intent.assetId)
  if (!asset) return { ok: false, reason: `asset not in packaged seed: ${intent.assetId}` }
  if (asset.type !== "skill" && asset.type !== "agent" && asset.type !== "mcp" && asset.type !== "plugin")
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
  // #315:seed(离线随包)激活同样过闸(office 静态基线 + 已验公示若在场)。
  const seedAdv = deps.advisoryGate(advisoryInputOf(entry, "seed"))
  if (!seedAdv.allowed) return { ok: false, reason: `advisory ${seedAdv.advisoryId}: ${seedAdv.reason} — activation refused (R14)` }

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

  const tx = (deps.transaction ?? passthroughTx).begin({ op: "install", kind: entry.type, name: entry.name, scope: "global", manifestDigest })
  const rollback = (reason: string): void => (deps.transaction ?? passthroughTx).rollback(tx.txId, reason)

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
    const configTarget = path.join(deps.globalRoot(), "alpha.jsonc")
    const agentGen = await installAgentFromCas(deps.globalRoot(), {
      name: entry.name,
      id: entry.id,
      environment: deps.environment(),
      scope: { kind: "global" },
      origin: "catalog",
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

  // ── mcp / plugin seed(REQ-102 #359,2026-07-16 Codex 裁决,见 issue 评论)────────────────────
  if (asset.type === "mcp")
    return installSeedMcp({ deps, entry, manifest, manifestDigest, payloadDigest, intent, rollback, txId: tx.txId })
  if (asset.type === "plugin")
    return installPluginFromCas({
      deps,
      entry,
      manifest,
      manifestDigest,
      payloadDigest,
      promotedSpecs: promoted.files,
      casBaseRoot,
      auth: intent.authorization ? { authorization: intent.authorization } : {},
      rollback,
      txId: tx.txId,
    })

  // downgrade 门作为锁内 precondition:持 Bundle 锁后、写盘前重读账本判定(同版本重装 = 幂等允许,
  // generation 追加可回滚)。锁外判定有确定 TOCTOU(并发 catalog 安装可在窗口内提交更高版本)。
  const gen = await installSkillGeneration(deps.globalRoot(), {
    name: entry.name,
    id: entry.id,
    environment: deps.environment(),
    scope: { kind: "global" },
    origin: "catalog",
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
  return { ok: true, kind: "skill", name: entry.name, ...(gen.files.length ? { files: gen.files } : {}), manifestDigest }
}

/**
 * mcp seed 安装(REQ-102 #359):config action 单事务 —— 安装语义派生自 bundled entry 的
 * installSpec(CAS blob 只是离线携带字节,**不是运行载荷**:本通道只承诺「离线完成配置安装」,
 * local npm/uvx MCP 首次运行仍可能联网)。phase-1 fail-closed(裁决 Q1):seed intent 无 grants
 * 通道 —— 需密钥/workspace/Excel 的一律拒;纯 validator(validateServer)在 plan 生成前跑安全门
 * (ext-config-tx 只保证 JSONC/顶层键)。事务内绝不触 persistMcp/withConfigWriteLock(自锁)。
 */
async function installSeedMcp(args: {
  deps: PlannerDeps
  entry: CatalogEntry
  manifest: ExtensionManifestV2
  manifestDigest: string
  payloadDigest: string
  intent: SeedInstallIntent
  rollback: (reason: string) => void
  txId: string
}): Promise<CatalogInstallOutcome> {
  const { deps, entry, manifest, manifestDigest, payloadDigest, intent, rollback } = args
  const root = deps.globalRoot()
  const spec = entry.installSpec
  if (spec?.kind !== "mcp") {
    rollback("entry has no mcp installSpec")
    return { ok: false, reason: "entry has no mcp installSpec" }
  }
  // #378 r7 Major:真源路由门(seed MCP 同样只写 <root>/alpha.jsonc)。
  const seedMcpTruth = configTruthInRootGate(root, deps.installers.mcpConfigTruthPath())
  if (!seedMcpTruth.ok) {
    rollback(seedMcpTruth.reason)
    return seedMcpTruth
  }
  if ((spec.requiredEnvVars?.length ?? 0) > 0) {
    rollback("secret-bearing MCP")
    return { ok: false, reason: "secret-bearing MCP is not seed-installable (seed intent has no grants channel, phase 1) — refused" }
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
  const cmd = Array.isArray(derived.config.command) ? (derived.config.command as unknown[]) : []
  const touchesExcel = entry.name === "excel-mcp-server" || cmd.some((a) => typeof a === "string" && a.includes("excel-mcp-server"))
  if (touchesExcel) {
    rollback("Excel MCP")
    return { ok: false, reason: "Excel MCP is not seed-installable (REQ-105 managed workspace is outside the config-action boundary) — refused" }
  }
  // 纯 validator(裁决 B):命令头/inline-eval/URL/危险 env 安全门,零写盘。
  const valid = validateServer(derived.config)
  if (!valid.ok) {
    rollback(valid.reason)
    return { ok: false, reason: `seed MCP config failed validation: ${valid.reason} — refused` }
  }
  const configTarget = path.join(root, "alpha.jsonc")
  const now = deps.now?.() ?? new Date().toISOString()
  const receiptTemplate: UpsertInput = {
    id: entry.id,
    name: entry.name,
    kind: "mcp",
    environment: deps.environment(),
    scope: { kind: "global" },
    version: manifest.version,
    manifestDigest,
    payloadDigest,
    grantDigest: computeGrantDigest({}),
    desiredState: "enabled",
    origin: "catalog",
    configKey: `mcp.${entry.name}`,
    installedAt: now,
  }
  const plan: TxPlan = {
    items: [
      {
        key: `mcp--${entry.name}`,
        action: "config",
        config: { target: configTarget, edits: [{ keyPath: ["mcp", entry.name], value: derived.config }] },
        manifestDigest,
        capabilities: manifest.capabilities,
        receipt: receiptTemplate,
      },
    ],
    ...(intent.authorization ? { authorization: stampAuthorization(intent.authorization, () => deps.now?.() ?? new Date().toISOString())! } : {}),
  }
  const hooks: TxHooks = {
    populate: () => {}, // config action 无 staging 载荷
    precondition: () => mcpSeedGate(root, entry.name, configTarget, manifest.version),
    commitReceipt: (records: TxCommitRecord[]) => {
      const written = upsertRecordsV2(root, recoveryReceiptInputs(records))
      if (!written.ok) throw new Error(`seed mcp receipt commit failed: ${written.reason}`)
    },
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
  // liveMcp(裁决 B):renderer 据此 live sdk.mcp.add;seed 无密钥 → live = durable 原样。
  return { ok: true, kind: "mcp", name: entry.name, manifestDigest, liveMcp: { name: entry.name, config: derived.config } }
}

/**
 * CAS 载荷 plugin 安装(REQ-102 #359 seed 首建;#378 起 catalog vendored fresh 同一载体,Codex
 * 裁决 D2:constraints/探针/precondition 复用,不另建近似实现):CAS 字节 = 离线运行载荷,
 * **以 file items 进同一事务**(#358 引擎;不做锁外 staging)—— 目录 = 内容寻址
 * `plugins/<name>@<digest16>`,每个载荷文件一个 file item + config item 换/追加 plugin[] 元素,
 * 全提交或全回滚;崩溃恢复按 journal digest 判翻转 + seedPluginFileProbe 验载荷。
 * **接入 #352 三态**(裁决 Q4):absent → fresh;有效 catalog 旧账 → journaled replace
 * (replacePluginViaTransaction 的 seedPayload 挂点);v1-only/损坏/双键/漂移 → 拒;
 * same-version healthy 幂等早退;更高已装拒 downgrade。npm plugin 无 CAS 载荷,显式拒
 * (seed 裁决 E;catalog npm 走 config action 事务,在 installCatalog 分流)。
 */
async function installPluginFromCas(args: {
  deps: PlannerDeps
  entry: CatalogEntry
  manifest: ExtensionManifestV2
  manifestDigest: string
  payloadDigest: string
  promotedSpecs: TxFileSpec[]
  casBaseRoot: string
  /** grants(catalog 通道;seed 无 grants)+ authorize 重驱决定。 */
  auth: Pick<CatalogInstallIntent, "grants" | "authorization">
  rollback: (reason: string) => void
  txId: string
}): Promise<CatalogInstallOutcome> {
  const { deps, entry, manifest, manifestDigest, payloadDigest, auth, rollback } = args
  const root = deps.globalRoot()
  const spec = entry.installSpec as { kind?: string; package?: string; vendoredAssetKey?: string } | undefined
  if (spec?.kind !== "plugin") {
    rollback("entry has no plugin installSpec")
    return { ok: false, reason: "entry has no plugin installSpec" }
  }
  // 纯 npm(无 vendored 载荷)才拒 —— vendoredAssetKey 在场时 package 只是发行元数据,本通道
  // 装的是 CAS 载荷(catalog vendored entry 常两者并存)。
  if (typeof spec.package === "string" && spec.package && !spec.vendoredAssetKey) {
    rollback("npm plugin has no CAS payload")
    return { ok: false, reason: "npm plugin has no offline CAS payload — this channel installs vendored payloads only; refused" }
  }
  // 名称含 "--" 与 item key 方案(plugin--<name>[--f<i>])歧义 —— 与 agent 同款显式拒(#358 r2)。
  if (entry.name.includes("--")) {
    rollback("ambiguous plugin name")
    return { ok: false, reason: `plugin name "${entry.name}" contains "--" — ambiguous with the transaction key scheme (plugin--<name>--f<i>); refused` }
  }
  // r7 Major:真源路由门(catalog vendored 与 seed plugin 共用本载体,同拒)。
  const pluginTruth = configTruthInRootGate(root, deps.installers.mcpConfigTruthPath())
  if (!pluginTruth.ok) {
    rollback(pluginTruth.reason)
    return pluginTruth
  }
  if (!args.promotedSpecs.some((f) => f.path === "plugin.js")) {
    rollback("no plugin.js entrypoint")
    return { ok: false, reason: "seed plugin payload must include a top-level plugin.js entrypoint — refused" }
  }
  const dirName = seedPluginDirName(entry.name, payloadDigest)
  const dir = path.join(root, "plugins", dirName)
  const jsPath = path.join(dir, "plugin.js")
  const configTarget = path.join(root, "alpha.jsonc")
  const readPluginArray = () => readPluginArrayStrictAt(configTarget)
  // #352 三态分发(main 从自己账本裁决;refuse ≠ fresh,模糊态绝不当首装装)。
  const dispatch = resolvePluginDispatch(root, entry, spec, readPluginArray, () => deps.installers.readLegacyPluginArrayStrict())
  if (dispatch.mode === "refuse") {
    rollback(dispatch.reason)
    return { ok: false, reason: dispatch.reason }
  }
  // requireAbsent:fresh 与异 payload replace 的目标必须缺席;同 payload repair(dir===oldDir)
  // 前像 = 旧内容,合法覆盖(引擎 journaled)。
  const requireAbsent = dispatch.mode === "fresh" || (dispatch.facts.form.kind === "vendored" && dispatch.facts.form.oldDir !== dir)
  const payload = seedPluginPayloadItems(entry.name, dirName, args.promotedSpecs, args.casBaseRoot, requireAbsent)
  if (!payload.ok) {
    rollback(payload.reason)
    return { ok: false, reason: payload.reason }
  }
  if (dispatch.mode === "replace") {
    // 裁决 Q4:same-version healthy 由 replace 的幂等早退处理;更高已装拒 downgrade、不可比拒。
    // 并发漂移由 replace 事务的锁内 precondition(record generation/digest/desiredState 重读)兜底。
    const installedVersion = dispatch.facts.record.version
    if (installedVersion !== manifest.version) {
      if (installedVersion === undefined) {
        rollback("installed plugin has no recorded version")
        return { ok: false, reason: `installed plugin "${entry.name}" has no recorded version — not comparable to seed ${manifest.version}, refusing (fail closed)` }
      }
      const cmp = compareVersionsSafe(manifest.version, installedVersion)
      if (cmp === null) {
        rollback("version not comparable")
        return { ok: false, reason: `installed version ${installedVersion} not comparable to seed ${manifest.version} — refusing (no accidental downgrade channel)` }
      }
      if (cmp < 0) {
        rollback("downgrade refused")
        return { ok: false, reason: `installed version ${installedVersion} is newer than seed ${manifest.version} — refusing downgrade` }
      }
    }
    return replacePluginViaTransaction({
      deps,
      entry,
      manifest,
      manifestDigest,
      intent: auth,
      facts: dispatch.facts,
      rollback,
      txId: args.txId,
      seedPayload: { dir, dirRel: `plugins/${dirName}`, jsPath, items: payload.items, specs: args.promotedSpecs, probe: seedPluginFileProbe() },
      payloadDigest,
      readPluginArray,
    })
  }
  // fresh:无账在场一律拒(#354 未策展不认领)—— bare 目录与本通道的内容寻址目录都算在场
  // (fresh 时后者只可能是外部放置/历史残留,journaled 覆盖也不认领,review #383)。
  if (fs.existsSync(path.join(root, "plugins", entry.name))) {
    rollback("unregistered plugin dir present")
    return { ok: false, reason: `plugin dir "plugins/${entry.name}" exists without a ledger record — refusing to overwrite or adopt unregistered content` }
  }
  // r3 Major 4:壳容忍 —— recovery 回滚遗留的纯空目录树不阻断重试;文件/symlink 在场才是
  // 无账在场(拒不认领);preAbsent 的最终强制在引擎 requireAbsent 断言(锁内)。
  if (seedDirBlocksInstall(root, `plugins/${dirName}`)) {
    rollback("unregistered plugin dir present")
    return { ok: false, reason: `plugin dir "plugins/${dirName}" exists without a ledger record — refusing to overwrite or adopt unregistered content (remove it and retry)` }
  }
  const snapshot = readPluginArray()
  if (!snapshot.ok) {
    rollback(snapshot.reason)
    return snapshot
  }
  // r2 Major:同名派生路径全形态扫描(含其他 digest 的内容寻址目录)—— 不止本次 jsPath。
  const sameNameEntry = findSameNamePluginPathEntry(snapshot.value, root, entry.name)
  if (sameNameEntry) {
    rollback("unregistered plugin config present")
    return { ok: false, reason: `config already contains "${sameNameEntry}" without a ledger record — refusing to adopt or double-install an unregistered plugin` }
  }
  // r6 Major:legacy XDG 源同判(引擎合并两源;legacy 同名路径在场时 fresh 落账会双载)。
  const freshLegacyGate = legacySameNamePluginGate(() => deps.installers.readLegacyPluginArrayStrict(), root, entry.name)
  if (!freshLegacyGate.ok) {
    rollback("legacy plugin conflict")
    return freshLegacyGate
  }
  const nextArray = [...snapshot.value, jsPath]
  const snapshotCanon = JSON.stringify(snapshot.value)
  const now = deps.now?.() ?? new Date().toISOString()
  const receiptTemplate: UpsertInput = {
    id: entry.id,
    name: entry.name,
    kind: "plugin",
    environment: deps.environment(),
    scope: { kind: "global" },
    version: manifest.version,
    manifestDigest,
    payloadDigest,
    grantDigest: computeGrantDigest(auth.grants ?? {}),
    desiredState: "enabled",
    origin: "catalog",
    files: [dir],
    configKey: `plugin-path:${jsPath}`,
    installedAt: now,
  }
  const plan: TxPlan = {
    items: [
      ...payload.items,
      {
        // 逻辑主 item:capabilities/receipt 只挂这里(一个扩展一个授权 key,账本单条)。
        key: `plugin--${entry.name}`,
        action: "config",
        config: { target: configTarget, edits: [{ keyPath: ["plugin"], value: nextArray }] },
        manifestDigest,
        capabilities: manifest.capabilities,
        receipt: receiptTemplate,
      },
    ],
    ...(auth.authorization ? { authorization: stampAuthorization(auth.authorization, () => deps.now?.() ?? new Date().toISOString())! } : {}),
  }
  const hooks: TxHooks = {
    populate: () => {}, // file/config 的 staging 由引擎适配器落
    probe: seedPluginFileProbe(),
    // 锁内前置(TOCTOU 钉死):三态判定**整体重跑**(review #383 Major:只重读当前名会漏
    // catalog id 的历史名/v1-only 兜底扫描)+ config 数组未漂移 + 在场目录重查。
    precondition: () => {
      const ledgerProbe = probeLedgerForWrite(root)
      if (!ledgerProbe.ok) return { ok: false, reason: `refusing plugin install: ${ledgerProbe.reason}` }
      const redispatch = resolvePluginDispatch(root, entry, spec, readPluginArray, () => deps.installers.readLegacyPluginArrayStrict())
      if (redispatch.mode !== "fresh") return { ok: false, reason: "plugin ledger changed since plan — retry the install" }
      const cur = readPluginArray()
      if (!cur.ok) return cur
      if (JSON.stringify(cur.value) !== snapshotCanon) return { ok: false, reason: "plugin config changed since plan — retry the install" }
      const legacyRe = legacySameNamePluginGate(() => deps.installers.readLegacyPluginArrayStrict(), root, entry.name) // r6
      if (!legacyRe.ok) return legacyRe
      if (fs.existsSync(path.join(root, "plugins", entry.name)) || seedDirBlocksInstall(root, `plugins/${dirName}`))
        return { ok: false, reason: `plugin dir appeared without a ledger record — refusing` }
      return { ok: true }
    },
    commitReceipt: (records: TxCommitRecord[]) => {
      const written = upsertRecordsV2(root, recoveryReceiptInputs(records))
      if (!written.ok) throw new Error(`plugin receipt commit failed: ${written.reason}`)
    },
  }
  const result = await runExtensionTransaction(root, plan, hooks)
  if (!result.ok) {
    // 只在 journal 终态 rolled-back 时收空壳目录(圈禁 + lstat;retained/symlink 一律不碰)。
    removeEmptyDirTreeConfined(root, `plugins/${dirName}`, result.txId)
    rollback(result.reason)
    if (result.stage === "authorize") {
      if (result.authorization) return { ok: false, stage: "authorize", reason: result.reason, authorization: result.authorization }
      return { ok: false, reason: result.reason }
    }
    return { ok: false, reason: result.reason, ...(result.stage ? { stage: result.stage } : {}) }
  }
  ;(deps.transaction ?? passthroughTx).commit(args.txId)
  return { ok: true, kind: "plugin", name: entry.name, manifestDigest, files: [dir] }
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
    ;(deps.transaction ?? passthroughTx).commit(tx.txId) // 外层通知钩子无副作用;真事务在引擎内
    const r = await uninstallExtensionTransaction(root, `mcp--${intent.name}`, {
      action: "config",
      removeArtifacts: () => {
        const cfg = deps.installers.removeMcpConfigInLock(intent.name)
        if (!cfg.ok) throw new Error(cfg.reason)
        const sec = deps.installers.removeMcpSecretsStrict(intent.name)
        if (!sec.ok) throw new Error(sec.reason)
        // #359:seed/bundle 事务安装过授权闸的 MCP,授权账随 artifact 一并清(失败抛错 →
        // journal 保持 uninstalling 前滚;恢复 seam 同步此语义)。
        const grants = removeInstallGrants(root, [`mcp--${intent.name}`])
        if (!grants.ok) throw new Error(grants.reason)
      },
      commitLedger: () => {
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
    const grants = removeInstallGrants(root, [`plugin--${intent.name}`])
    if (!grants.ok) {
      rollback(grants.reason)
      return { ok: false, reason: `plugin uninstall: ${grants.reason}` }
    }
    if (grants.removed.length) removedFiles = [...(removedFiles ?? []), ...grants.removed]
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
export function setInstallStateByKey(
  rawIntent: unknown,
  deps: Pick<PlannerDeps, "globalRoot" | "advisoryGate">,
): { ok: true } | { ok: false; reason: string } {
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
  const record = findRecordV2(root, intent.type, intent.name)
  if (!record) return { ok: false, reason: `no v2 record for ${intent.type}:${intent.name} in this scope — fail closed (v1-only installs have no desired-state channel)` }
  if (record.scope.kind === "project") {
    if (intent.scope !== "project") return { ok: false, reason: "fail closed: record is project-scoped but intent is global" }
    const verified = verifyProjectScope(record, intent.projectDir)
    if (!verified.ok) return verified
  }
  // #315:「禁止再启用」的核心位点 —— disabled→enabled 过闸(catalog 来源要求新鲜公示;
  // created/imported 来源按离线基线,catalogId 命中仍拦)。
  if (intent.state === "enabled") {
    const adv = deps.advisoryGate({
      catalogId: record.id,
      name: record.name,
      payloadDigest: record.payloadDigest,
      provenance: record.origin === "catalog" ? "cache" : "bundled",
    })
    if (!adv.allowed) return { ok: false, reason: `advisory ${adv.advisoryId}: ${adv.reason} — re-enable refused (R14)` }
  }
  return setDesiredStateV2(root, intent.type, intent.name, intent.state)
}
