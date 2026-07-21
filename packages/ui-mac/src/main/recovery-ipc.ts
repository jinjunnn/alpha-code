import { ipcMain } from "electron"
import type { RecoveryAction, RecoveryIncidentWire } from "../shared/recovery"
import { write as writeLog } from "./logging"
import type { RecoveryService } from "./recovery-service"
import { createRecoveryWindow, loadRecoveryWindow, type RecoveryWindowFatalReason } from "./windows"

type BootRecoveryFatalReason = RecoveryWindowFatalReason | "current-ipc-rejected"

export function registerRecoveryIpcHandlers(service: RecoveryService) {
  let boot:
    | {
        incident: RecoveryIncidentWire
        senderID: number
        finish: (action: RecoveryAction, reason?: BootRecoveryFatalReason) => void
      }
    | undefined

  ipcMain.handle("recovery-boot-current", (event) => {
    if (!boot || boot.senderID !== event.sender.id) {
      boot?.finish("exit-app", "current-ipc-rejected")
      throw new Error("Boot Recovery is unavailable")
    }
    return boot.incident
  })
  ipcMain.handle("recovery-submit", async (event, request: { incident: string; action: unknown }) => {
    const result = await service.submit(request?.incident, request?.action, event.sender.id)
    if (
      result.ok &&
      result.applied &&
      boot?.senderID === event.sender.id &&
      boot.incident.incident === request.incident
    ) {
      boot.finish(result.action)
    }
    return result
  })

  return {
    presentBoot(incident: RecoveryIncidentWire) {
      if (boot) return Promise.reject(new Error("Boot Recovery is already active"))
      return new Promise<RecoveryAction>((resolve) => {
        const state = {
          settled: false,
          window: undefined as ReturnType<typeof createRecoveryWindow> | undefined,
        }
        const finish = (action: RecoveryAction, reason?: BootRecoveryFatalReason) => {
          if (state.settled) return
          state.settled = true
          boot = undefined
          if (state.window && !state.window.isDestroyed()) state.window.destroy()
          resolve(action)
          if (reason) writeLog("recovery", "Boot Recovery host failed", { reason }, "error")
        }
        const win = createRecoveryWindow((reason) => finish("exit-app", reason))
        state.window = win
        if (state.settled) {
          if (!win.isDestroyed()) win.destroy()
          return
        }
        service.allow(incident.incident, win.webContents.id)
        boot = { incident, senderID: win.webContents.id, finish }
        win.once("closed", () => finish("exit-app"))
        loadRecoveryWindow(win)
      })
    },
  }
}

export type RecoveryIpcController = ReturnType<typeof registerRecoveryIpcHandlers>
