// alpha model-catalog IPC (main process). Exposes the config-driven catalog (main/alpha-models.json,
// via alpha-models.ts) to the renderer's model picker. Read-only; no secrets.

import { ipcMain } from "electron"
import { getModelCatalog } from "./alpha-models"

export function registerModelsIpcHandlers() {
  ipcMain.handle("models-catalog", () => getModelCatalog())
}
