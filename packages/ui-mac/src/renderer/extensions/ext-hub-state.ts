// Session-transient open/close state for the Extension Hub (定制中心) overlay. A module-level
// signal — there is a single hub — mirroring sidebar-state.ts. Deliberately NOT persisted: the
// hub always starts closed on launch. Imported by alpha-sidebar.tsx (the toggle button) and
// renderer/index.tsx (to drive <ExtensionHub open=…/>).

import { createSignal } from "solid-js"

const [open, setOpen] = createSignal(false)

// REQ-019 T1:hub 顶部横向 tab 分区(横向导航 + 详情面包屑)。`#1594`(REQ-236 批准稿 `#hub-tabs`):
// 九个页签收成连接器 / 技能 / 助手三页 —— 推荐、套件、云能力成了连接器页的分组,已安装成了每页顶部一组,
// 导入收进每页的「添加」下拉。模块级 = session 内记住上次分区,重开 hub 回到原处;不落盘(下次启动回「连接器」)。
export type HubSection = "connectors" | "skills" | "agents"

const [section, setSection] = createSignal<HubSection>("connectors")

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
