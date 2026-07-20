import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { dirname } from "node:path"
import type { CasGcRoundInput, CasGcRoundSummary } from "./ext-cas-gc"
import type { CasGcSchedulerConfig, CasGcSpawnRound } from "./ext-cas-gc-scheduler"
import {
  cleanupDurableAtomicTemporaryFilesSync,
  fsyncDirRequiredSync,
  fsyncFileSync,
  writeFileDurableAtomicSync,
  type DurableAtomicFileSystem,
  type DurableAtomicWriteOptions,
} from "./ext-atomic-fs"
import {
  ALPHA_SETTINGS_DEFAULTS,
  type AlphaSettings,
  type ExtensionStorageResult,
  type ExtensionStorageSnapshot,
  type SettingsAuthority,
  type SettingsReadResult,
  type SettingsValidateResult,
  type SettingsWriteResult,
} from "../shared/settings-adapters"
import { RENDERER_SETTINGS_KEY } from "./store-keys"

const REVISION_PATTERN = /^s1:[0-9a-f]{64}$/
const MAX_FONT_CHARS = 256
const MAX_KEYBINDS = 1_000
const MAX_KEYBIND_CHARS = 256
const MAX_SOUND_ID_CHARS = 64
const INVALID = Symbol("invalid")

export type SettingsAdapterOptions = {
  onCommitPoint?: DurableAtomicWriteOptions["onCommitPoint"]
  /** Test-only syscall seam for the durable atomic helper. */
  fileSystem?: DurableAtomicFileSystem
}

export function createSettingsAdapter(file: string, options?: SettingsAdapterOptions) {
  cleanupDurableAtomicTemporaryFilesSync(file, options?.fileSystem)
  return {
    read(): SettingsReadResult {
      const current = readCurrent(file)
      if (current.kind === "valid") return { ok: true, ...current.authority }
      if (current.kind === "invalid") return { ok: false, code: "authority-invalid", revision: current.revision }
      return { ok: false, code: "read-failed" }
    },
    validate(value: unknown): SettingsValidateResult {
      return decodeSettings(value, false) ? { ok: true } : { ok: false, code: "invalid-input" }
    },
    write(input: unknown): SettingsWriteResult {
      const envelope = object(input)
      if (!envelope || !keysAllowed(envelope, ["value", "expectedRevision"])) {
        return { ok: false, code: "invalid-input" }
      }
      const value = decodeSettings(envelope.value, false)
      if (!value || typeof envelope.expectedRevision !== "string" || !REVISION_PATTERN.test(envelope.expectedRevision)) {
        return { ok: false, code: "invalid-input" }
      }
      const current = readCurrent(file)
      if (current.kind === "failed") return { ok: false, code: "read-failed" }
      const json = JSON.stringify(value)
      if (current.kind === "valid" && JSON.stringify(current.authority.value) === json) {
        try {
          if (existsSync(file)) {
            fsyncFileSync(file)
            fsyncDirRequiredSync(dirname(file))
          }
        } catch {
          return writeFailure(readCurrent(file))
        }
        return { ok: true, changed: false, ...current.authority }
      }
      const revision = current.kind === "valid" ? current.authority.revision : current.revision
      if (revision !== envelope.expectedRevision) {
        return {
          ok: false,
          code: "revision-conflict",
          ...(current.kind === "valid" ? { authoritative: current.authority } : {}),
          revision,
        }
      }
      try {
        const document = readSettingsDocument(file)
        document[RENDERER_SETTINGS_KEY] = json
        writeFileDurableAtomicSync(file, JSON.stringify(document, null, "\t"), {
          onCommitPoint: options?.onCommitPoint,
          fileSystem: options?.fileSystem,
        })
      } catch {
        return writeFailure(readCurrent(file))
      }
      const saved = readCurrent(file)
      if (saved.kind === "valid" && JSON.stringify(saved.authority.value) === json) {
        return { ok: true, changed: true, ...saved.authority }
      }
      return writeFailure(saved)
    },
  }
}

export function createExtensionStorageAdapter(config: CasGcSchedulerConfig, spawnRound: CasGcSpawnRound) {
  const current: { state: ExtensionStorageSnapshot["state"]; result: ExtensionStorageResult | null } = {
    state: "not-run",
    result: null,
  }

  const run = async (dryRun: boolean): Promise<ExtensionStorageResult> => {
    if (current.state === "checking" || current.state === "collecting") return emptyStorageResult("busy")
    current.state = dryRun ? "checking" : "collecting"
    current.result = null
    const input: CasGcRoundInput = {
      casBaseRoot: config.casBaseRoot,
      envRoots: [...config.envRoots],
      seedLockPaths: [...config.seedLockPaths],
      graceMs: config.graceMs,
      dryRun,
    }
    try {
      current.result = projectStorageResult(await spawnRound(input))
    } catch {
      current.result = emptyStorageResult("worker-failed")
    }
    current.state = "ready"
    return { ...current.result }
  }

  return {
    snapshot(): ExtensionStorageSnapshot {
      if (current.state === "ready" && current.result) return { state: "ready", result: { ...current.result } }
      return { state: current.state as "not-run" | "checking" | "collecting", result: null }
    },
    inspect: () => run(true),
    collect: () => run(false),
  }
}

