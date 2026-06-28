// Custom-provider IPC (main process). Two privileged ops the renderer can't do itself: persist a
// custom provider into the user config (ext-config.persistProvider, whitelisted/atomic) and probe
// connectivity with a 1-token chat (provider-test). Keys flow through the main process only.

import { ipcMain, type IpcMainInvokeEvent } from "electron"
import type { ProviderInput, ProviderTestInput } from "../shared/alpha-model-types"
import { getProviderKeyStatus } from "./alpha-models"
import { persistProvider, removeProvider } from "./ext-config"
import { testProvider } from "./provider-test"

export function registerProviderIpcHandlers() {
  ipcMain.handle("providers-add", (_event: IpcMainInvokeEvent, input: ProviderInput) => persistProvider(input))
  ipcMain.handle("providers-test", (_event: IpcMainInvokeEvent, input: ProviderTestInput) => testProvider(input))
  // Read-only key-state for the picker's "需 Key / 已配置" gating. No secrets cross the boundary —
  // only { configured, source, hint(last4) } per provider id.
  ipcMain.handle("providers-key-status", () => getProviderKeyStatus())
  // Remove a provider's inline key/definition from opencode.jsonc (env keys are untouched).
  ipcMain.handle("providers-remove", (_event: IpcMainInvokeEvent, id: string) => removeProvider(id))
}
