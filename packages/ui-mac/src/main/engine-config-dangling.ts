// REQ-053 AC1/AC2: remove only confirmed-absent Alpha-owned engine-config references.
// The planner is electron-free and performs no writes. Filesystem identity/absence is injectable so
// every fail-closed branch can be tested without changing process-global fs behavior.

import { existsSync, lstatSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { parse, type ParseError } from "jsonc-parser"
import {
  collectMcpFileRefPaths,
  isAbsenceError,
  pathIdentity,
  resolveMcpRefPath,
  type PathIdentity,
} from "./alpha-mcp-secrets"
import { alphaGlobalRoot } from "./alpha-installs"
import { opencodeHomeDir } from "./alpha-bridge"
import { ALPHA_CONFIG_TOP_KEYS, alphaJsoncPath, isAlphaOwnedConfig } from "./engine-config-truth"
import {
  mcpPluginTargetPath,
  writeConfigLeafEditsUnlocked,
  type ConfigLeafEdit,
} from "./ext-config"

export type DanglingPathInspection = {
  identity: PathIdentity
  status: "present" | "absent" | "uncertain"
  reason?: string
}

export type DanglingSweepEdit = ConfigLeafEdit & {
  kind: "plugin" | "mcp"
  resolvedPath: string
}

export type DanglingSweepPlan = {
  edits: DanglingSweepEdit[]
  uncertain: Array<{ keyPath: Array<string | number>; resolvedPath: string; reason: string }>
}

export type DanglingSweepOutcome = {
  changedFiles: string[]
  stripped: DanglingSweepEdit[]
  warnings: string[]
  enforcementGap: string[]
}

export type DanglingSweepOptions = {
  configDir: string
  guardRoots: string[]
  inspectPath?: (file: string) => DanglingPathInspection
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)

export function inspectDanglingPath(file: string): DanglingPathInspection {
  const identity = pathIdentity(file)
  if (!identity.certain) return { identity, status: "uncertain", reason: "filesystem identity is uncertain" }
  try {
    lstatSync(file)
    return { identity, status: "present" }
  } catch (error) {
    if (isAbsenceError(error)) return { identity, status: "absent" }
    return {
      identity: { forms: identity.forms, certain: false },
      status: "uncertain",
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Plan only leaf removals; the input object is never mutated. */
export function planDanglingSweep(parsed: unknown, options: DanglingSweepOptions): DanglingSweepPlan {
  if (!isRecord(parsed)) return { edits: [], uncertain: [] }
  const inspectPath = options.inspectPath ?? inspectDanglingPath
  const guards = options.guardRoots.map((root) => inspectPath(root).identity)
  const inspectReference = (resolvedPath: string) => {
    const inspected = inspectPath(resolvedPath)
    if (!inspected.identity.certain)
      return { status: "uncertain" as const, reason: inspected.reason ?? "filesystem identity is uncertain" }
    const certainGuards = guards.filter((guard) => guard.certain)
    // pathIdentity orders forms as lexical then canonical. Containment must compare the canonical
    // forms: accepting the lexical form of `/guard/link/outside/missing` would let a good symlink
    // prefix escape the guard, while canonical comparison still recognizes outside aliases into it.
    const candidate = inspected.identity.forms[inspected.identity.forms.length - 1]
    const inside = certainGuards.some((guard) => {
      const root = guard.forms[guard.forms.length - 1]
      const rel = relative(root, candidate)
      return rel === "" || (rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel))
    })
    if (!inside && guards.some((guard) => !guard.certain))
      return { status: "uncertain" as const, reason: "guard-root identity is uncertain" }
    if (!inside) return { status: "outside" as const }
    if (inspected.status === "uncertain")
      return { status: "uncertain" as const, reason: inspected.reason ?? "absence is uncertain" }
    return { status: inspected.status }
  }

  const edits: DanglingSweepEdit[] = []
  const uncertain: DanglingSweepPlan["uncertain"] = []
  if (ALPHA_CONFIG_TOP_KEYS.has("plugin") && Array.isArray(parsed.plugin)) {
    parsed.plugin.forEach((entry, index) => {
      if (typeof entry !== "string" || !isAbsolute(entry)) return
      const resolvedPath = resolve(entry)
      const inspected = inspectReference(resolvedPath)
      if (inspected.status === "absent") {
        edits.push({ keyPath: ["plugin", index], value: undefined, kind: "plugin", resolvedPath })
        return
      }
      if (inspected.status === "uncertain")
        uncertain.push({ keyPath: ["plugin", index], resolvedPath, reason: inspected.reason })
    })
  }

  if (ALPHA_CONFIG_TOP_KEYS.has("mcp") && isRecord(parsed.mcp)) {
    Object.entries(parsed.mcp).forEach(([name, leaf]) => {
      if (!isRecord(leaf)) return
      ;(["environment", "headers"] as const).forEach((field) => {
        if (!isRecord(leaf[field])) return
        Object.entries(leaf[field]).forEach(([key, value]) => {
          const references = collectMcpFileRefPaths(value).map((ref) => resolveMcpRefPath(ref, options.configDir))
          const inspections = references.map((resolvedPath) => ({ resolvedPath, result: inspectReference(resolvedPath) }))
          const uncertainInspections = inspections.filter(
            (item): item is typeof item & { result: { status: "uncertain"; reason: string } } =>
              item.result.status === "uncertain",
          )
          if (uncertainInspections.length > 0) {
            uncertainInspections.forEach((item) =>
              uncertain.push({
                keyPath: ["mcp", name, field, key],
                resolvedPath: item.resolvedPath,
                reason: item.result.reason,
              }),
            )
            return
          }
          const dangling = inspections.find((item) => item.result.status === "absent")
          if (dangling) {
            edits.push({
              keyPath: ["mcp", name, field, key],
              value: undefined,
              kind: "mcp",
              resolvedPath: dangling.resolvedPath,
            })
          }
        })
      })
    })
  }

  return {
    edits: edits.sort((left, right) => {
      if (left.kind === "plugin" && right.kind !== "plugin") return -1
      if (left.kind !== "plugin" && right.kind === "plugin") return 1
      if (left.kind !== "plugin" || right.kind !== "plugin") return 0
      return Number(right.keyPath[1]) - Number(left.keyPath[1])
    }),
    uncertain,
  }
}

export function sweepEngineConfigDanglingUnlocked(options: {
  phase: "boot" | "respawn" | "credentials-clear" | "data-clear"
  userDataPath: string
  engineDataPath: string
  homeDir?: string
  inspectPath?: (file: string) => DanglingPathInspection
}): DanglingSweepOutcome {
  const homeDir = options.homeDir ?? homedir()
  const alphaConfig = alphaJsoncPath()
  const legacyDir = opencodeHomeDir()
  const legacyConfig = existsSync(join(legacyDir, "opencode.jsonc"))
    ? join(legacyDir, "opencode.jsonc")
    : existsSync(join(legacyDir, "opencode.json"))
      ? join(legacyDir, "opencode.json")
      : join(legacyDir, "opencode.jsonc")
  const xdgDir = process.env.OPENCODE_CONFIG_DIR
    ? process.env.OPENCODE_CONFIG_DIR
    : process.env.XDG_CONFIG_HOME
      ? join(process.env.XDG_CONFIG_HOME, "opencode")
      : join(homeDir, ".config", "opencode")
  const xdgConfig = existsSync(join(xdgDir, "opencode.jsonc"))
    ? join(xdgDir, "opencode.jsonc")
    : existsSync(join(xdgDir, "opencode.json"))
      ? join(xdgDir, "opencode.json")
      : join(xdgDir, "opencode.jsonc")
  const routedConfig = mcpPluginTargetPath()
  const writable = routedConfig === alphaConfig
    ? options.phase === "data-clear" ? [legacyConfig] : [alphaConfig, legacyConfig]
    : routedConfig === legacyConfig
      ? [legacyConfig]
      : []
  const targets = [
    ...writable.map((file) => ({ file, ownership: file === legacyConfig ? "legacy" as const : "alpha" as const })),
    { file: xdgConfig, ownership: "foreign" as const },
  ].filter((target, index, all) => all.findIndex((item) => item.file === target.file) === index)
  const enforcement = options.phase === "boot" || options.phase === "respawn"
  const outcome: DanglingSweepOutcome = { changedFiles: [], stripped: [], warnings: [], enforcementGap: [] }
  const guardRoots = [options.userDataPath, alphaGlobalRoot(), options.engineDataPath, join(homeDir, ".alpha")]

  targets.forEach((target) => {
    let text: string
    try {
      text = readFileSync(target.file, "utf8")
    } catch (error) {
      if (isAbsenceError(error)) return
      const warning = `${target.file}: config unreadable; dangling sweep left it untouched (${error instanceof Error ? error.message : String(error)})`
      outcome.warnings.push(warning)
      if (enforcement && target.ownership !== "foreign") outcome.enforcementGap.push(warning)
      return
    }

    const errors: ParseError[] = []
    const parsed: unknown = parse(text, errors, { allowTrailingComma: true })
    if (errors.length > 0 || !isRecord(parsed)) {
      const warning = `${target.file}: config is not a parseable JSONC object; dangling sweep made zero writes`
      outcome.warnings.push(warning)
      if (enforcement && hasDanglingShape(text)) outcome.enforcementGap.push(warning)
      return
    }

    const plan = planDanglingSweep(parsed, {
      configDir: dirname(target.file),
      guardRoots,
      inspectPath: options.inspectPath,
    })
    const verdict = target.ownership === "legacy"
      ? isAlphaOwnedConfig({ parsed, receiptMcpNames: new Set(), receiptPluginKeys: new Set() })
      : null
    const writableTarget = target.ownership !== "foreign" && (target.ownership !== "legacy" || verdict?.owned)

    if (!writableTarget) {
      if (plan.edits.length === 0 && plan.uncertain.length === 0) return
      const reason = target.ownership === "legacy" && verdict && !verdict.owned
        ? `legacy ownership bail-out: ${verdict.reason}`
        : "user-foreign config is read-only"
      const warning = `${target.file}: dangling-shaped references kept (${reason})`
      outcome.warnings.push(warning)
      if (enforcement) outcome.enforcementGap.push(warning)
      return
    }

    if (plan.uncertain.length > 0) {
      const warning = `${target.file}: ${plan.uncertain.length} reference(s) kept because identity/absence is uncertain`
      outcome.warnings.push(warning)
      if (enforcement) outcome.enforcementGap.push(warning)
    }
    if (plan.edits.length === 0) return
    const written = writeConfigLeafEditsUnlocked(target.file, text, plan.edits)
    if (!written.ok) {
      const warning = `${target.file}: dangling sweep write failed (${written.reason})`
      outcome.warnings.push(warning)
      if (enforcement) outcome.enforcementGap.push(warning)
      return
    }
    outcome.changedFiles.push(target.file)
    outcome.stripped.push(...plan.edits)
  })

  return outcome
}

function hasDanglingShape(text: string): boolean {
  if (text.includes("{file:")) return true
  return /"plugin"\s*:\s*\[[\s\S]*?"(?:\/|[A-Za-z]:\\\\)/.test(text)
}
