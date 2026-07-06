import { BrowserWindow, Menu, shell } from "electron"
import type { MenuItemConstructorOptions } from "electron"
import {
  DESKTOP_MENU,
  desktopMenuVisible,
  type DesktopMenuEntry,
  type DesktopMenuRole,
} from "@opencode-ai/app/desktop-menu"

import { UPDATER_ENABLED } from "./constants"
import { runDesktopMenuAction } from "./desktop-menu-actions"
import type { DbMenuActions } from "./db-safety-boot"
import type { DataClearAction } from "./data-clear-boot"

type Deps = {
  trigger: (id: string) => void
  checkForUpdates: () => void
  relaunch: () => void
  data?: DbMenuActions
  dataClear?: DataClearAction
}

export function createMenu(deps: Deps) {
  if (process.platform !== "darwin") return

  const template: MenuItemConstructorOptions[] = DESKTOP_MENU.filter((menu) =>
    desktopMenuVisible(menu, "macos"),
  ).map((menu) => {
    if (menu.role) return { role: nativeRole(menu.role) }
    return {
      label: menu.label,
      submenu: menu.items
        ?.filter((entry) => desktopMenuVisible(entry, "macos"))
        .map((entry) => nativeItem(entry, deps)),
    }
  })

  // S17 T3(B14①②):alpha 自有「数据」菜单 —— DB 手动备份/导出入口(设计
  // docs/designs/2026-07-05-db-safety-belt.md 决策 6)。dev 态置灰(分支后缀库,备错目标风险>收益);
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
          click: () => shell.openExternal("https://github.com/jinjunnn/alpha-code/blob/alpha/docs/UNINSTALL.md"),
        },
      )
    }
    template.push({ label: "数据", submenu })
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function nativeItem(entry: DesktopMenuEntry, deps: Deps): MenuItemConstructorOptions {
  if (entry.type === "separator") return { type: "separator" }
  if (entry.role) return { role: nativeRole(entry.role) }

  const item: MenuItemConstructorOptions = {
    label: entry.label,
    accelerator: entry.accelerator?.macos,
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
