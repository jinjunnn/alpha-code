import { ipcMain } from "electron"
import { createExtensionStorageAdapter, createSettingsAdapter } from "./settings-adapters"
import { spawnProductionCasGcWorkerRound, type CasGcSchedulerConfig } from "./ext-cas-gc-scheduler"
import { getStore } from "./store"
import { RENDERER_SETTINGS_STORE } from "./store-keys"

export function registerSettingsIpcHandlers(config: CasGcSchedulerConfig) {
  const settings = createSettingsAdapter(getStore(RENDERER_SETTINGS_STORE))
  const storage = createExtensionStorageAdapter(config, spawnProductionCasGcWorkerRound)
  ipcMain.handle("settings-read", () => settings.read())
  ipcMain.handle("settings-validate", (_event, value: unknown) => settings.validate(value))
  ipcMain.handle("settings-write", (_event, input: unknown) => settings.write(input))
  ipcMain.handle("extension-storage-snapshot", () => storage.snapshot())
  ipcMain.handle("extension-storage-inspect", () => storage.inspect())
  ipcMain.handle("extension-storage-collect", () => storage.collect())
}
