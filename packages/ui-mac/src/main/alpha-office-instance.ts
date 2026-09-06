// alpha-office-instance — REQ-155 `#1244`:四个 Alpha 随包 Office 连接器的安装记录**跟随运行中的实例**,
// 不跟随安装那一刻冻结进去的 app 包路径,也不跟随它们当初被装进去的那个渠道根。
//
// ── 地面真相(2026-09-04,owner 本机,实读)──────────────────────────────────────────────
// app 从 prod 切到 dev 渠道之后:dev 根 `installs.json` = `{"receipts":[],"records":[]}`、`alpha.jsonc`
// 无 `mcp` 键;prod 根里四条 committed 记录仍在,而它们的 `alpha.jsonc` 命令指着
// `/Applications/alpha-code.app/Contents/Resources/office-mcp/server.py` —— 那个路径已不存在
// (应用现名 `Code Puppy.app`)。于是 `office-docs` 技能照常生效,而它推荐的四个工具一个都不在。
//
// ── 哪两件事是「实例特有」的,不该被当成 durable 真相 ───────────────────────────────────
//   · **随包 server 的绝对路径**:`ext-mcp-policy` 在安装时把 `{alphaResources}` 解析成**当时那个**
//     bundle 的 realpath 写进 `alpha.jsonc`。bundle 改名 / 挪动 / 更新,这个路径就悬空了。
//   · **渠道根**:REQ-098 让 `env/{prod,beta,dev}` 三根恒为兄弟;切渠道等于从一个空根起步。
// 唯一 durable 的事实是用户的**意图**:「随包 Word/Excel/PowerPoint/PDF 连接器已装,且 enabled|disabled」。
// 本 boot reconcile 把前者从**运行中的实例**重新派生,把后者从**兄弟渠道根**收养过来。每次启动跑一次,
// 排在第一次 sidecar fork 之前(锚在 alpha-office-instance.test.ts;index.ts 结构上进不了 bun)。
//
// ── 两个收窄式操作,都幂等、都 fail-closed ───────────────────────────────────────────────
//   1. **re-anchor**:当前根里的 Alpha Office `mcp.<name>` 叶子,命令与钉死模板逐 token 相同、只有
//      server 槽指着另一个绝对 `…/office-mcp/server.py` ⇒ 把 server 槽改写成当前 bundle 的 canonical
//      路径。命令里别的一个字不动(workspace 槽可能还是遗留的具体路径 —— 紧接着跑的
//      `reconcileMcpWorkspaceMarkers` 会把它还原成 `{workspace}`,而它认模板**需要**当前 server 路径,
//      所以本步必须排在它前面)。账本不动:record 的身份事实没变。
//   2. **adopt**:当前根里**完全没有**该连接器(既无 v2 record 也无 v1 receipt),而某个兄弟根里有一条
//      committed、catalog 来源、global scope 的 v2 record 加上它的配置叶子 ⇒ 经**与安装同一道写策略**
//      (`applyMcpWritePolicy`:canonical server、`{workspace}` 标记、REQ-133 安全检查、内容 digest)
//      写进当前根。`desiredState` 照抄、能力授权账照抄、transaction id 新铸。多个兄弟都有时取
//      `updatedAt ?? installedAt` 最新的那条。**兄弟根只读**:不写、不 quarantine(sideEffectFree 读)。
// 其余一切 —— 自定义 MCP、非 Office 的 catalog MCP、模板漂移、到处都没有的(用户卸载过的)连接器、
// 损坏账本 —— 逐字节不动,并如实报告。两条路都不会产生「有 record 无叶子 / 有叶子无 record」的半状态:
// adopt 先探账本可写、再写 record、再写叶子,叶子写失败即撤回 record。
//
// 不在本模块辖区(有意):record 的 `payloadDigest` 不随 bundle 更新而重算 —— 那是既有行为
// (安装时一次性记录),与本票「陈旧路径」无关,单独立票。