type CurrentSettings =
  | { kind: "valid"; authority: SettingsAuthority }
  | { kind: "invalid"; revision: string }
  | { kind: "failed" }

function readCurrent(file: string): CurrentSettings {
  try {
    const raw = readSettingsDocument(file)[RENDERER_SETTINGS_KEY]
    const parsed = parseStored(raw)
    if (parsed === INVALID) return { kind: "invalid", revision: revision(raw) }
    const value = decodeSettings(parsed, true)
    if (!value) return { kind: "invalid", revision: revision(raw) }
    return { kind: "valid", authority: { value, revision: revision(JSON.stringify(value)) } }
  } catch {
    return { kind: "failed" }
  }
}

function readSettingsDocument(file: string) {
  if (!existsSync(file)) return {} as Record<string, unknown>
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown
  const document = object(parsed)
  if (!document) throw new Error("invalid settings document")
  return document
}

function parseStored(raw: unknown): unknown | typeof INVALID {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== "string") return raw
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return INVALID
  }
}

function revision(value: unknown) {
  return `s1:${createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex")}`
}

function writeFailure(current: CurrentSettings): SettingsWriteResult {
  if (current.kind === "valid") return { ok: false, code: "write-failed", authoritative: current.authority }
  if (current.kind === "invalid") return { ok: false, code: "write-failed", revision: current.revision }
  return { ok: false, code: "write-failed" }
}

function decodeSettings(value: unknown, allowMissing: boolean): AlphaSettings | undefined {
  const root = object(value)
  if (!root || !keysAllowed(root, ["general", "appearance", "keybinds", "permissions", "notifications", "sounds"])) return
  const general = decodeGeneral(root.general, allowMissing)
  const appearance = decodeAppearance(root.appearance, allowMissing)
  const keybinds = decodeKeybinds(root.keybinds, allowMissing)
  const permissions = decodeBooleans(root.permissions, ["autoApprove"], ALPHA_SETTINGS_DEFAULTS.permissions, allowMissing)
  const notifications = decodeBooleans(
    root.notifications,
    ["agent", "permissions", "errors"],
    ALPHA_SETTINGS_DEFAULTS.notifications,
    allowMissing,
  )
  const sounds = decodeSounds(root.sounds, allowMissing)
  if (!general || !appearance || !keybinds || !permissions || !notifications || !sounds) return
  return {
    general,
    appearance,
    keybinds,
    permissions: { autoApprove: permissions.autoApprove },
    notifications: {
      agent: notifications.agent,
      permissions: notifications.permissions,
      errors: notifications.errors,
    },
    sounds,
  }
}

function decodeGeneral(value: unknown, allowMissing: boolean): AlphaSettings["general"] | undefined {
  const source = group(value, allowMissing)
  const keys = [
    "autoSave",
    "releaseNotes",
    "followup",
    "showFileTree",
    "showNavigation",
    "showSearch",
    "showStatus",
    "showTerminal",
    "showReasoningSummaries",
    "shellToolPartsExpanded",
    "editToolPartsExpanded",
    "showSessionProgressBar",
    "showCustomAgents",
    "newLayoutDesigns",
  ]
  if (!source || !keysAllowed(source, keys)) return
  const booleans = decodeBooleans(
    source,
    keys.filter((key) => key !== "followup" && key !== "newLayoutDesigns"),
    ALPHA_SETTINGS_DEFAULTS.general,
    allowMissing,
  )
  const followup = stringValue(source, "followup", ALPHA_SETTINGS_DEFAULTS.general.followup, allowMissing)
  if (!booleans || followup === INVALID || (followup !== "queue" && followup !== "steer")) return
  if (source.newLayoutDesigns !== undefined && typeof source.newLayoutDesigns !== "boolean") return
  return {
    autoSave: booleans.autoSave,
    releaseNotes: booleans.releaseNotes,
    followup,
    showFileTree: booleans.showFileTree,
    showNavigation: booleans.showNavigation,
    showSearch: booleans.showSearch,
    showStatus: booleans.showStatus,
    showTerminal: booleans.showTerminal,
    showReasoningSummaries: booleans.showReasoningSummaries,
    shellToolPartsExpanded: booleans.shellToolPartsExpanded,
    editToolPartsExpanded: booleans.editToolPartsExpanded,
    showSessionProgressBar: booleans.showSessionProgressBar,
    showCustomAgents: booleans.showCustomAgents,
    ...(typeof source.newLayoutDesigns === "boolean" ? { newLayoutDesigns: source.newLayoutDesigns } : {}),
  }
}

