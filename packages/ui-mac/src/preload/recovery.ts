import { contextBridge, ipcRenderer } from "electron"
import type { RecoveryAction, RecoveryActionResult, RecoveryIncidentWire } from "../shared/recovery"

export type RecoveryBootAPI = {
  current: () => Promise<RecoveryIncidentWire>
  submit: (incident: string, action: RecoveryAction) => Promise<RecoveryActionResult>
}

const recovery: RecoveryBootAPI = {
  current: () => ipcRenderer.invoke("recovery-boot-current"),
  submit: (incident, action) => ipcRenderer.invoke("recovery-submit", { incident, action }),
}

contextBridge.exposeInMainWorld("recovery", recovery)
