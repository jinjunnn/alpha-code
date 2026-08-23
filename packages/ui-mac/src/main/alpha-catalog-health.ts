// #1084(#987 CHOICE=A,DECIDE #1078)—— 平台模型目录刷新失败的**用户可观察出口**。
//
// 在此之前:`fetchPlatformModels()` 把网关拒绝翻成稳定分类码(`rate_limited` / `unauthorized` /
// `http-503` / `network` …),但三个刷新入口一个都不消费它 —— main/index.ts 两处
// `.catch(() => {})` 把整个结果扔掉,`models-platform-live` IPC 有 preload 桥却零 renderer
// 调用方。于是「失败处理」写得再好,用户永远看不到:picker 静静停在旧缓存或内置 snapshot 上。
//
// 出口落在**刷新的产出端**(syncLiveAllowlist),不是逐个调用点:三个入口共用同一个函数,
// 在那里上报即三条路径同时有出口,`.catch` 补不补都不影响判据。
//
// 与 alpha-contract-health 的分工:那个模块只承载 `ContractIncompatibleError`(有 surface /
// 代际字段的契约不兼容),本模块承载「这次目录刷新的结局」这一件事 —— 成功即 `null`(清横幅),
// 失败即那个分类码。contract-incompatible 两边都记:main 侧要保持「最后一次刷新结局」单一真源,
// renderer 侧靠契约横幅在场时自抑制来避免两条横幅重叠(见 Banner.tsx)。
import { ipcMain, type BrowserWindow } from "electron"
import type { CatalogRefreshFailure } from "../shared/alpha-model-types"
import { getLogger } from "./logging"

let failure: CatalogRefreshFailure | null = null
let getWindow: () => BrowserWindow | null = () => null

export function registerCatalogHealthIpcHandlers(window: () => BrowserWindow | null) {
  getWindow = window
  ipcMain.handle("alpha-catalog-health", () => failure)
}

/** 记录并广播一次目录刷新的结局。`code === null` = 本次刷新成功 ⇒ 清掉出口(横幅不许永远挂着)。
 *  推送与 invoke 两条都要有:启动那次刷新跑在窗口存在之前,只有推送的话它到不了 renderer。 */
export function reportCatalogRefresh(code: string | null) {
  failure = code ? { code, at: new Date().toISOString() } : null
  if (failure) getLogger().warn("alpha-catalog-health: platform model catalog refresh failed", failure)
  const window = getWindow()
  if (window && !window.isDestroyed()) window.webContents.send("alpha-catalog-failure", failure)
}

export function getCatalogFailure(): CatalogRefreshFailure | null {
  return failure
}
