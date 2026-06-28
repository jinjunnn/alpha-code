// Custom-provider IPC (main process). Two privileged ops the renderer can't do itself: persist a
// custom provider into the user config (ext-config.persistProvider, whitelisted/atomic) and probe
// connectivity with a 1-token chat (provider-test). Keys flow through the main process only.

import { ipcMain, type IpcMainInvokeEvent } from "electron"
import type { ProviderInput, ProviderTestInput } from "../shared/alpha-model-types"
import { persistProvider } from "./ext-config"
import { testProvider } from "./provider-test"

export function registerProviderIpcHandlers() {
  ipcMain.handle("providers-add", (_event: IpcMainInvokeEvent, input: ProviderInput) => persistProvider(input))
  ipcMain.handle("providers-test", (_event: IpcMainInvokeEvent, input: ProviderTestInput) => testProvider(input))
}
