// 自动化调度器(REQ-021 A1.3/A1.4/A1.6,ADR-022)—— Electron 主进程,每任务单 timer:
// 算下次触发 → setTimeout → 执行 → 重排。应用未运行不执行(UI 明示,不装后台常驻);
// powerMonitor resume + 半小时兜底 tick 重算(睡眠错过按 catchUpPolicy:skip 丢弃);
// 全局并发 1,overlap skip 记账;dailyRunCap(默认 24/日,跨重启持久)。
//
// 执行链只走 SDK(ADR-002):session.create(标题「⏱ 自动化 · <name>」)→ session.prompt
// (agent=alpha-automation readonly 档,阻塞到回复完成)→ 最终回复落 report.md + status.json
// 进目标项目 .alpha/runs/auto-<id>-<ts>/(alpha-workdir 守卫)。超 maxDurationMin 中断(abort)。

import { BrowserWindow, Notification, powerMonitor } from "electron"
// CLIENT subpath(纯 fetch,main 的 Node 环境同样适用;v2 barrel 的 Node-only 依赖问题是 renderer 限定)
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { AutomationEvent, AutomationRunRecord, AutomationTask } from "../shared/automation-types"
import { AUTOMATION_DEFAULTS } from "../shared/automation-types"
import { rescheduleAfterGap, shouldTripBreaker } from "../shared/automation-schedule"
import { getAutomation, listAutomations, readAutomationState, saveAutomation, writeAutomationState } from "./alpha-automations"
import { writeRunFiles } from "./alpha-workdir"
import { getLogger } from "./logging"

export interface AutomationServerInfo {
  url: string
  username: string | null
  password: string | null
}

let awaitServer: (() => Promise<AutomationServerInfo>) | null = null
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const plannedAt = new Map<string, number>()
let runningTaskId: string | null = null
const MAX_TIMEOUT_MS = 2 ** 31 - 1 // setTimeout 上限 ~24.8 天 → 超长延迟分段

export function getPlannedFireAt(id: string): number | null {
  return plannedAt.get(id) ?? null
}

export function isAutomationRunning(id: string): boolean {
  return runningTaskId === id
}

function broadcast(event: AutomationEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("automation-event", event)
  }
}

export function startAutomationScheduler(deps: { awaitServer: () => Promise<AutomationServerInfo> }): void {
  awaitServer = deps.awaitServer
  rearmAutomations()
  powerMonitor.on("resume", () => rearmAutomations())
  // 兜底 tick:长睡眠/时钟漂移下 setTimeout 可能滞后或被吞,半小时全量重排一次(幂等)。
  const tick = setInterval(() => rearmAutomations(), 30 * 60 * 1000)
  tick.unref()
}

/** 全量重排(启动/resume/任务增删改/暂停切换后调用,幂等)。 */
export function rearmAutomations(): void {
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()
  const state = readAutomationState()
  if (state.pausedAll) {
    plannedAt.clear()
    return
  }
  const now = new Date()
  const alive = new Set<string>()
  for (const task of listAutomations()) {
    if (!task.enabled) continue
    if (task.execution === "cloud") continue // A3:云档由 B 侧 cron 执行,本地不排
    alive.add(task.id)
    armTask(task, now)
  }
  for (const id of [...plannedAt.keys()]) if (!alive.has(id)) plannedAt.delete(id)
}

function armTask(task: AutomationTask, now: Date): void {
  const prev = plannedAt.get(task.id)
  const anchor = new Date(task.createdAt)
  // 错过(planned 已过而没跑成,如睡眠/未运行期间)→ skip 不补,按现在重算(验收③⑤语义)。
  const { next, missed } = rescheduleAfterGap(task.schedule, prev ? new Date(prev) : null, now, anchor)
  if (missed) getLogger().log("automation: missed fire skipped (catchUpPolicy)", { id: task.id })
  if (!next) {
    plannedAt.delete(task.id)
    return
  }
  plannedAt.set(task.id, next.getTime())
  scheduleTimeout(task.id, next.getTime() - now.getTime())
}

function scheduleTimeout(id: string, delayMs: number): void {
  const existing = timers.get(id)
  if (existing) clearTimeout(existing)
  const delay = Math.max(0, delayMs)
  const timer = setTimeout(
    () => {
      const target = plannedAt.get(id)
      if (target === undefined) return
      const remaining = target - Date.now()
      if (remaining > 1000) return scheduleTimeout(id, remaining) // 分段续排(超长延迟)
      void fire(id)
    },
    Math.min(delay, MAX_TIMEOUT_MS),
  )
  timer.unref()
  timers.set(id, timer)
}

