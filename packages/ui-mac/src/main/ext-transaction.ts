// REQ-100 (GitHub issue #192) —
// 扩展原子事务执行层:staging → 校验 → materialize generation → health probe → atomic switch →
// receipt commit,配套 transaction journal、崩溃恢复、rollback 与 quarantine。
//
// 不变量(AC1 的机器可验形态):**live generation 在任意崩溃点后要么是旧版完整内容、要么是新版
// 完整内容,绝无半装态**。达成机制:
//   · 一切写入先落 `<root>/ext-tx/staging/<txId>/`(与 store 同根 = 同卷),校验(逐文件 sha256 +
//     结构精确匹配 + 拒 symlink)通过前不碰任何 live 路径;
//   · generation 目录经单次 rename 原子出现;live 指针 = `current.json` 原子换名写
//     (tmp → fsync → rename,与 alpha-installs.writeLedger 同仓惯例 —— 本仓 materialization
//     的既有原子原语是 rename,不引入 symlink,呼应 ADR-019 全面零 symlink 的方向);
//   · 指针翻转前旧 generation 一直保留;journal 先记 intent(state=switching,含 previous
//     指针)再翻转 —— 崩溃恢复永远有据可依,且「撤销状态优先于 receipt」:journal 是权威,
//     receipt 只在 committed 后才写;
//   · 健康探测失败 / receipt commit 失败 / 恢复期健康未知 → 回旧 generation + 失败 generation
//     移入 quarantine(带 reason 收据),loud;
//   · 环境级 Bundle 锁(ext-bundle-lock)串行化并发事务(AC5),锁在模拟崩溃下不释放,
//     由陈旧恢复接管;
//   · GC 有界:每扩展默认保留 3 代(current + 前两个,AC4 离线回滚口径),删除受
//     realpath 圈禁 + 命名模式双守卫。
//
// root = 环境 mutable root(REQ-098 alpha-environment:prod/beta/dev 分域)。所有 API root
// 参数化 → 环境隔离天然成立(prod 事务不可能触碰 beta 根),单测零 mock(仓规:不用
// mock.module,可注入面走参数,html-preview-host DI 同款纪律)。
//
// REQ-099 接缝(另一 agent 并行实现 manifest/receipt v2 + planner;本文件不 import 其文件):
//   · 消费侧:TxPlan / TxPlanItem —— planner 产出「fs-safe key + 期望文件清单(相对路径 +
//     sha256 [+size])+ manifestDigest(此处不透明)」的结构化子集即可驱动本引擎;
//   · 暴露侧:hooks.commitReceipt(TxCommitRecord[])—— InstallRecordV2 写入方挂在这里,
//     **必须幂等(upsert)**(崩溃恢复会重放);generation 实际路径经
//     resolveLiveGenerationDir / listGenerations 提供,receipt 的 owned paths 由 planner
//     按受控根 + generation 重新派生。

import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import type { TxStageNonAuthorizeWire } from "../shared/ext-capability-authorization"
import {
  confinedExistingPath,
  fsyncDirTreeSync,
  fsyncFileSync,
  isSafeRelPath,
  renameAtomicSync,
  sha256FileSync,
  writeFileAtomicSync,
} from "./ext-atomic-fs"
import { tryAcquireBundleLock, type BundleLock } from "./ext-bundle-lock"
import {
  applyConfigImage,
  prepareConfigTx,
  readStagedConfigImage,
  restoreConfigImage,
  stageConfigImage,
  type ConfigEdit,
  type ConfigTxImage,
} from "./ext-config-tx"
import {
  applyFileImage,
  confineFileTarget,
  fileStagePaths,
  prepareFileTx,
  readStagedFileImage,
  restoreFileImage,
  stageFileImage,
  type FileTxImage,
} from "./ext-file-tx"
import {
  capabilityGrantPath,
  confirmationCovers,
  evaluateBundleAuthorization,
  isSafeCapability,
  writeCapabilityGrantSync,
  type CapabilityDiff,
} from "./ext-capability-grants"

// ── 类型(接缝定义,见文件头 REQ-099 段) ─────────────────────────────────────────────────────

export type TxFileSpec = { path: string; sha256: string; size?: number }

/** REQ-100 #311:action 判别式。缺省 "generation"(向后兼容:老 plan/journal 无此字段即文件树 generation)。
 *  - generation:文件树装进不可变 generation 目录 + current.json 指针翻转(skill 等)。
 *  - config:alpha.jsonc 叶/数组的 journaled 原子替换(mcp/plugin;走 ext-config-tx 适配器)。
 *  - file:根内单文件的 journaled 原子替换(agent md;走 ext-file-tx 适配器,REQ-102 #358)。
 *  - receipt:无 materialize/switch 副作用,只参加最终 receipt commit(cloud)。 */
export type TxActionKind = "generation" | "config" | "receipt" | "file"

/** config action 载荷:目标文件 + 有序 edit(同一 target 多条 edit 由适配器按序累积)。 */
export type TxConfigAction = { target: string; edits: ConfigEdit[] }

/** file action 载荷(REQ-102 #358):目标 = **root 内受控相对路径**(引擎自 root 派生绝对路径 ——
 *  调用方绝对路径无通道,Codex 裁决 #358 B 圈禁要求)+ 完整新内容字节。前像由引擎在锁内捕获。
 *  requireAbsent(#359 review r3):锁内前像必须缺席,否则结构化拒绝 —— 把 planner 的「未策展
 *  不认领」从锁外 existsSync 检查升级为执行引擎断言(检查与捕获之间被旁路建文件时,拒绝而不是
 *  带前像覆盖认领)。 */
export type TxFileAction = { relTarget: string; next: Buffer; requireAbsent?: boolean }

/** file action 内容上界(引擎级防线;业务上界如 agent 的 256KB 由 planner 把关)。 */
const FILE_ACTION_MAX_BYTES = 16 * 1024 * 1024

export type TxPlanItem = {
  /** fs-safe 扩展标识(planner 派生,如 "skill--foo";不含路径分隔符/冒号)。 */
  key: string
  /** action 类型;缺省 generation。 */
  action?: TxActionKind
  /** generation:期望载荷 = receipt 的 digest 集(结构精确匹配:缺一 / 多一 / 哈希不符均拒)。config/receipt 忽略。 */
  files?: TxFileSpec[]
  /** config action 的目标叶变更(action==="config" 必填)。 */
  config?: TxConfigAction
  /** file action 的目标文件变更(action==="file" 必填)。 */
  file?: TxFileAction
  /** REQ-099 manifest digest,本层不解释、只透传进 journal / commit record。 */
  manifestDigest?: string
  /**
   * manifest 声明的 capability 集(REQ-099 解码期白名单把关;本层视为不透明字符串集)。
   * 缺省按空集处理:committed 时授权账落空集,未来任何 capability 出现都构成扩张 → 必须确认。
   */
  capabilities?: string[]
  /** receipt 模板(不透明透传:本层不解释)。持久化进 journal + commit record,使崩溃恢复能自足
   *  前滚提交 receipt(REQ-100 #312:recovery 用同一 probe 判健康后落账,而非 health-by-assumption)。 */
  receipt?: unknown
}

/** 判别式取值(缺省 generation)。 */
export function actionOf(item: { action?: TxActionKind }): TxActionKind {
  return item.action ?? "generation"
}

/** 用户对完整新 capability 集的覆盖式确认(逐 item;展示什么确认什么,防 TOCTOU)。 */
export type TxAuthorizationDecision = {
  /** item key → 用户确认的完整 capability 集(须覆盖该 item 的请求集)。 */
  confirmed: Record<string, string[]>
  decidedAt?: string
}

/** Bundle 内被跳过的 optional child(AC2:跳过必须在授权与 receipt 中可见)。 */
export type TxSkippedOptional = { key: string; reason?: string }

export type TxPlan = {
  /** 可选调用方提供(须匹配 TX_ID 格式);缺省自动生成。 */
  txId?: string
  /** Bundle = 多 item 单事务:全部成功才 commit,任一 required child 失败 → current 全量不变(AC2)。 */
  items: TxPlanItem[]
  /** capability 扩张 / 首次授权时必须携带(一次展示、一次授权、一次 commit —— REQ-100 交付②)。 */
  authorization?: TxAuthorizationDecision
  /** planner 决定跳过的 optional child;进 journal + 授权收据,审计可见。 */
  skippedOptional?: TxSkippedOptional[]
}

export type HealthVerdict = { healthy: true } | { healthy: false; reason: string }
export type HealthProbePhase = "pre-switch" | "post-switch" | "recovery"
/** 类型化健康探测(REQ-100 #312):按 action + key 做 kind-appropriate 校验(如 skill 验 SKILL.md
 *  可发现/frontmatter name 匹配)。pre-switch 失败 → abort+隔离;post-switch/recovery 失败 → 回滚+隔离。 */
export type HealthProbe = (input: {
  key: string
  /** action 类型(缺省 generation);typed probe 据此 dispatch。 */
  action: TxActionKind
  genId: string
  generationDir: string
  phase: HealthProbePhase
  /** file action(#358):live 目标绝对路径(pre-switch 时尚未翻转;post-switch/recovery 为已落内容)。 */
  fileTarget?: string
  /** file action(#358):pre-switch 阶段的 staged next 内容路径(候选内容语义校验用)。 */
  stagedFile?: string
  /** file action(#358):journal 记录的 next 内容 digest —— generic recovery probe(无 planner
   *  闭包上下文)据此验 live/staged 内容一致性。 */
  fileDigest?: string
}) => HealthVerdict | Promise<HealthVerdict>

export type TxCommitRecord = {
  txId: string
  key: string
  /** action 类型(缺省 generation:向后兼容既有 receipt 消费方)。 */
  action?: TxActionKind
  /** generation:live 代号;config/receipt 缺省。 */
  generation?: string
  /** generation:live 目录;config/receipt 缺省。 */
  generationDir?: string
  previousGeneration?: string | null
  manifestDigest?: string
  /** generation:载荷 digest 集;config/receipt 缺省。 */
  files?: TxFileSpec[]
  /** config:目标文件(卸载/对账参考)。 */
  configTarget?: string
  /** file:目标文件绝对路径(卸载/对账参考;#358)。 */
  fileTarget?: string
  /** receipt 模板(不透明透传;commitReceipt 消费方据此落账,恢复前滚同源)。 */
  receipt?: unknown
  committedAt: string
}

export type TxLog = (event: string, detail: Record<string, unknown>) => void

/** 故障注入点(测试专用):到达该点即抛 ExtTxCrashError 且**不做任何清理、不释放锁**=模拟进程死亡。 */
export const TX_CRASH_POINTS = [
  "after-lock",
  "after-authorize",
  "after-journal",
  "mid-populate",
  "after-populate",
  "after-staged",
  "mid-materialize",
  "after-materialized",
  "after-pre-probe",
  "after-switching-journal",
  "mid-switch",
  "after-switched",
  "after-post-probe",
  "after-receipt-commit",
  "before-gc",
] as const
export type TxCrashPoint = (typeof TX_CRASH_POINTS)[number]

export class ExtTxCrashError extends Error {
  readonly point: TxCrashPoint
  constructor(point: TxCrashPoint) {
    super(`simulated crash at ${point}`)
    this.name = "ExtTxCrashError"
    this.point = point
  }
}

export type TxHooks = {
  /** 把 item 载荷写进 stagingDir(下载/解包/复制由调用方实现;本层只管事务语义)。 */
  populate: (item: TxPlanItem, stagingDir: string) => void | Promise<void>
  /** 类型化健康探测(可注入):pre-switch 失败 → abort+隔离(current 不动);post-switch 失败 → 回滚+隔离。 */
  probe?: HealthProbe
  /** 锁内业务前置(REQ-102 #317:如 downgrade 门):持 Bundle 锁后、任何写盘(journal/staging)前
   *  执行,失败 = 零副作用拒绝 —— 判定与并发提交串行化,封死锁外读账本的 TOCTOU。 */
  precondition?: () => { ok: true } | { ok: false; reason: string }
  /** receipt 提交接缝(REQ-099 InstallRecordV2 写入方)。必须幂等 upsert —— 恢复会重放。 */
  commitReceipt?: (records: TxCommitRecord[]) => void | Promise<void>
  log?: TxLog
  now?: () => Date
  /** 每扩展保留代数(含 current),默认 3(AC4:离线可回滚前两个健康版本)。 */
  keepGenerations?: number
  lockStaleMs?: number
  pidAlive?: (pid: number) => boolean
  /** 测试专用故障注入,生产不传。 */
  crashAt?: TxCrashPoint
}

/** #348:非 authorize 阶段枚举定义在 shared wire 模块(preload/renderer 判别联合共用同一真源)。 */
export type TxStage = "authorize" | TxStageNonAuthorizeWire

