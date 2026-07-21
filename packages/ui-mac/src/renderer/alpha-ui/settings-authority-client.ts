import type { AlphaSettings, SettingsReadResult, SettingsWriteResult } from "../../shared/settings-adapters"

const SETTINGS_KEY = "settings.v3"
const SETTINGS_STORE = "default.dat"
const SETTINGS_ACCESS_ERROR = "Settings authority is available only through window.api.settings"

let revision: string | undefined

function trackRead(result: SettingsReadResult) {
  if (result.ok) revision = result.revision
  if (!result.ok) revision = result.code === "authority-invalid" ? result.revision : undefined
  return result
}

function trackWrite(result: SettingsWriteResult) {
  if (result.ok) revision = result.revision
  if (!result.ok && result.authoritative) revision = result.authoritative.revision
  if (!result.ok && result.revision) revision = result.revision
  return result
}

/** Shared renderer client: the Alpha surface and the app Settings context use the same CAS revision. */
export const settingsAuthorityClient = {
  read: () => window.api.settings.read().then(trackRead),
  validate: (value: unknown) => window.api.settings.validate(value),
  write: (input: { value: AlphaSettings; expectedRevision: string }) => window.api.settings.write(input).then(trackWrite),
}

export function isSettingsAuthorityTarget(name: string, key: string) {
  return name === SETTINGS_STORE && key === SETTINGS_KEY
}

/**
 * Typed storage shape for the app Settings context. The generic store IPC is ratcheted shut for
 * this exact key; hydration and reactive exact-replay writes are translated to the typed adapter.
 */
export function settingsAuthorityStorage() {
  const assertKey = (key: string) => {
    if (key === SETTINGS_KEY) return
    throw new Error(SETTINGS_ACCESS_ERROR)
  }
  const requireRevision = async () => {
    if (revision) return revision
    const result = await settingsAuthorityClient.read()
    if (result.ok || result.code === "authority-invalid") return result.revision
    throw new Error(`Settings authority unavailable: ${result.code}`)
  }

  return {
    getItem: async (key: string) => {
      assertKey(key)
      const result = await settingsAuthorityClient.read()
      if (!result.ok) throw new Error(`Settings authority unavailable: ${result.code}`)
      return JSON.stringify(result.value)
    },
    setItem: async (key: string, raw: string) => {
      assertKey(key)
      const value = JSON.parse(raw) as unknown
      const validated = await settingsAuthorityClient.validate(value)
      if (!validated.ok) throw new Error(`Settings candidate rejected: ${validated.code}`)
      const result = await settingsAuthorityClient.write({
        value: value as AlphaSettings,
        expectedRevision: await requireRevision(),
      })
      if (!result.ok) throw new Error(`Settings commit failed: ${result.code}`)
    },
    removeItem: async (key: string) => {
      assertKey(key)
      throw new Error(SETTINGS_ACCESS_ERROR)
    },
  }
}

export type SettingsSurfaceApi = {
  settings: {
    read: () => Promise<SettingsReadResult>
    validate: (value: unknown) => ReturnType<typeof settingsAuthorityClient.validate>
    write: (input: { value: AlphaSettings; expectedRevision: string }) => Promise<SettingsWriteResult>
  }
  extensionStorage: Window["api"]["extensionStorage"]
}

export function settingsSurfaceApi(): SettingsSurfaceApi {
  return {
    settings: settingsAuthorityClient,
    extensionStorage: window.api.extensionStorage,
  }
}
