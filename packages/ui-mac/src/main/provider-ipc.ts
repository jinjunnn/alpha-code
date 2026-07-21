// Custom-provider IPC (main process). Two privileged ops the renderer can't do itself: persist a
// custom provider into the user config (ext-config.persistProvider, whitelisted/atomic) and probe
// connectivity with a 1-token chat (provider-test). Keys flow through the main process only.

import { ipcMain, type IpcMainInvokeEvent } from "electron"
import type { ProviderInput, ProviderTestInput } from "../shared/alpha-model-types"
import { getProviderKeyStatus } from "./alpha-provider-status"
import { removeProvider } from "./ext-config"
import { removeByokKey, setByokKey } from "./alpha-byok-keys"
import { persistProviderAndRefresh } from "./provider-lifecycle"
import { testProvider } from "./provider-test"

export function registerProviderIpcHandlers() {
  ipcMain.handle("providers-add", (_event: IpcMainInvokeEvent, input: ProviderInput) =>
    persistProviderAndRefresh(input),
  )
  ipcMain.handle("providers-test", (_event: IpcMainInvokeEvent, input: ProviderTestInput) => testProvider(input))
  // Read-only key-state for the picker's "需 Key / 已配置" gating. No secrets cross the boundary —
  // only { configured, source, hint(last4) } per provider id.
  ipcMain.handle("providers-key-status", () => getProviderKeyStatus())
  // Store / drop a catalog BYOK provider's key in alpha's encrypted keychain (alpha-byok-keys).
  // Applies on the next sidecar (re)fork: keychain → keyEnv → inline custom-provider apiKey.
  ipcMain.handle("providers-set-key", (_event: IpcMainInvokeEvent, id: string, key: string) => setByokKey(id, key))
  ipcMain.handle("providers-remove-key", (_event: IpcMainInvokeEvent, id: string) => removeByokKey(id))
  // Remove an off-catalog custom provider's inline key/definition from opencode.jsonc (env untouched).
  ipcMain.handle("providers-remove", (_event: IpcMainInvokeEvent, id: string) => removeProvider(id))
}