import { readFileSync, realpathSync } from "node:fs"
import { isAbsolute, join, win32 } from "node:path"
import { applyEdits, modify, parse } from "jsonc-parser"
import type { ParseError } from "jsonc-parser"
import {
  ALPHA_OFFICE_CONNECTORS,
  WORKSPACE_MARKER,
  alphaOfficeInstallCommand,
  type AlphaOfficeFormat,
} from "../shared/office-advisories"
import { alphaSiblingEnvironmentRoots, getAlphaEnvironment, type AppEnvironment } from "./alpha-environment"
import { alphaGlobalRoot } from "./alpha-installs"
import { readCapabilityGrant, writeCapabilityGrantSync } from "./ext-capability-grants"
import { mcpPluginTargetPath, validateServer, writeConfigTextAtomic } from "./ext-config"
import { resourcesRoot } from "./ext-fs-installer"
import { applyMcpWritePolicy } from "./ext-mcp-policy"
import { probeLedgerForWrite, readLedgerV2, removeRecordV2, upsertRecordV2, type InstallRecordV2 } from "./ext-receipt-v2"

const ALPHA_OFFICE_SERVER_MARKER = "{alphaResources}/office-mcp/server.py"
const SERVER_SUFFIX = "/office-mcp/server.py"
const CONFIG_FILE = "alpha.jsonc"
const LOG_TAG = "[req155-1244]"

export type OfficeSiblingRoot = { environment: AppEnvironment; root: string }

export type OfficeInstanceReconcileOptions = {
  /** 当前环境;缺省 = 冻结快照。 */
  environment?: AppEnvironment
  /** 当前环境 mutable root;缺省 = 冻结快照。 */
  currentRoot?: string
  /** 只读的兄弟根;缺省 = 冻结快照派生的另外两根。 */
  siblings?: OfficeSiblingRoot[]
  /** 当前根的 alpha.jsonc;缺省 = `<currentRoot>/alpha.jsonc`,且必须与 mcpPluginTargetPath() 一致。 */
  configPath?: string
  /** 当前 bundle 的 canonical server 路径;`null` = 解析不到(本次什么都不做)。缺省 = 从 resourcesRoot 解析。 */
  alphaOfficeServerPath?: string | null
  now?: () => string
  transactionId?: (name: string) => string
  logError?: (message: string) => void
}

export type OfficeInstanceReconcileOutcome = {
  /** 当前根里 server 槽被改写到当前 bundle 的连接器名。 */
  reanchored: string[]
  /** 从兄弟根收养进当前根的连接器名。 */
  adopted: string[]
  warnings: string[]
}

type Connector = (typeof ALPHA_OFFICE_CONNECTORS)[number]

/** 与钉死模板逐 token 比对,只放过 server 槽(任意绝对 `…/office-mcp/server.py`)与 workspace 槽
 *  (`{workspace}` 或绝对路径)。server 槽已是当前路径 ⇒ null(无事可做)。模板漂移 ⇒ null(不碰)。 */
export function reanchorOfficeCommand(format: AlphaOfficeFormat, command: unknown, currentServer: string): string[] | null {
  if (!isStringArray(command)) return null
  const template = alphaOfficeInstallCommand(format)
  const serverIndex = template.indexOf(ALPHA_OFFICE_SERVER_MARKER)
  const workspaceIndex = template.indexOf(WORKSPACE_MARKER)
  if (command.length !== template.length) return null
  for (let index = 0; index < template.length; index += 1) {
    if (index === serverIndex || index === workspaceIndex) continue
    if (command[index] !== template[index]) return null
  }
  const server = command[serverIndex]!
  if (!isAbsoluteAny(server) || !normalizeSlashes(server).endsWith(SERVER_SUFFIX)) return null
  if (server === currentServer) return null
  const workspace = command[workspaceIndex]!
  if (workspace !== WORKSPACE_MARKER && !isAbsoluteAny(workspace)) return null
  return command.map((argument, index) => (index === serverIndex ? currentServer : argument))
}

