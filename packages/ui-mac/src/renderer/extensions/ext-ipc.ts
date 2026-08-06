// `#765`:renderer 访问扩展 IPC 的**唯一**入口。
//
// 生产代码一律 `extIpc.xxx(...)`,不再直接写 `window.api.ext.xxx(...)` ——
// 后者会绕过 warning 呈现咽喉,而「绕过」正是本票要消灭的那个形态。
// 这条纪律由 `ext-ipc-chokepoint.test.ts` 机械执行:整棵 renderer 树里
// 只有本文件允许出现 `api.ext`,新增一个直连调用点即红。
//
// 呈现落点 = 全局 toast(与 hub 的 `flash()` 同一个 pushToast 单例、同一个 `.a-toast` 视口):
// 用户读得到的地方,而不是「hub 调过 flash」这种内部事实。
import type { ElectronAPI } from "../../preload/types"
import { pushToast } from "../alpha-ui/Toast"
import { warningPresentingExt } from "./ext-ipc-warning"

export const extIpc: ElectronAPI["ext"] = warningPresentingExt<ElectronAPI["ext"]>(
  () => window.api.ext,
  (warning) => pushToast({ kind: "info", title: warning }),
)
