// ext-agent-install — REQ-102 #358:把 agent seed 安装路由进事务引擎(file + config 双 item 单事务)。
//
// 背景:agent 的物理形态 = `<root>/agents/<name>.md`(内容真源)+ alpha.jsonc `agent.<name>` 条目
// (引擎生效面),既非文件树 generation 也非纯配置叶。旧路径 writeAgent 用进程内手工前像补偿
// (md→config→receipt 三步间有失败窗口),且绕过 #348 授权闸 —— Codex 裁决 #358 P2 否决。本模块
// 把 agent seed 收敛成一次 runExtensionTransaction:
//   item1(逻辑主 item):action="file" 写 md(ext-file-tx journaled 原子替换),capabilities +
//     receipt 模板只挂这里(一个逻辑扩展一个授权 key,不弹两次;receipt 单条);
//   item2:action="config" 写 `agent.<name>` 叶(ext-config-tx;与 md 同事务全提交或全回滚)。
// 内容转换必须复用 agentMdToEntry(裁决 C:不得另写宽松 frontmatter 解析器);内容字节 = CAS blob
// 原样(byte-exact,与 seed 清单 digest 一致,不做行尾归一)。

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { parse, type ParseError } from "jsonc-parser"
import type { AppEnvironment } from "./alpha-environment"
import type { InstallReceiptOrigin } from "../preload/types"
import { agentMdToEntry } from "./agent-md-entry"
import { readCasBlobVerified } from "./ext-cas"
import type { CapabilityDiff } from "./ext-capability-grants"
import { commitInputFromRecord } from "./ext-skill-generations"
import { upsertRecordsV2, type ScopeIdentity, type UpsertInput } from "./ext-receipt-v2"
import {
  runExtensionTransaction,
  type HealthProbe,
  type TxAuthorizationDecision,
  type TxCommitRecord,
  type TxFileSpec,
  type TxHooks,
  type TxPlan,
  type TxStage,
} from "./ext-transaction"

const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
/** 装约定(与 installBuiltinAgent/installRemoteAgent 同款 256KB 帽)。 */
export const AGENT_MD_MAX_BYTES = 256 * 1024
/** 单顶层 .md(无目录分隔;装约定与 installRemoteAgent 一致)。 */
const TOP_LEVEL_MD_RE = /^[^/\\]+\.md$/

/** fs-safe 事务 key(授权账/journal/store 同键)。 */
export function agentInstallKey(name: string): string {
  return `agent--${name}`
}

/** config 副 item 的 key(同 plan 内唯一即可;无 capabilities、无 receipt —— 授权与账本都归主 item)。 */
export function agentConfigItemKey(name: string): string {
  return `agent--${name}--config`
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)

/** 结构化深比较(config 叶 vs 解析条目;JSONC 键序不定,不能靠 stringify)。 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]))
  }
  return false
}

/**
 * agent seed 的类型化健康探测(#358,对标 skillGenerationProbe;分相位,Codex 裁决 E):
 *   pre-switch  → staged candidate 语义健康(agentMdToEntry 可解析且与预期条目一致);
 *   post-switch / recovery → live md digest 与预期一致 + 可解析 + live `agent.<name>` 叶与解析
 *   结果严格一致(md/config 任一背离 = 不健康 → 回滚/隔离)。
 */