/** adopt 前的形状归一:同一模板匹配(server 槽任意绝对 server 路径),workspace 槽若是遗留的具体绝对
 *  路径则还原成 `{workspace}`(REQ-134:catalog MCP 的 workspace 跟随实例,不是安装时那台机器的目录)。
 *  模板不匹配原样返回 —— 让写策略去拒绝,并把理由说出来。 */
function normalizeWorkspaceSlot(format: AlphaOfficeFormat, command: string[]): string[] {
  const template = alphaOfficeInstallCommand(format)
  const serverIndex = template.indexOf(ALPHA_OFFICE_SERVER_MARKER)
  const workspaceIndex = template.indexOf(WORKSPACE_MARKER)
  if (command.length !== template.length) return command
  for (let index = 0; index < template.length; index += 1) {
    if (index === serverIndex || index === workspaceIndex) continue
    if (command[index] !== template[index]) return command
  }
  const workspace = command[workspaceIndex]!
  if (workspace === WORKSPACE_MARKER || !isAbsoluteAny(workspace)) return command
  return command.map((argument, index) => (index === workspaceIndex ? WORKSPACE_MARKER : argument))
}

export function reconcileAlphaOfficeInstalls(options: OfficeInstanceReconcileOptions = {}): OfficeInstanceReconcileOutcome {
  const warnings: string[] = []
  const logError = options.logError ?? ((message: string) => console.error(message))
  const warn = (message: string) => {
    warnings.push(message)
    logError(`${LOG_TAG} ${message}`)
  }
  const outcome: OfficeInstanceReconcileOutcome = { reanchored: [], adopted: [], warnings }

  let environment: AppEnvironment
  let currentRoot: string
  let siblings: OfficeSiblingRoot[]
  try {
    environment = options.environment ?? getAlphaEnvironment().environment
    currentRoot = options.currentRoot ?? alphaGlobalRoot()
    siblings = options.siblings ?? alphaSiblingEnvironmentRoots()
  } catch (error) {
    warn(`office instance reconcile skipped; environment unresolved (${errorMessage(error)})`)
    return outcome
  }
  const configPath = options.configPath ?? join(currentRoot, CONFIG_FILE)
  if (options.configPath === undefined && mcpPluginTargetPath() !== configPath) {
    // 逃生变量把 mcp 写入目标挪到了别处(ALPHA_LEGACY_INSTALL_ROOT / ALPHA_JSONC_TRUTH_DISABLE):
    // 那不是本环境根的真相文件,收养与重锚都会写错地方 —— 什么都不做。
    warn(`office instance reconcile skipped; mcp config target is not the environment root truth file: ${mcpPluginTargetPath()}`)
    return outcome
  }
  const currentServer = options.alphaOfficeServerPath === undefined ? resolveAlphaOfficeServerPath() : options.alphaOfficeServerPath
  if (!currentServer) {
    warn("office instance reconcile skipped; bundled office-mcp/server.py is unavailable in this instance (fail-closed)")
    return outcome
  }

  // ── 当前根:配置文本 + 账本(只读;写经各自的原子写器)────────────────────────────────
  const config = readConfig(configPath)
  if (!config.ok) {
    warn(`office instance reconcile skipped; ${config.reason}`)
    return outcome
  }
  const currentLedger = readLedgerV2(currentRoot, { sideEffectFree: true })
  const presentInCurrent = new Set<string>([
    ...currentLedger.records.filter((record) => record.kind === "mcp").map((record) => record.name),
    ...currentLedger.v1Only.filter((receipt) => receipt.type === "mcp").map((receipt) => receipt.name),
  ])

  // ── 1. re-anchor(当前根里已有 record 的叶子)────────────────────────────────────────
  let text = config.text
  for (const connector of ALPHA_OFFICE_CONNECTORS) {
    if (!presentInCurrent.has(connector.name)) continue
    const leaf = config.mcp[connector.name]
    if (!isRecord(leaf) || leaf.type !== "local") continue
    const command = reanchorOfficeCommand(connector.format, leaf.command, currentServer)
    if (!command) continue
    text = applyEdits(text, modify(text, ["mcp", connector.name, "command"], command, { formattingOptions: { tabSize: 2, insertSpaces: true } }))
    outcome.reanchored.push(connector.name)
  }
  if (outcome.reanchored.length > 0) {
    const written = writeConfigTextAtomic(configPath, config.text, text)
    if (!written.ok) {
      warn(`re-anchor write failed: ${configPath} (${written.reason})`)
      outcome.reanchored.length = 0
      return outcome
    }
  }

  // ── 2. adopt(当前根里完全没有的连接器,从兄弟根收养)─────────────────────────────────
  const missing = ALPHA_OFFICE_CONNECTORS.filter((connector) => !presentInCurrent.has(connector.name))
  if (missing.length === 0) return outcome
  const siblingViews = siblings.map((sibling) => readSibling(sibling))
  for (const view of siblingViews) for (const warning of view.warnings) warn(`sibling ${view.environment}: ${warning}`)

  for (const connector of missing) {
    const candidates = siblingViews
      .map((view) => ({ view, record: view.records.find((record) => adoptable(record, connector)) }))
      .filter((candidate): candidate is { view: SiblingView; record: InstallRecordV2 } => candidate.record !== undefined)
    if (candidates.length === 0) continue
    const pick = candidates.reduce((best, candidate) => (timestamp(candidate.record) > timestamp(best.record) ? candidate : best))
    const leaf = pick.view.mcp[connector.name]
    if (!isRecord(leaf) || leaf.type !== "local" || !isStringArray(leaf.command)) {
      warn(`${connector.name}: sibling ${pick.view.environment} holds a record but no local config leaf — not adopted`)
      continue
    }
    // `enabled` 是引擎消费键,由 desiredState 重新投影;其余叶子字段(timeout / environment)照抄。
    const { enabled: _enabled, ...server } = leaf as Record<string, unknown> & { enabled?: unknown }
    server.command = normalizeWorkspaceSlot(connector.format, leaf.command)
    const policy = applyMcpWritePolicy(connector.name, server)
    if (!policy.ok) {
      warn(`${connector.name}: sibling ${pick.view.environment} leaf refused by the office write policy — not adopted (${policy.reason})`)
      continue
    }
    const valid = validateServer(server)
    if (!valid.ok) {
      warn(`${connector.name}: sibling ${pick.view.environment} leaf refused by config validation — not adopted (${valid.reason})`)
      continue
    }
    const probe = probeLedgerForWrite(currentRoot)
    if (!probe.ok) {
      warn(`adoption stopped; current ledger not writable (${probe.reason})`)
      break
    }
    const now = (options.now ?? (() => new Date().toISOString()))()
    const txId = (options.transactionId ?? defaultTransactionId)(connector.name)
    const written = upsertRecordV2(currentRoot, {
      id: pick.record.id,
      name: connector.name,
      kind: "mcp",
      environment,
      scope: { kind: "global" },
      ...(pick.record.version ? { version: pick.record.version } : {}),
      ...(pick.record.manifestDigest ? { manifestDigest: pick.record.manifestDigest } : {}),
      ...(policy.artifactDigest ? { payloadDigest: policy.artifactDigest } : {}),
      ...(pick.record.grantDigest ? { grantDigest: pick.record.grantDigest } : {}),
      desiredState: pick.record.desiredState,
      origin: "catalog",
      configKey: `mcp.${connector.name}`,
      transaction: { id: txId, state: "committed" },
      installedAt: pick.record.installedAt,
      updatedAt: now,
    })
    if (!written.ok) {
      warn(`${connector.name}: ledger write refused — not adopted (${written.reason})`)
      continue
    }
    for (const warning of written.warnings) warn(`${connector.name}: ledger warning ${warning}`)
    const projected = pick.record.desiredState === "disabled" ? { ...server, enabled: false } : server
    const before = readConfig(configPath)
    const leafWrite = before.ok
      ? writeConfigTextAtomic(
          configPath,
          before.text,
          applyEdits(before.text, modify(before.text, ["mcp", connector.name], projected, { formattingOptions: { tabSize: 2, insertSpaces: true } })),
        )
      : { ok: false as const, reason: before.reason }
    if (!leafWrite.ok) {
      const rollback = removeRecordV2(currentRoot, "mcp", connector.name)
      warn(
        `${connector.name}: config leaf write failed (${leafWrite.reason}); record ${rollback.ok ? "rolled back" : `NOT rolled back: ${rollback.reason}`}`,
      )
      continue
    }
    const grant = readCapabilityGrant(pick.view.root, `mcp--${connector.name}`)
    if (grant) {
      try {
        writeCapabilityGrantSync(currentRoot, { ...grant, txId, grantedAt: now })
      } catch (error) {
        warn(`${connector.name}: capability grant copy failed (${errorMessage(error)}); install adopted without grant record`)
      }
    }
    outcome.adopted.push(connector.name)
  }
  return outcome
}

