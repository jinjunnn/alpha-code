import log from "electron-log/main.js"
import { createSettingsAdapter } from "./settings-adapters"
import { getStore } from "./store"
import { RENDERER_SETTINGS_STORE } from "./store-keys"

// alpha ships opencode's "new layout" (V2) as its baseline: that mode renders the minimal
// titlebar+main shell (no legacy rail sidebar, no big wordmark home) onto which our own
// Codex-style sidebar (renderer/sidebar/*) is mounted, and it is the mode whose session route
// auto-creates a draft for "new chat". opencode persists this preference in the renderer's
// `settings.v3` (electron-store file "default.dat", plain-JSON value; see
// packages/app/src/utils/persist.ts). We seed it from the main process — before the renderer
// reads it — exactly ONCE (guarded by a sentinel), so a user who later turns it back off in
// Settings is respected. Escape hatch: ALPHA_LEGACY_LAYOUT=1 skips the seed entirely.

const SEEDED_KEY = "alphaNewLayoutSeeded"

export function ensureAlphaLayoutDefault() {
  if (process.env.ALPHA_LEGACY_LAYOUT === "1") return

  const sentinelStore = getStore() // main settings store ("opencode.settings")
  if (sentinelStore.get(SEEDED_KEY)) return

  try {
    const settings = createSettingsAdapter(getStore(RENDERER_SETTINGS_STORE).path)
    const current = settings.read()
    if (!current.ok) throw new Error("settings authority unavailable")
    if (current.value.general.newLayoutDesigns !== true) {
      const next = structuredClone(current.value)
      next.general.newLayoutDesigns = true
      if (!settings.write({ value: next, expectedRevision: current.revision }).ok) {
        throw new Error("settings authority commit failed")
      }
      log.log("alpha: seeded new layout (newLayoutDesigns=true)")
    }

    sentinelStore.set(SEEDED_KEY, true)
  } catch (err) {
    log.warn("alpha: failed to seed new layout default", err)
  }

  // REQ-028:agent 控件可见性(V2 布局下 customAgents 默认隐藏 → agent.cycle 禁用,「只读」档
  // 无从切换)。同款一次性 sentinel;用户之后在设置里关掉则尊重。
  try {
    if (sentinelStore.get("alphaCustomAgentsSeeded")) return
    const settings = createSettingsAdapter(getStore(RENDERER_SETTINGS_STORE).path)
    const current = settings.read()
    if (!current.ok) throw new Error("settings authority unavailable")
    if (current.value.general.showCustomAgents !== true) {
      const next = structuredClone(current.value)
      next.general.showCustomAgents = true
      if (!settings.write({ value: next, expectedRevision: current.revision }).ok) {
        throw new Error("settings authority commit failed")
      }
      log.log("alpha: seeded custom agents visibility (showCustomAgents=true)")
    }
    sentinelStore.set("alphaCustomAgentsSeeded", true)
  } catch (err) {
    log.warn("alpha: failed to seed new layout default", err)
  }
}
