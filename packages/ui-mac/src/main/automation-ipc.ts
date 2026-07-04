// 自动化 IPC(REQ-021 A1)。薄 handler:CRUD 落 alpha-automations、变更后 rearm、
// 「登录时启动」走 app.set/getLoginItemSettings(A1.3 配套设置项)。校验在存储层(loud)。

import { app, ipcMain, type IpcMainInvokeEvent } from "electron"
import type { AutomationTask } from "../shared/automation-types"
import {
  deleteAutomation,
  getAutomation,
  listAutomations,
  readAutomationState,
  saveAutomation,
  writeAutomationState,
} from "./alpha-automations"
import { getPlannedFireAt, isAutomationRunning, rearmAutomations } from "./automation-scheduler"

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

  ipcMain.handle("automations-save", (_e: IpcMainInvokeEvent, task: AutomationTask) => {
    const res = saveAutomation(task)
    if (res.ok) rearmAutomations()
    return res
  })

  ipcMain.handle("automations-delete", (_e: IpcMainInvokeEvent, id: string) => {
    const res = deleteAutomation(id)
    if (res.ok) rearmAutomations()
    return res
  })

  ipcMain.handle("automations-toggle", (_e: IpcMainInvokeEvent, id: string, enabled: boolean) => {
    const task = getAutomation(id)
    if (!task) return { ok: false as const, reason: "not found" }
    task.enabled = enabled === true
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

  // 「登录时启动」:应用未运行不执行(诚实边界)→ 给用户把 app 挂开机自启的开关。
  ipcMain.handle("automations-login-item", (_e: IpcMainInvokeEvent, open?: boolean) => {
    if (typeof open === "boolean") app.setLoginItemSettings({ openAtLogin: open })
    return { openAtLogin: app.getLoginItemSettings().openAtLogin }
  })
}
