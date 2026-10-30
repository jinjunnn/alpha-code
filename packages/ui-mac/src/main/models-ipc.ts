// alpha model-catalog IPC (main process). Exposes the config-driven catalog (main/alpha-models.json,
// via alpha-models.ts) to the renderer's model picker. Read-only; no secrets.
//
// REQ-001:catalog 改为 effective 视图(内置 snapshot 按 B 网关 edition 白名单收窄 + liveSync 来源
// 标注)。`#1555` 起平台段读 fork 前钉住的「已应用目录」,与 sidecar 的 buildAlphaModelConfig 同一份;
// 平台段的**唯一投影**在 alpha-live-allowlist.projectPlatformModels。
//
// **这里刻意不做刷新。** `models.catalog()` 不只被 picker 调用:composer 的模型链
// (renderer/alpha-ui/alpha-composer.tsx)也在调,且挂着会重跑的响应式依赖;picker 自身还因认证/
// 重试/目录变化重载。刷新只经 catalog-refresher.ts 的 requestCatalogRefresh(单飞 + 序号/身份仲裁)。
// 零调用的 `models-platform-live` IPC 已随 `#1555` 删除。

import { ipcMain } from "electron"
import { getEffectiveCatalog } from "./alpha-platform-models"

export function registerModelsIpcHandlers(userDataPath: string) {
  ipcMain.handle("models-catalog", () => getEffectiveCatalog(userDataPath))
}