// ── 只读采集 ───────────────────────────────────────────────────────────────────────────────

type SiblingView = {
  environment: AppEnvironment
  root: string
  records: InstallRecordV2[]
  mcp: Record<string, unknown>
  warnings: string[]
}

function readSibling(sibling: OfficeSiblingRoot): SiblingView {
  const warnings: string[] = []
  const ledger = readLedgerV2(sibling.root, { sideEffectFree: true })
  warnings.push(...ledger.warnings)
  const config = readConfig(join(sibling.root, CONFIG_FILE))
  if (!config.ok) warnings.push(config.reason)
  return { environment: sibling.environment, root: sibling.root, records: ledger.records, mcp: config.ok ? config.mcp : {}, warnings }
}

function adoptable(record: InstallRecordV2, connector: Connector): boolean {
  return (
    record.kind === "mcp" &&
    record.name === connector.name &&
    record.id === connector.catalogId &&
    record.origin === "catalog" &&
    record.scope.kind === "global" &&
    (record.transaction === undefined || record.transaction.state === "committed")
  )
}

function timestamp(record: InstallRecordV2): number {
  const value = Date.parse(record.updatedAt ?? record.installedAt)
  return Number.isNaN(value) ? 0 : value
}

type ConfigRead = { ok: true; text: string; mcp: Record<string, unknown> } | { ok: false; reason: string }

