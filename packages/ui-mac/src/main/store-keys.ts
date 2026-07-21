export const SETTINGS_STORE = "opencode.settings"
export const RENDERER_SETTINGS_STORE = "default.dat"
export const RENDERER_SETTINGS_KEY = "settings.v3"
export const DEFAULT_SERVER_URL_KEY = "defaultServerUrl"
export const WSL_SERVERS_KEY = "wslServers"
export const PINCH_ZOOM_ENABLED_KEY = "pinchZoomEnabled"

export const GENERIC_SETTINGS_ACCESS_ERROR =
  "default.dat/settings.v3 is reserved for the typed Settings adapter"
export const GENERIC_STORE_NAME_ERROR = "generic renderer store name must be a platform-safe filename"

export function normalizeGenericStoreName(name: string) {
  if (/[\\/]/.test(name)) throw new Error(GENERIC_STORE_NAME_ERROR)
  return normalizeNtfsBaseComponent(name)
}

export function isRendererSettingsAuthorityTarget(name: string, key?: string) {
  if (normalizeGenericStoreName(name) !== RENDERER_SETTINGS_STORE) return false
  return key === undefined || normalizeNtfsBaseComponent(key) === RENDERER_SETTINGS_KEY
}

/** The generic renderer store bridge must never read, mutate, delete, or clear Settings authority. */
export function assertGenericStoreAccess(name: string, key?: string) {
  if (!isRendererSettingsAuthorityTarget(name, key)) return
  throw new Error(GENERIC_SETTINGS_ACCESS_ERROR)
}

function normalizeNtfsBaseComponent(value: string) {
  const colon = value.indexOf(":")
  return value.slice(0, colon < 0 ? value.length : colon).replace(/[ .]+$/u, "").toLowerCase()
}
