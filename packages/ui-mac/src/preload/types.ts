// Minimal window.api surface for the ui-mac walking skeleton. Only the channels
// the custom renderer Platform actually reads are exposed. Optional desktop
// capabilities (pickers, updater, clipboard image, markdown, wsl, deep links,
// zoom, menu) are intentionally omitted; the Platform stubs them with TODOs.

export type ServerReadyData = {
  url: string
  username: string | null
  password: string | null
}

export type AlphaAPI = {
  // lifecycle / server discovery
  awaitInitialization: () => Promise<ServerReadyData>
  killSidecar: () => Promise<void>
  relaunch: () => void

  // default server url
  getDefaultServerUrl: () => Promise<string | null>
  setDefaultServerUrl: (url: string | null) => Promise<void>

  // storage (Platform.storage)
  storeGet: (name: string, key: string) => Promise<string | null>
  storeSet: (name: string, key: string, value: string) => Promise<void>
  storeDelete: (name: string, key: string) => Promise<void>
  storeClear: (name: string) => Promise<void>
  storeKeys: (name: string) => Promise<string[]>
  storeLength: (name: string) => Promise<number>

  // window helpers
  getWindowCount: () => Promise<number>
  getWindowFocused: () => Promise<boolean>
  setWindowFocus: () => Promise<void>
  showWindow: () => Promise<void>

  // misc
  openLink: (url: string) => void
  openPath: (path: string, app?: string) => Promise<void>
  setBackgroundColor: (color: string) => Promise<void>
}
