import { contextBridge, ipcRenderer } from "electron"
import type { AuthState, ElectronAPI, WslServersEvent } from "./types"
import type { UpdaterState } from "@opencode-ai/app/updater"

const updaterCallbacks = new Set<(state: UpdaterState) => void>()
let updaterState: UpdaterState | undefined
let updaterSubscription: Promise<void> | undefined
const updaterHandler = (_: unknown, state: UpdaterState) => {
  updaterState = state
  updaterCallbacks.forEach((callback) => callback(state))
}

const api: ElectronAPI = {
  killSidecar: () => ipcRenderer.invoke("kill-sidecar"),
  installCli: () => ipcRenderer.invoke("install-cli"),
  awaitInitialization: () => ipcRenderer.invoke("await-initialization"),
  wslServers: {
    getState: () => ipcRenderer.invoke("wsl-servers-get-state"),
    subscribe: (cb) => {
      const handler = (_: unknown, event: WslServersEvent) => cb(event)
      ipcRenderer.on("wsl-servers-event", handler)
      void ipcRenderer.invoke("wsl-servers-subscribe")
      return () => {
        ipcRenderer.removeListener("wsl-servers-event", handler)
        void ipcRenderer.invoke("wsl-servers-unsubscribe")
      }
    },
    probeRuntime: () => ipcRenderer.invoke("wsl-servers-probe-runtime"),
    refreshDistros: () => ipcRenderer.invoke("wsl-servers-refresh-distros"),
    installWsl: () => ipcRenderer.invoke("wsl-servers-install-wsl"),
    installDistro: (name) => ipcRenderer.invoke("wsl-servers-install-distro", name),
    probeDistro: (name) => ipcRenderer.invoke("wsl-servers-probe-distro", name),
    probeOpencode: (name) => ipcRenderer.invoke("wsl-servers-probe-opencode", name),
    installOpencode: (name) => ipcRenderer.invoke("wsl-servers-install-opencode", name),
    openTerminal: (name) => ipcRenderer.invoke("wsl-servers-open-terminal", name),
    addServer: (distro) => ipcRenderer.invoke("wsl-servers-add", distro),
    removeServer: (id) => ipcRenderer.invoke("wsl-servers-remove", id),
    startServer: (id) => ipcRenderer.invoke("wsl-servers-start", id),
  },
  updater: {
    subscribe: async (cb) => {
      updaterCallbacks.add(cb)
      if (updaterState) cb(updaterState)
      if (!updaterSubscription) {
        ipcRenderer.on("updater-state", updaterHandler)
        updaterSubscription = ipcRenderer.invoke("updater-subscribe")
      }
      await updaterSubscription
      return () => {
        updaterCallbacks.delete(cb)
        if (updaterCallbacks.size > 0) return
        ipcRenderer.removeListener("updater-state", updaterHandler)
        updaterSubscription = undefined
        void ipcRenderer.invoke("updater-unsubscribe")
      }
    },
    check: () => ipcRenderer.invoke("updater-check"),
    install: () => ipcRenderer.invoke("updater-install"),
  },
  consumeInitialDeepLinks: () => ipcRenderer.invoke("consume-initial-deep-links"),
  getDefaultServerUrl: () => ipcRenderer.invoke("get-default-server-url"),
  setDefaultServerUrl: (url) => ipcRenderer.invoke("set-default-server-url", url),
  getDisplayBackend: () => ipcRenderer.invoke("get-display-backend"),
  setDisplayBackend: (backend) => ipcRenderer.invoke("set-display-backend", backend),
  parseMarkdownCommand: (markdown) => ipcRenderer.invoke("parse-markdown", markdown),
  checkAppExists: (appName) => ipcRenderer.invoke("check-app-exists", appName),
  resolveAppPath: (appName) => ipcRenderer.invoke("resolve-app-path", appName),
  storeGet: (name, key) => ipcRenderer.invoke("store-get", name, key),
  storeSet: (name, key, value) => ipcRenderer.invoke("store-set", name, key, value),
  storeDelete: (name, key) => ipcRenderer.invoke("store-delete", name, key),
  storeClear: (name) => ipcRenderer.invoke("store-clear", name),
  storeKeys: (name) => ipcRenderer.invoke("store-keys", name),
  storeLength: (name) => ipcRenderer.invoke("store-length", name),

  getWindowCount: () => ipcRenderer.invoke("get-window-count"),
  onMenuCommand: (cb) => {
    const handler = (_: unknown, id: string) => cb(id)
    ipcRenderer.on("menu-command", handler)
    return () => ipcRenderer.removeListener("menu-command", handler)
  },
  onDeepLink: (cb) => {
    const handler = (_: unknown, urls: string[]) => cb(urls)
    ipcRenderer.on("deep-link", handler)
    return () => ipcRenderer.removeListener("deep-link", handler)
  },

  openDirectoryPicker: (opts) => ipcRenderer.invoke("open-directory-picker", opts),
  openFilePicker: (opts) => ipcRenderer.invoke("open-file-picker", opts),
  readPickedFile: (token, path) => ipcRenderer.invoke("read-picked-file", token, path),
  releasePickedFiles: (token) => ipcRenderer.invoke("release-picked-files", token),
  saveFilePicker: (opts) => ipcRenderer.invoke("save-file-picker", opts),
  openLink: (url) => ipcRenderer.send("open-link", url),
  openPath: (path, app) => ipcRenderer.invoke("open-path", path, app),
  readClipboardImage: () => ipcRenderer.invoke("read-clipboard-image"),
  writeClipboard: (text: string) => ipcRenderer.invoke("write-clipboard", text) as Promise<boolean>,
  showNotification: (title, body) => ipcRenderer.send("show-notification", title, body),
  getWindowFocused: () => ipcRenderer.invoke("get-window-focused"),
  setWindowFocus: () => ipcRenderer.invoke("set-window-focus"),
  showWindow: () => ipcRenderer.invoke("show-window"),
  relaunch: () => ipcRenderer.send("relaunch"),
  endpoints: () => ipcRenderer.invoke("alpha-endpoints"),
  getZoomFactor: () => ipcRenderer.invoke("get-zoom-factor"),
  setZoomFactor: (factor) => ipcRenderer.invoke("set-zoom-factor", factor),
  getPinchZoomEnabled: () => ipcRenderer.invoke("get-pinch-zoom-enabled"),
  setPinchZoomEnabled: (enabled) => ipcRenderer.invoke("set-pinch-zoom-enabled", enabled),
  onPinchZoomEnabledChanged: (cb) => {
    const handler = (_: unknown, enabled: boolean) => cb(enabled)
    ipcRenderer.on("pinch-zoom-enabled-changed", handler)
    return () => ipcRenderer.removeListener("pinch-zoom-enabled-changed", handler)
  },
  onZoomFactorChanged: (cb) => {
    const handler = (_: unknown, factor: number) => cb(factor)
    ipcRenderer.on("zoom-factor-changed", handler)
    return () => ipcRenderer.removeListener("zoom-factor-changed", handler)
  },
  setTitlebar: (theme) => ipcRenderer.invoke("set-titlebar", theme),
  runDesktopMenuAction: (action) => ipcRenderer.invoke("run-desktop-menu-action", action),
  setBackgroundColor: (color: string) => ipcRenderer.invoke("set-background-color", color),
  exportDebugLogs: () => ipcRenderer.invoke("export-debug-logs"),
  recordFatalRendererError: (error) => ipcRenderer.invoke("record-fatal-renderer-error", error),
  auth: {
    getState: () => ipcRenderer.invoke("auth-get-state"),
    start: () => ipcRenderer.invoke("auth-start"),
    logout: () => ipcRenderer.invoke("auth-logout"),
    setMode: (mode) => ipcRenderer.invoke("auth-set-mode", mode),
    enableProxy: () => ipcRenderer.invoke("auth-enable-proxy"),
    subscribe: (cb) => {
      const handler = (_: unknown, state: AuthState) => cb(state)
      ipcRenderer.on("auth-state", handler)
      void ipcRenderer
        .invoke("auth-get-state")
        .then((state: AuthState) => cb(state))
        .catch(() => {})
      return () => ipcRenderer.removeListener("auth-state", handler)
    },
  },
  ext: {
    persistMcp: (name, server, meta, secretVars) =>
      ipcRenderer.invoke("ext-persist-mcp", name, server, meta, secretVars),
    removeMcp: (name) => ipcRenderer.invoke("ext-remove-mcp", name),
    checkRuntime: (tool) => ipcRenderer.invoke("ext-check-runtime", tool),
    configHealth: () => ipcRenderer.invoke("ext-config-health"),
    factorySkillIds: () => ipcRenderer.invoke("ext-factory-skill-ids"),
    installPlugin: (pkg, meta) => ipcRenderer.invoke("ext-install-plugin", pkg, meta),
    installBuiltinSkill: (builtinAssetKey, name, target, meta) =>
      ipcRenderer.invoke("ext-install-builtin-skill", builtinAssetKey, name, target, meta),
    readBuiltinSkill: (builtinAssetKey) => ipcRenderer.invoke("ext-read-builtin-skill", builtinAssetKey),
    importSkillFolder: (srcDir, target) => ipcRenderer.invoke("ext-import-skill-folder", srcDir, target),
    importSkillGit: (url, target) => ipcRenderer.invoke("ext-import-skill-git", url, target),
    installBuiltinAgent: (builtinAssetKey, name, target, meta) =>
      ipcRenderer.invoke("ext-install-builtin-agent", builtinAssetKey, name, target, meta),
    installVendoredPlugin: (vendoredAssetKey, name, meta) =>
      ipcRenderer.invoke("ext-install-vendored-plugin", vendoredAssetKey, name, meta),
    listInstalls: (projectDir) => ipcRenderer.invoke("ext-list-installs", projectDir),
    uninstall: (receipt) => ipcRenderer.invoke("ext-uninstall", receipt),
    migrateScan: () => ipcRenderer.invoke("ext-migrate-scan"),
    removeLegacy: (type, name) => ipcRenderer.invoke("ext-migrate-remove-legacy", type, name),
    enableCloud: (id, name, meta) => ipcRenderer.invoke("ext-enable-cloud", id, name, meta),
  },
  account: {
    summary: () => ipcRenderer.invoke("account-summary"),
    transactions: (limit) => ipcRenderer.invoke("account-transactions", limit),
  },
  cloud: {
    dispatch: (envelope) => ipcRenderer.invoke("cloud-dispatch", envelope),
    status: (jobId) => ipcRenderer.invoke("cloud-status", jobId),
    cancel: (jobId) => ipcRenderer.invoke("cloud-cancel", jobId),
    artifacts: (jobId) => ipcRenderer.invoke("cloud-artifacts", jobId),
    fetchArtifact: (artifactId) => ipcRenderer.invoke("cloud-artifact-content", artifactId),
    saveRun: (directory, runId, contract) => ipcRenderer.invoke("cloud-save-run", directory, runId, contract),
    subscribe: (jobId) => ipcRenderer.invoke("cloud-subscribe", jobId),
    unsubscribe: (jobId) => ipcRenderer.invoke("cloud-unsubscribe", jobId),
    gitDiff: (directory) => ipcRenderer.invoke("cloud-git-diff", directory),
    onEvent: (cb) => {
      const h = (_e: unknown, payload: { jobId: string; event: string; data: unknown; id?: string }) => cb(payload)
      ipcRenderer.on("cloud-job-event", h)
      return () => ipcRenderer.removeListener("cloud-job-event", h)
    },
  },
  automations: {
    list: () => ipcRenderer.invoke("automations-list"),
    save: (task) => ipcRenderer.invoke("automations-save", task),
    remove: (id) => ipcRenderer.invoke("automations-delete", id),
    toggle: (id, enabled) => ipcRenderer.invoke("automations-toggle", id, enabled),
    pauseAll: (paused) => ipcRenderer.invoke("automations-pause-all", paused),
    loginItem: (open) => ipcRenderer.invoke("automations-login-item", open),
    onEvent: (cb) => {
      const h = (_e: unknown, event: Parameters<typeof cb>[0]) => cb(event)
      ipcRenderer.on("automation-event", h)
      return () => ipcRenderer.removeListener("automation-event", h)
    },
  },
  models: {
    catalog: () => ipcRenderer.invoke("models-catalog"),
    platformLive: () => ipcRenderer.invoke("models-platform-live"),
  },
  providers: {
    add: (input) => ipcRenderer.invoke("providers-add", input),
    test: (input) => ipcRenderer.invoke("providers-test", input),
    keyStatus: () => ipcRenderer.invoke("providers-key-status"),
    setKey: (id, key) => ipcRenderer.invoke("providers-set-key", id, key),
    removeKey: (id) => ipcRenderer.invoke("providers-remove-key", id),
    remove: (id) => ipcRenderer.invoke("providers-remove", id),
  },
}

contextBridge.exposeInMainWorld("api", api)
