import { ipcMain } from "electron"
import type { RecoveryAction, RecoveryIncidentWire } from "../shared/recovery"
import type { RecoveryService } from "./recovery-service"
import { createRecoveryWindow } from "./windows"

export function registerRecoveryIpcHandlers(service: RecoveryService) {
  let boot:
    | {
        incident: RecoveryIncidentWire
        senderID: number
        finish: (action: RecoveryAction) => void
      }
    | undefined

  ipcMain.handle("recovery-boot-current", (event) => {
    if (!boot || boot.senderID !== event.sender.id) throw new Error("Boot Recovery is unavailable")
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
      const win = createRecoveryWindow()
      service.allow(incident.incident, win.webContents.id)
      return new Promise<RecoveryAction>((resolve) => {
        let settled = false
        const finish = (action: RecoveryAction) => {
          if (settled) return
          settled = true
          boot = undefined
          if (!win.isDestroyed()) win.destroy()
          resolve(action)
        }
        boot = { incident, senderID: win.webContents.id, finish }
        win.once("closed", () => {
          if (settled) return
          settled = true
          boot = undefined
          resolve("exit-app")
        })
      })
    },
  }
}

export type RecoveryIpcController = ReturnType<typeof registerRecoveryIpcHandlers>
