// 自动化任务存储(REQ-021 A1)——<current-environment-root>/automations/<id>.json + _state.json。
// 形制对齐 alpha-installs.ts(alphaGlobalRoot 同根、校验后原子写、坏文件跳过不清库)。
// 纯存储层:不含调度逻辑(automation-scheduler.ts)、不触达引擎。

import * as fs from "node:fs"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import type { AutomationGlobalState, AutomationStoreErrorCode, AutomationTask } from "../shared/automation-types"
import { AUTOMATION_DEFAULTS } from "../shared/automation-types"
import { isValidCron } from "../shared/automation-schedule"
import { alphaGlobalRoot } from "./alpha-installs"
import { getLogger } from "./logging"

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

export function automationsRoot(): string {
  return path.join(alphaGlobalRoot(), "automations")
}

export function newAutomationId(): string {
  return `auto-${randomUUID().slice(0, 8)}`
}

/** 存储层拒绝:`code` 是结构槽(renderer 据它出当前语言的人话),`reason` 是只进日志的英文细节。 */
export type AutomationStoreRefusal = { code: AutomationStoreErrorCode; reason: string }

const refuse = (code: AutomationStoreErrorCode, reason: string): AutomationStoreRefusal => ({ code, reason })

/** 校验一个任务形状;返回 null = 合法,否则拒绝(loud;[#1001] 码进 UI,reason 进日志)。 */
export function validateAutomation(task: AutomationTask): AutomationStoreRefusal | null {
  if (!task || typeof task !== "object") return refuse("automation-invalid", "task must be an object")
  if (typeof task.id !== "string" || !SAFE_ID.test(task.id)) return refuse("automation-invalid", "invalid id")
  if (typeof task.name !== "string" || !task.name.trim() || task.name.length > 80) return refuse("automation-name-invalid", "invalid name")
  if (typeof task.prompt !== "string" || !task.prompt.trim() || task.prompt.length > 8000)
    return refuse("automation-prompt-invalid", "invalid prompt")
  if (!task.target || typeof task.target.projectDir !== "string" || !path.isAbsolute(task.target.projectDir))
    return refuse("automation-project-dir-invalid", "projectDir must be absolute")
  try {
    if (!fs.statSync(task.target.projectDir).isDirectory()) return refuse("automation-project-dir-invalid", "projectDir not a directory")
  } catch {
    return refuse("automation-project-dir-invalid", "projectDir not found")
  }
  // A1 恒 local;A2(REQ-024)放开 standard 可写档(cloud 仍归 A3/REQ-025)。
  if (task.execution !== "local" && task.execution !== "cloud") return refuse("automation-invalid", "execution must be local | cloud")
  if (task.permissionProfile !== "readonly" && task.permissionProfile !== "standard")
    return refuse("automation-invalid", "permissionProfile must be readonly | standard")
  const s = task.schedule
  if (!s || typeof s !== "object") return refuse("automation-schedule-invalid", "invalid schedule")
  if (s.kind === "cron") {
    if (typeof s.expr !== "string" || !isValidCron(s.expr)) return refuse("automation-schedule-invalid", "invalid cron expression")
  } else if (s.kind === "interval") {
    if (typeof s.everyMinutes !== "number" || !Number.isFinite(s.everyMinutes)) return refuse("automation-schedule-invalid", "invalid interval")
    if (s.everyMinutes < AUTOMATION_DEFAULTS.minIntervalMinutes)
      return refuse("automation-schedule-invalid", `interval must be >= ${AUTOMATION_DEFAULTS.minIntervalMinutes} minutes`)
  } else if (s.kind === "once") {
    if (typeof s.at !== "string" || Number.isNaN(Date.parse(s.at))) return refuse("automation-schedule-invalid", "invalid once timestamp")
  } else {
    return refuse("automation-schedule-invalid", "invalid schedule kind")
  }
  const maxMin = task.budget?.maxDurationMin
  if (typeof maxMin !== "number" || maxMin < 1 || maxMin > 120) return refuse("automation-duration-invalid", "maxDurationMin must be 1-120")
  return null
}

function writeFileAtomic(file: string, data: string): void {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}

export function listAutomations(): AutomationTask[] {
  const root = automationsRoot()
  let entries: string[]
  try {
    entries = fs.readdirSync(root).filter((f) => f.endsWith(".json") && !f.startsWith("_"))
  } catch {
    return []
  }
  const out: AutomationTask[] = []
  for (const file of entries) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(root, file), "utf8")) as AutomationTask
      if (validateAutomation(parsed) === null) out.push(parsed)
      else getLogger().warn("alpha-automations: dropping invalid task file", file)
    } catch {
      getLogger().warn("alpha-automations: unreadable task file", file)
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export function getAutomation(id: string): AutomationTask | null {
  if (!SAFE_ID.test(id)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(automationsRoot(), `${id}.json`), "utf8")) as AutomationTask
    return validateAutomation(parsed) === null ? parsed : null
  } catch {
    return null
  }
}

export function saveAutomation(task: AutomationTask): { ok: true } | ({ ok: false } & AutomationStoreRefusal) {
  const invalid = validateAutomation(task)
  if (invalid) return { ok: false, ...invalid }
  try {
    fs.mkdirSync(automationsRoot(), { recursive: true })
    writeFileAtomic(path.join(automationsRoot(), `${task.id}.json`), JSON.stringify(task, null, 2))
    return { ok: true }
  } catch (error) {
    return { ok: false, ...refuse("automation-storage-failed", error instanceof Error ? error.message : String(error)) }
  }
}

export function deleteAutomation(id: string): { ok: true } | { ok: false; reason: string } {
  if (!SAFE_ID.test(id)) return { ok: false, reason: "invalid id" }
  try {
    fs.rmSync(path.join(automationsRoot(), `${id}.json`), { force: true })
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

// ── 全局态(暂停全部 + dailyRunCap 记账)────────────────────────────────────────────────────

const DEFAULT_STATE: AutomationGlobalState = { pausedAll: false, runCount: { date: "", count: 0 } }

export function readAutomationState(): AutomationGlobalState {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(automationsRoot(), "_state.json"), "utf8"))
    return {
      pausedAll: parsed.pausedAll === true,
      runCount:
        parsed.runCount && typeof parsed.runCount.date === "string" && typeof parsed.runCount.count === "number"
          ? parsed.runCount
          : { ...DEFAULT_STATE.runCount },
    }
  } catch {
    return { ...DEFAULT_STATE, runCount: { ...DEFAULT_STATE.runCount } }
  }
}

export function writeAutomationState(state: AutomationGlobalState): void {
  try {
    fs.mkdirSync(automationsRoot(), { recursive: true })
    writeFileAtomic(path.join(automationsRoot(), "_state.json"), JSON.stringify(state, null, 2))
  } catch (error) {
    getLogger().warn("alpha-automations: state write failed", error)
  }
}
