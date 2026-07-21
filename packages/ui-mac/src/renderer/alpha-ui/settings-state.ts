import { createSignal } from "solid-js"

const [open, setOpen] = createSignal(false)

export function settingsOpen() {
  return open()
}

export function setSettingsOpen(value: boolean) {
  setOpen(value)
}