function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

/** A2(REQ-024):手动「立即运行」—— 不动 timers/plannedAt(不改 next-fire);占用全局并发位;
 *  计入每日 cap(诚实记账,手动跑也是跑)。 */
export async function runAutomationNow(id: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const task = getAutomation(id)
  if (!task) return { ok: false, reason: "任务不存在" }
  if (runningTaskId) return { ok: false, reason: "另一任务正在运行" }
  const state = readAutomationState()
  const today = localDateStr(new Date())
  const usedToday = state.runCount.date === today ? state.runCount.count : 0
  if (usedToday >= AUTOMATION_DEFAULTS.dailyRunCap) return { ok: false, reason: `已达每日运行上限(${AUTOMATION_DEFAULTS.dailyRunCap} 次/日)` }
  writeAutomationState({ ...state, runCount: { date: today, count: usedToday + 1 } })
  runningTaskId = id
  const at = new Date().toISOString()
  broadcast({ type: "run-started", taskId: id, at })
  let record: AutomationRunRecord
  try {
    record = await executeTask(task)
  } catch (error) {
    record = { at, status: "failed", summary: error instanceof Error ? error.message : String(error) }
  } finally {
    runningTaskId = null
  }
  const fresh = getAutomation(id)
  if (fresh) {
    fresh.lastRun = record
    fresh.history = [record, ...(fresh.history ?? [])].slice(0, AUTOMATION_DEFAULTS.historyKeep)
    const saved = saveAutomation(fresh)
    if (!saved.ok) getLogger().warn("automation: history write failed", saved.reason)
  }
  broadcast({ type: "run-finished", taskId: id, record })
  return { ok: true }
}

async function fire(id: string): Promise<void> {
  timers.delete(id)
  plannedAt.delete(id)
  const task = getAutomation(id)
  if (!task || !task.enabled) return
  const state = readAutomationState()
  if (state.pausedAll) return

  const at = new Date().toISOString()
  let record: AutomationRunRecord
  const today = localDateStr(new Date())
  const usedToday = state.runCount.date === today ? state.runCount.count : 0

  if (runningTaskId) {
    // 全局并发 1 + overlapPolicy:skip —— 被跳过要记账可见,不静默(REQ A1.3)。
    record = { at, status: "skipped-overlap", summary: `另一任务正在运行,按策略跳过` }
  } else if (usedToday >= AUTOMATION_DEFAULTS.dailyRunCap) {
    record = { at, status: "skipped-cap", summary: `已达每日运行上限(${AUTOMATION_DEFAULTS.dailyRunCap} 次/日)` }
  } else {
    writeAutomationState({ ...state, runCount: { date: today, count: usedToday + 1 } })
    runningTaskId = id
    broadcast({ type: "run-started", taskId: id, at })
    try {
      record = await executeTask(task)
    } catch (error) {
      record = { at, status: "failed", summary: error instanceof Error ? error.message : String(error) }
    } finally {
      runningTaskId = null
    }
  }

  // lastRun + 历史(capped)落任务文件;重读避免覆盖执行期间的用户编辑。
  let breakerTripped = false
  const fresh = getAutomation(id)
  if (fresh) {
    fresh.lastRun = record
    fresh.history = [record, ...(fresh.history ?? [])].slice(0, AUTOMATION_DEFAULTS.historyKeep)
    // A2(REQ-024):连败熔断 —— 判定纯函数在 shared(单测),原因落任务文件(UI 呈现;
    // 重新启用清除,见 automation-ipc toggle)。
    if (fresh.enabled && shouldTripBreaker(fresh.history, AUTOMATION_DEFAULTS.failureBreaker)) {
      fresh.enabled = false
      fresh.disabledReason = "consecutive_failures"
      breakerTripped = true
    }
    const saved = saveAutomation(fresh)
    if (!saved.ok) getLogger().warn("automation: history write failed", saved.reason)
  }
  if (breakerTripped) {
    getLogger().log("automation: breaker tripped (3 consecutive failures)", { id })
    new Notification({ title: `⏱ ${task.name}`, body: `连续失败 ${AUTOMATION_DEFAULTS.failureBreaker} 次,已自动停用;修复后可在自动化面板重新启用` }).show()
    broadcast({ type: "tasks-changed" })
  }

  if (task.notify.system && record.status !== "skipped-overlap" && record.status !== "skipped-cap") {
    const body =
      record.status === "ok"
        ? (record.summary ?? "已完成")
        : record.status === "timeout"
          ? `超时中断(>${task.budget.maxDurationMin} 分钟)`
          : `失败:${record.summary ?? record.status}`
    const n = new Notification({ title: `⏱ ${task.name}`, body })
    n.on("click", () => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win) {
        win.show()
        win.focus()
      }
    })
    n.show()
  }
  broadcast({ type: "run-finished", taskId: id, record })

  const after = getAutomation(id)
  if (after?.enabled) armTask(after, new Date())
}

