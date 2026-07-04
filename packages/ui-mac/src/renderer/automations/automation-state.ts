// 自动化面板的会话级开合状态(REQ-021 A1.1)。镜像 ext-hub-state.ts:模块级单例信号,
// 不落盘 —— 启动恒关闭。侧栏按钮与 renderer/index.tsx 共用。

import { createSignal } from "solid-js"

const [open, setOpen] = createSignal(false)

export function automationOpen(): boolean {
  return open()
}

export function setAutomationOpen(value: boolean): void {
  setOpen(value)
}

export function toggleAutomation(): void {
  setOpen((prev) => !prev)
}
