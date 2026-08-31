// [ac#1207] REQ-147 AC1 —— UpdaterState 的每一个 status 都有确定的用户可见呈现。
//
// 单一权威:上游联合类型 `UpdaterState`(@opencode-ai/app/updater)的 `status`。这里只
// **消费**那个类型,不重写一份自己的 status 枚举 —— 映射用 `Record<UpdaterState["status"], …>`
// 标注,上游新增一个 status 而这里没给呈现时,**编译期**就红(tsgo:missing property);
// 运行时的穷尽性由 updater-state-surface.test.ts 再钉一道(独立字面量清单,不从本文件推导)。
//
// 「呈现」允许是「确定地不画」(null):disabled/idle 是静息态,没有值得占位的信息。
// 其余六个 status 都投影到侧栏 footer 的更新条(alpha-sidebar.tsx 消费本映射渲染)。
//
// unsolicited 的语义:后台到达(启动自检 / 10 分钟定时器)也要显示,还是只在用户主动
// 检查过之后显示。downloading/ready/installing 是「正在发生/等着你装」的事实,不请自来也该
// 看见(AC2 的跨重启入口正是 unsolicited 的 ready);up-to-date/error 是一次检查的反馈,
// 后台自检每次启动都会产生一条 up-to-date,不加门控就是每次启动都挂一条永久噪声。

import type { UpdaterState } from "@opencode-ai/app/updater"
import type { t } from "../i18n"

type I18nKey = Parameters<typeof t>[0]

export type UpdaterSurfaceSpec = {
  /** 呈现文案的 i18n key(en/zh 都登记;其余 locale 回落 en)。 */
  textKey: I18nKey
  /** true = 后台到达也显示;false = 只在用户主动检查(solicited)后显示。 */
  unsolicited: boolean
  /** 主动作:目前只有 ready → install。 */
  action?: "install"
  /** 终态反馈,可手动关掉(up-to-date / error)。 */
  dismissible?: boolean
}

/** status → 呈现。null = 确定地不画。对联合类型穷尽(缺一个成员 = 编译红)。 */
export const UPDATER_STATUS_SURFACE: Record<UpdaterState["status"], UpdaterSurfaceSpec | null> = {
  disabled: null,
  idle: null,
  checking: { textKey: "alpha.updater.checking", unsolicited: false },
  downloading: { textKey: "alpha.updater.downloading", unsolicited: true },
  ready: { textKey: "alpha.updater.ready", unsolicited: true, action: "install" },
  "up-to-date": { textKey: "alpha.updater.upToDate", unsolicited: false, dismissible: true },
  installing: { textKey: "alpha.updater.installing", unsolicited: true },
  error: { textKey: "alpha.updater.error", unsolicited: false, dismissible: true },
}

/** 文案插值参数(版本号 / 错误消息)。窄化只能按 status 写 switch,穷尽权威仍是上面那张表。 */
export function updaterSurfaceParams(state: UpdaterState): Record<string, string> {
  switch (state.status) {
    case "downloading":
    case "ready":
    case "installing":
      return { version: state.version }
    case "error":
      return { message: state.message }
    default:
      return {}
  }
}

/** 组件用的入口:给定状态与「用户是否主动检查过」,返回要画的东西(null = 不画)。 */
export function updaterSurfaceFor(state: UpdaterState, solicited: boolean) {
  const spec = UPDATER_STATUS_SURFACE[state.status]
  if (!spec) return null
  if (!spec.unsolicited && !solicited) return null
  return { ...spec, params: updaterSurfaceParams(state) }
}