function parseModel(model: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined
  const idx = model.indexOf("/")
  if (idx <= 0) return undefined
  return { providerID: model.slice(0, idx), modelID: model.slice(idx + 1) }
}

function runTimestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

async function executeTask(task: AutomationTask): Promise<AutomationRunRecord> {
  if (!awaitServer) return { at: new Date().toISOString(), status: "failed", summary: "scheduler not started" }
  const at = new Date().toISOString()
  const started = Date.now()
  const server = await awaitServer()
  const headers =
    server.username || server.password
      ? { Authorization: `Basic ${Buffer.from(`${server.username ?? ""}:${server.password ?? ""}`).toString("base64")}` }
      : undefined
  const client = createOpencodeClient({ baseUrl: server.url, headers })
  const directory = task.target.projectDir

  let sessionID: string | undefined
  let timedOut = false
  const controller = new AbortController()
  const killer = setTimeout(
    () => {
      timedOut = true
      controller.abort()
      if (sessionID) void client.session.abort({ sessionID, directory } as never).catch(() => {})
    },
    task.budget.maxDurationMin * 60_000,
  )
  killer.unref()

  try {
    const created = await client.session.create(
      { directory, title: `⏱ 自动化 · ${task.name}` } as never,
      { signal: controller.signal } as never,
    )
    const createdData = (created as { data?: { id?: string }; error?: unknown }).data
    if ((created as { error?: unknown }).error || !createdData?.id) throw new Error("session.create failed")
    sessionID = createdData.id

    const model = parseModel(task.target.model)
    const res = await client.session.prompt(
      {
        sessionID,
        directory,
        agent: task.target.agent,
        ...(model ? { model } : {}),
        parts: [{ type: "text", text: task.prompt }],
      } as never,
      { signal: controller.signal } as never,
    )
    if ((res as { error?: unknown }).error) throw new Error(`prompt failed: ${JSON.stringify((res as { error: unknown }).error).slice(0, 300)}`)
    const parts = ((res as { data?: { parts?: { type?: string; text?: string }[] } }).data?.parts ?? []) as {
      type?: string
      text?: string
    }[]
    const reply = parts
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n\n")
      .trim()

    const finishedAt = new Date().toISOString()
    const runId = `auto-${task.id}-${runTimestamp(new Date(started))}`
    const saved = writeRunFiles(directory, runId, {
      "report.md": reply || "(空回复)",
      "status.json": JSON.stringify(
        { taskId: task.id, name: task.name, sessionID, at, finishedAt, status: "ok", schedule: task.schedule, prompt: task.prompt },
        null,
        2,
      ),
    })
    if (!saved.ok) getLogger().warn("automation: run dir write failed", saved.reason)
    const firstLine = reply.split("\n").find((l) => l.trim()) ?? ""
    return {
      at,
      status: "ok",
      durationMs: Date.now() - started,
      sessionID,
      runDir: saved.ok ? saved.dir : undefined,
      summary: firstLine.slice(0, 120),
    }
  } catch (error) {
    const status = timedOut ? "timeout" : "failed"
    const summary = timedOut
      ? `超过 ${task.budget.maxDurationMin} 分钟,已中断`
      : error instanceof Error
        ? error.message.slice(0, 300)
        : String(error).slice(0, 300)
    // 失败也留痕(best-effort):status.json 进 run 目录,方便详情页回溯。
    const runId = `auto-${task.id}-${runTimestamp(new Date(started))}`
    const saved = writeRunFiles(directory, runId, {
      "status.json": JSON.stringify(
        { taskId: task.id, name: task.name, sessionID, at, finishedAt: new Date().toISOString(), status, error: summary, prompt: task.prompt },
        null,
        2,
      ),
    })
    return {
      at,
      status,
      durationMs: Date.now() - started,
      sessionID,
      runDir: saved.ok ? saved.dir : undefined,
      summary,
    }
  } finally {
    clearTimeout(killer)
  }
}
