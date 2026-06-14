// @refresh reload
//
// alpha-code ui-mac renderer entry — Option B mount.
// Reuses @opencode-ai/app's entire state/sync/SSE/permission/diff layer by
// mounting <AppInterface> under a custom Platform + a token re-skin. NOTHING in
// opencode/ is edited; app/ui are reused via Vite alias to the submodule source.

import {
  AppBaseProviders,
  AppInterface,
  PlatformProvider,
  ServerConnection,
  type Platform,
} from "@opencode-ai/app"
import type { AsyncStorage } from "@solid-primitives/storage"
import { MemoryRouter } from "@solidjs/router"
import { createMemo, createResource, Show } from "solid-js"
import { render } from "solid-js/web"

// The full renderer CSS bundle from @opencode-ai/app (tailwind layers + the ui
// token system). Import once, BEFORE our override so theme.css wins the cascade.
import "@opencode-ai/app/index.css"
// alpha-code A re-skin: override a few brand tokens (proves the seam).
import "./theme.css"

const root = document.getElementById("root")
if (!(root instanceof HTMLElement)) throw new Error("#root not found")

// ---------------------------------------------------------------------------
// Custom Platform. Required PlatformBase members are implemented; the desktop
// discriminant adds os + openDirectoryPickerDialog. Everything else is OPTIONAL
// and either delegates to window.api or is a clearly-marked TODO stub.
// ---------------------------------------------------------------------------
function createPlatform(): Platform {
  // window.api.store* -> AsyncStorage, exactly like desktop's renderer.
  const storage = (() => {
    const cache = new Map<string, AsyncStorage>()
    const build = (name: string): AsyncStorage => {
      const api: AsyncStorage = {
        getItem: (key) => window.api.storeGet(name, key),
        setItem: (key, value) => window.api.storeSet(name, key, value),
        removeItem: (key) => window.api.storeDelete(name, key),
        clear: () => window.api.storeClear(name),
        key: async (index) => (await window.api.storeKeys(name))[index],
        getLength: () => window.api.storeLength(name),
        get length() {
          return api.getLength()
        },
      }
      return api
    }
    return (name = "default.dat") => {
      const cached = cache.get(name)
      if (cached) return cached
      const made = build(name)
      cache.set(name, made)
      return made
    }
  })()

  return {
    platform: "desktop",
    os: "macos",
    version: "0.0.0",

    // --- REQUIRED PlatformBase members ---
    openLink: (url) => window.api.openLink(url),
    restart: async () => {
      await window.api.killSidecar().catch(() => undefined)
      window.api.relaunch()
    },
    back: () => window.history.back(),
    forward: () => window.history.forward(),
    notify: async (title, description) => {
      const focused = await window.api.getWindowFocused().catch(() => document.hasFocus())
      if (focused) return
      const n = new Notification(title, { body: description ?? "" })
      n.onclick = () => {
        void window.api.showWindow()
        void window.api.setWindowFocus()
        n.close()
      }
    },

    // --- REQUIRED on the desktop discriminant ---
    async openDirectoryPickerDialog() {
      // TODO: wire a real open-directory-picker IPC + dialog.showOpenDialog.
      // Returning null is the documented "cancelled" result, so the app stays
      // functional (the directory picker just appears to be dismissed).
      return null
    },

    // --- OPTIONAL: implemented because cheap + used by the app ---
    storage,
    getDefaultServer: async () => {
      const url = await window.api.getDefaultServerUrl().catch(() => null)
      return url ? ServerConnection.Key.make(url) : null
    },
    setDefaultServer: async (url) => {
      await window.api.setDefaultServerUrl(url)
    },
    fetch: (input, init) => (input instanceof Request ? fetch(input) : fetch(input, init)),

    // --- OPTIONAL: TODO stubs (no-op / throw-free) ---
    // Each is safe to leave unimplemented for a walking skeleton; the app
    // feature-detects most of these (they are `?` on Platform).
    openPath: async (path, app) => window.api.openPath(path, app), // basic shell open
    // TODO: openAttachmentPickerDialog — needs file-picker IPC + readPickedFile.
    // TODO: saveFilePickerDialog — needs save-file-picker IPC.
    // TODO: readClipboardImage — needs read-clipboard-image IPC.
    // TODO: parseMarkdown — needs a markdown IPC (desktop uses `marked`).
    // TODO: updater — needs electron-updater wiring; omitted => updates disabled.
    // TODO: getDisplayBackend/setDisplayBackend — Linux-only, irrelevant on Mac.
    // TODO: webviewZoom / get|setPinchZoomEnabled — zoom UX, omitted.
    // TODO: runDesktopMenuAction — native menu wiring, omitted.
    // TODO: checkAppExists / exportDebugLogs / recordFatalRendererError — diag.
  }
}

const platform = createPlatform()

render(() => {
  // Sidecar credentials are available immediately (before the health check).
  const [sidecar] = createResource(() => window.api.awaitInitialization())

  const ready = createMemo(() => !sidecar.loading)

  // Build an http ServerConnection with Basic auth from the sidecar creds.
  // For type:"http" the ServerConnection.Key IS the url string.
  const servers = createMemo<ServerConnection.Any[]>(() => {
    const data = sidecar()
    if (!data) return []
    return [
      {
        type: "http",
        displayName: "alpha-code local",
        http: {
          url: data.url,
          username: data.username ?? undefined,
          password: data.password ?? undefined,
        },
      },
    ]
  })

  const defaultServer = createMemo(() => {
    const data = sidecar()
    return data ? ServerConnection.Key.make(data.url) : null
  })

  const splash = (
    <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base">
      <span class="opacity-50 animate-pulse">alpha-code</span>
    </div>
  )

  return (
    <PlatformProvider value={platform}>
      <AppBaseProviders>
        <Show when={ready()} fallback={splash}>
          <Show when={defaultServer()} keyed>
            {(key) => (
              <AppInterface
                defaultServer={key}
                servers={servers()}
                // MemoryRouter is REQUIRED in Electron: opencode's app uses
                // @solidjs/router; without an in-memory router, clicking any nav
                // button changes the window URL and the Electron window navigates
                // away / blanks (looks like "the app closed"). Mirrors desktop.
                router={MemoryRouter}
                // disableHealthCheck: embedded server is up by the time creds resolve.
                disableHealthCheck
              />
            )}
          </Show>
        </Show>
      </AppBaseProviders>
    </PlatformProvider>
  )
}, root)
