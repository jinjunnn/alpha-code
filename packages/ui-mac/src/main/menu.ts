import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron"
import type { MenuItemConstructorOptions } from "electron"
import { join } from "node:path"
import {
  DESKTOP_MENU,
  desktopMenuVisible,
  type DesktopMenuEntry,
  type DesktopMenuPlatform,
  type DesktopMenuRole,
} from "@opencode-ai/app/desktop-menu"

import { UPDATER_ENABLED } from "./constants"
import { runDesktopMenuAction } from "./desktop-menu-actions"
import { menuPlatform } from "./platform"
import type { DbMenuActions } from "./db-safety-boot"
import type { DataClearAction } from "./data-clear-boot"

type Deps = {
  trigger: (id: string) => void
  checkForUpdates: () => void
  relaunch: () => void
  data?: DbMenuActions
  dataClear?: DataClearAction
}

// REQ-076 T2(阻断①):原「非 darwin 直接 return」使 Windows 无任何应用菜单,「数据」菜单
// (DB 备份/清除/卸载说明)不可达。现按 seam 的 menuPlatform 双平台构建(上游 desktop-menu
// 模型原生带 windows 可见性与加速键);linux 不发布,维持不建。
export function createMenu(deps: Deps) {
  const target = menuPlatform()
  if (!target) return

  const template: MenuItemConstructorOptions[] = DESKTOP_MENU.filter((menu) =>
    desktopMenuVisible(menu, target),
  ).map((menu) => {
    if (menu.role) return { role: nativeRole(menu.role) }
    return {
      label: menu.label,
      submenu: menu.items
        ?.filter((entry) => desktopMenuVisible(entry, target))
        .map((entry) => nativeItem(entry, deps, target)),
    }
  })

  // S17 T3(B14①②):alpha 自有「数据」菜单 —— DB 手动备份/导出入口(设计
  // dev 态置灰(分支后缀库,备错目标风险>收益);
  // 文案中文硬编码(main 无 i18n,ADR-022 先例)。S23(C16):清除数据入口同屏(B14 验收④)。
  if (deps.data) {
    const data = deps.data
    const submenu: MenuItemConstructorOptions[] = [
      { label: "立即备份会话数据库", enabled: data.enabled, click: () => data.backupNow() },
      { label: "导出会话数据库…", enabled: data.enabled, click: () => data.exportDb() },
      { type: "separator" },
      { label: "打开备份文件夹", click: () => data.openBackups() },
    ]
    if (deps.dataClear) {
      const dataClear = deps.dataClear
      submenu.push(
        { type: "separator" },
        { label: "清除数据…", click: () => dataClear.clearData() },
        {
          label: "卸载与数据残留说明",
          click: () => shell.openExternal("https://github.com/jinjunnn/alpha-code/blob/alpha/docs/runbooks/uninstall.md"),
        },
      )
    }
    template.push({ label: "数据", submenu })
  }

  // REQ-076 T2:Windows 上 app.setAboutPanelOptions 是 no-op(About 面板仅 mac/linux)——
  // 「关于 + 开源声明(B15 NOTICE)」改由「帮助」菜单承载(ADR-026 §5 诚实呈现)。
  if (target === "windows") {
    template.push({
      label: "帮助",
      submenu: [
        { label: "关于 alpha-code", click: () => showAboutDialog() },
        { label: "开源声明(NOTICE)", click: () => void shell.openPath(noticePath()) },
      ],
    })
  }

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)

  // win32 主窗为 frameless(titleBarOverlay,windows.ts)→ 原生菜单栏不显示,但应用菜单的
  // 加速键仍全局生效。可见入口 = renderer 顶栏按钮经本通道弹原生菜单(按钮属 win32 UI,
  // 无法在 mac 上视觉核验 → 随 REQ-076 真机批落地;通道先就位,幂等注册防 respawn 重复)。
  if (target === "windows") {
    ipcMain.removeHandler("popup-app-menu")
    ipcMain.handle("popup-app-menu", () => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      if (win) menu.popup({ window: win })
    })
  }
}

function noticePath() {
  // 打包态:extraResources 落 <resources>/NOTICE.txt(electron-builder.config.ts,B15);
  // dev:包根 resources/NOTICE.txt。
  return app.isPackaged ? join(process.resourcesPath, "NOTICE.txt") : join(app.getAppPath(), "resources", "NOTICE.txt")
}

function showAboutDialog() {
  void dialog.showMessageBox({
    type: "info",
    title: "关于 alpha-code",
    message: `alpha-code ${app.getVersion()}`,
    detail: "© 2025 opencode (MIT). alpha-code fork build.\n完整许可与归属见「帮助 → 开源声明(NOTICE)」。",
  })
}

function nativeItem(entry: DesktopMenuEntry, deps: Deps, target: DesktopMenuPlatform): MenuItemConstructorOptions {
  if (entry.type === "separator") return { type: "separator" }
  if (entry.role) return { role: nativeRole(entry.role) }

  const item: MenuItemConstructorOptions = {
    label: entry.label,
    accelerator: entry.accelerator?.[target],
    enabled: entry.enabled === "updater" ? UPDATER_ENABLED : undefined,
  }

  if (entry.command) {
    const command = entry.command
    item.click = () => deps.trigger(command)
  }
  if (entry.action) {
    const action = entry.action
    item.click = () =>
      runDesktopMenuAction(BrowserWindow.getFocusedWindow(), action, {
        checkForUpdates: deps.checkForUpdates,
        relaunch: deps.relaunch,
      })
  }
  if (entry.href) {
    const href = entry.href
    item.click = () => shell.openExternal(href)
  }

  return item
}

function nativeRole(role: DesktopMenuRole) {
  return role as NonNullable<MenuItemConstructorOptions["role"]>
}