function decodeAppearance(value: unknown, allowMissing: boolean): AlphaSettings["appearance"] | undefined {
  const source = group(value, allowMissing)
  if (!source || !keysAllowed(source, ["fontSize", "mono", "sans", "terminal"])) return
  const fontSize = numberValue(source, "fontSize", ALPHA_SETTINGS_DEFAULTS.appearance.fontSize, allowMissing)
  const mono = stringValue(source, "mono", ALPHA_SETTINGS_DEFAULTS.appearance.mono, allowMissing)
  const sans = stringValue(source, "sans", ALPHA_SETTINGS_DEFAULTS.appearance.sans, allowMissing)
  const terminal = stringValue(source, "terminal", ALPHA_SETTINGS_DEFAULTS.appearance.terminal, allowMissing)
  if (fontSize === INVALID || fontSize < 8 || fontSize > 72) return
  if (mono === INVALID || sans === INVALID || terminal === INVALID) return
  if ([mono, sans, terminal].some((font) => font.length > MAX_FONT_CHARS)) return
  return { fontSize, mono, sans, terminal }
}

function decodeKeybinds(value: unknown, allowMissing: boolean): Record<string, string> | undefined {
  const source = group(value, allowMissing)
  if (!source || Object.keys(source).length > MAX_KEYBINDS) return
  if (
    !Object.entries(source).every(
      ([key, binding]) =>
        safeKey(key) && key.length <= MAX_KEYBIND_CHARS && typeof binding === "string" && binding.length <= MAX_KEYBIND_CHARS,
    )
  )
    return
  return Object.fromEntries(Object.entries(source) as Array<[string, string]>)
}

function decodeSounds(value: unknown, allowMissing: boolean): AlphaSettings["sounds"] | undefined {
  const source = group(value, allowMissing)
  if (!source || !keysAllowed(source, ["agentEnabled", "agent", "permissionsEnabled", "permissions", "errorsEnabled", "errors"])) return
  const enabled = decodeBooleans(
    source,
    ["agentEnabled", "permissionsEnabled", "errorsEnabled"],
    ALPHA_SETTINGS_DEFAULTS.sounds,
    allowMissing,
  )
  const agent = stringValue(source, "agent", ALPHA_SETTINGS_DEFAULTS.sounds.agent, allowMissing)
  const permissions = stringValue(source, "permissions", ALPHA_SETTINGS_DEFAULTS.sounds.permissions, allowMissing)
  const errors = stringValue(source, "errors", ALPHA_SETTINGS_DEFAULTS.sounds.errors, allowMissing)
  if (!enabled || agent === INVALID || permissions === INVALID || errors === INVALID) return
  if ([agent, permissions, errors].some((id) => id.length > MAX_SOUND_ID_CHARS || !/^[a-z0-9-]+$/.test(id))) return
  return {
    agentEnabled: enabled.agentEnabled,
    agent,
    permissionsEnabled: enabled.permissionsEnabled,
    permissions,
    errorsEnabled: enabled.errorsEnabled,
    errors,
  }
}

function decodeBooleans<T extends Record<string, unknown>>(
  value: unknown,
  keys: string[],
  defaults: T,
  allowMissing: boolean,
): Record<string, boolean> | undefined {
  const source = group(value, allowMissing)
  if (!source) return
  const entries = keys.map((key) => [key, booleanValue(source, key, defaults[key] === true, allowMissing)] as const)
  if (entries.some(([, result]) => result === INVALID)) return
  return Object.fromEntries(entries) as Record<string, boolean>
}

function booleanValue(source: Record<string, unknown>, key: string, fallback: boolean, allowMissing: boolean) {
  if (source[key] === undefined) return allowMissing ? fallback : INVALID
  return typeof source[key] === "boolean" ? source[key] : INVALID
}

function stringValue(source: Record<string, unknown>, key: string, fallback: string, allowMissing: boolean) {
  if (source[key] === undefined) return allowMissing ? fallback : INVALID
  return typeof source[key] === "string" ? source[key] : INVALID
}

function numberValue(source: Record<string, unknown>, key: string, fallback: number, allowMissing: boolean) {
  if (source[key] === undefined) return allowMissing ? fallback : INVALID
  return typeof source[key] === "number" && Number.isSafeInteger(source[key]) ? source[key] : INVALID
}

function group(value: unknown, allowMissing: boolean) {
  if (value === undefined && allowMissing) return {}
  return object(value)
}

function object(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function keysAllowed(value: Record<string, unknown>, allowed: string[]) {
  return Object.keys(value).every((key) => allowed.includes(key) && safeKey(key))
}

function safeKey(key: string) {
  return key !== "__proto__" && key !== "prototype" && key !== "constructor"
}

function projectStorageResult(summary: CasGcRoundSummary): ExtensionStorageResult {
  const busy =
    summary.reason?.startsWith("CAS lock busy:") === true ||
    summary.reason?.endsWith("— GC skipped (mutual exclusion)") === true
  return {
    code: summary.ok ? "ok" : busy ? "busy" : "fail-closed",
    blobsTotal: summary.blobsTotal,
    sweepableCount: summary.sweepableCount,
    sweptCount: summary.sweptCount,
    keptByGrace: summary.keptByGrace,
    warningCount: summary.warningCount,
  }
}

function emptyStorageResult(code: ExtensionStorageResult["code"]): ExtensionStorageResult {
  return { code, blobsTotal: 0, sweepableCount: 0, sweptCount: 0, keptByGrace: 0, warningCount: 0 }
}