/** 缺席 = 合法空配置;在场但读不了 / 解析不了 / 根不是对象 / `mcp` 不是对象 = 拒绝(不猜)。 */
function readConfig(file: string): ConfigRead {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { ok: true, text: "{}", mcp: {} }
    return { ok: false, reason: `config unreadable: ${file} (${errorMessage(error)})` }
  }
  const errors: ParseError[] = []
  const parsed: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length > 0) return { ok: false, reason: `config unparseable: ${file} (${errors.length} error(s))` }
  if (parsed === undefined && text.trim() === "") return { ok: true, text: "{}", mcp: {} }
  if (!isRecord(parsed)) return { ok: false, reason: `config root is not an object: ${file}` }
  if (parsed.mcp === undefined) return { ok: true, text, mcp: {} }
  if (!isRecord(parsed.mcp)) return { ok: false, reason: `config mcp key is not an object: ${file}` }
  return { ok: true, text, mcp: parsed.mcp }
}

function resolveAlphaOfficeServerPath(): string | null {
  try {
    return realpathSync(join(resourcesRoot(), "office-mcp", "server.py"))
  } catch {
    return null
  }
}

function defaultTransactionId(name: string): string {
  return `tx-office-adopt-${Date.now().toString(36)}-${name}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((argument) => typeof argument === "string")
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/")
}

function isAbsoluteAny(value: string): boolean {
  return isAbsolute(value) || win32.isAbsolute(value)
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined
  return typeof error.code === "string" ? error.code : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
