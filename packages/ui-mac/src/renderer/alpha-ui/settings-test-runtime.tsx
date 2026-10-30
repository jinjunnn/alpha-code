import { PlatformProvider, type Platform } from "../../../../app/src/context/platform"
import {
  SettingsProvider,
  type SettingsAuthorityCoordinator,
  useSettings,
} from "../../../../app/src/context/settings"
import { createComponent, createSignal } from "solid-js"
import type { SettingsSurfaceApi } from "./settings-authority-client"
import { AlphaSettings } from "./settings"

export { createComponent, createSignal } from "solid-js"
export { render } from "solid-js/web"
export { AlphaSettings } from "./settings"
// #1593:判据用上游真正解析按键的那份代码与默认面板键位(只读),以及壳级注册的同一份默认值。
export { DEFAULT_PALETTE_KEYBIND, parseKeybind } from "../../../../app/src/context/command"
export { SHELL_KEYBINDS } from "../sidebar/shell-keybinds"

function SettingsContextProbe() {
  const settings = useSettings()
  return (
    <div data-settings-context-probe>
      <output data-context-auto-save>{String(settings.general.autoSave())}</output>
      <output data-context-font-size>{String(settings.appearance.fontSize())}</output>
      <output data-context-release-notes>{String(settings.general.releaseNotes())}</output>
      <button type="button" data-context-update-release-notes onClick={() => settings.general.setReleaseNotes(false)}>
        Update release notes
      </button>
    </div>
  )
}

export function SettingsProductionHarness(props: {
  coordinator: SettingsAuthorityCoordinator
  api: SettingsSurfaceApi
}) {
  const platform: Platform = {
    platform: "desktop",
    os: "macos",
    settings: props.coordinator,
    openExternal() {},
    restart: async () => undefined,
    notify: async () => undefined,
    openDirectoryPickerDialog: async () => null,
  }
  return (
    <PlatformProvider value={platform}>
      <SettingsProvider>
        <SettingsContextProbe />
        <AlphaSettings open={true} onClose={() => undefined} api={props.api} />
      </SettingsProvider>
    </PlatformProvider>
  )
}