export function makeAgentSeedProbe(opts: {
  name: string
  configTarget: string
  expectedDigest: string
  expectedEntry: Record<string, unknown>
}): HealthProbe {
  return (input) => {
    if (input.action !== "file") return { healthy: true } // generation/config 由各自 probe 管
    const readMd = (p: string | undefined, label: string): { ok: true; text: string } | { ok: false; reason: string } => {
      if (!p) return { ok: false, reason: `agent "${opts.name}": ${label} path missing from probe input` }
      try {
        return { ok: true, text: readFileSync(p, "utf8") }
      } catch {
        return { ok: false, reason: `agent "${opts.name}": ${label} md not readable` }
      }
    }
    if (input.phase === "pre-switch") {
      const staged = readMd(input.stagedFile, "staged")
      if (!staged.ok) return { healthy: false, reason: staged.reason }
      const parsed = agentMdToEntry(staged.text)
      if (!parsed.ok) return { healthy: false, reason: `agent "${opts.name}": staged md not convertible: ${parsed.reason}` }
      if (!deepEqual(parsed.entry, opts.expectedEntry))
        return { healthy: false, reason: `agent "${opts.name}": staged md entry drifted from plan` }
      return { healthy: true }
    }
    // post-switch / recovery:验 live md + live config 叶。
    let data: Buffer
    try {
      data = readFileSync(input.fileTarget ?? "")
    } catch {
      return { healthy: false, reason: `agent "${opts.name}": live md not readable` }
    }
    const digest = createHash("sha256").update(data).digest("hex")
    if (digest !== opts.expectedDigest) return { healthy: false, reason: `agent "${opts.name}": live md digest mismatch` }
    const parsed = agentMdToEntry(data.toString("utf8"))
    if (!parsed.ok) return { healthy: false, reason: `agent "${opts.name}": live md not convertible: ${parsed.reason}` }
    let cfgText: string
    try {
      cfgText = readFileSync(opts.configTarget, "utf8")
    } catch {
      return { healthy: false, reason: `agent "${opts.name}": live config not readable` }
    }
    const errors: ParseError[] = []
    const cfg: unknown = parse(cfgText, errors)
    if (errors.length > 0) return { healthy: false, reason: `agent "${opts.name}": live config is not valid jsonc` }
    const agentMap = isObj(cfg) ? cfg.agent : undefined
    const leaf = isObj(agentMap) ? agentMap[opts.name] : undefined
    if (!deepEqual(leaf, parsed.entry))
      return { healthy: false, reason: `agent "${opts.name}": live config entry diverged from md (md/config must not fork)` }
    return { healthy: true }
  }
}

export type AgentSeedInstall = {
  name: string
  /** catalog entry id(agent:<name>)。 */
  id: string
  environment: AppEnvironment
  scope: ScopeIdentity
  origin: InstallReceiptOrigin
  /** 唯一内容源:CAS(调用方先 promote;此处读取重验,缺失/篡改 fail-closed)。恰一个顶层 .md。 */
  casFile: { spec: TxFileSpec; casBaseRoot: string }
  /** alpha.jsonc 绝对路径(调用方从受控根派生;`agent.<name>` 叶经 ext-config-tx 白名单)。 */
  configTarget: string
  /** #348:严格解码 manifest.capabilities(必填;空集也显式传,禁二次派生制造第二真源)。 */
  capabilities: string[]
  authorization?: TxAuthorizationDecision
  version?: string
  manifestDigest?: string
  payloadDigest?: string
  grantDigest?: string
  /** 锁内业务前置(fresh-only 门在此重读账本 + md/config 在场,封锁外 TOCTOU)。 */
  precondition?: () => { ok: true } | { ok: false; reason: string }
}

export type AgentSeedResult =
  | { ok: true; mdPath: string; files: string[] }
  | { ok: false; stage: "authorize"; reason: string; authorization: CapabilityDiff[] }
  | { ok: false; reason: string; stage?: Exclude<TxStage, "authorize"> }

/**
 * 把一个 agent seed 装进事务(file md + config 叶单事务;#348 授权闸在锁内)。commitReceipt 写失败
 * → 引擎回滚(md 恢复缺席/前像 + config 叶复原),receipt 与 live 永不背离(#354 同款 fail-closed)。
 */
