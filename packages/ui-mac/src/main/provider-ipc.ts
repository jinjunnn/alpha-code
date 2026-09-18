// Custom-provider IPC (main process). Privileged ops the renderer can't do itself: persist a custom
// provider (key → alpha's encrypted keychain store, definition → alpha.jsonc with a constant marker;
// provider-lifecycle), probe connectivity with a 1-token chat (provider-test), and remove one. Keys flow
// through the main process only — no IPC channel ever returns a key value (REQ-226 AC3).

import { ipcMain, type IpcMainInvokeEvent } from "electron"
import type { ProviderInput, ProviderTestInput } from "../shared/alpha-model-types"
import { getProviderKeyStatus } from "./alpha-provider-status"
import { removeByokKey } from "./alpha-byok-keys"
import { persistProviderAndRefresh, removeProviderAndRefresh, setProviderKeyAndRetireLegacyBlock } from "./provider-lifecycle"
import { testProvider } from "./provider-test"

export function registerProviderIpcHandlers() {
  ipcMain.handle("providers-add", (_event: IpcMainInvokeEvent, input: ProviderInput) =>
    persistProviderAndRefresh(input),
  )
  ipcMain.handle("providers-test", (_event: IpcMainInvokeEvent, input: ProviderTestInput) => testProvider(input))
  // Read-only key-state for the picker's "需 Key / 已配置 / 需重填" gating. No secrets cross the boundary —
  // only { configured, source, hint(last4) } per provider id.
  ipcMain.handle("providers-key-status", () => getProviderKeyStatus())
  // Store / drop a catalog BYOK provider's key in alpha's encrypted keychain (alpha-byok-keys).
  // Applies on the next sidecar (re)fork: keychain → keyEnv → {file:} ref in the injected BYOK node.
  // Re-entering a key also retires a pre-#1343 plaintext block for that id from alpha.jsonc (R1 finding 1).
  ipcMain.handle("providers-set-key", (_event: IpcMainInvokeEvent, id: string, key: string) =>
    setProviderKeyAndRetireLegacyBlock(id, key),
  )
  ipcMain.handle("providers-remove-key", (_event: IpcMainInvokeEvent, id: string) => removeByokKey(id))
  // Remove a provider: its key from the keychain store FIRST, then its definition from alpha.jsonc (REQ-226
  // baseline §2.1 步骤 8), then one respawn so the {file:} channel sweeps the key file. Env keys untouched.
  ipcMain.handle("providers-remove", (_event: IpcMainInvokeEvent, id: string) => removeProviderAndRefresh(id))
}
