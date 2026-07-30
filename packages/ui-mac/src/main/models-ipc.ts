// alpha model-catalog IPC (main process). Exposes the config-driven catalog (main/alpha-models.json,
// via alpha-models.ts) to the renderer's model picker. Read-only; no secrets.
//
// REQ-001:catalog 改为 effective 视图(内置 snapshot 按 B 网关 edition 白名单收窄 + liveSync 来源
// 标注);platform-live 拉取顺带刷新本地缓存(下次 fork 装配用新清单)。
//
// REQ-127 #681:两个 handler 都只经 getEffectiveCatalog / syncLiveAllowlist —— 平台段的**唯一投影**
// 在 alpha-live-allowlist.projectPlatformModels,sidecar 的 buildAlphaModelConfig 走同一个函数。
//
// **这里刻意不做后台刷新。** `models.catalog()` 不只被 picker 调用:composer 的模型链
// (renderer/alpha-ui/alpha-composer.tsx)也在调,且挂着会重跑的响应式依赖;picker 自身还因认证/
// 重试/目录变化重载。在 handler 里挂 fire-and-forget refresh 会变成请求风暴,而且先发后到的旧响应
// 会覆盖新快照 —— 原子写只保证不出现半个文件,不保证顺序。真实刷新点仍是启动(main/index.ts)与
// 登录后 respawn 前两处。「picker 打开从不刷新目录」是**既存缺陷**,要修需单飞/序号仲裁,另开票。

import { ipcMain } from "electron"
import { getEffectiveCatalog, syncLiveAllowlist } from "./alpha-platform-models"

export function registerModelsIpcHandlers(userDataPath: string) {
  ipcMain.handle("models-catalog", () => getEffectiveCatalog(userDataPath))
  // REQ-001(原 D2 收编):从 B gateway /v1/models 拉 live allowlist,成功即写缓存(失败保留 last-known)。
  ipcMain.handle("models-platform-live", () => syncLiveAllowlist(userDataPath))
}
