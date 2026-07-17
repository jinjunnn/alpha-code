// Install receipts ledger (REQ-018 T1, S12) — alpha's own record of what the extension hub
// installed: identity, scope, version and the exact files/config keys each install owns. Engine
// visibility truth stays with the SDK (mcp.status / app.skills / app.agents / command.list);
// receipts add the "what did WE install and what do we own" half so installed-state, uninstall
// and update work for fs/config types too (designs/2026-07-04-extension-hub-v3-universal.md §4.1).
//
// Storage: <root>/installs.json, root = ~/.alpha (global scope) or <projectDir>/.alpha (project
// scope). Electron-free and root-parameterized (same testability pattern as alpha-workdir.ts).
// A corrupt ledger is never silently clobbered: reads surface a warning, and the next write
// quarantines the corrupt file as installs.json.corrupt-<ts> before starting fresh.

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { InstallLedgerView, InstallReceipt } from "../preload/types"
import { tryGetAlphaEnvironment } from "./alpha-environment"
import { alphaRoot } from "./alpha-workdir"
import { writeFileAtomicSync } from "./ext-atomic-fs"

const LEDGER_FILE = "installs.json"
const LEDGER_VERSION = 1
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const RECEIPT_TYPES = new Set(["mcp", "skill", "agent", "command", "plugin", "bundle", "cloud"])
const RECEIPT_SCOPES = new Set(["global", "project"])
// REQ-063:imported-claude / imported-agents = 外部生态(.claude / .agents)转换导入,来源可溯
const RECEIPT_ORIGINS = new Set(["catalog", "created", "imported", "imported-claude", "imported-agents"])

export type LedgerRead = { receipts: InstallReceipt[]; warning?: string }
export type LedgerWriteResult = { ok: true } | { ok: false; reason: string }

/**
 * `~/.alpha` — the global alpha home (ADR-019 修订:全局层;installs/skills/agents/… live under it).
 * Overridable so tests and OPENCODE_TEST_ONBOARDING builds never touch the real home dir
 * (os.homedir() is not env-redirectable under bun).
 */
export function alphaGlobalRoot(): string {
  // REQ-098 #301:main 已冻结环境根 → 以冻结快照为单一真源,运行期 process.env 漂移(如 shell env
  // 后台刷新)不再改变消费者看到的根。未初始化(纯单测 / sidecar 进程)才退回 process.env。
  const frozen = tryGetAlphaEnvironment()
  if (frozen) return frozen.mutableRoot
  return process.env.ALPHA_GLOBAL_DIR || path.join(os.homedir(), ".alpha")
}

function ledgerPath(root: string): string {
  return path.join(root, LEDGER_FILE)
}

/** Field-level validation; receipts are data, but names/paths feed later fs operations — keep them sane. */
export function validateReceipt(receipt: InstallReceipt): string | null {
  if (!receipt || typeof receipt !== "object") return "receipt must be an object"
  if (typeof receipt.id !== "string" || !receipt.id || receipt.id.length > 200) return "invalid id"
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(receipt.id)) return "invalid id"
  if (typeof receipt.name !== "string" || !SAFE_NAME.test(receipt.name)) return "invalid name"
  if (!RECEIPT_TYPES.has(receipt.type)) return "invalid type"
  if (!RECEIPT_SCOPES.has(receipt.scope)) return "invalid scope"
  if (!RECEIPT_ORIGINS.has(receipt.origin)) return "invalid origin"
  if (typeof receipt.installedAt !== "string" || Number.isNaN(Date.parse(receipt.installedAt)))
    return "invalid installedAt"
  if (receipt.version !== undefined && typeof receipt.version !== "string") return "invalid version"
  if (receipt.configKey !== undefined && typeof receipt.configKey !== "string") return "invalid configKey"
  if (receipt.files !== undefined) {
    if (!Array.isArray(receipt.files)) return "invalid files"
    for (const file of receipt.files) {
      if (typeof file !== "string" || !path.isAbsolute(file)) return `files must be absolute paths: ${String(file)}`
    }
  }
  return null
}

function coerceReceipts(parsed: unknown): { receipts: InstallReceipt[]; dropped: number } {
  if (!parsed || typeof parsed !== "object") return { receipts: [], dropped: 0 }
  const raw = (parsed as { receipts?: unknown }).receipts
  if (!Array.isArray(raw)) return { receipts: [], dropped: 0 }
  const receipts: InstallReceipt[] = []
  let dropped = 0
  for (const entry of raw) {
    if (validateReceipt(entry as InstallReceipt) === null) receipts.push(entry as InstallReceipt)
    else dropped += 1
  }
  return { receipts, dropped }
}

/** Read the ledger under `root`. Missing file/dir → empty; corrupt file → empty + warning (no clobber). */
export function readLedger(root: string): LedgerRead {
  const file = ledgerPath(root)
  let text: string
  try {
    text = fs.readFileSync(file, "utf8")
  } catch {
    return { receipts: [] }
  }
  try {
    const { receipts, dropped } = coerceReceipts(JSON.parse(text))
    return dropped > 0 ? { receipts, warning: `${dropped} invalid receipt(s) ignored in ${file}` } : { receipts }
  } catch (error) {
    return { receipts: [], warning: `installs.json unreadable (${error instanceof Error ? error.message : "parse error"}): ${file}` }
  }
}