export type TxResult =
  | { ok: true; txId: string; committed: TxCommitRecord[]; warnings: string[] }
  | {
      ok: false
      txId?: string
      stage: TxStage
      reason: string
      quarantined?: string[]
      /** stage="authorize" 时携带逐 item capability diff(UI 展示 → 用户确认 → 带 authorization 重驱)。 */
      authorization?: CapabilityDiff[]
      warnings: string[]
    }

/** 事务状态机(journal 持久化;每次转换原子写)。 */
export type TxState =
  | "staging" // journal 已建,staging 进行中(live 零接触)
  | "staged" // staging 全量校验通过
  | "materialized" // generation 目录已 rename 就位(未 live)
  | "switching" // 已记录 previous 指针 + 翻转意图(commit 意图点)
  | "switched" // 全部指针已翻转(previous generation 保留)
  | "committed" // receipt 已提交(终态,成功)
  | "rolled-back" // 终态:指针已回旧,失败 generation 已隔离
  | "aborted" // 终态:switch 之前失败,current 全量不变
  | "uninstalling" // REQ-100 #313:卸载进行中(锁内 store-first 删除 → 删账)
  | "uninstalled" // 终态:owned store + 账本已删

export type TxJournalItem = {
  key: string
  /** action 类型;缺省 generation(向后兼容 v:1 老 journal 无此字段)。 */
  action?: TxActionKind
  /** generation:目标代号。config/receipt 恒为占位(不建目录、不翻指针)。 */
  genId: string
  /** generation:期望载荷 digest 集。config/receipt 为空数组。 */
  files: TxFileSpec[]
  /** config:目标文件 + staging 里 pre/next image 的 digest(内容在受保护 staging,journal 不落值)。 */
  config?: { target: string; slot: number; preDigest: string; nextDigest: string }
  /** file:root 内相对目标 + pre/next digest + 前像缺席标记(缺席 ≠ 零字节,#358;内容在受保护
   *  staging)。requireAbsent/applied(#359 r5):requireAbsent 意图与**逐 item apply 进度**持久化
   *  —— 恢复据 applied 区分「本事务已写」与「旁路植入同 digest 内容」,后者绝不 unlink/前滚认领。 */
  file?: { relTarget: string; slot: number; preDigest: string; nextDigest: string; preAbsent: boolean; requireAbsent: boolean; applied?: boolean }
  /** receipt 模板(不透明透传;恢复前滚据此重建 InstallRecordV2,无需 caller 上下文)。 */
  receipt?: unknown
  manifestDigest?: string
  /** committed 后写授权账用(恢复前滚也要写,故持久化在 journal 里)。 */
  capabilities?: string[]
  /** switching 起持久化:翻转前的指针(null = 全新安装)。 */
  previousGeneration?: string | null
}

/** authorize 阶段的裁决快照(持久化在 journal:committed 时据此落授权收据,恢复前滚同样可写)。 */
export type TxJournalAuthorization = {
  decidedAt: string
  items: CapabilityDiff[]
  skippedOptional: Array<{ key: string; reason: string }>
}

export type TxJournal = {
  v: 1
  txId: string
  /** 事务类型;缺省 install(向后兼容旧 journal 无此字段)。uninstall/rollback 各走独立恢复补偿(REQ-100 #313)。 */
  op?: "install" | "uninstall" | "rollback"
  state: TxState
  createdAt: string
  updatedAt: string
  reason?: string
  items: TxJournalItem[]
  authorization?: TxJournalAuthorization
}

export const KEEP_GENERATIONS_DEFAULT = 3
const QUARANTINE_KEEP_DEFAULT = 10
const JOURNAL_KEEP_DEFAULT = 100

const SAFE_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
const GEN_NAME = /^gen-\d{6}-[a-f0-9]{8}$/
const TX_ID_RE = /^tx-[a-z0-9]{1,20}-[a-f0-9]{8}$/
const SHA256_RE = /^[a-f0-9]{64}$/

// ── 目录布局 ─────────────────────────────────────────────────────────────────────────────────

const TX_DIR = "ext-tx"
const STORE_DIR = "ext-store"

export function extensionStorePaths(root: string, key: string) {
  const store = path.join(root, STORE_DIR, key)
  return { store, generations: path.join(store, "generations"), pointer: path.join(store, "current.json") }
}

const txStagingRoot = (root: string) => path.join(root, TX_DIR, "staging")
const txStagingDir = (root: string, txId: string) => path.join(txStagingRoot(root), txId)
const journalDir = (root: string) => path.join(root, TX_DIR, "journal")
const journalPath = (root: string, txId: string) => path.join(journalDir(root), `${txId}.json`)
const quarantineRoot = (root: string) => path.join(root, TX_DIR, "quarantine")
const authzReceiptPath = (root: string, txId: string) => path.join(root, TX_DIR, "authz", `${txId}.json`)
const generationDirOf = (root: string, key: string, genId: string) =>
  path.join(extensionStorePaths(root, key).generations, genId)

// ── generation receipt descriptor 快照(REQ-100 #313 契约 a):每物理 generation 一份账本描述符,
//    使离线回滚能把 receipt 复原到目标 generation 的元数据(receipt 与 live 不分叉)。落 store 下的
//    receipts/ 子目录,与 generation 一一配对(GC/quarantine/uninstall 联动删除)。 ────────────────
const receiptSnapshotDir = (root: string, key: string) => path.join(extensionStorePaths(root, key).store, "receipts")
const receiptSnapshotPath = (root: string, key: string, genId: string) => path.join(receiptSnapshotDir(root, key), `${genId}.json`)

export type GenerationReceiptSnapshot = { v: 1; key: string; genId: string; receipt: unknown; committedAt: string }

/** 提交阶段幂等写 generation 快照(receipt 不透明;无 receipt 模板 = 不写)。 */
function writeReceiptSnapshot(root: string, key: string, genId: string, receipt: unknown, committedAt: string): void {
  if (receipt === undefined) return
  const snap: GenerationReceiptSnapshot = { v: 1, key, genId, receipt, committedAt }
  writeFileAtomicSync(receiptSnapshotPath(root, key, genId), JSON.stringify(snap, null, 2) + "\n")
}

/** 严格读取目标 generation 快照(key/genId 必须匹配);缺失/损坏 → null。 */
export function readGenerationReceiptSnapshot(root: string, key: string, genId: string): GenerationReceiptSnapshot | null {
  if (!SAFE_KEY.test(key) || !GEN_NAME.test(genId)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(receiptSnapshotPath(root, key, genId), "utf8")) as GenerationReceiptSnapshot
    if (parsed && parsed.v === 1 && parsed.key === key && parsed.genId === genId && parsed.receipt !== undefined) return parsed
  } catch {
    /* 缺失/损坏 */
  }
  return null
}

function removeReceiptSnapshot(root: string, key: string, genId: string): void {
  try {
    fs.unlinkSync(receiptSnapshotPath(root, key, genId))
  } catch {
    /* 已无 */
  }
}

/** 从 journal item 构造 commit record(主提交与恢复前滚同源;透传 receipt 模板 REQ-100 #312)。 */
function buildCommitRecord(root: string, txId: string, it: TxJournalItem, committedAt: string): TxCommitRecord {
  const receipt = it.receipt !== undefined ? { receipt: it.receipt } : {}
  const kind = actionOf(it)
  if (kind === "generation")
    return {
      txId,
      key: it.key,
      action: "generation",
      generation: it.genId,
      generationDir: generationDirOf(root, it.key, it.genId),
      previousGeneration: it.previousGeneration ?? null,
      manifestDigest: it.manifestDigest,
      files: it.files,
      ...receipt,
      committedAt,
    }
  if (kind === "config")
    return { txId, key: it.key, action: "config", ...(it.config ? { configTarget: it.config.target } : {}), manifestDigest: it.manifestDigest, ...receipt, committedAt }
  if (kind === "file")
    return { txId, key: it.key, action: "file", ...(it.file ? { fileTarget: path.join(root, it.file.relTarget) } : {}), manifestDigest: it.manifestDigest, ...receipt, committedAt }
  return { txId, key: it.key, action: "receipt", manifestDigest: it.manifestDigest, ...receipt, committedAt }
}

function newTxId(): string {
  return `tx-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`
}

const defaultLog: TxLog = (event, detail) => console.error(`[ext-transaction] ${event} ${JSON.stringify(detail)}`)

// ── generation 指针(live 真相;原子换名写) ─────────────────────────────────────────────────

type GenPointer = { v: 1; generation: string; txId: string; switchedAt: string }

function parsePointer(text: string): GenPointer | null {
  try {
    const parsed = JSON.parse(text) as GenPointer
    if (!parsed || typeof parsed !== "object") return null
    if (typeof parsed.generation !== "string" || !GEN_NAME.test(parsed.generation)) return null
    return parsed
  } catch {
    return null
  }
}

/** 读 live 指针。缺失/不可解析 → null(不可解析属 fail-closed:视作无 live,由上层 loud)。 */
export function readCurrentGeneration(root: string, key: string): { genId: string; dir: string } | null {
  if (!SAFE_KEY.test(key)) return null
  const { pointer } = extensionStorePaths(root, key)
  let text: string
  try {
    text = fs.readFileSync(pointer, "utf8")
  } catch {
    return null
  }
  const parsed = parsePointer(text)
  if (!parsed) return null
  return { genId: parsed.generation, dir: generationDirOf(root, key, parsed.generation) }
}

/** 暴露给消费方(config 通道 / planner path 派生)的 live 目录;指针或目录缺失 → null。 */
export function resolveLiveGenerationDir(root: string, key: string): string | null {
  const current = readCurrentGeneration(root, key)
  if (!current) return null
  try {
    return fs.statSync(current.dir).isDirectory() ? current.dir : null
  } catch {
    return null
  }
}

function writePointerSync(root: string, key: string, genId: string, txId: string, now: () => Date): void {
  const { pointer } = extensionStorePaths(root, key)
  const record: GenPointer = { v: 1, generation: genId, txId, switchedAt: now().toISOString() }
  writeFileAtomicSync(pointer, JSON.stringify(record, null, 2) + "\n")
}

/** 只吞 ENOENT(幂等:已经不在);其余错误抛出 —— EACCES/EBUSY 下静默会让卸载/回滚谎报
 *  指针已清(review #374 Major:pointer-only 失败曾被计入 removed 并终态化)。 */
function clearPointerSync(root: string, key: string): void {
  const { pointer } = extensionStorePaths(root, key)
  try {
    fs.unlinkSync(pointer)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
}

export function listGenerations(root: string, key: string): Array<{ genId: string; dir: string; current: boolean }> {
  if (!SAFE_KEY.test(key)) return []
  const { generations } = extensionStorePaths(root, key)
  let names: string[]
  try {
    names = fs.readdirSync(generations).filter((n) => GEN_NAME.test(n))
  } catch {
    return []
  }
  const current = readCurrentGeneration(root, key)?.genId
  return names
    .sort()
    .map((genId) => ({ genId, dir: path.join(generations, genId), current: genId === current }))
}

function nextGenId(root: string, key: string, txId: string): string {
  const { generations } = extensionStorePaths(root, key)
  let max = 0
  try {
    for (const name of fs.readdirSync(generations)) {
      const m = /^gen-(\d{6})-/.exec(name)
      if (m) max = Math.max(max, Number.parseInt(m[1]!, 10))
    }
  } catch {
    /* dir 未建 = 0 */
  }
  const suffix = txId.slice(-8)
  return `gen-${String(max + 1).padStart(6, "0")}-${suffix}`
}

// ── journal ──────────────────────────────────────────────────────────────────────────────────

function writeJournalSync(root: string, journal: TxJournal): void {
  writeFileAtomicSync(journalPath(root, journal.txId), JSON.stringify(journal, null, 2) + "\n")
}

export function readTransactionJournal(root: string, txId: string): TxJournal | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(journalPath(root, txId), "utf8")) as TxJournal
    return parsed && typeof parsed === "object" && typeof parsed.txId === "string" ? parsed : null
  } catch {
    return null
  }
}

export function listTransactionJournals(root: string): TxJournal[] {
  let names: string[]
  try {
    names = fs.readdirSync(journalDir(root)).filter((n) => n.endsWith(".json"))
  } catch {
    return []
  }
  const out: TxJournal[] = []
  for (const name of names.sort()) {
    const j = readTransactionJournal(root, name.slice(0, -".json".length))
    if (j) out.push(j)
  }
  return out
}

// ── 计划校验与 staging 校验 ──────────────────────────────────────────────────────────────────

