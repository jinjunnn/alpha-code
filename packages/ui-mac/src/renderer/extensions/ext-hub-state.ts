// Session-transient open/close state for the Extension Hub (定制中心) overlay. A module-level
// signal — there is a single hub — mirroring sidebar-state.ts. Deliberately NOT persisted: the
// hub always starts closed on launch. Imported by alpha-sidebar.tsx (the toggle button) and
// renderer/index.tsx (to drive <ExtensionHub open=…/>).

import { createSignal } from "solid-js"

const [open, setOpen] = createSignal(false)

// REQ-019 T1:hub 顶部横向 tab 分区(用户拍板 2026-07-04:横向导航 + 详情面包屑,不做纵向左栏
// ——应用侧栏旁再叠一条竖栏是双侧栏)。有更新并入「已安装」、导入并入「创建」。模块级 =
// session 内记住上次分区,重开 hub 回到原处;不落盘(下次启动回「推荐」)。
export type HubSection =
  | "featured"
  | "connectors"
  | "skills"
  | "agents"
  | "plugins"
  | "bundles"
  | "installed"
  | "create"
  | "cloud"

const [section, setSection] = createSignal<HubSection>("featured")

export function hubSection(): HubSection {
  return section()
}

export function setHubSection(value: HubSection): void {
  setSection(value)
}

export function extHubOpen(): boolean {
  return open()
}

export function setExtHubOpen(value: boolean): void {
  setOpen(value)
}

export function toggleExtHub(): void {
  setOpen((prev) => !prev)
}
