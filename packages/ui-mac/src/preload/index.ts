import { contextBridge, ipcRenderer } from "electron"
import {
  type AuthErrorCode,
  type AuthState,
  type CloudArtifactProgress,
  type CloudRunSavedEvent,
  type ContractFailure,
  type DeepLinkBatch,
  type ElectronAPI,
  type HtmlPreviewClosedEvent,
  type RendererStartupMarkName,
  type SidecarGenerationState,
  STARTUP_TIMELINE_CHANNEL,
  type StartupTimelineExtra,
  type WslServersEvent,
} from "./types"
import type { UpdaterState } from "@opencode-ai/app/updater"
import type { SessionGrantsEndedEventWire } from "./types"

const updaterCallbacks = new Set<(state: UpdaterState) => void>()
let updaterState: UpdaterState | undefined
let updaterSubscription: Promise<void> | undefined
const updaterHandler = (_: unknown, state: UpdaterState) => {
  updaterState = state
  updaterCallbacks.forEach((callback) => callback(state))
}

const api: ElectronAPI = {
  killSidecar: () => ipcRenderer.invoke("kill-sidecar"),
  sidecarGeneration: {
    getState: () => ipcRenderer.invoke("sidecar-generation-state"),
    subscribe: (cb) => {
      const handler = (_: unknown, state: SidecarGenerationState) => cb(state)
      ipcRenderer.on("sidecar-generation", handler)
      void ipcRenderer
        .invoke("sidecar-generation-state")
        .then((state: SidecarGenerationState) => cb(state))
        .catch(() => {})
      return () => ipcRenderer.removeListener("sidecar-generation", handler)
    },
  },
  startupTimeline: {
    mark: (name: RendererStartupMarkName, rendererNow: number, extra?: StartupTimelineExtra) =>
      ipcRenderer.send(STARTUP_TIMELINE_CHANNEL, { name, rendererNow, extra }),
  },
  contracts: {
    health: () => ipcRenderer.invoke("alpha-contract-health"),
    subscribe: (cb) => {
      const handler = (_: unknown, failure: ContractFailure) => cb(failure)
      ipcRenderer.on("alpha-contract-failure", handler)
      return () => ipcRenderer.removeListener("alpha-contract-failure", handler)
    },
  },
  recovery: {
    onIncident: (cb) => {
      const handler = (_: unknown, incident: Parameters<typeof cb>[0]) => cb(incident)
      ipcRenderer.on("alpha-recovery-incident", handler)
      return () => ipcRenderer.removeListener("alpha-recovery-incident", handler)
    },
    submit: (request) => ipcRenderer.invoke("recovery-submit", request),
  },
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
    probeAddable: (distros: string[]) => ipcRenderer.invoke("wsl-servers-probe-addable", distros),
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
  settings: {
    read: () => ipcRenderer.invoke("settings-read"),
    validate: (value) => ipcRenderer.invoke("settings-validate", value),
    write: (input) => ipcRenderer.invoke("settings-write", input),
  },
  extensionStorage: {
    snapshot: () => ipcRenderer.invoke("extension-storage-snapshot"),
    inspect: () => ipcRenderer.invoke("extension-storage-inspect"),
    collect: () => ipcRenderer.invoke("extension-storage-collect"),
  },

  getWindowCount: () => ipcRenderer.invoke("get-window-count"),
  onMenuCommand: (cb) => {
    const handler = (_: unknown, id: string) => cb(id)
    ipcRenderer.on("menu-command", handler)
    return () => ipcRenderer.removeListener("menu-command", handler)
  },
  onDeepLink: (cb) => {
    const handler = (_: unknown, batch: DeepLinkBatch) => cb(batch)
    ipcRenderer.on("deep-link", handler)
    return () => ipcRenderer.removeListener("deep-link", handler)
  },
  acknowledgeDeepLinks: (batchId) => ipcRenderer.invoke("acknowledge-deep-links", batchId),

  openDirectoryPicker: (opts) => ipcRenderer.invoke("open-directory-picker", opts),
  workspaceDefaultDir: () => ipcRenderer.invoke("alpha-workspace-default"),
  workspaceEnsureDefault: (dir) => ipcRenderer.invoke("alpha-workspace-ensure", dir),
  openFilePicker: (opts) => ipcRenderer.invoke("open-file-picker", opts),
  readPickedFile: (token, path) => ipcRenderer.invoke("read-picked-file", token, path),
  releasePickedFiles: (token) => ipcRenderer.invoke("release-picked-files", token),
  saveFilePicker: (opts) => ipcRenderer.invoke("save-file-picker", opts),
  openLink: (url) => ipcRenderer.send("open-link", url),
  openPath: (path, app) => ipcRenderer.invoke("open-path", path, app),
  popupAppMenu: () => ipcRenderer.invoke("popup-app-menu"),
  readClipboardImage: () => ipcRenderer.invoke("read-clipboard-image"),
  writeClipboard: (text: string) => ipcRenderer.invoke("write-clipboard", text) as Promise<boolean>,
  showNotification: (title, body) => ipcRenderer.send("show-notification", title, body),
  getWindowFocused: () => ipcRenderer.invoke("get-window-focused"),
  setWindowFocus: () => ipcRenderer.invoke("set-window-focus"),
  showWindow: () => ipcRenderer.invoke("show-window"),
  relaunch: () => ipcRenderer.send("relaunch"),
  endpoints: () => ipcRenderer.invoke("alpha-endpoints"),
  // REQ-098:环境快照只读通道 —— 刻意不传任何参数(环境由 main 从构建事实解析,renderer 零输入)。
  environment: () => ipcRenderer.invoke("alpha-environment"),
  surfaces: {
    reportFailure: (payload) => ipcRenderer.invoke("alpha-surface-failure", payload),
  },
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
    onError: (cb) => {
      const handler = (_: unknown, e: { code: AuthErrorCode }) => cb(e)
      ipcRenderer.on("auth-error", handler)
      return () => ipcRenderer.removeListener("auth-error", handler)
    },
  },
  ext: {
    persistMcp: (name, server, secretVars) => ipcRenderer.invoke("ext-persist-mcp", name, server, secretVars),
    removeMcp: (name) => ipcRenderer.invoke("ext-remove-mcp", name),
    checkRuntime: (tool) => ipcRenderer.invoke("ext-check-runtime", tool),
    configHealth: () => ipcRenderer.invoke("ext-config-health"),
    factorySkillIds: () => ipcRenderer.invoke("ext-factory-skill-ids"),
    builtinRead: () => ipcRenderer.invoke("builtin-read"),
    builtinApply: (gov, visibleAgents, confirmBuildDisable) =>
      ipcRenderer.invoke("builtin-apply", gov, visibleAgents, confirmBuildDisable),
    builtinReset: () => ipcRenderer.invoke("builtin-reset"),
    importAgentPreview: (token, filePath) => ipcRenderer.invoke("ext-import-agent-preview", token, filePath),
    importAgentConfirm: (previewId) => ipcRenderer.invoke("ext-import-agent-confirm", previewId),
    remoteCatalog: () => ipcRenderer.invoke("ext-remote-catalog"),
    packageDetail: (catalogId) => ipcRenderer.invoke("ext-package-detail", catalogId),
    curationBlob: (catalogId, kind) => ipcRenderer.invoke("ext-curation-blob", catalogId, kind),
    browseSeed: () => ipcRenderer.invoke("ext-seed-browse"),
    installPlugin: (pkg) => ipcRenderer.invoke("ext-install-plugin", pkg),
    installCatalog: (intent) => ipcRenderer.invoke("ext-install-catalog", intent),
    readBuiltinSkill: (builtinAssetKey) => ipcRenderer.invoke("ext-read-builtin-skill", builtinAssetKey),
    importSkillFolder: (target) => ipcRenderer.invoke("ext-import-skill-folder", target),
    importSkillGit: (url, target) => ipcRenderer.invoke("ext-import-skill-git", url, target),
    listInstalls: (projectDir) => ipcRenderer.invoke("ext-list-installs", projectDir),
    uninstallV2: (intent) => ipcRenderer.invoke("ext-uninstall-v2", intent),
    setInstallState: (intent) => ipcRenderer.invoke("ext-set-install-state", intent),
    advisoryActive: () => ipcRenderer.invoke("ext-advisory-active"),
    listGenerations: (intent) => ipcRenderer.invoke("ext-list-generations", intent),
    rollback: (intent, genId) => ipcRenderer.invoke("ext-rollback", intent, genId),
    migrateScan: () => ipcRenderer.invoke("ext-migrate-scan"),
    migrateVerify: (requests) => ipcRenderer.invoke("ext-migrate-verify", requests),
    removeLegacy: (type, name) => ipcRenderer.invoke("ext-migrate-remove-legacy", type, name),
    trustCheck: (directory) => ipcRenderer.invoke("ext-trust-check", directory),
    externalCheck: (directory) => ipcRenderer.invoke("ext-external-check", directory),
    projectResidualsCheck: (projectDir) => ipcRenderer.invoke("ext-project-residuals-check", projectDir),
    projectResidualsClean: (projectDir) => ipcRenderer.invoke("ext-project-residuals-clean", projectDir),
    journalRetainedList: (intent) => ipcRenderer.invoke("ext-journal-retained-list", intent),
    journalRetire: (intent) => ipcRenderer.invoke("ext-journal-retire", intent),
    // REQ-103(#195):governance 只读查询(五维所有权 + 三态)。只透传 projectDir,零写面。
    inventoryView: (projectDir) => ipcRenderer.invoke("ext-inventory-view", projectDir),
    // #408:session-grant 三通道 + 会话结束事件(labs 条目会话级启用;grant 纯 main 内存,零持久面)。
    sessionGrant: (input) => ipcRenderer.invoke("ext-session-grant", input),
    sessionGrantRevoke: (input) => ipcRenderer.invoke("ext-session-grant-revoke", input),
    sessionGrants: () => ipcRenderer.invoke("ext-session-grants"),
    onSessionGrantsEnded: (cb) => {
      const handler = (_: unknown, e: SessionGrantsEndedEventWire) => cb(e)
      ipcRenderer.on("ext-session-grants-ended", handler)
      return () => ipcRenderer.removeListener("ext-session-grants-ended", handler)
    },
  },
  account: {
    summary: () => ipcRenderer.invoke("account-summary"),
    transactions: (limit) => ipcRenderer.invoke("account-transactions", limit),
  },
  cloud: {
    dispatch: (envelope) => ipcRenderer.invoke("cloud-dispatch", envelope),
    upload: (intent) => ipcRenderer.invoke("cloud-upload", intent),
    confirmUpload: (requestId) => ipcRenderer.invoke("cloud-upload-confirm", requestId),
    cancelUpload: (requestId) => ipcRenderer.invoke("cloud-upload-cancel", requestId),
    status: (jobId) => ipcRenderer.invoke("cloud-status", jobId),
    cancel: (jobId) => ipcRenderer.invoke("cloud-cancel", jobId),
    artifacts: (jobId) => ipcRenderer.invoke("cloud-artifacts", jobId),
    // REQ-092:descriptor-only 下载通道(进度=事件订阅;内容字节永不过 IPC)。
    downloadArtifact: (directory, runId, artifact) =>
      ipcRenderer.invoke("cloud-artifact-download", directory, runId, artifact),
    cancelArtifactDownload: (artifactId) => ipcRenderer.invoke("cloud-artifact-download-cancel", artifactId),
    onArtifactProgress: (cb) => {
      const h = (_e: unknown, p: CloudArtifactProgress) => cb(p)
      ipcRenderer.on("cloud-artifact-progress", h)
      return () => ipcRenderer.removeListener("cloud-artifact-progress", h)
    },
    saveRun: (directory, runId, contract) => ipcRenderer.invoke("cloud-save-run", directory, runId, contract),
    onRunSaved: (cb) => {
      const h = (_e: unknown, e: CloudRunSavedEvent) => cb(e)
      ipcRenderer.on("cloud-run-saved", h)
      return () => ipcRenderer.removeListener("cloud-run-saved", h)
    },
    subscribe: (jobId) => ipcRenderer.invoke("cloud-subscribe", jobId),
    unsubscribe: (jobId) => ipcRenderer.invoke("cloud-unsubscribe", jobId),
    gitDiff: (directory) => ipcRenderer.invoke("cloud-git-diff", directory),
    onEvent: (cb) => {
      const h = (_e: unknown, payload: { jobId: string; event: string; data: unknown; id?: string }) => cb(payload)
      ipcRenderer.on("cloud-job-event", h)
      return () => ipcRenderer.removeListener("cloud-job-event", h)
    },
  },
  // REQ-093(#185):run artifact manifest 只读查询(main 侧 artifact-service;无字节、无绝对路径)。
  runArtifacts: {
    list: (directory, runId) => ipcRenderer.invoke("run-artifacts-list", directory, runId),
    inspect: (directory, runId, artifactId) => ipcRenderer.invoke("run-artifact-inspect", directory, runId, artifactId),
    usage: (directory, runId) => ipcRenderer.invoke("run-artifacts-usage", directory, runId),
    projectUsage: (directory) => ipcRenderer.invoke("run-artifacts-usage", directory),
    // REQ-094/095(#186/#187):打开前复核 + 受控内容读取(text 截断 / bytes 限额;守卫在 main)。
    verify: (directory, runId, artifactId) => ipcRenderer.invoke("run-artifact-verify", directory, runId, artifactId),
    read: (directory, runId, ref, opts) => ipcRenderer.invoke("run-artifact-read", directory, runId, ref, opts),
    openExternal: (directory, runId, artifactId) =>
      ipcRenderer.invoke("run-artifact-open-external", directory, runId, artifactId),
    quickLook: (identity) => ipcRenderer.invoke("run-artifact-quick-look", identity),
  },
  // REQ-096(#188):隔离 HTML preview 控制通道 —— renderer 只拿 opaque previewId;一次性 host
  // 的 URL/token、文件字节与绝对路径永不过 IPC(host 本体 main/html-preview-host.ts)。
  htmlPreview: {
    open: (directory, runId, artifactId) => ipcRenderer.invoke("html-preview-open", directory, runId, artifactId),
    close: (previewId) => ipcRenderer.invoke("html-preview-close", previewId),
    status: (previewId) => ipcRenderer.invoke("html-preview-status", previewId),
    onClosed: (cb) => {
      const handler = (_: unknown, e: HtmlPreviewClosedEvent) => cb(e)
      ipcRenderer.on("html-preview-closed", handler)
      return () => ipcRenderer.removeListener("html-preview-closed", handler)
    },
  },
  automations: {
    list: () => ipcRenderer.invoke("automations-list"),
    save: (task) => ipcRenderer.invoke("automations-save", task),
    remove: (id) => ipcRenderer.invoke("automations-delete", id),
    toggle: (id, enabled) => ipcRenderer.invoke("automations-toggle", id, enabled),
    pauseAll: (paused) => ipcRenderer.invoke("automations-pause-all", paused),
    loginItem: (open) => ipcRenderer.invoke("automations-login-item", open),
    runNow: (id) => ipcRenderer.invoke("automations-run-now", id),
    nlLlm: (text, projectDir) => ipcRenderer.invoke("automations-nl-llm", text, projectDir),
    cloudSync: () => ipcRenderer.invoke("automations-cloud-sync"),
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
