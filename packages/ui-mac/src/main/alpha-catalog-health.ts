// #1084(#987 CHOICE=A,DECIDE #1078)—— 模型目录刷新失败的**用户可观察出口**。
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
import type { CatalogRefreshHealth } from "../shared/alpha-model-types"
import { getLogger } from "./logging"

// REQ-237 `#1556`(方案 §2.1 / I10):两份目录(平台 V3、BYOK 预置目录)共用本模块,所以结局**按文档**各存一格。
// 此前只有一个 `failure`,一份成功就会把另一份仍在的失败整个清掉。一份成功只清它自己那一格。
export type CatalogDocument = keyof CatalogRefreshHealth

const health: CatalogRefreshHealth = { platform: null, byok: null }
let getWindow: () => BrowserWindow | null = () => null

export function registerCatalogHealthIpcHandlers(window: () => BrowserWindow | null) {
  getWindow = window
  ipcMain.handle("alpha-catalog-health", () => getCatalogFailure())
}

/** 记录并广播一份目录这一次刷新的结局。`code === null` = 这份目录本次刷新成功 ⇒ 只清它自己那一格
 *  (横幅不许永远挂着,也不许替另一份目录报平安)。推送与 invoke 两条都要有:启动那次刷新跑在窗口存在之前,
 *  只有推送的话它到不了 renderer。 */
export function reportCatalogRefresh(doc: CatalogDocument, code: string | null) {
  const failure = code ? { code, at: new Date().toISOString() } : null
  health[doc] = failure
  if (failure) getLogger().warn("alpha-catalog-health: model catalog refresh failed", { doc, ...failure })
  const window = getWindow()
  if (window && !window.isDestroyed()) window.webContents.send("alpha-catalog-failure", getCatalogFailure())
}

export function getCatalogFailure(): CatalogRefreshHealth {
  return { ...health }
}
