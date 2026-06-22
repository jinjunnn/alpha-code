// Session-transient open/close state for the Extension Hub (定制中心) overlay. A module-level
// signal — there is a single hub — mirroring sidebar-state.ts. Deliberately NOT persisted: the
// hub always starts closed on launch. Imported by alpha-sidebar.tsx (the toggle button) and
// renderer/index.tsx (to drive <ExtensionHub open=…/>).

import { createSignal } from "solid-js"

const [open, setOpen] = createSignal(false)

export function extHubOpen(): boolean {
  return open()
}

export function setExtHubOpen(value: boolean): void {
  setOpen(value)
}

export function toggleExtHub(): void {
  setOpen((prev) => !prev)
}
