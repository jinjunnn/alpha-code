import log from "electron-log/main.js"
import { getStore } from "./store"

// alpha ships opencode's "new layout" (V2) as its baseline: that mode renders the minimal
// titlebar+main shell (no legacy rail sidebar, no big wordmark home) onto which our own
// Codex-style sidebar (renderer/sidebar/*) is mounted, and it is the mode whose session route
// auto-creates a draft for "new chat". opencode persists this preference in the renderer's
// `settings.v3` (electron-store file "default.dat", plain-JSON value; see
// packages/app/src/utils/persist.ts). We seed it from the main process — before the renderer
// reads it — exactly ONCE (guarded by a sentinel), so a user who later turns it back off in
// Settings is respected. Escape hatch: ALPHA_LEGACY_LAYOUT=1 skips the seed entirely.

const RENDERER_STORE = "default.dat"
const SETTINGS_KEY = "settings.v3"
const SEEDED_KEY = "alphaNewLayoutSeeded"

export function ensureAlphaLayoutDefault() {
  if (process.env.ALPHA_LEGACY_LAYOUT === "1") return

  const sentinelStore = getStore() // main settings store ("opencode.settings")
  if (sentinelStore.get(SEEDED_KEY)) return

  try {
    const store = getStore(RENDERER_STORE)
    const raw = store.get(SETTINGS_KEY)

    let settings: Record<string, unknown> = {}
    if (typeof raw === "string") {
      try {
        settings = JSON.parse(raw) as Record<string, unknown>
      } catch {
        settings = {}
      }
    } else if (raw && typeof raw === "object") {
      settings = raw as Record<string, unknown>
    }

    const general =
      settings.general && typeof settings.general === "object"
        ? (settings.general as Record<string, unknown>)
        : {}

    if (general.newLayoutDesigns !== true) {
      general.newLayoutDesigns = true
      settings.general = general
      store.set(SETTINGS_KEY, JSON.stringify(settings))
      log.log("alpha: seeded new layout (newLayoutDesigns=true)")
    }

    sentinelStore.set(SEEDED_KEY, true)
  } catch (err) {
    log.warn("alpha: failed to seed new layout default", err)
  }
}
