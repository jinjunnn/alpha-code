// alpha model-catalog IPC (main process). Exposes the config-driven catalog (main/alpha-models.json,
// via alpha-models.ts) to the renderer's model picker. Read-only; no secrets.

import { ipcMain } from "electron"
import { getModelCatalog } from "./alpha-models"
import { fetchPlatformModels } from "./alpha-platform-models"

export function registerModelsIpcHandlers() {
  ipcMain.handle("models-catalog", () => getModelCatalog())
  // 阶段三 step 17:从 B gateway /v1/models 拉 live allowlist(解静态目录漂移)。
  ipcMain.handle("models-platform-live", () => fetchPlatformModels())
}
