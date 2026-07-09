// 自动化 IPC(REQ-021 A1)。薄 handler:CRUD 落 alpha-automations、变更后 rearm、
// 「登录时启动」走 app.set/getLoginItemSettings(A1.3 配套设置项)。校验在存储层(loud)。

import { app, ipcMain, type IpcMainInvokeEvent } from "electron"
import { getLogger } from "./logging"
import { ensureUserWorkspaceDir } from "./alpha-user-workspace"
import type { AutomationTask } from "../shared/automation-types"
import {
  deleteAutomation,
  getAutomation,
  listAutomations,
  readAutomationState,
  saveAutomation,
  writeAutomationState,
} from "./alpha-automations"
import { getPlannedFireAt, isAutomationRunning, rearmAutomations, runAutomationNow } from "./automation-scheduler"
import { llmParseAutomation } from "./automation-llm"
import { deleteCloudSchedule, listCloudSchedules, pullCloudScheduleRuns, setCloudScheduleEnabled, upsertCloudSchedule } from "./alpha-cloud-schedules"

export function registerAutomationIpcHandlers() {
  ipcMain.handle("automations-list", () => ({
    tasks: listAutomations().map((t) => ({
      ...t,
      nextFireAt: getPlannedFireAt(t.id),
      running: isAutomationRunning(t.id),
    })),
    state: readAutomationState(),
    loginItem: app.getLoginItemSettings().openAtLogin,
  }))

  ipcMain.handle("automations-save", async (_e: IpcMainInvokeEvent, task: AutomationTask) => {
    // REQ-071/ADR-025 lazy 供给:目标是默认工作目录 ~/Alpha 时先建它,存储层「必须是目录」校验
    // 才能在全新机器上通过;其他路径 no-op(不代建任意目录,校验照旧 loud)。
    ensureUserWorkspaceDir(task?.target?.projectDir)
    // A3(REQ-025):云档 = 先注册/更新 B schedule(失败不落盘,loud);本地档若此前是云档,先删 B 侧。
    const prev = getAutomation(task?.id)
    const wasCloud = !!prev?.cloudScheduleId
    if (task?.execution === "cloud") {
      const up = await upsertCloudSchedule({ ...task, cloudScheduleId: prev?.cloudScheduleId })
      if (!up.ok) return { ok: false as const, reason: up.reason }
      task.cloudScheduleId = up.scheduleId
      const res = saveAutomation(task)
      if (!res.ok && !wasCloud) {
        // codex H2:B 注册成功但本地落盘失败 → 补偿删除,不留孤儿 schedule(否则离线持续触发且本地不可管)。
        void deleteCloudSchedule(up.scheduleId).then((d) => {
          if (!d.ok) getLogger().error(`automations: ORPHAN cloud schedule ${up.scheduleId} — local save failed AND compensating delete failed (${d.reason})`)
        })
        return { ok: false as const, reason: `${res.reason}(云端注册已回滚)` }
      }
      if (res.ok) rearmAutomations()
      return res
    }
    if (prev?.cloudScheduleId) {
      const del = await deleteCloudSchedule(prev.cloudScheduleId)
      if (!del.ok) return { ok: false as const, reason: del.reason }
      delete task.cloudScheduleId
    }
    const res = saveAutomation(task)
    if (res.ok) rearmAutomations()
    return res
  })

  ipcMain.handle("automations-delete", async (_e: IpcMainInvokeEvent, id: string) => {
    const prev = getAutomation(id)
    if (prev?.cloudScheduleId) {
      const del = await deleteCloudSchedule(prev.cloudScheduleId)
      if (!del.ok) return { ok: false as const, reason: del.reason } // 云侧删不掉不静默(否则离线幽灵触发)
    }
    const res = deleteAutomation(id)
    if (res.ok) rearmAutomations()
    return res
  })

  ipcMain.handle("automations-toggle", async (_e: IpcMainInvokeEvent, id: string, enabled: boolean) => {
    const task = getAutomation(id)
    if (!task) return { ok: false as const, reason: "not found" }
    task.enabled = enabled === true
    if (task.enabled) delete task.disabledReason // A2:手动重新启用 = 清熔断态
    if (task.cloudScheduleId) {
      const r = await setCloudScheduleEnabled(task.cloudScheduleId, task.enabled)
      if (!r.ok) return { ok: false as const, reason: r.reason }
    }
    const res = saveAutomation(task)
    if (res.ok) rearmAutomations()
    return res
  })

  ipcMain.handle("automations-pause-all", (_e: IpcMainInvokeEvent, paused: boolean) => {
    const state = readAutomationState()
    writeAutomationState({ ...state, pausedAll: paused === true })
    rearmAutomations()
    return { ok: true as const }
  })

  // A3(REQ-025):云侧状态回读(熔断/停用原因)+ 错过 run 拉回;离线返回 null/error,UI 保持本地态。
  ipcMain.handle("automations-cloud-sync", async () => {
    const schedules = await listCloudSchedules()
    const pulled = await pullCloudScheduleRuns()
    return { schedules, pulled }
  })

  // A2(REQ-024):手动立即运行(不改 next-fire;占并发位;计日 cap)。
  ipcMain.handle("automations-run-now", (_e: IpcMainInvokeEvent, id: string) => runAutomationNow(String(id)))

  // A2(REQ-024):LLM 辅助解析(规则解析失败时的兜底;临时会话一次抽取后删除)。
  ipcMain.handle("automations-nl-llm", (_e: IpcMainInvokeEvent, text: string, projectDir: string) =>
    llmParseAutomation(String(text ?? ""), String(projectDir ?? "")),
  )

  // 「登录时启动」:应用未运行不执行(诚实边界)→ 给用户把 app 挂开机自启的开关。
  ipcMain.handle("automations-login-item", (_e: IpcMainInvokeEvent, open?: boolean) => {
    if (typeof open === "boolean") app.setLoginItemSettings({ openAtLogin: open })
    return { openAtLogin: app.getLoginItemSettings().openAtLogin }
  })
}