export async function installAgentFromCas(root: string, spec: AgentSeedInstall): Promise<AgentSeedResult> {
  if (!SAFE_NAME.test(spec.name)) return { ok: false, reason: `invalid agent name: ${spec.name}` }
  // casFile 畸形(调用方绕类型)= 结构化拒绝,不抛未捕获异常(与 installSkillGeneration 同纪律)。
  const casFile: unknown = spec.casFile
  if (!isObj(casFile) || !isObj(casFile.spec) || typeof casFile.casBaseRoot !== "string" || !isAbsolute(casFile.casBaseRoot))
    return { ok: false, reason: "invalid casFile content source (spec + absolute casBaseRoot required)" }
  const fileSpec = spec.casFile.spec
  // 装约定(与既有 agent 安装器同款):恰一文件、顶层 .md、≤256KB。
  if (!TOP_LEVEL_MD_RE.test(fileSpec.path))
    return { ok: false, reason: `agent seed asset must be a single top-level .md file (got "${fileSpec.path}") — refused` }
  if (fileSpec.size !== undefined && fileSpec.size > AGENT_MD_MAX_BYTES) return { ok: false, reason: "agent md 过大 — refused" }
  const blob = readCasBlobVerified(spec.casFile.casBaseRoot, fileSpec.sha256)
  if (!blob.ok) return { ok: false, reason: `agent seed content unavailable: ${blob.reason}` }
  if (blob.data.length > AGENT_MD_MAX_BYTES) return { ok: false, reason: "agent md 过大 — refused" }
  if (fileSpec.size !== undefined && blob.data.length !== fileSpec.size)
    return { ok: false, reason: `agent seed content size mismatch for ${fileSpec.path} — refused` }
  // 内容转换单一真源:agentMdToEntry(fail-closed:解析不动即拒装,不装出字段静默丢失的 agent)。
  const parsed = agentMdToEntry(blob.data.toString("utf8"))
  if (!parsed.ok) return { ok: false, reason: `agent frontmatter not convertible: ${parsed.reason}` }

  const relTarget = `agents/${spec.name}.md`
  const mdPath = join(root, relTarget)
  const now = new Date().toISOString()
  const receiptTemplate: UpsertInput = {
    id: spec.id,
    name: spec.name,
    kind: "agent",
    environment: spec.environment,
    scope: spec.scope,
    ...(spec.version ? { version: spec.version } : {}),
    ...(spec.manifestDigest ? { manifestDigest: spec.manifestDigest } : {}),
    ...(spec.payloadDigest ? { payloadDigest: spec.payloadDigest } : {}),
    ...(spec.grantDigest ? { grantDigest: spec.grantDigest } : {}),
    desiredState: "enabled",
    origin: spec.origin,
    files: [mdPath],
    configKey: `agent.${spec.name}`,
    installedAt: now,
  }
  const plan: TxPlan = {
    items: [
      {
        key: agentInstallKey(spec.name),
        action: "file",
        file: { relTarget, next: blob.data },
        capabilities: spec.capabilities,
        receipt: receiptTemplate,
        ...(spec.manifestDigest ? { manifestDigest: spec.manifestDigest } : {}),
      },
      {
        // 副 item:无 capabilities(授权 key 归主 item,一个逻辑扩展只弹一次)、无 receipt(账本单条)。
        key: agentConfigItemKey(spec.name),
        action: "config",
        config: { target: spec.configTarget, edits: [{ keyPath: ["agent", spec.name], value: parsed.entry }] },
      },
    ],
    ...(spec.authorization ? { authorization: spec.authorization } : {}),
  }
  const hooks: TxHooks = {
    ...(spec.precondition ? { precondition: spec.precondition } : {}),
    populate: () => {}, // 无 generation item;file/config 的 staging 由引擎适配器落
    probe: makeAgentSeedProbe({
      name: spec.name,
      configTarget: spec.configTarget,
      expectedDigest: fileSpec.sha256,
      expectedEntry: parsed.entry,
    }),
    // 账本是事务提交证据(#336/#354):只有主 item 带 receipt,config 副 item 不落账。
    commitReceipt: (records: TxCommitRecord[]) => {
      const withReceipt = records.filter((rec) => rec.receipt !== undefined)
      const written = upsertRecordsV2(root, withReceipt.map((rec) => commitInputFromRecord(rec)))
      if (!written.ok) throw new Error(`receipt commit failed for agent ${spec.name}: ${written.reason}`)
    },
  }

  const result = await runExtensionTransaction(root, plan, hooks)
  if (!result.ok) {
    if (result.stage === "authorize") {
      if (result.authorization) return { ok: false, stage: "authorize", reason: result.reason, authorization: result.authorization }
      return { ok: false, reason: result.reason } // 引擎契约保证带 diff;缺失时诚实降级
    }
    return { ok: false, reason: result.reason, stage: result.stage }
  }
  return { ok: true, mdPath, files: [mdPath] }
}
