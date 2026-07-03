// alpha model-catalog IPC (main process). Exposes the config-driven catalog (main/alpha-models.json,
// via alpha-models.ts) to the renderer's model picker. Read-only; no secrets.
//
// REQ-001:catalog 改为 effective 视图(内置 snapshot 按 B 网关 edition 白名单收窄 + liveSync 来源
// 标注);platform-live 拉取顺带刷新本地缓存(picker 打开即同步,下次 fork 装配用新白名单)。

import { ipcMain } from "electron"
import { getEffectiveCatalog, syncLiveAllowlist } from "./alpha-platform-models"

export function registerModelsIpcHandlers(userDataPath: string) {
  ipcMain.handle("models-catalog", () => getEffectiveCatalog(userDataPath))
  // REQ-001(原 D2 收编):从 B gateway /v1/models 拉 live allowlist,成功即写缓存(失败保留 last-known)。
  ipcMain.handle("models-platform-live", () => syncLiveAllowlist(userDataPath))
}