function validatePlan(root: string, plan: TxPlan): string | null {
  if (!path.isAbsolute(root)) return `root must be absolute: ${root}`
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.items)) return "invalid plan"
  if (plan.txId !== undefined && !TX_ID_RE.test(plan.txId)) return `invalid txId: ${plan.txId}`
  if (plan.items.length === 0) return "plan has no items"
  if (plan.items.length > 64) return "plan exceeds 64 items"
  const keys = new Set<string>()
  for (const item of plan.items) {
    if (!item || typeof item !== "object") return "invalid plan item"
    if (typeof item.key !== "string" || !SAFE_KEY.test(item.key)) return `invalid item key: ${String(item.key)}`
    if (keys.has(item.key)) return `duplicate item key: ${item.key}`
    keys.add(item.key)
    const kind = actionOf(item)
    // config action:目标绝对路径 + 至少一条 edit(叶白名单由 ext-config-tx 适配器把关);无 files。
    if (kind === "config") {
      if (!item.config || typeof item.config !== "object") return `config item "${item.key}" missing config payload`
      if (typeof item.config.target !== "string" || !path.isAbsolute(item.config.target))
        return `config item "${item.key}": target must be an absolute path`
      if (!Array.isArray(item.config.edits) || item.config.edits.length === 0)
        return `config item "${item.key}": at least one edit required`
    } else if (kind === "file") {
      // file action(#358):root 内受控相对路径 + 有界内容字节;无 files 清单。
      if (!item.file || typeof item.file !== "object") return `file item "${item.key}" missing file payload`
      if (typeof item.file.relTarget !== "string" || !isSafeRelPath(item.file.relTarget))
        return `file item "${item.key}": unsafe relTarget: ${item.file.relTarget}`
      if (!Buffer.isBuffer(item.file.next) || item.file.next.length === 0)
        return `file item "${item.key}": next content must be a non-empty Buffer`
      if (item.file.next.length > FILE_ACTION_MAX_BYTES)
        return `file item "${item.key}": next content exceeds ${FILE_ACTION_MAX_BYTES} bytes`
      if (item.file.requireAbsent !== undefined && typeof item.file.requireAbsent !== "boolean")
        return `file item "${item.key}": requireAbsent must be a boolean`
    } else if (kind === "receipt") {
      // receipt-only:无 files/config 副作用,只参加最终 receipt commit。
    } else {
      // generation:期望载荷 digest 集精确匹配。
      if (!Array.isArray(item.files) || item.files.length === 0) return `item "${item.key}" has no expected files`
      if (item.files.length > 4096) return `item "${item.key}" exceeds 4096 files`
      const paths = new Set<string>()
      for (const file of item.files) {
        if (!file || typeof file !== "object") return `item "${item.key}": invalid file spec`
        if (typeof file.path !== "string" || !isSafeRelPath(file.path))
          return `item "${item.key}": unsafe file path: ${String(file.path)}`
        if (paths.has(file.path)) return `item "${item.key}": duplicate file path: ${file.path}`
        paths.add(file.path)
        if (typeof file.sha256 !== "string" || !SHA256_RE.test(file.sha256))
          return `item "${item.key}": invalid sha256 for ${file.path}`
        if (file.size !== undefined && (!Number.isInteger(file.size) || file.size < 0))
          return `item "${item.key}": invalid size for ${file.path}`
      }
    }
    if (item.capabilities !== undefined) {
      if (!Array.isArray(item.capabilities) || item.capabilities.length > 32)
        return `item "${item.key}": invalid capabilities`
      const caps = new Set<string>()
      for (const cap of item.capabilities) {
        if (!isSafeCapability(cap)) return `item "${item.key}": unsafe capability: ${String(cap)}`
        if (caps.has(cap)) return `item "${item.key}": duplicate capability: ${cap}`
        caps.add(cap)
      }
    }
  }
  if (plan.authorization !== undefined) {
    const authz = plan.authorization
    if (!authz || typeof authz !== "object" || !authz.confirmed || typeof authz.confirmed !== "object")
      return "invalid authorization: confirmed map required"
    if (authz.decidedAt !== undefined && typeof authz.decidedAt !== "string") return "invalid authorization.decidedAt"
    for (const [key, confirmed] of Object.entries(authz.confirmed)) {
      if (!keys.has(key)) return `authorization for unknown item: ${key}`
      if (!Array.isArray(confirmed) || confirmed.length > 32 || !confirmed.every((c) => isSafeCapability(c)))
        return `authorization for "${key}": invalid confirmed capability set`
    }
  }
  if (plan.skippedOptional !== undefined) {
    if (!Array.isArray(plan.skippedOptional) || plan.skippedOptional.length > 64) return "invalid skippedOptional"
    const skipped = new Set<string>()
    for (const entry of plan.skippedOptional) {
      if (!entry || typeof entry !== "object" || typeof entry.key !== "string" || !SAFE_KEY.test(entry.key))
        return `skippedOptional: invalid key: ${String(entry?.key)}`
      if (keys.has(entry.key)) return `skippedOptional key "${entry.key}" collides with an installed item`
      if (skipped.has(entry.key)) return `skippedOptional: duplicate key: ${entry.key}`
      skipped.add(entry.key)
      if (entry.reason !== undefined && (typeof entry.reason !== "string" || entry.reason.length > 300))
        return `skippedOptional "${entry.key}": invalid reason`
    }
  }
  return null
}

/** staging 目录结构精确校验:期望集全在、零多余、零 symlink、sha256/size 全符;顺手 fsync 内容。 */
function verifyStagedItem(stagingDir: string, files: TxFileSpec[]): { ok: true } | { ok: false; reason: string } {
  const expected = new Map(files.map((f) => [f.path, f]))
  const seen = new Set<string>()
  const walk = (relDir: string): string | null => {
    const abs = relDir ? path.join(stagingDir, relDir) : stagingDir
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) return `symlink not allowed in staging: ${rel}`
      if (entry.isDirectory()) {
        const err = walk(rel)
        if (err) return err
      } else if (entry.isFile()) {
        const spec = expected.get(rel)
        if (!spec) return `unexpected file in staging: ${rel}`
        const absFile = path.join(stagingDir, rel)
        const size = fs.statSync(absFile).size
        if (spec.size !== undefined && size !== spec.size) return `size mismatch for ${rel}: ${size} ≠ ${spec.size}`
        if (sha256FileSync(absFile) !== spec.sha256) return `sha256 mismatch for ${rel}`
        fsyncFileSync(absFile)
        seen.add(rel)
      } else {
        return `unsupported entry type in staging: ${rel}`
      }
    }
    return null
  }
  try {
    const err = walk("")
    if (err) return { ok: false, reason: err }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "failed to read staging dir" }
  }
  for (const p of expected.keys()) {
    if (!seen.has(p)) return { ok: false, reason: `missing expected file: ${p}` }
  }
  fsyncDirTreeSync(stagingDir)
  return { ok: true }
}

// ── quarantine ───────────────────────────────────────────────────────────────────────────────

export type QuarantineReceipt = {
  v: 1
  txId: string
  reason: string
  from: "pre-switch-probe" | "post-switch-rollback" | "crash-recovery"
  quarantinedAt: string
  items: Array<{ key: string; genId: string; movedTo: string }>
}

/** 失败 generation 移入 `<root>/ext-tx/quarantine/<txId>/` 并落 reason 收据(绝不原地删失败版本)。 */
function quarantineGenerations(
  root: string,
  txId: string,
  entries: Array<{ key: string; genId: string; dir: string }>,
  reason: string,
  from: QuarantineReceipt["from"],
  now: () => Date,
  warnings: string[],
): string[] {
  const qDir = path.join(quarantineRoot(root), txId)
  const moved: QuarantineReceipt["items"] = []
  for (const entry of entries) {
    if (!fs.existsSync(entry.dir)) continue
    if (!GEN_NAME.test(entry.genId) || !confinedExistingPath(root, entry.dir)) {
      warnings.push(`quarantine refused (path guard): ${entry.dir}`)
      continue
    }
    const dest = path.join(qDir, `${entry.key}--${entry.genId}`)
    try {
      renameAtomicSync(entry.dir, dest)
      moved.push({ key: entry.key, genId: entry.genId, movedTo: dest })
      removeReceiptSnapshot(root, entry.key, entry.genId) // #313:隔离的失败 generation 其快照无效,联动清除
    } catch (error) {
      warnings.push(`quarantine move failed for ${entry.dir}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const receipt: QuarantineReceipt = { v: 1, txId, reason, from, quarantinedAt: now().toISOString(), items: moved }
  try {
    writeFileAtomicSync(path.join(qDir, "quarantine.json"), JSON.stringify(receipt, null, 2) + "\n")
  } catch (error) {
    warnings.push(`quarantine receipt write failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  return moved.map((m) => m.movedTo)
}

export function readQuarantineReceipt(root: string, txId: string): QuarantineReceipt | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(quarantineRoot(root), txId, "quarantine.json"), "utf8"),
    ) as QuarantineReceipt
    return parsed && typeof parsed === "object" ? parsed : null
  } catch {
    return null
  }
}

// ── Bundle 授权收据(一次展示、一次授权、一次 commit 的审计面) ──────────────────────────────

export type BundleAuthorizationReceipt = {
  v: 1
  txId: string
  decidedAt: string
  /** 逐 item 的 capability diff(用户看到并确认的内容;requiresConfirmation=false 的 item 为放行记录)。 */
  items: CapabilityDiff[]
  /** AC2:optional child 的跳过在授权中可见。 */
  skippedOptional: Array<{ key: string; reason: string }>
}

export function readBundleAuthorizationReceipt(root: string, txId: string): BundleAuthorizationReceipt | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(authzReceiptPath(root, txId), "utf8")) as BundleAuthorizationReceipt
    return parsed && typeof parsed === "object" && Array.isArray(parsed.items) ? parsed : null
  } catch {
    return null
  }
}

/**
 * committed 之后的授权落账(主路径与恢复前滚共用;幂等):
 *   · 逐 item 写 grants.json(下次升级的 diff 基线)—— **只有走到 committed 的事务**才会执行,
 *     abort/rollback 一律不触碰授权账 → 拒绝/失败后旧版继续按旧授权健康运行;
 *   · 落 Bundle 授权收据(diff + optional 跳过,审计可见)。
 * 失败仅记 warnings(live 与 receipt 已真实;授权账落后的失败模式 = 下次多问一次,fail closed)。
 */
