export const SETTINGS_STORE = "opencode.settings"
export const RENDERER_SETTINGS_STORE = "default.dat"
export const RENDERER_SETTINGS_KEY = "settings.v3"
export const DEFAULT_SERVER_URL_KEY = "defaultServerUrl"
export const WSL_SERVERS_KEY = "wslServers"
export const PINCH_ZOOM_ENABLED_KEY = "pinchZoomEnabled"

export const GENERIC_SETTINGS_ACCESS_ERROR =
  "default.dat/settings.v3 is reserved for the typed Settings adapter"

/** The generic renderer store bridge must never read, mutate, delete, or clear Settings authority. */
export function assertGenericStoreAccess(name: string, key?: string) {
  if (name !== RENDERER_SETTINGS_STORE) return
  if (key !== undefined && key !== RENDERER_SETTINGS_KEY) return
  throw new Error(GENERIC_SETTINGS_ACCESS_ERROR)
}
