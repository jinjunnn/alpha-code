import { createStore, reconcile, type Store } from "solid-js/store"
import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { persisted } from "@/utils/persist"
import { usePlatform } from "./platform"

export interface NotificationSettings {
  agent: boolean
  permissions: boolean
  errors: boolean
}

export interface SoundSettings {
  agentEnabled: boolean
  agent: string
  permissionsEnabled: boolean
  permissions: string
  errorsEnabled: boolean
  errors: string
}

export interface Settings {
  general: {
    autoSave: boolean
    releaseNotes: boolean
    followup: "queue" | "steer"
    showFileTree: boolean
    showNavigation: boolean
    showSearch: boolean
    showStatus: boolean
    showTerminal: boolean
    showReasoningSummaries: boolean
    shellToolPartsExpanded: boolean
    editToolPartsExpanded: boolean
    showSessionProgressBar: boolean
    showCustomAgents: boolean
    newLayoutDesigns?: boolean
  }
  appearance: {
    fontSize: number
    mono: string
    sans: string
    terminal: string
  }
  keybinds: Record<string, string>
  permissions: {
    autoApprove: boolean
  }
  notifications: NotificationSettings
  sounds: SoundSettings
}

export type SettingsAuthoritySnapshot = {
  value: Settings
  revision: string
}

export type SettingsAuthorityCoordinator = {
  read(): Promise<SettingsAuthoritySnapshot>
  update(change: (current: Settings) => Settings): Promise<SettingsAuthoritySnapshot>
  subscribe(listener: (snapshot: SettingsAuthoritySnapshot) => void): () => void
}

export const monoDefault = "System Mono"
export const sansDefault = "System Sans"
export const terminalDefault = "JetBrainsMono Nerd Font Mono"
export const newLayoutDesignsDefault = import.meta.env.VITE_OPENCODE_CHANNEL !== "prod"

const monoFallback =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
const sansFallback = 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
const terminalFallback =
  '"JetBrainsMono Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'

const monoBase = monoFallback
const sansBase = sansFallback
const terminalBase = terminalFallback

function input(font: string | undefined) {
  return font ?? ""
}