function writeCommitAuthorizationSync(root: string, journal: TxJournal, now: () => Date, warnings: string[]): void {
  for (const it of journal.items) {
    // #358 review Minor:未声明 capabilities 的 item 不落授权账(未参与授权 ≠ 已授权空集)。
    if (it.capabilities === undefined) continue
    try {
      writeCapabilityGrantSync(root, {
        v: 1,
        key: it.key,
        capabilities: it.capabilities,
        manifestDigest: it.manifestDigest,
        txId: journal.txId,
        grantedAt: now().toISOString(),
      })
    } catch (error) {
      warnings.push(`grant write failed for "${it.key}": ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (journal.authorization) {
    const receipt: BundleAuthorizationReceipt = {
      v: 1,
      txId: journal.txId,
      decidedAt: journal.authorization.decidedAt,
      items: journal.authorization.items,
      skippedOptional: journal.authorization.skippedOptional,
    }
    try {
      writeFileAtomicSync(authzReceiptPath(root, journal.txId), JSON.stringify(receipt, null, 2) + "\n")
    } catch (error) {
      warnings.push(`authorization receipt write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

// ── 受守卫删除 ───────────────────────────────────────────────────────────────────────────────

function removeDirGuarded(root: string, dir: string, warnings: string[]): boolean {
  if (!fs.existsSync(dir)) return true
  if (!confinedExistingPath(root, dir)) {
    warnings.push(`removal refused (path guard): ${dir}`)
    return false
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    return true
  } catch (error) {
    warnings.push(`removal failed for ${dir}: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

// ── GC(有界保留 + 双守卫) ──────────────────────────────────────────────────────────────────

export function gcGenerations(
  root: string,
  key: string,
  opts: { keep?: number; log?: TxLog } = {},
): { deleted: string[]; warnings: string[] } {
  const warnings: string[] = []
  const deleted: string[] = []
  if (!SAFE_KEY.test(key)) return { deleted, warnings: [`gc refused: invalid key ${key}`] }
  const keep = Math.max(1, opts.keep ?? KEEP_GENERATIONS_DEFAULT)
  const { generations, pointer } = extensionStorePaths(root, key)
  if (!fs.existsSync(generations)) return { deleted, warnings }
  // fail closed:指针文件存在但不可解析 → 无法判定 current,整体跳过 GC(宁多留不误删)
  const current = readCurrentGeneration(root, key)
  if (fs.existsSync(pointer) && !current) {
    return { deleted, warnings: [`gc skipped for "${key}": pointer unreadable (fail closed)`] }
  }
  let names: string[]
  try {
    names = fs.readdirSync(generations).filter((n) => GEN_NAME.test(n))
  } catch (error) {
    return { deleted, warnings: [`gc failed to list generations: ${error instanceof Error ? error.message : String(error)}`] }
  }
  const sorted = names.sort().reverse() // seq 降序(零填充 6 位 → 字典序即数值序)
  const keepSet = new Set<string>()
  if (current) keepSet.add(current.genId)
  for (const name of sorted) {
    if (keepSet.size >= keep) break
    keepSet.add(name)
  }
  for (const name of sorted) {
    if (keepSet.has(name)) continue
    const dir = path.join(generations, name)
    if (current && name === current.genId) continue // 双保险:live 永不删
    if (removeDirGuarded(root, dir, warnings)) {
      deleted.push(dir)
      removeReceiptSnapshot(root, key, name) // #313:generation 删 → 联动删其 receipt 快照
    }
  }
  return { deleted, warnings }
}

/** quarantine 有界保留(按目录 mtime 新→旧,默认留 10 个事务)。 */
export function gcQuarantine(root: string, opts: { keep?: number } = {}): { deleted: string[]; warnings: string[] } {
  const warnings: string[] = []
  const deleted: string[] = []
  const keep = Math.max(0, opts.keep ?? QUARANTINE_KEEP_DEFAULT)
  const qRoot = quarantineRoot(root)
  let entries: Array<{ name: string; mtime: number }>
  try {
    entries = fs
      .readdirSync(qRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, mtime: fs.statSync(path.join(qRoot, e.name)).mtimeMs }))
  } catch {
    return { deleted, warnings }
  }
  entries.sort((a, b) => b.mtime - a.mtime)
  for (const entry of entries.slice(keep)) {
    const dir = path.join(qRoot, entry.name)
    if (removeDirGuarded(root, dir, warnings)) deleted.push(dir)
  }
  return { deleted, warnings }
}

function gcTerminalJournals(root: string, keep: number, warnings: string[]): void {
  const journals = listTransactionJournals(root)
    .filter((j) => j.state === "committed" || j.state === "rolled-back" || j.state === "aborted" || j.state === "uninstalled")
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  for (const journal of journals.slice(Math.max(0, keep))) {
    try {
      fs.unlinkSync(journalPath(root, journal.txId))
    } catch (error) {
      warnings.push(`journal gc failed for ${journal.txId}: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      fs.unlinkSync(authzReceiptPath(root, journal.txId)) // 授权收据随 journal 同界清理
    } catch {
      /* 无收据 = 无事可清 */
    }
  }
}

// ── 主流程 ───────────────────────────────────────────────────────────────────────────────────

export async function runExtensionTransaction(root: string, plan: TxPlan, hooks: TxHooks): Promise<TxResult> {
  const warnings: string[] = []
  const log = hooks.log ?? defaultLog
  const now = hooks.now ?? (() => new Date())
  const crash = (point: TxCrashPoint): void => {
    if (hooks.crashAt === point) throw new ExtTxCrashError(point)
  }

  const invalid = validatePlan(root, plan)
  if (invalid) return { ok: false, stage: "validate", reason: invalid, warnings }
  const txId = plan.txId ?? newTxId()

  const acquired = tryAcquireBundleLock(root, {
    txId,
    now,
    log,
    pidAlive: hooks.pidAlive,
    staleMs: hooks.lockStaleMs,
  })
  if (!acquired.ok) return { ok: false, txId, stage: "lock", reason: acquired.reason, warnings }
  if (acquired.recoveredStale) {
    warnings.push(
      `stale bundle lock recovered: ${acquired.recoveredStale.reason} (evidence: ${acquired.recoveredStale.movedTo})`,
    )
  }
  const lock: BundleLock = acquired.lock
  crash("after-lock")

  // ── authorize:capability diff 重确认闸口(锁内评估 → 与并发 commit 串行化,防 TOCTOU)。
  // 扩张 / 首次授权而确认未覆盖完整请求集 → 拒绝启动:零写盘、current 原样健康运行(AC3)。
  // #358 review Minor:未声明 capabilities 的 item(如 agent 的 config 副 item)不参与授权评估
  // 也不落授权账 —— 「未参与授权」不得折叠成「已授权空集」;一个逻辑扩展一个授权 key。
  const authz = evaluateBundleAuthorization(root, plan.items.filter((it) => it.capabilities !== undefined))
  for (const diff of authz.items) {
    if (!diff.requiresConfirmation) continue
    if (confirmationCovers(plan.authorization?.confirmed[diff.key], diff.requested)) continue
    lock.release()
    const grew = diff.added.length > 0 ? `added: ${diff.added.join(", ")}` : "initial grant"
    log("tx-authorization-required", { txId, key: diff.key, added: diff.added, previous: diff.previous })
    return {
      ok: false,
      txId,
      stage: "authorize",
      reason: `capability grant for "${diff.key}" requires explicit re-confirmation (${grew}) — silent inheritance refused`,
      authorization: authz.items,
      warnings,
    }
  }
  crash("after-authorize")

  // 锁内业务前置(如 seed downgrade 门):此刻已与并发提交串行化,失败零副作用(未写 journal/staging)。
  if (hooks.precondition) {
    const pre = hooks.precondition()
    if (!pre.ok) {
      lock.release()
      log("tx-precondition-refused", { txId, reason: pre.reason })
      return { ok: false, txId, stage: "precondition", reason: pre.reason, warnings }
    }
  }

  // config action 的 image 对在锁内、staging 前一次性 prepare(捕获 live preimage + 计算 nextImage);
  // 任一失败 = 写盘前 fail-closed。digest 进 journal(内容进受保护 staging),恢复据此判定翻转/回滚。
  const configImages = new Map<string, ConfigTxImage>()
  // 同一 target 的多个 config action 链式累积:后一个以前一个的 nextImage 为基线(preImage),否则
  // switch 时后写覆盖前写。首个 action 从 live 读。
  const accumulatedText = new Map<string, string>()
  for (const item of plan.items) {
    if (actionOf(item) !== "config") continue
    if (!item.config) {
      lock.release()
      return { ok: false, txId, stage: "validate", reason: `config item "${item.key}" missing config payload`, warnings }
    }
    const target = item.config.target
    const prep = prepareConfigTx(target, item.config.edits, accumulatedText.get(target))
    if (!prep.ok) {
      lock.release()
      return { ok: false, txId, stage: "staging", reason: `config prepare failed for "${item.key}": ${prep.reason}`, warnings }
    }
    configImages.set(item.key, prep.image)
    accumulatedText.set(target, prep.image.nextImage)
  }

  // file action 的 image 对同样在锁内、staging 前一次性 prepare(捕获 live 前像含缺席态,#358)。
  // 同一 target 的多个 file item 无累积语义(整文件替换,后写覆盖前写)—— 直接拒。
  const fileImages = new Map<string, FileTxImage>()
  const fileRequireAbsent = new Set<string>()
  const fileTargets = new Set<string>()
  for (const item of plan.items) {
    if (actionOf(item) !== "file") continue
    if (!item.file) {
      lock.release()
      return { ok: false, txId, stage: "validate", reason: `file item "${item.key}" missing file payload`, warnings }
    }
    const target = path.join(root, item.file.relTarget)
    if (fileTargets.has(target)) {
      lock.release()
      return { ok: false, txId, stage: "validate", reason: `duplicate file target across items: ${item.file.relTarget}`, warnings }
    }
    fileTargets.add(target)
    // #358 review Blocker 2:词法安全 ≠ root 圈禁 —— 已存在前缀段若是 symlink,写入会逃逸 root。
    const confined = confineFileTarget(root, item.file.relTarget)
    if (!confined.ok) {
      lock.release()
      return { ok: false, txId, stage: "staging", reason: `file prepare failed for "${item.key}": ${confined.reason}`, warnings }
    }
    const prep = prepareFileTx(target, item.file.next)
    if (!prep.ok) {
      lock.release()
      return { ok: false, txId, stage: "staging", reason: `file prepare failed for "${item.key}": ${prep.reason}`, warnings }
    }
    // #359 review r3:requireAbsent = 锁内执行断言 —— 前像在场即拒(零写盘),绝不带前像覆盖认领。
    if (item.file.requireAbsent && !prep.image.preAbsent) {
      lock.release()
      return { ok: false, txId, stage: "staging", reason: `file target for "${item.key}" must be absent (unregistered content is not adopted) — refused`, warnings }
    }
    if (item.file.requireAbsent) fileRequireAbsent.add(item.key)
    fileImages.set(item.key, prep.image)
  }

  const iso = now().toISOString()
  let journal: TxJournal = {
    v: 1,
    txId,
    state: "staging",
    createdAt: iso,
    updatedAt: iso,
    items: plan.items.map((item, index) => ({
      key: item.key,
      action: actionOf(item),
      // generation 才建代号;config/receipt 用占位(不建目录、不翻指针)。
      genId: actionOf(item) === "generation" ? nextGenId(root, item.key, txId) : "gen-000000-000000",
      files: item.files ?? [],
      ...(actionOf(item) === "config" && configImages.has(item.key)
        ? {
            config: {
              target: item.config!.target,
              slot: index,
              preDigest: configImages.get(item.key)!.preDigest,
              nextDigest: configImages.get(item.key)!.nextDigest,
            },
          }
        : {}),
      ...(actionOf(item) === "file" && fileImages.has(item.key)
        ? {
            file: {
              relTarget: item.file!.relTarget,
              slot: index,
              preDigest: fileImages.get(item.key)!.preDigest,
              nextDigest: fileImages.get(item.key)!.nextDigest,
              preAbsent: fileImages.get(item.key)!.preAbsent,
              requireAbsent: item.file!.requireAbsent === true,
            },
          }
        : {}),
      manifestDigest: item.manifestDigest,
      ...(item.receipt !== undefined ? { receipt: item.receipt } : {}),
      capabilities: item.capabilities,
    })),
    authorization: {
      decidedAt: plan.authorization?.decidedAt ?? iso,
      items: authz.items,
      skippedOptional: (plan.skippedOptional ?? []).map((s) => ({ key: s.key, reason: s.reason ?? "" })),
    },
  }

  const advance = (state: TxState, reason?: string): void => {
    journal = { ...journal, state, updatedAt: now().toISOString(), ...(reason !== undefined ? { reason } : {}) }
    writeJournalSync(root, journal)
    lock.refresh()
  }

  const genEntries = () =>
    journal.items
      .filter((it) => actionOf(it) === "generation")
      .map((it) => ({ key: it.key, genId: it.genId, dir: generationDirOf(root, it.key, it.genId) }))

  const fileEntries = () =>
    journal.items
      .filter((it) => actionOf(it) === "file" && it.file)
      .map((it) => ({ key: it.key, target: path.join(root, it.file!.relTarget), slot: it.file!.slot, nextDigest: it.file!.nextDigest }))

  /** config/file action 回滚:逆序恢复(仅当 target 仍是 next 态才恢复前像;旁路改写 → fail-closed 留证)。
   *  返回 fileBlocked:file 恢复被旁路改写/读失败挡住 —— 调用方**不得终态化**(review r2 Blocker)。 */
  const rollbackImageActions = (): { fileBlocked: string | null } => {
    let fileBlocked: string | null = null
    for (const it of [...journal.items].reverse()) {
      const kind = actionOf(it)
      if (kind === "config") {
        const image = configImages.get(it.key)
        if (!image) continue
        const restored = restoreConfigImage(image)
        if (!restored.ok) warnings.push(`config rollback for "${it.key}": ${restored.reason}`)
      } else if (kind === "file") {
        const image = fileImages.get(it.key)
        if (!image) continue
        // r3 Blocker:restore 同样先紧邻重验圈禁 —— 目录被重绑定时绝不经 symlink 写/删 root 外
        // 文件(即使内容恰好匹配 next 态),转 fileBlocked 保留非终态。
        const confined = it.file ? confineFileTarget(root, it.file.relTarget) : { ok: false as const, reason: "missing file journal segment" }
        if (!confined.ok) {
          fileBlocked = `file rollback for "${it.key}": ${confined.reason}`
          continue
        }
        // r5 Blocker:本事务从未 apply(applied ≠ true)的 requireAbsent item —— live 在场
        // 只能是窗口内的旁路植入,**即使内容恰等于 nextDigest 也不 unlink**(那是别人的字节,
        // 不是本事务输出),保留非终态留证;缺席 = 无事可回。
        if (it.file?.requireAbsent && it.file.applied !== true) {
          if (fs.existsSync(path.join(root, it.file.relTarget)))
            fileBlocked = `file rollback for "${it.key}": bypass-planted content at an unapplied target — retained as evidence`
          continue
        }
        const restored = restoreFileImage(image)
        if (!restored.ok) fileBlocked = `file rollback for "${it.key}": ${restored.reason}`
      }
    }
    return { fileBlocked }
  }

  /** switch 之前的失败:current 全量不变。quarantineFailed=true(探测失败)→ 隔离;否则删未引用残留。 */
  const abortPreSwitch = (stage: TxStage, reason: string, quarantineFailed = false): TxResult => {
    let quarantined: string[] | undefined
    const gens = genEntries().filter((g) => fs.existsSync(g.dir))
    if (gens.length > 0) {
      if (quarantineFailed) {
        quarantined = quarantineGenerations(root, txId, gens, reason, "pre-switch-probe", now, warnings)
      } else {
        for (const g of gens) removeDirGuarded(root, g.dir, warnings)
      }
    }
    removeDirGuarded(root, txStagingDir(root, txId), warnings)
    advance("aborted", reason)
    log("tx-aborted", { txId, stage, reason })
    lock.release()
    return { ok: false, txId, stage, reason, quarantined, warnings }
  }

  /** switch 之后的失败:config/file 逆序恢复 + generation 指针回旧(previous 一直保留)+ 失败 generation 隔离。
   *  file 恢复被旁路改写挡住 → **保留非终态**(不删 staging、不隔离、不 advance):终态化会同时
   *  留下部分回滚态、销毁恢复依据并解除 recovery gate 的阻断(review r2 Blocker)。 */
  const rollbackAll = (stage: TxStage, reason: string): TxResult => {
    const { fileBlocked } = rollbackImageActions()
    if (fileBlocked) {
      const detail = `${reason}; ${fileBlocked} — transaction retained non-terminal for recovery/manual diagnosis`
      log("tx-file-restore-blocked", { txId, stage, detail })
      lock.release()
      return { ok: false, txId, stage, reason: detail, warnings }
    }
    for (const it of journal.items) {
      if (actionOf(it) !== "generation") continue
      const current = readCurrentGeneration(root, it.key)
      if (current?.genId !== it.genId) continue // 未翻转的不用回
      const prev = it.previousGeneration ?? null
      if (prev && fs.existsSync(generationDirOf(root, it.key, prev))) {
        writePointerSync(root, it.key, prev, txId, now)
      } else {
        if (prev) warnings.push(`previous generation ${prev} missing for "${it.key}" — pointer cleared (fail closed)`)
        try {
          clearPointerSync(root, it.key)
        } catch (error) {
          warnings.push(`pointer clear failed for "${it.key}": ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    const quarantined = quarantineGenerations(root, txId, genEntries(), reason, "post-switch-rollback", now, warnings)
    removeDirGuarded(root, txStagingDir(root, txId), warnings)
    advance("rolled-back", reason)
    log("tx-rolled-back", { txId, stage, reason })
    lock.release()
    return { ok: false, txId, stage, reason, quarantined, warnings }
  }

  writeJournalSync(root, journal)
  crash("after-journal")

  // ① staging:一切写入先落 staging(live 零接触)。generation → populate 文件树;config → 落
  //    preimage/nextimage(内容进受保护 staging);receipt → 无 staging 副作用。
  try {
    for (let i = 0; i < plan.items.length; i++) {
      const item = plan.items[i]!
      const kind = actionOf(item)
      if (kind === "generation") {
        const dir = path.join(txStagingDir(root, txId), item.key)
        fs.mkdirSync(dir, { recursive: true })
        await hooks.populate(item, dir)
      } else if (kind === "config") {
        stageConfigImage(txStagingDir(root, txId), i, configImages.get(item.key)!)
      } else if (kind === "file") {
        stageFileImage(txStagingDir(root, txId), i, fileImages.get(item.key)!)
      }
      if (i === 0 && plan.items.length > 1) crash("mid-populate")
    }
  } catch (error) {
    if (error instanceof ExtTxCrashError) throw error
    return abortPreSwitch("staging", `staging failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  crash("after-populate")

  // ② 校验:generation 逐文件 sha256 + 结构精确匹配;config 复核 staging 里 pre/next image digest 一致。
  for (let i = 0; i < plan.items.length; i++) {
    const item = plan.items[i]!
    const kind = actionOf(item)
    if (kind === "generation") {
      const verdict = verifyStagedItem(path.join(txStagingDir(root, txId), item.key), item.files ?? [])
      if (!verdict.ok) return abortPreSwitch("verify", `"${item.key}" staging verification failed: ${verdict.reason}`)
    } else if (kind === "config") {
      const cfg = journal.items.find((j) => j.key === item.key)!.config!
      const rebuilt = readStagedConfigImage(txStagingDir(root, txId), cfg.slot, cfg.target, cfg.preDigest, cfg.nextDigest)
      if (!rebuilt.ok) return abortPreSwitch("verify", `"${item.key}" config staging verification failed: ${rebuilt.reason}`)
    } else if (kind === "file") {
      const fl = journal.items.find((j) => j.key === item.key)!.file!
      const rebuilt = readStagedFileImage(txStagingDir(root, txId), fl.slot, path.join(root, fl.relTarget), fl.preDigest, fl.nextDigest, fl.preAbsent)
      if (!rebuilt.ok) return abortPreSwitch("verify", `"${item.key}" file staging verification failed: ${rebuilt.reason}`)
    }
  }
  advance("staged")
  crash("after-staged")

  // ③ materialize:generation → staging 目录单次 rename 进 generations/<genId>;config/receipt 不
  //    materialize(config 的 next-image 已在 staging 待命,live alpha.jsonc 未动)。
  try {
    for (let i = 0; i < journal.items.length; i++) {
      const it = journal.items[i]!
      if (actionOf(it) !== "generation") continue
      renameAtomicSync(path.join(txStagingDir(root, txId), it.key), generationDirOf(root, it.key, it.genId))
      if (i === 0 && journal.items.length > 1) crash("mid-materialize")
    }
  } catch (error) {
    if (error instanceof ExtTxCrashError) throw error
    return abortPreSwitch("materialize", `materialize failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  advance("materialized")
  crash("after-materialized")

  // ④ pre-switch health probe(需求档管线序:probe 在 switch 前;失败 → current 不动 + 隔离)
  if (hooks.probe) {
    for (const g of genEntries()) {
      let verdict: HealthVerdict
      try {
        verdict = await hooks.probe({ key: g.key, action: "generation", genId: g.genId, generationDir: g.dir, phase: "pre-switch" })
      } catch (error) {
        if (error instanceof ExtTxCrashError) throw error
        verdict = { healthy: false, reason: error instanceof Error ? error.message : "probe threw" }
      }
      if (!verdict.healthy) {
        return abortPreSwitch("pre-switch-probe", `health probe failed for "${g.key}": ${verdict.reason}`, true)
      }
    }
    // file action(#358):pre-switch 验 staged candidate(语义健康;digest 已由 verify 阶段把关)。
    for (const f of fileEntries()) {
      let verdict: HealthVerdict
      try {
        verdict = await hooks.probe({
          key: f.key,
          action: "file",
          genId: "gen-000000-000000",
          generationDir: "",
          phase: "pre-switch",
          fileTarget: f.target,
          stagedFile: fileStagePaths(txStagingDir(root, txId), f.slot).next,
          fileDigest: f.nextDigest,
        })
      } catch (error) {
        if (error instanceof ExtTxCrashError) throw error
        verdict = { healthy: false, reason: error instanceof Error ? error.message : "probe threw" }
      }
      if (!verdict.healthy) {
        return abortPreSwitch("pre-switch-probe", `health probe failed for "${f.key}": ${verdict.reason}`)
      }
    }
  }
  crash("after-pre-probe")

  // ⑤ atomic switch:先持久化 previous 指针 + 意图(journal=switching),再逐 item 翻转 —— generation
  //    换 current.json 指针,config 原子替换 live alpha.jsonc(next-image),receipt 无副作用。
  for (const it of journal.items)
    it.previousGeneration = actionOf(it) === "generation" ? (readCurrentGeneration(root, it.key)?.genId ?? null) : null
  advance("switching")
  crash("after-switching-journal")
  try {
    for (let i = 0; i < journal.items.length; i++) {
      const it = journal.items[i]!
      const kind = actionOf(it)
      if (kind === "generation") writePointerSync(root, it.key, it.genId, txId, now)
      else if (kind === "config") applyConfigImage(configImages.get(it.key)!)
      else if (kind === "file") {
        // #358 review r3 Blocker:prepare 期圈禁与此处写入之间隔着 staging/verify/materialize/
        // 异步 probe —— 父目录可在窗口内被重绑定为 root 外 symlink。写入前**紧邻**重验;
        // 残余窗口收窄为 lstat→单次原子写的微秒级(契约记录,与 GC promote 窗口同类)。
        const confined = confineFileTarget(root, it.file!.relTarget)
        if (!confined.ok) throw new Error(`file confinement re-check failed for "${it.key}": ${confined.reason}`)
        // #359 review r4 Blocker:requireAbsent 只在 prepare 断言会被 prepare→apply 的异步窗口
        // 绕过(旁路植入计划内文件被覆盖)—— apply 前**紧邻**重断言缺席;在场即抛 → rollbackAll。
        if (fileRequireAbsent.has(it.key) && fs.existsSync(path.join(root, it.file!.relTarget)))
          throw new Error(`file target for "${it.key}" appeared before switch (must be absent) — refused`)
        // #359 review r5 Blocker:apply 前把逐 item 进度持久化(applied)—— 恢复/回滚据此区分
        // 「本事务已写」与「旁路植入的同 digest 内容」;后者(未 applied 而 live 在场)绝不
        // unlink、绝不前滚认领,保留非终态留证。
        it.file!.applied = true
        writeJournalSync(root, journal)
        applyFileImage(fileImages.get(it.key)!)
      }
      if (i === 0 && journal.items.length > 1) crash("mid-switch")
    }
  } catch (error) {
    if (error instanceof ExtTxCrashError) throw error
    return rollbackAll("switch", `switch failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  advance("switched")
  crash("after-switched")

  // ⑥ post-switch health probe(AC4:失败自动回旧 generation + 隔离)
  if (hooks.probe) {
    for (const g of genEntries()) {
      let verdict: HealthVerdict
      try {
        verdict = await hooks.probe({ key: g.key, action: "generation", genId: g.genId, generationDir: g.dir, phase: "post-switch" })
      } catch (error) {
        if (error instanceof ExtTxCrashError) throw error
        verdict = { healthy: false, reason: error instanceof Error ? error.message : "probe threw" }
      }
      if (!verdict.healthy) {
        return rollbackAll("post-switch-probe", `health probe failed for "${g.key}": ${verdict.reason}`)
      }
    }
    // file action(#358):post-switch 验 live 落点(内容 + 关联 config 叶一致性由 typed probe 判)。
    for (const f of fileEntries()) {
      let verdict: HealthVerdict
      try {
        verdict = await hooks.probe({
          key: f.key,
          action: "file",
          genId: "gen-000000-000000",
          generationDir: "",
          phase: "post-switch",
          fileTarget: f.target,
          fileDigest: f.nextDigest,
        })
      } catch (error) {
        if (error instanceof ExtTxCrashError) throw error
        verdict = { healthy: false, reason: error instanceof Error ? error.message : "probe threw" }
      }
      if (!verdict.healthy) {
        return rollbackAll("post-switch-probe", `health probe failed for "${f.key}": ${verdict.reason}`)
      }
    }
  }
  crash("after-post-probe")

  // ⑦ receipt commit(REQ-099 接缝;失败 → 回滚,receipt 与 live 永不背离)
  const committedAt = now().toISOString()
  const records: TxCommitRecord[] = journal.items.map((it) => buildCommitRecord(root, txId, it, committedAt))
  if (hooks.commitReceipt) {
    try {
      await hooks.commitReceipt(records)
    } catch (error) {
      if (error instanceof ExtTxCrashError) throw error
      return rollbackAll("receipt-commit", `receipt commit failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  // generation receipt descriptor 快照(#313):与 receipt commit 同阶段落盘,供离线回滚复原元数据。
  for (const it of journal.items)
    if (actionOf(it) === "generation") writeReceiptSnapshot(root, it.key, it.genId, it.receipt, committedAt)
  crash("after-receipt-commit")
  advance("committed")
  // 授权账只在 committed 后落盘(与恢复前滚共用;此前任何失败路径都不触碰授权账)
  writeCommitAuthorizationSync(root, journal, now, warnings)
  crash("before-gc")

  // ⑧ 有界 GC + staging 清理(均 warnings-only,不影响成功语义)。GC 只针对 generation(config 无代数)。
  for (const it of journal.items) {
    if (actionOf(it) !== "generation") continue
    const gc = gcGenerations(root, it.key, { keep: hooks.keepGenerations ?? KEEP_GENERATIONS_DEFAULT, log })
    warnings.push(...gc.warnings)
  }
  removeDirGuarded(root, txStagingDir(root, txId), warnings)
  lock.release()
  log("tx-committed", { txId, items: journal.items.map((it) => `${it.key}@${it.genId}`) })
  return { ok: true, txId, committed: records, warnings }
}

// ── 离线回滚(AC4:previous healthy rollback,默认保留代数支持前两个版本) ─────────────────────

export function rollbackToGeneration(
  root: string,
  key: string,
  genId: string,
  opts: { now?: () => Date; log?: TxLog; pidAlive?: (pid: number) => boolean; lockStaleMs?: number } = {},
): { ok: true; previous: string | null } | { ok: false; reason: string } {
  const now = opts.now ?? (() => new Date())
  if (!SAFE_KEY.test(key)) return { ok: false, reason: `invalid key: ${key}` }
  if (!GEN_NAME.test(genId)) return { ok: false, reason: `invalid generation id: ${genId}` }
  const acquired = tryAcquireBundleLock(root, {
    txId: newTxId(),
    now,
    log: opts.log,
    pidAlive: opts.pidAlive,
    staleMs: opts.lockStaleMs,
  })
  if (!acquired.ok) return { ok: false, reason: acquired.reason }
  try {
    const dir = generationDirOf(root, key, genId)
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return { ok: false, reason: `generation not on disk: ${genId}` }
    }
    const previous = readCurrentGeneration(root, key)?.genId ?? null
    if (previous === genId) return { ok: true, previous }
    writePointerSync(root, key, genId, newTxId(), now)
    return { ok: true, previous }
  } finally {
    acquired.lock.release()
  }
}

// ── 卸载(AC6:只删 transaction/generation 拥有的路径;未知条目保留 + loud) ───────────────────

export function uninstallExtension(
  root: string,
  key: string,
  opts: { now?: () => Date; log?: TxLog; pidAlive?: (pid: number) => boolean; lockStaleMs?: number } = {},
): { ok: true; removed: string[]; warnings: string[] } | { ok: false; reason: string; warnings: string[] } {
  const warnings: string[] = []
  const removed: string[] = []
  if (!SAFE_KEY.test(key)) return { ok: false, reason: `invalid key: ${key}`, warnings }
  const now = opts.now ?? (() => new Date())
  const acquired = tryAcquireBundleLock(root, {
    txId: newTxId(),
    now,
    log: opts.log,
    pidAlive: opts.pidAlive,
    staleMs: opts.lockStaleMs,
  })
  if (!acquired.ok) return { ok: false, reason: acquired.reason, warnings }
  try {
    deleteOwnedGenerationStore(root, key, removed, warnings)
    return { ok: true, removed, warnings }
  } finally {
    acquired.lock.release()
  }
}

/** 删 owned generation store(pointer/grants/generations/store dir),幂等,只删 generation-named 目录
 *  (未知条目保留 + loud)。REQ-100 #313:卸载与恢复补偿共用,store-first 顺序的删除原语。 */
/** 返回 hardFailure:**已知 owned path 删除失败**(指针/授权账/generation 目录/receipts 快照)——
 *  调用方必须保持 journal 非终态供恢复前滚(#346 Codex 裁决:删不掉 ≠ 删完了)。「未知条目保留」
 *  是设计行为(warning loud,不算 hard)。 */
function deleteOwnedGenerationStore(root: string, key: string, removed: string[], warnings: string[]): { hardFailure: boolean } {
  const { store, generations, pointer } = extensionStorePaths(root, key)
  if (!fs.existsSync(store)) return { hardFailure: false } // 幂等:已经不在
  let hardFailure = false
  if (fs.existsSync(pointer)) {
    try {
      clearPointerSync(root, key)
      removed.push(pointer)
    } catch (error) {
      warnings.push(`pointer clear failed: ${error instanceof Error ? error.message : String(error)}`)
      hardFailure = true
    }
  }
  // 授权账是事务拥有的路径(grants.json)—— 卸载一并清除,幂等
  const grantFile = capabilityGrantPath(root, key)
  if (fs.existsSync(grantFile)) {
    try {
      fs.unlinkSync(grantFile)
      removed.push(grantFile)
    } catch (error) {
      warnings.push(`grant removal failed: ${error instanceof Error ? error.message : String(error)}`)
      hardFailure = true
    }
  }
  if (fs.existsSync(generations)) {
    for (const name of fs.readdirSync(generations)) {
      const child = path.join(generations, name)
      if (!GEN_NAME.test(name)) {
        warnings.push(`uninstall kept unknown entry (not generation-owned): ${child}`)
        continue
      }
      if (removeDirGuarded(root, child, warnings)) removed.push(child)
      else hardFailure = true
    }
    try {
      fs.rmdirSync(generations) // 只在空时成功;有未知条目则保留 + 上面的 warning 已 loud
    } catch {
      /* non-empty → retained */
    }
  }
  // #313:receipts/(generation 描述符快照)是事务拥有路径 —— 卸载一并删,否则 rmdir store 失败。
  const snapDir = receiptSnapshotDir(root, key)
  if (fs.existsSync(snapDir)) {
    try {
      fs.rmSync(snapDir, { recursive: true, force: true })
      removed.push(snapDir)
    } catch (error) {
      warnings.push(`receipts dir removal failed: ${error instanceof Error ? error.message : String(error)}`)
      hardFailure = true
    }
  }
  try {
    fs.rmdirSync(store)
  } catch {
    if (fs.existsSync(store)) warnings.push(`uninstall kept non-empty store dir (unknown entries): ${store}`)
  }
  return { hardFailure }
}

export type UninstallHooks = {
  /** 账本删除接缝(artifact 删完、锁内调用):REQ-100 #313 store-first, ledger-second。抛错 → journal
   *  保持 uninstalling,恢复据此前滚补删账。 */
  commitLedger?: () => void | Promise<void>
  /** #346 action 判别:generation(缺省,删 ext-store)| config(锁内调用 removeArtifacts 删配置面)。 */
  action?: "generation" | "config"
  /** #346 config 卸载的 artifact 删除接缝(**锁内调用**,只准用 in-lock 原语,绝不重取 bundle 锁):
   *  config-leaf 删除 + 密钥吊销,必须幂等、失败必须抛错(→ journal 保持 uninstalling 前滚)。
   *  action=config 时必填 —— 缺失在写 journal 前就拒绝。 */
  removeArtifacts?: () => void | Promise<void>
  log?: TxLog
  now?: () => Date
  pidAlive?: (pid: number) => boolean
  lockStaleMs?: number
}

/**
 * 串行化 owned-path 卸载(REQ-100 #313):**锁内** journaled、store-first、ledger-second。
 * 崩溃在 store 删除与账本删除之间 → 留「有账不可运行」ghost,由 recoverExtensionTransactions 前滚补删账
 * (不留孤儿 generation,也绝不谎报成功)。commitLedger 抛错 → 返回失败且 journal 保持 uninstalling。 */
export async function uninstallExtensionTransaction(
  root: string,
  key: string,
  hooks: UninstallHooks = {},
): Promise<{ ok: true; removed: string[]; warnings: string[] } | { ok: false; reason: string; warnings: string[] }> {
  const warnings: string[] = []
  const removed: string[] = []
  if (!path.isAbsolute(root)) return { ok: false, reason: `root must be absolute: ${root}`, warnings }
  if (!SAFE_KEY.test(key)) return { ok: false, reason: `invalid key: ${key}`, warnings }
  const action = hooks.action ?? "generation"
  // #346:config 卸载缺 artifact 接缝 = 无法执行也无法恢复 —— 写 journal 前就拒(零副作用)。
  if (action === "config" && !hooks.removeArtifacts)
    return { ok: false, reason: "config uninstall requires a removeArtifacts hook — refused before journaling", warnings }
  const now = hooks.now ?? (() => new Date())
  const log = hooks.log ?? defaultLog
  const txId = newTxId()
  const acquired = tryAcquireBundleLock(root, { txId, now, log, pidAlive: hooks.pidAlive, staleMs: hooks.lockStaleMs })
  if (!acquired.ok) return { ok: false, reason: acquired.reason, warnings }
  try {
    const iso = now().toISOString()
    // journal 先记 intent(op=uninstall);item.key + action 供恢复补偿识别与分派。
    let journal: TxJournal = {
      v: 1,
      txId,
      op: "uninstall",
      state: "uninstalling",
      createdAt: iso,
      updatedAt: iso,
      items: [{ key, action, genId: "gen-000000-000000", files: [] }],
    }
    writeJournalSync(root, journal)
    // artifact-first(store/config)→ ledger-second。任一失败:journal 保持 uninstalling,恢复前滚。
    if (action === "config") {
      try {
        await hooks.removeArtifacts!()
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        warnings.push(`artifact removal failed — journal retained for recovery: ${msg}`)
        return { ok: false, reason: `uninstall artifact removal failed (will forward-complete on recovery): ${msg}`, warnings }
      }
    } else {
      const { hardFailure } = deleteOwnedGenerationStore(root, key, removed, warnings)
      if (hardFailure)
        return { ok: false, reason: `uninstall store removal incomplete (journal retained for recovery): ${warnings.join("; ")}`, warnings }
    }
    // ledger-second:锁内删账。抛错 → 不 mark 终态,恢复前滚补删。
    if (hooks.commitLedger) await hooks.commitLedger()
    journal = { ...journal, state: "uninstalled", updatedAt: now().toISOString() }
    writeJournalSync(root, journal)
    log("tx-uninstalled", { txId, key, action, removed: removed.length })
    return { ok: true, removed, warnings }
  } catch (error) {
    warnings.push(`ledger removal failed (artifacts already removed) — recovery will complete: ${error instanceof Error ? error.message : String(error)}`)
    return { ok: false, reason: `uninstall ledger commit failed: ${error instanceof Error ? error.message : String(error)}`, warnings }
  } finally {
    acquired.lock.release()
  }
}

export type RollbackHooks = {
  /** 锁内回调:据目标 gen 快照 + 当前账本构造回滚 receipt(不透明;逻辑 generation 递增、
   *  previousDigest 指回滚前 live、desiredState 用当前策略)。返回 null = 快照缺失/损坏 → abort 零变更。 */
  resolveReceipt: (targetGenId: string) => unknown | null
  probe?: HealthProbe
  commitReceipt: (record: TxCommitRecord) => void | Promise<void>
  log?: TxLog
  now?: () => Date
  pidAlive?: (pid: number) => boolean
  lockStaleMs?: number
}

/**
 * 两版离线回滚(REQ-100 #313):**锁内** journaled —— probe 验目标 gen 健康 + 严格读快照构造新 receipt
 * 修订 → 翻 current.json 指针 → commitReceipt 落新修订。任一前置失败(目录缺失/probe/快照)= 零变更。
 * 崩溃在翻指针与落账之间 → recoverExtensionTransactions 从 journal receipt 前滚补账(receipt 与 live 不分叉)。 */
export async function rollbackGenerationTransaction(
  root: string,
  key: string,
  targetGenId: string,
  hooks: RollbackHooks,
): Promise<{ ok: true; previous: string | null } | { ok: false; reason: string }> {
  if (!path.isAbsolute(root)) return { ok: false, reason: `root must be absolute: ${root}` }
  if (!SAFE_KEY.test(key)) return { ok: false, reason: `invalid key: ${key}` }
  if (!GEN_NAME.test(targetGenId)) return { ok: false, reason: `invalid generation id: ${targetGenId}` }
  const now = hooks.now ?? (() => new Date())
  const log = hooks.log ?? defaultLog
  const txId = newTxId()
  const acquired = tryAcquireBundleLock(root, { txId, now, log, pidAlive: hooks.pidAlive, staleMs: hooks.lockStaleMs })
  if (!acquired.ok) return { ok: false, reason: acquired.reason }
  try {
    const dir = generationDirOf(root, key, targetGenId)
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { ok: false, reason: `generation not on disk: ${targetGenId}` }
    const previous = readCurrentGeneration(root, key)?.genId ?? null
    if (previous === targetGenId) return { ok: true, previous } // 已是目标
    // 健康门:目标 gen 必须通过类型化 probe(零变更前置)。
    if (hooks.probe) {
      const verdict = await hooks.probe({ key, action: "generation", genId: targetGenId, generationDir: dir, phase: "pre-switch" })
      if (!verdict.healthy) return { ok: false, reason: `rollback target unhealthy: ${verdict.reason}` }
    }
    const receipt = hooks.resolveReceipt(targetGenId)
    if (receipt === null || receipt === undefined) return { ok: false, reason: `rollback receipt unavailable for ${targetGenId} (snapshot missing/corrupt)` }
    const iso = now().toISOString()
    let journal: TxJournal = {
      v: 1,
      txId,
      op: "rollback",
      state: "switching",
      createdAt: iso,
      updatedAt: iso,
      items: [{ key, genId: targetGenId, files: [], receipt, previousGeneration: previous }],
    }
    writeJournalSync(root, journal)
    writePointerSync(root, key, targetGenId, txId, now) // 原子翻指针
    journal = { ...journal, state: "switched", updatedAt: now().toISOString() }
    writeJournalSync(root, journal)
    const record = buildCommitRecord(root, txId, journal.items[0]!, now().toISOString())
    await hooks.commitReceipt(record) // 落新 receipt 修订
    journal = { ...journal, state: "committed", updatedAt: now().toISOString() }
    writeJournalSync(root, journal)
    log("tx-rolled-forward", { txId, key, target: targetGenId, previous })
    return { ok: true, previous }
  } catch (error) {
    if (error instanceof ExtTxCrashError) throw error
    return { ok: false, reason: `rollback failed: ${error instanceof Error ? error.message : String(error)}` }
  } finally {
    acquired.lock.release()
  }
}

// ── 崩溃恢复 ─────────────────────────────────────────────────────────────────────────────────

export type TxRecoveryAction = "none" | "cleaned" | "aborted" | "rolled-back" | "resumed-committed"
/** corrupt=true:本轮遇到不可解析 journal(已移 .corrupt-* 留证)—— 写方 gate 必须把该轮判为
 *  阻断(不能仅因 .json 已移走就判安全,#347 Codex 裁决);下轮无 corrupt 即可放行。 */
export type TxRecoveryReport = { txId: string; state: TxState; action: TxRecoveryAction; detail: string; corrupt?: boolean }

const TERMINAL_TX_STATES = new Set<TxState>(["committed", "rolled-back", "aborted", "uninstalled"])

/** ADR-030(#372)只读巡检:列出根下全部 journal 的 {txId, op, state};不可解析的 journal 以
 *  state:"unreadable" 报告(调用方必须视同在途 —— 无法证明它不是)。`unreadableDir` 区分
 *  「journal 目录不存在 = 确无 journal」与「目录在但枚举失败 = 失据,调用方必须 fail-closed」
 *  (Codex review PR#373 M2:枚举错误不得静默当作零)。零写入、不持锁:仅用于残留报告与
 *  「清理前有无在途手术」判定,真正的收敛仍归 recoverExtensionTransactions。 */
export type TxJournalProbe = { txId: string; op: "install" | "uninstall" | "rollback"; state: TxState | "unreadable"; terminal: boolean }
export function probeTransactionJournals(root: string): { entries: TxJournalProbe[]; unreadableDir: boolean } {
  if (!path.isAbsolute(root)) return { entries: [], unreadableDir: true }
  const dir = journalDir(root)
  let names: string[] = []
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"))
  } catch (error) {
    // review #376 Blocker:只有 ENOENT 可解释为「目录不存在且确无 journal」;ENOTDIR
    // (journal 位置被普通文件占据)与其它枚举失败一律失据 → 调用方必须 fail-closed。
    const code = (error as NodeJS.ErrnoException).code
    return { entries: [], unreadableDir: code !== "ENOENT" }
  }
  const entries = names.sort().map((name) => {
    const txId = name.slice(0, -".json".length)
    const journal = readTransactionJournal(root, txId)
    if (!journal) return { txId, op: "install" as const, state: "unreadable" as const, terminal: false }
    return { txId, op: journal.op ?? "install", state: journal.state, terminal: TERMINAL_TX_STATES.has(journal.state) }
  })
  return { entries, unreadableDir: false }
}

/** REQ-099 #309(Codex review #357 major):`ok:true` ≠ 恢复干净 —— aborted/rolled-back 报告、
 *  以及「still failing — retained for retry」类非终态 journal 都返回 ok:true。迁移等只该在
 *  账本无在途手术时进行的动作,用本谓词判定;不干净只损失一次启动窗口,下次干净再做。 */
export function recoveryClean(r: { ok: boolean; reports: TxRecoveryReport[] }): boolean {
  if (!r.ok) return false
  return r.reports.every((rep) => rep.action !== "aborted" && rep.action !== "rolled-back" && TERMINAL_TX_STATES.has(rep.state))
}

export type RecoverOptions = {
  probe?: HealthProbe
  commitReceipt?: (records: TxCommitRecord[]) => void | Promise<void>
  /** REQ-100 #313:卸载恢复的账本删除接缝(按 key 幂等去账)。缺失时卸载 journal **保持非终态**
   *  (#346 修正:此前缺 seam 仍标 uninstalled = 假终态)。 */
  commitUninstall?: (key: string) => void | Promise<void>
  /** #346:config 卸载恢复的 artifact 删除接缝(config-leaf + 密钥,幂等)。**恢复锁内调用** ——
   *  实现只准用 in-lock 原语,绝不重取 bundle 锁。缺失时 config 卸载 journal 保持非终态。 */
  uninstallArtifacts?: (key: string) => void | Promise<void>
  log?: TxLog
  now?: () => Date
  pidAlive?: (pid: number) => boolean
  lockStaleMs?: number
  keepQuarantine?: number
  keepJournals?: number
}

/**
 * 启动期 / 下一次事务前调用:把 journal 里所有非终态事务收敛到终态,恢复不变量。
 * 各状态的处置(状态机的崩溃恢复列):
 *   staging / staged / materialized —— switch 从未发生 → live 全量未动:删 staging 残留 +
 *     未被指针引用的 generation 目录,journal → aborted(retryable,清晰提示可重试);
 *   switching / switched —— commit 意图已持久化但 health/receipt 未确认:
 *     · 全部 item 已翻转 ∧ 注入了 probe ∧ 全部 recovery 探测健康 ∧ 注入了 commitReceipt
 *       → 前滚:重放 receipt(幂等 upsert)→ journal committed;
 *     · 否则(部分翻转 = Bundle 原子性破缺,或健康未知/失败)→ 回滚:指针回 previous
 *       (journal 里在翻转前就持久化了),失败 generation 全部隔离(带收据),journal rolled-back;
 *   终态 —— 只清 staging 残留。
 * 恢复本身持 Bundle 锁(与并发事务互斥);锁被活进程持有 → 如实返回 skipped。
 */
export async function recoverExtensionTransactions(
  root: string,
  opts: RecoverOptions = {},
): Promise<{ ok: boolean; reason?: string; reports: TxRecoveryReport[] }> {
  const log = opts.log ?? defaultLog
  const now = opts.now ?? (() => new Date())
  const reports: TxRecoveryReport[] = []
  if (!path.isAbsolute(root)) return { ok: false, reason: `root must be absolute: ${root}`, reports }
  if (!fs.existsSync(path.join(root, TX_DIR))) return { ok: true, reports }

  const acquired = tryAcquireBundleLock(root, {
    txId: `tx-recovery-${crypto.randomBytes(4).toString("hex")}`,
    now,
    log,
    pidAlive: opts.pidAlive,
    staleMs: opts.lockStaleMs,
  })
  if (!acquired.ok) return { ok: false, reason: `recovery skipped: ${acquired.reason}`, reports }
  const lock = acquired.lock

  try {
    // 不可解析的 journal:移开留证(loud),绝不静默删
    let names: string[] = []
    try {
      names = fs.readdirSync(journalDir(root)).filter((n) => n.endsWith(".json"))
    } catch {
      /* no journals */
    }
    for (const name of names.sort()) {
      const txId = name.slice(0, -".json".length)
      const journal = readTransactionJournal(root, txId)
      if (!journal) {
        const from = journalPath(root, txId)
        const to = `${from}.corrupt-${Date.now()}`
        try {
          fs.renameSync(from, to)
        } catch {
          /* best-effort */
        }
        log("recovery-journal-corrupt", { txId, movedTo: to })
        reports.push({ txId, state: "aborted", action: "cleaned", detail: `unreadable journal moved to ${to}`, corrupt: true })
        continue
      }
      reports.push(
        journal.op === "uninstall"
          ? await recoverUninstall(root, journal, opts, now, log)
          : journal.op === "rollback"
            ? await recoverRollback(root, journal, opts, now, log)
            : await recoverOne(root, journal, opts, now, log),
      )
    }
    // 有界清理:quarantine + 终态 journal
    const warnings: string[] = []
    gcQuarantine(root, { keep: opts.keepQuarantine ?? QUARANTINE_KEEP_DEFAULT }).warnings.forEach((w) =>
      warnings.push(w),
    )
    gcTerminalJournals(root, opts.keepJournals ?? JOURNAL_KEEP_DEFAULT, warnings)
    for (const w of warnings) log("recovery-gc-warning", { warning: w })
    return { ok: true, reports }
  } finally {
    lock.release()
  }
}

/** 卸载恢复补偿(REQ-100 #313):前滚 —— 幂等完成 store 删除 + 账本删除,直到终态。账本删除仍失败
 *  则保持 uninstalling 供下次前滚(绝不谎报完成)。在 recoverExtensionTransactions 的恢复锁内运行。 */
async function recoverUninstall(
  root: string,
  journal: TxJournal,
  opts: RecoverOptions,
  now: () => Date,
  log: TxLog,
): Promise<TxRecoveryReport> {
  const txId = journal.txId
  if (journal.state === "uninstalled") return { txId, state: journal.state, action: "none", detail: "already terminal" }
  // #346:空/多 item、畸形 item(key/genId/files/state)、未知 action、缺 seam —— 一律保持非终态
  // (绝不静默终态化;gate 依据终态放行)。review #374 Major:只校数量不校形状会让 key="bogus"
  // 走 generation 分派 + 空 store 视为已删 → 假终态。
  const item = journal.items[0]
  if (!item || journal.items.length !== 1)
    return { txId, state: journal.state, action: "none", detail: "malformed uninstall journal (items) — retained for manual diagnosis" }
  if (journal.state !== "uninstalling")
    return { txId, state: journal.state, action: "none", detail: `unexpected state "${journal.state}" for op=uninstall — retained for manual diagnosis` }
  const key = item.key
  if (typeof key !== "string" || !SAFE_KEY.test(key) || key.indexOf("--") <= 0)
    return { txId, state: journal.state, action: "none", detail: `malformed uninstall journal (key "${String(key)}") — retained for manual diagnosis` }
  if (!Array.isArray(item.files) || typeof item.genId !== "string" || (item.genId !== "gen-000000-000000" && !GEN_NAME.test(item.genId)))
    return { txId, state: journal.state, action: "none", detail: "malformed uninstall journal (item shape) — retained for manual diagnosis" }
  const action = actionOf(item)
  const warnings: string[] = []
  const removed: string[] = []
  if (action === "config") {
    if (!opts.uninstallArtifacts)
      return { txId, state: journal.state, action: "none", detail: "missing uninstallArtifacts seam — retained for retry" }
    try {
      await opts.uninstallArtifacts(key) // 恢复锁内;幂等重放 config-leaf + 密钥净除
    } catch (error) {
      warnings.push(`recovery artifact removal failed: ${error instanceof Error ? error.message : String(error)}`)
      log("recovery-uninstall-pending", { txId, key, warnings })
      return { txId, state: journal.state, action: "none", detail: "artifact removal still failing — retained for retry" }
    }
  } else if (action === "generation") {
    const { hardFailure } = deleteOwnedGenerationStore(root, key, removed, warnings) // 幂等:store 可能已删
    if (hardFailure) {
      log("recovery-uninstall-pending", { txId, key, warnings })
      return { txId, state: journal.state, action: "none", detail: "store removal still failing — retained for retry" }
    }
  } else {
    return { txId, state: journal.state, action: "none", detail: `unknown uninstall action "${action}" — retained for manual diagnosis` }
  }
  if (!opts.commitUninstall)
    return { txId, state: journal.state, action: "none", detail: "missing commitUninstall seam — retained for retry" }
  try {
    await opts.commitUninstall(key)
  } catch (error) {
    warnings.push(`recovery uninstall ledger removal failed: ${error instanceof Error ? error.message : String(error)}`)
    log("recovery-uninstall-pending", { txId, key, warnings })
    return { txId, state: journal.state, action: "none", detail: "ledger removal still failing — retained for retry" }
  }
  writeJournalSync(root, { ...journal, state: "uninstalled", updatedAt: now().toISOString() })
  for (const w of warnings) log("recovery-uninstall-warning", { txId, warning: w })
  log("recovery-uninstalled", { txId, key, action })
  return { txId, state: journal.state, action: "resumed-committed", detail: "uninstall forward-completed" }
}

/** 回滚恢复补偿(REQ-100 #313):前滚 —— 确保指针翻到目标 gen,并从 journal receipt 补落新修订。
 *  receipt commit 仍失败 → 保持非终态供下次前滚。在恢复锁内运行。 */
async function recoverRollback(
  root: string,
  journal: TxJournal,
  opts: RecoverOptions,
  now: () => Date,
  log: TxLog,
): Promise<TxRecoveryReport> {
  const txId = journal.txId
  const it = journal.items[0]
  if (!it || journal.state === "committed") return { txId, state: journal.state, action: "none", detail: "already terminal" }
  if (readCurrentGeneration(root, it.key)?.genId !== it.genId) writePointerSync(root, it.key, it.genId, txId, now) // 幂等翻指针
  // #346 修正:receipt 在而 commitReceipt seam 缺 → 保持非终态(此前会跳过落账仍标 committed = 假终态)。
  if (it.receipt !== undefined && !opts.commitReceipt)
    return { txId, state: journal.state, action: "none", detail: "missing commitReceipt seam — retained for retry" }
  if (opts.commitReceipt && it.receipt !== undefined) {
    try {
      await opts.commitReceipt([buildCommitRecord(root, txId, it, now().toISOString())])
    } catch (error) {
      log("recovery-rollback-pending", { txId, key: it.key, warning: error instanceof Error ? error.message : String(error) })
      return { txId, state: journal.state, action: "none", detail: "receipt commit still failing — retained for retry" }
    }
  }
  writeJournalSync(root, { ...journal, state: "committed", updatedAt: now().toISOString() })
  log("recovery-rolled-forward", { txId, key: it.key, target: it.genId })
  return { txId, state: journal.state, action: "resumed-committed", detail: "rollback forward-completed" }
}

async function recoverOne(
  root: string,
  journal: TxJournal,
  opts: RecoverOptions,
  now: () => Date,
  log: TxLog,
): Promise<TxRecoveryReport> {
  const txId = journal.txId
  const warnings: string[] = []
  const finish = (state: TxState, reason: string): void => {
    writeJournalSync(root, { ...journal, state, reason, updatedAt: now().toISOString() })
  }
  const staleStaging = txStagingDir(root, txId)

  if (journal.state === "committed" || journal.state === "rolled-back" || journal.state === "aborted") {
    if (fs.existsSync(staleStaging)) {
      removeDirGuarded(root, staleStaging, warnings)
      return { txId, state: journal.state, action: "cleaned", detail: "removed leftover staging dir" }
    }
    return { txId, state: journal.state, action: "none", detail: "already terminal" }
  }

  if (journal.state === "staging" || journal.state === "staged" || journal.state === "materialized") {
    // switch 未发生 → live 未动:删 staging + 未被引用的 generation 残留(mid-materialize 崩溃会留下)
    removeDirGuarded(root, staleStaging, warnings)
    for (const it of journal.items) {
      const dir = generationDirOf(root, it.key, it.genId)
      const current = readCurrentGeneration(root, it.key)
      if (current?.genId === it.genId) continue // 防御:理论不可达(此状态从未翻转)
      if (fs.existsSync(dir)) removeDirGuarded(root, dir, warnings)
    }
    const reason = "crash recovery: transaction interrupted before switch — no changes applied; retry the install"
    finish("aborted", reason)
    log("recovery-aborted", { txId, priorState: journal.state, warnings })
    return { txId, state: journal.state, action: "aborted", detail: reason }
  }

  // switching / switched:commit 意图已持久化,health/receipt 未确认。逐 action 判定翻转:
  //   generation → current.json 指针 === genId;config → live target digest === nextDigest;
  //   file → live target 存在且 digest === nextDigest(#358;next 恒非空,缺席即未翻转);receipt → 恒真。
  const sha256Text = (t: string): string => crypto.createHash("sha256").update(t, "utf8").digest("hex")
  const configTargetDigest = (target: string): string | null => {
    try {
      return sha256Text(fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "{}")
    } catch {
      return null
    }
  }
  const fileTargetDigest = (target: string): string | null => {
    try {
      if (!fs.existsSync(target)) return null
      return crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex")
    } catch {
      return null
    }
  }
  const reconstructConfigImage = (it: TxJournalItem): ConfigTxImage | null => {
    if (actionOf(it) !== "config" || !it.config) return null
    const r = readStagedConfigImage(staleStaging, it.config.slot, it.config.target, it.config.preDigest, it.config.nextDigest)
    return r.ok ? r.image : null
  }
  const reconstructFileImage = (it: TxJournalItem): FileTxImage | null => {
    if (actionOf(it) !== "file" || !it.file) return null
    // #358 review Blocker 2:恢复路径同样不得信任 journal 里的 relTarget —— 形状 + 圈禁重验。
    if (typeof it.file.relTarget !== "string" || !isSafeRelPath(it.file.relTarget)) return null
    if (!confineFileTarget(root, it.file.relTarget).ok) return null
    const r = readStagedFileImage(staleStaging, it.file.slot, path.join(root, it.file.relTarget), it.file.preDigest, it.file.nextDigest, it.file.preAbsent)
    return r.ok ? r.image : null
  }
  const isFlipped = (it: TxJournalItem): boolean => {
    const kind = actionOf(it)
    if (kind === "receipt") return true
    if (kind === "config") return it.config ? configTargetDigest(it.config.target) === it.config.nextDigest : false
    // file(r5 Blocker):翻转 = **本事务已 apply(journal 进度)∧ live digest 命中** —— 只看
    // digest 会把旁路植入的同 digest 文件误认本事务输出(前滚落账 = 认领外部内容)。
    // r6 Blocker(持久化兼容):#358 时代的 legacy file journal 无 requireAbsent/applied 字段
    // (以 requireAbsent === undefined 判别)—— 按其发布时语义退回纯 digest 判定,否则升级后
    // 在途 already-switched journal 会被误判未翻转而错误回滚(receipt 已提交时即双真源分叉)。
    if (kind === "file") {
      if (!it.file) return false
      const digestHit = fileTargetDigest(path.join(root, it.file.relTarget)) === it.file.nextDigest
      const legacy = it.file.requireAbsent === undefined
      return legacy ? digestHit : it.file.applied === true && digestHit
    }
    return readCurrentGeneration(root, it.key)?.genId === it.genId
  }
  // #358 review r2 Blocker:对 journal file 段的**任何**采信(isFlipped digest 读、probe、
  // receipt replay 前滚)都必须先过形状 + 圈禁 —— 否则 `<root>/agents` 被换成 root 外 symlink
  // 且外部文件恰好匹配 nextDigest 时,前滚会为逃逸 root 的文件落账并解除 recovery gate。
  for (const it of journal.items) {
    if (actionOf(it) !== "file") continue
    if (!it.file || typeof it.file.relTarget !== "string" || !isSafeRelPath(it.file.relTarget) || !confineFileTarget(root, it.file.relTarget).ok) {
      const detail = `file target validation failed for "${it.key}" (shape/confinement) — retained for manual diagnosis`
      log("recovery-file-retained", { txId, key: it.key, detail })
      return { txId, state: journal.state, action: "none", detail }
    }
  }
  const allFlipped = journal.items.every(isFlipped)

  if (allFlipped && opts.probe && opts.commitReceipt) {
    let healthy = true
    let probeReason = ""
    for (const it of journal.items) {
      const kind = actionOf(it)
      if (kind !== "generation" && kind !== "file") continue // config/receipt 不做类型化探测
      const dir = kind === "generation" ? generationDirOf(root, it.key, it.genId) : ""
      try {
        const verdict = await opts.probe({
          key: it.key,
          action: kind,
          genId: it.genId,
          generationDir: dir,
          phase: "recovery",
          ...(kind === "file" && it.file ? { fileTarget: path.join(root, it.file.relTarget), fileDigest: it.file.nextDigest } : {}),
        })
        if (!verdict.healthy) {
          healthy = false
          probeReason = `health probe failed for "${it.key}": ${verdict.reason}`
          break
        }
      } catch (error) {
        healthy = false
        probeReason = `health probe threw for "${it.key}": ${error instanceof Error ? error.message : String(error)}`
        break
      }
    }
    if (healthy) {
      const committedAt = now().toISOString()
      const records: TxCommitRecord[] = journal.items.map((it) => buildCommitRecord(root, txId, it, committedAt))
      try {
        await opts.commitReceipt(records) // 幂等 upsert(接缝契约)
        for (const it of journal.items)
          if (actionOf(it) === "generation") writeReceiptSnapshot(root, it.key, it.genId, it.receipt, committedAt) // #313 快照前滚
        removeDirGuarded(root, staleStaging, warnings)
        finish("committed", "crash recovery: switch verified healthy — receipt replayed")
        // 前滚 = committed:授权账与授权收据同样落位(幂等;主路径同一 helper)
        writeCommitAuthorizationSync(root, { ...journal, state: "committed" }, now, warnings)
        for (const w of warnings) log("recovery-warning", { txId, warning: w })
        log("recovery-resumed", { txId })
        return { txId, state: journal.state, action: "resumed-committed", detail: "probe healthy; receipt replayed" }
      } catch (error) {
        warnings.push(`receipt replay failed: ${error instanceof Error ? error.message : String(error)}`)
        // 落回滚路径:receipt 无法落 → live 不得与 receipt 背离
      }
    } else {
      warnings.push(probeReason)
    }
  }

  // 回滚:config/file 逆序恢复(target 仍是 next 态才恢复前像)+ generation 指针回 previous + 隔离失败代。
  // #358 review Blocker 3:file image 不可重建(staging 丢失/journal 段非法/圈禁不过)= 失据 ——
  // **保留非终态**供重试/人工处置,零改动零终态化;绝不在失据时宣称 rolled-back(那会同时留下
  // 半装态并撤销非终态 journal 对后续写操作的阻断)。
  for (const it of journal.items) {
    if (actionOf(it) !== "file") continue
    if (!reconstructFileImage(it)) {
      const detail = `file image unrecoverable for "${it.key}" (staging lost/journal malformed/confinement failed) — retained for retry or manual diagnosis`
      log("recovery-file-retained", { txId, key: it.key, detail })
      return { txId, state: journal.state, action: "none", detail }
    }
  }
  const reasonParts = [
    allFlipped ? "health not confirmed after crash" : "bundle partially switched at crash (atomicity restored)",
    ...warnings,
  ]
  const reason = `crash recovery rollback: ${reasonParts.join("; ")}`
  let fileRestoreBlocked: string | null = null
  for (const it of [...journal.items].reverse()) {
    const kind = actionOf(it)
    if (kind === "config") {
      const image = reconstructConfigImage(it)
      if (!image) {
        warnings.push(`config recovery: cannot reconstruct image for "${it.key}" — leaving live as-is (fail closed)`)
        continue
      }
      const restored = restoreConfigImage(image)
      if (!restored.ok) warnings.push(`config recovery rollback for "${it.key}": ${restored.reason}`)
    } else if (kind === "file") {
      // r3 Blocker:预扫与此处之间仍有 config 恢复等异步间隙 —— restore 前紧邻再重验一次圈禁。
      const confined = it.file ? confineFileTarget(root, it.file.relTarget) : { ok: false as const, reason: "missing file journal segment" }
      if (!confined.ok) {
        fileRestoreBlocked = `file recovery rollback for "${it.key}": ${confined.reason}`
        continue
      }
      // r5 Blocker:崩溃前未 apply 的 requireAbsent item —— live 在场(同/异 digest 皆然)=
      // 窗口植入,绝不 unlink,保留非终态留证;缺席 = 无事可回。
      if (it.file?.requireAbsent && it.file.applied !== true) {
        if (fs.existsSync(path.join(root, it.file.relTarget)))
          fileRestoreBlocked = `file recovery rollback for "${it.key}": bypass-planted content at an unapplied target — retained as evidence`
        continue
      }
      const restored = restoreFileImage(reconstructFileImage(it)!) // 上方预扫已证明可重建
      if (!restored.ok) fileRestoreBlocked = `file recovery rollback for "${it.key}": ${restored.reason}`
    }
  }
  // #358 review Blocker 3:file 恢复被旁路改写挡住(target 既非 pre 也非 next)= 现场需人工核对 ——
  // 保留非终态 + staging(证据与重试依据),不隔离、不终态化。已完成的 config 恢复幂等(下轮 noop)。
  if (fileRestoreBlocked) {
    log("recovery-file-retained", { txId, detail: fileRestoreBlocked })
    return { txId, state: journal.state, action: "none", detail: `${fileRestoreBlocked} — retained for manual diagnosis` }
  }
  for (const it of journal.items) {
    if (actionOf(it) !== "generation") continue
    const current = readCurrentGeneration(root, it.key)
    if (current?.genId !== it.genId) continue
    const prev = it.previousGeneration ?? null
    if (prev && fs.existsSync(generationDirOf(root, it.key, prev))) {
      writePointerSync(root, it.key, prev, txId, now)
    } else {
      if (prev) warnings.push(`previous generation ${prev} missing for "${it.key}" — pointer cleared (fail closed)`)
      try {
        clearPointerSync(root, it.key)
      } catch (error) {
        warnings.push(`pointer clear failed for "${it.key}": ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  quarantineGenerations(
    root,
    txId,
    journal.items.filter((it) => actionOf(it) === "generation").map((it) => ({ key: it.key, genId: it.genId, dir: generationDirOf(root, it.key, it.genId) })),
    reason,
    "crash-recovery",
    now,
    warnings,
  )
  removeDirGuarded(root, staleStaging, warnings)
  finish("rolled-back", reason)
  log("recovery-rolled-back", { txId, priorState: journal.state, reason, warnings })
  return { txId, state: journal.state, action: "rolled-back", detail: reason }
}
