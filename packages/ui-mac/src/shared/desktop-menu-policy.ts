// REQ-126 AC7(#658):alpha 桌面菜单的发布面。
//
// 为什么存在:原生菜单项由 `main/menu.ts` 按上游 `DESKTOP_MENU` 逐条发布,点一下就经
// `sendMenuCommand` 送到渲染进程 `command.trigger(id)`。而 REQ-085/086/125 把上游 home /
// new-session / session 三片叶换成 alpha 自有 surface 之后,挂在那些叶(以及只在 admission 那一跳
// 短暂挂载的 legacy layout)上的命令注册一起蒸发 —— 上游 `run()` 对未注册 id **静默返回**,于是
// 菜单里一串项目按下去什么都不发生,也不报错。
//
// 处置只有三条路:alpha 承接(在壳里注册,见 alpha-sidebar.tsx 的 `alpha.shell` 注册块)、
// 明确退休(从这里删掉,菜单上不再出现)、或本次恢复。本模块承载「退休」那一列,并且是**纯数据**
// (不 import electron),所以主进程的发布面与渲染进程的运行时闸门读的是同一份事实。
//
// 判据方向:凡是这里**发布**出去的命令 id,渲染进程闸门都要求它在真实壳里确实注册且可触发
// (src/renderer/sidebar/shell-commands.test.ts)。上游日后新增菜单项会默认落进发布面 → 直接被
// 那道闸门抓住,而不是悄悄多出一个点了没反应的入口。

import { DESKTOP_MENU, desktopMenuVisible, type DesktopMenu, type DesktopMenuEntry, type DesktopMenuPlatform } from "@opencode-ai/app/desktop-menu"

/**
 * 退休(alpha 不继承)的菜单命令。每条都写明为什么不是「承接」。
 *
 * 共同前提:这些能力在 alpha 里要么已经有别的活入口,要么根本不存在 —— 而把它们接活都需要新建
 * alpha 自己的模型(会话/项目排序、全局可寻址的面板句柄),那是新能力,不在本票射程内。
 */
export const RETIRED_MENU_COMMANDS: ReadonlySet<string> = new Set([
  // 终端 / 文件树:上游注册在 session 叶(use-session-commands)。alpha 会话工作区的终端与文件
  // 面板是**每个会话自己的组件状态**(session-workspace-shell 的 rail),没有全局句柄可给菜单;
  // 而工作区顶栏已经带着活的同类开关。要给菜单接活 = 新建跨组件通道,过度工程。
  "terminal.toggle",
  "fileTree.toggle",
  // 上/下一个会话、上/下一个项目:上游注册在 legacy layout,操作的是上游 tab / 项目模型 ——
  // alpha 的导航面是侧栏,没有「当前顺序」这个概念。接活 = 先造一套 alpha 会话排序模型。
  "session.previous",
  "session.next",
  "project.previous",
  "project.next",
])

/** 该 platform 下 alpha 实际发布的菜单(退休项已剔除,分隔符已收拢)。 */
export function alphaDesktopMenu(platform: DesktopMenuPlatform): DesktopMenu[] {
  const menus: DesktopMenu[] = []
  for (const menu of DESKTOP_MENU) {
    if (!desktopMenuVisible(menu, platform)) continue
    if (menu.role) {
      menus.push(menu)
      continue
    }
    const items = tidySeparators(
      (menu.items ?? []).filter(
        (entry) => desktopMenuVisible(entry, platform) && !(entry.type === "item" && entry.command !== undefined && RETIRED_MENU_COMMANDS.has(entry.command)),
      ),
    )
    // 整个子菜单被掏空 = 该菜单不发布(留一个空标题比少一个菜单更糟)。
    if (items.length === 0) continue
    menus.push({ ...menu, items })
  }
  return menus
}

/** alpha 发布面上仍然存在的命令 id 全集 —— 渲染进程闸门按它逐个要求「真注册且可触发」。 */
export function publishedMenuCommands(platform: DesktopMenuPlatform): string[] {
  const ids = new Set<string>()
  for (const menu of alphaDesktopMenu(platform)) {
    for (const entry of menu.items ?? []) {
      if (entry.type === "item" && entry.command) ids.add(entry.command)
    }
  }
  return [...ids].sort()
}

/** 删掉命令项之后,原来的分隔符会悬空:去掉开头/结尾以及连续的分隔符。 */
function tidySeparators(entries: DesktopMenuEntry[]): DesktopMenuEntry[] {
  const out: DesktopMenuEntry[] = []
  for (const entry of entries) {
    if (entry.type !== "separator") {
      out.push(entry)
      continue
    }
    if (out.length === 0) continue
    if (out[out.length - 1]!.type === "separator") continue
    out.push(entry)
  }
  while (out.length > 0 && out[out.length - 1]!.type === "separator") out.pop()
  return out
}