function family(font: string) {
  if (/^[\w-]+$/.test(font)) return font
  return `"${font.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

function stack(font: string | undefined, base: string) {
  const value = font?.trim() ?? ""
  if (!value) return base
  return `${family(value)}, ${base}`
}

export function monoInput(font: string | undefined) {
  return input(font)
}

export function sansInput(font: string | undefined) {
  return input(font)
}

export function monoFontFamily(font: string | undefined) {
  return stack(font, monoBase)
}

export function sansFontFamily(font: string | undefined) {
  return stack(font, sansBase)
}

export function terminalInput(font: string | undefined) {
  return input(font)
}

export function terminalFontFamily(font: string | undefined) {
  return stack(font, terminalBase)
}

const defaultSettings: Settings = {
  general: {
    autoSave: true,
    releaseNotes: true,
    followup: "steer",
    showFileTree: false,
    showNavigation: false,
    showSearch: false,
    showStatus: false,
    showTerminal: false,
    showReasoningSummaries: false,
    shellToolPartsExpanded: false,
    editToolPartsExpanded: false,
    showSessionProgressBar: true,
    showCustomAgents: false,
  },
  appearance: {
    fontSize: 14,
    mono: "",
    sans: "",
    terminal: "",
  },
  keybinds: {},
  permissions: {
    autoApprove: false,
  },
  notifications: {
    agent: true,
    permissions: true,
    errors: false,
  },
  sounds: {
    agentEnabled: true,
    agent: "staplebops-01",
    permissionsEnabled: true,
    permissions: "staplebops-02",
    errorsEnabled: true,
    errors: "nope-03",
  },
}

function withFallback<T>(read: () => T | undefined, fallback: T) {
  return createMemo(() => read() ?? fallback)
}

function cloneSettings(value: Settings) {
  return JSON.parse(JSON.stringify(value)) as Settings
}

function createSettingsState(coordinator: SettingsAuthorityCoordinator | undefined): {
  store: Store<Settings>
  ready: Accessor<boolean>
  update(change: (current: Settings) => Settings): void
} {
  if (!coordinator) {
    const state = persisted("settings.v3", createStore<Settings>(defaultSettings))
    return {
      store: state[0],
      ready: state[3],
      update(change) {
        state[1](reconcile(change(cloneSettings(state[0]))))
      },
    }
  }

  const [store, setStore] = createStore<Settings>(cloneSettings(defaultSettings))
  const [ready, setReady] = createSignal(false)
  const adopt = (snapshot: SettingsAuthoritySnapshot) => {
    setStore(reconcile(cloneSettings(snapshot.value)))
    setReady(true)
  }
  const unsubscribe = coordinator.subscribe(adopt)
  onCleanup(unsubscribe)
  void coordinator.read().then(adopt, () => undefined)

  return {
    store,
    ready,
    update(change) {
      setStore(reconcile(change(cloneSettings(store))))
      void coordinator.update(change).then(adopt, () => coordinator.read().then(adopt, () => undefined))
    },
  }
}

export const { use: useSettings, provider: SettingsProvider } = createSimpleContext({
  name: "Settings",
  gate: false,
  init: () => {
    const state = createSettingsState(usePlatform().settings)
    const store = state.store
    const setGeneral = <Key extends keyof Settings["general"]>(key: Key, value: Settings["general"][Key]) =>
      state.update((current) => ({ ...current, general: { ...current.general, [key]: value } }))
    const setAppearance = <Key extends keyof Settings["appearance"]>(
      key: Key,
      value: Settings["appearance"][Key],
    ) => state.update((current) => ({ ...current, appearance: { ...current.appearance, [key]: value } }))
    const setNotification = <Key extends keyof Settings["notifications"]>(
      key: Key,
      value: Settings["notifications"][Key],
    ) => state.update((current) => ({ ...current, notifications: { ...current.notifications, [key]: value } }))
    const setSound = <Key extends keyof Settings["sounds"]>(key: Key, value: Settings["sounds"][Key]) =>
      state.update((current) => ({ ...current, sounds: { ...current.sounds, [key]: value } }))
    const showFileTree = withFallback(() => store.general?.showFileTree, defaultSettings.general.showFileTree)
    const showSearch = withFallback(() => store.general?.showSearch, defaultSettings.general.showSearch)
    const showStatus = withFallback(() => store.general?.showStatus, defaultSettings.general.showStatus)
    const showCustomAgents = withFallback(
      () => store.general?.showCustomAgents,
      defaultSettings.general.showCustomAgents,
    )
    const newLayoutDesigns = withFallback(() => store.general?.newLayoutDesigns, newLayoutDesignsDefault)
    const visible = (preference: () => boolean) => createMemo(() => !newLayoutDesigns() || preference())

    createEffect(() => {
      if (typeof document === "undefined") return
      const root = document.documentElement
      root.style.setProperty("--font-family-mono", monoFontFamily(store.appearance?.mono))
      root.style.setProperty("--font-family-sans", sansFontFamily(store.appearance?.sans))
    })

    createEffect(() => {
      if (store.general?.followup !== "queue") return
      setGeneral("followup", "steer")
    })

    return {
      ready: state.ready,
      get current() {
        return store
      },
      general: {
        autoSave: withFallback(() => store.general?.autoSave, defaultSettings.general.autoSave),
        setAutoSave(value: boolean) {
          setGeneral("autoSave", value)
        },
        releaseNotes: withFallback(() => store.general?.releaseNotes, defaultSettings.general.releaseNotes),
        setReleaseNotes(value: boolean) {
          setGeneral("releaseNotes", value)
        },
        followup: withFallback(
          () => (store.general?.followup === "queue" ? "steer" : store.general?.followup),
          defaultSettings.general.followup,
        ),
        setFollowup(value: "queue" | "steer") {
          setGeneral("followup", value === "queue" ? "steer" : value)
        },
        showFileTree,
        setShowFileTree(value: boolean) {
          setGeneral("showFileTree", value)
        },
        showNavigation: withFallback(() => store.general?.showNavigation, defaultSettings.general.showNavigation),
        setShowNavigation(value: boolean) {
          setGeneral("showNavigation", value)
        },
        showSearch,
        setShowSearch(value: boolean) {
          setGeneral("showSearch", value)
        },
        showStatus,
        setShowStatus(value: boolean) {
          setGeneral("showStatus", value)
        },
        showTerminal: withFallback(() => store.general?.showTerminal, defaultSettings.general.showTerminal),
        setShowTerminal(value: boolean) {
          setGeneral("showTerminal", value)
        },
        showReasoningSummaries: withFallback(
          () => store.general?.showReasoningSummaries,
          defaultSettings.general.showReasoningSummaries,
        ),
        setShowReasoningSummaries(value: boolean) {
          setGeneral("showReasoningSummaries", value)
        },
        shellToolPartsExpanded: withFallback(
          () => store.general?.shellToolPartsExpanded,
          defaultSettings.general.shellToolPartsExpanded,
        ),
        setShellToolPartsExpanded(value: boolean) {
          setGeneral("shellToolPartsExpanded", value)
        },
        editToolPartsExpanded: withFallback(
          () => store.general?.editToolPartsExpanded,
          defaultSettings.general.editToolPartsExpanded,
        ),
        setEditToolPartsExpanded(value: boolean) {
          setGeneral("editToolPartsExpanded", value)
        },
        showSessionProgressBar: withFallback(
          () => store.general?.showSessionProgressBar,
          defaultSettings.general.showSessionProgressBar,
        ),
        setShowSessionProgressBar(value: boolean) {
          setGeneral("showSessionProgressBar", value)
        },
        showCustomAgents,
        setShowCustomAgents(value: boolean) {
          setGeneral("showCustomAgents", value)
        },
        newLayoutDesigns,
        setNewLayoutDesigns(value: boolean) {
          setGeneral("newLayoutDesigns", value)
        },
      },
      visibility: {
        fileTree: visible(showFileTree),
        search: visible(showSearch),
        status: visible(showStatus),
        customAgents: visible(showCustomAgents),
      },
      appearance: {
        fontSize: withFallback(() => store.appearance?.fontSize, defaultSettings.appearance.fontSize),
        setFontSize(value: number) {
          setAppearance("fontSize", value)
        },
        font: withFallback(() => store.appearance?.mono, defaultSettings.appearance.mono),
        setFont(value: string) {
          setAppearance("mono", value.trim() ? value : "")
        },
        uiFont: withFallback(() => store.appearance?.sans, defaultSettings.appearance.sans),
        setUIFont(value: string) {
          setAppearance("sans", value.trim() ? value : "")
        },
        terminalFont: withFallback(() => store.appearance?.terminal, defaultSettings.appearance.terminal),
        setTerminalFont(value: string) {
          setAppearance("terminal", value.trim() ? value : "")
        },
      },
      keybinds: {
        get: (action: string) => store.keybinds?.[action],
        set(action: string, keybind: string) {
          state.update((current) => ({ ...current, keybinds: { ...current.keybinds, [action]: keybind } }))
        },
        reset(action: string) {
          state.update((current) => {
            if (!Object.prototype.hasOwnProperty.call(current.keybinds, action)) return current
            const keybinds = { ...current.keybinds }
            delete keybinds[action]
            return { ...current, keybinds }
          })
        },
        resetAll() {
          state.update((current) => ({ ...current, keybinds: {} }))
        },
      },
      permissions: {
        autoApprove: withFallback(() => store.permissions?.autoApprove, defaultSettings.permissions.autoApprove),
        setAutoApprove(value: boolean) {
          state.update((current) => ({ ...current, permissions: { autoApprove: value } }))
        },
      },
      notifications: {
        agent: withFallback(() => store.notifications?.agent, defaultSettings.notifications.agent),
        setAgent(value: boolean) {
          setNotification("agent", value)
        },
        permissions: withFallback(() => store.notifications?.permissions, defaultSettings.notifications.permissions),
        setPermissions(value: boolean) {
          setNotification("permissions", value)
        },
        errors: withFallback(() => store.notifications?.errors, defaultSettings.notifications.errors),
        setErrors(value: boolean) {
          setNotification("errors", value)
        },
      },
      sounds: {
        agentEnabled: withFallback(() => store.sounds?.agentEnabled, defaultSettings.sounds.agentEnabled),
        setAgentEnabled(value: boolean) {
          setSound("agentEnabled", value)
        },
        agent: withFallback(() => store.sounds?.agent, defaultSettings.sounds.agent),
        setAgent(value: string) {
          setSound("agent", value)
        },
        permissionsEnabled: withFallback(
          () => store.sounds?.permissionsEnabled,
          defaultSettings.sounds.permissionsEnabled,
        ),
        setPermissionsEnabled(value: boolean) {
          setSound("permissionsEnabled", value)
        },
        permissions: withFallback(() => store.sounds?.permissions, defaultSettings.sounds.permissions),
        setPermissions(value: string) {
          setSound("permissions", value)
        },
        errorsEnabled: withFallback(() => store.sounds?.errorsEnabled, defaultSettings.sounds.errorsEnabled),
        setErrorsEnabled(value: boolean) {
          setSound("errorsEnabled", value)
        },
        errors: withFallback(() => store.sounds?.errors, defaultSettings.sounds.errors),
        setErrors(value: string) {
          setSound("errors", value)
        },
      },
    }
  },
})
