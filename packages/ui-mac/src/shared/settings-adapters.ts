/** REQ-090 Settings persisted in default.dat/settings.v3. */
export type AlphaSettings = {
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
  notifications: {
    agent: boolean
    permissions: boolean
    errors: boolean
  }
  sounds: {
    agentEnabled: boolean
    agent: string
    permissionsEnabled: boolean
    permissions: string
    errorsEnabled: boolean
    errors: string
  }
}

export const ALPHA_SETTINGS_DEFAULTS: AlphaSettings = {
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

export type SettingsAuthority = {
  value: AlphaSettings
  /** Opaque compare-and-set token; callers must not interpret it. */
  revision: string
}

export type SettingsReadResult =
  | ({ ok: true } & SettingsAuthority)
  | { ok: false; code: "read-failed" }
  | { ok: false; code: "authority-invalid"; revision: string }

export type SettingsValidateResult = { ok: true } | { ok: false; code: "invalid-input" }

export type SettingsWriteResult =
  | ({ ok: true; changed: boolean } & SettingsAuthority)
  | {
      ok: false
      code: "invalid-input" | "read-failed" | "revision-conflict" | "write-failed"
      authoritative?: SettingsAuthority
      revision?: string
    }

/** Renderer-safe GC projection. Keep this list closed: no reason, digest, path, bytes or warning detail. */
export type ExtensionStorageResult = {
  code: "ok" | "busy" | "fail-closed" | "worker-failed"
  blobsTotal: number
  sweepableCount: number
  sweptCount: number
  keptByGrace: number
  warningCount: number
}

export type ExtensionStorageSnapshot =
  | { state: "not-run" | "checking" | "collecting"; result: null }
  | { state: "ready"; result: ExtensionStorageResult }