// Corrupt ledgers are quarantined (renamed aside), never overwritten in place — loud self-heal.
function quarantineIfCorrupt(root: string): string | null {
  const file = ledgerPath(root)
  let text: string
  try {
    text = fs.readFileSync(file, "utf8")
  } catch {
    return null
  }
  try {
    JSON.parse(text)
    return null
  } catch {
    const quarantined = `${file}.corrupt-${Date.now()}`
    try {
      fs.renameSync(file, quarantined)
      return quarantined
    } catch {
      return null
    }
  }
}

// REQ-099(ADR-028 §4):账本升双格式后,v1 写路径必须原样携带 v2 `records[]`(ext-receipt-v2.ts
// 拥有其语义;这里只做不透明 carry-through)——否则任何 v1 addReceipt/removeReceipt 都会抹掉 v2 真相。
function readCarriedRecords(root: string): unknown[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath(root), "utf8")) as { records?: unknown }
    return Array.isArray(parsed?.records) ? parsed.records : []
  } catch {
    return []
  }
}

function writeLedger(root: string, receipts: InstallReceipt[]): LedgerWriteResult {
  try {
    fs.mkdirSync(root, { recursive: true })
    const file = ledgerPath(root)
    const records = readCarriedRecords(root)
    const payload = records.length > 0 ? { v: 2, receipts, records } : { v: LEDGER_VERSION, receipts }
    // #395 步骤6 + Codex r6 M2:掉电 durability —— 账本是启停/安装的 durable intent(账本先写契约
    // 的前提)。用 writeFileAtomicSync(tmp 完整写循环 + fsync 文件 + 原子 rename + fsync 目录)——
    // 手写单次 fs.writeSync 会忽略短写(ENOSPC/EIO 返回 < payload 时留下截断账本)。
    writeFileAtomicSync(file, JSON.stringify(payload, null, 2) + "\n")
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "failed to write ledger" }
  }
}

const receiptKey = (type: string, name: string) => `${type}:${name}`

/** Upsert by (type, name) — reinstall/update replaces the previous receipt for the same item. */
export function addReceipt(root: string, receipt: InstallReceipt): LedgerWriteResult & { warning?: string } {
  const invalid = validateReceipt(receipt)
  if (invalid) return { ok: false, reason: invalid }
  const quarantined = quarantineIfCorrupt(root)
  const { receipts, warning } = readLedger(root)
  const key = receiptKey(receipt.type, receipt.name)
  const next = receipts.filter((entry) => receiptKey(entry.type, entry.name) !== key)
  next.push(receipt)
  const written = writeLedger(root, next)
  if (!written.ok) return written
  const notes = [warning, quarantined ? `corrupt ledger quarantined: ${quarantined}` : undefined].filter(Boolean)
  return notes.length ? { ok: true, warning: notes.join("; ") } : { ok: true }
}

/** Remove by (type, name); returns the removed receipt so callers can clean up its files/configKey. */
export function removeReceipt(
  root: string,
  type: InstallReceipt["type"],
  name: string,
): (LedgerWriteResult & { removed: InstallReceipt | null }) {
  const quarantined = quarantineIfCorrupt(root)
  const { receipts } = readLedger(root)
  const key = receiptKey(type, name)
  const removed = receipts.find((entry) => receiptKey(entry.type, entry.name) === key) ?? null
  if (!removed && !quarantined) return { ok: true, removed: null }
  const written = writeLedger(root, receipts.filter((entry) => receiptKey(entry.type, entry.name) !== key))
  if (!written.ok) return { ...written, removed: null }
  return { ok: true, removed }
}

export function findReceipt(root: string, type: InstallReceipt["type"], name: string): InstallReceipt | null {
  const { receipts } = readLedger(root)
  return receipts.find((entry) => receiptKey(entry.type, entry.name) === receiptKey(type, name)) ?? null
}

/**
 * Merged read view for the renderer (IPC `ext-list-installs`): global ledger + the project ledger
 * when a valid project directory is supplied. Read-only — never creates directories.
 */
export function listInstalls(projectDir?: string): InstallLedgerView {
  const warnings: string[] = []
  const globalRead = readLedger(alphaGlobalRoot())
  if (globalRead.warning) warnings.push(globalRead.warning)
  let project: InstallReceipt[] = []
  if (projectDir !== undefined) {
    if (typeof projectDir !== "string") {
      warnings.push("invalid project directory")
    } else {
      const root = alphaRoot(projectDir)
      if (!root) {
        warnings.push(`invalid project directory: ${projectDir}`)
      } else {
        const projectRead = readLedger(root)
        if (projectRead.warning) warnings.push(projectRead.warning)
        project = projectRead.receipts
      }
    }
  }
  return { global: globalRead.receipts, project, warnings }
}
