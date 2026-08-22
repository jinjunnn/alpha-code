// `#765`:renderer 访问扩展 IPC 的**唯一**入口。
//
// 生产代码一律 `extIpc.xxx(...)`,不再直接写 `window.api.ext.xxx(...)` ——
// 后者会绕过 warning 呈现咽喉,而「绕过」正是本票要消灭的那个形态。
// 这条纪律由 `ext-ipc-chokepoint.test.ts` 机械执行:整棵 renderer 树里
// 只有本文件允许出现 `api.ext`,新增一个直连调用点即红。
//
// 呈现落点 = 全局 toast(与 hub 的 `flash()` 同一个 pushToast 单例、同一个 `.a-toast` 视口):
// 用户读得到的地方,而不是「hub 调过 flash」这种内部事实。
//
// ── `#771`:**常驻**,不是 4 秒一闪 ────────────────────────────────────────────────────────
//
// `#765` 把呈现搬到这一层时顺手把它降成了默认 toast(4 秒自动消失)。在那之前,整包卸载的
// warning 落在 `extension-detail` 的 `packageError` 槽里,**一直显示到用户处理**。重构要的是
// 「warning 不被丢掉」,不是「把它降级成一闪而过」—— 一条 4 秒的提示对「连接绑定没释放干净」
// 这种东西,和丢掉的差别只是运气。
//
// **判据不是方法名,是这条通道本身。** 本仓的呈现分工写在 `extension-hub.tsx` 的 B11 注释里:
// 「toast 只报成功,失败走行内」——短命的那种是结果确认(已保存/已复制/已发送),常驻的那种是
// 「有件事要你处理」。而经过这道咽喉的**全部**是后者:逐个看过一遍产出方,没有一条是例行确认 ——
//   · `ext-package-uninstall.ts`  连接绑定没释放掉 / 残留没清干净
//   · `alpha-installs.ts`         账本损坏已隔离 / 丢弃了 N 条非法 receipt
//   · `ext-install-planner.ts`    projectionLag(账本已 durable,本次没注入,重启才自愈)
//   · `ext-fs-installer.ts`       同上,账本读取降级
// 于是「该常驻吗」是**通道的属性**,不是调用点的属性 —— 这一层可以整类判定,不需要名单、
// 也不需要调用点传一个「持久度」提示。后者会把 `#765` 刚消灭的形态原样请回来:枚举/opt-in
// 对新成员默认放行,新加的调用点默认又是一闪而过。
//
// **为什么不是 Banner**(设计系统里「持久通知」的那个基元,`alpha-ui/Banner.tsx`):Banner 是
// **行内**的,要有一个组件挂载点;而这一层是全局 IPC 包装,没有组件上下文。从这里用 Banner 就得
// 先造一个应用级 banner 宿主 —— 那是一块新的全局界面,归设计权威(`design-loop`),不是本票的
// 尺寸。常驻 toast 是「4 秒即走」与「行内阻断态」之间那个诚实的中间点:留到用户按 ×,不占版面、
// 不阻断。若日后 owner 要把这类 warning 收进 Banner,换的是本文件这一处呈现函数,咽喉形状不变。
//
// 想要短命 toast 的地方照旧直接 `pushToast(...)`(hub 的 `flash()`),那条路不经过这里。
import type { ElectronAPI } from "../../preload/types"
import { pushToast } from "../alpha-ui/Toast"
import { warningPresentingExt } from "./ext-ipc-warning"

export const extIpc: ElectronAPI["ext"] = warningPresentingExt<ElectronAPI["ext"]>(
  () => window.api.ext,
  // `duration: 0` = 不装拆除定时器,只能由用户按 × 关掉(见 Toast.tsx)。
  (warning) => pushToast({ kind: "info", title: warning, duration: 0 }),
)
