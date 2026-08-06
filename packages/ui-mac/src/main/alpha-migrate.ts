// Legacy-install migration (REQ-018 T3). Before T2, the extension hub wrote skills/agents into the
// shared XDG config dir (~/.config/opencode/{skills,agent}) and MCP/plugin into that dir's
// opencode.jsonc. T2 moved installs to the alpha truth root (.alpha + ~/.opencode bridge). This
// module *scans* the legacy root for installs and *removes* them from there; the renderer re-installs
// each confirmed item to the new location via the existing installers (which also pins MCP versions
// from the catalog — the A2 tail — and moves inline secrets to the {file:} channel).
//
// SAFETY: we NEVER touch user-authored content indiscriminately. The renderer only offers items whose
// name matches a catalog entry (ADR-019 §4: migrate alpha's own installs, not the user's). This
// module just reports what's in the legacy root and removes a named item from it — electron-free and
// unit-testable. The USER-FACING trigger is gated behind ALPHA_MIGRATE_ENABLE until A6 is verified on
// a real machine (S12 T8) — see isMigrationEnabled().

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { applyEdits, modify, parse } from "jsonc-parser"
import { isExtensionName } from "../shared/extension-name"

export type LegacyInventory = {
  root: string
  skills: string[]
  agents: string[]
  mcp: { name: string; config: Record<string, unknown> }[]
  plugins: string[]
}

/** The legacy shared XDG config dir (same resolution as ext-config / ext-fs-installer). */
export function legacyConfigDir(): string {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, "opencode")
  return path.join(os.homedir(), ".config", "opencode")
}

function legacyConfigFile(root: string): string | null {
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const file = path.join(root, name)
    if (fs.existsSync(file)) return file
  }
  return null
}

/** Report the extension installs sitting in the legacy root. Empty/missing → empty inventory. */
export function scanLegacy(): LegacyInventory {
  const root = legacyConfigDir()
  const inv: LegacyInventory = { root, skills: [], agents: [], mcp: [], plugins: [] }
  const dirEntries = (sub: string): string[] => {
    try {
      return fs
        .readdirSync(path.join(root, sub), { withFileTypes: true })
        .filter((d) => d.isDirectory() && isExtensionName(d.name) && fs.existsSync(path.join(root, sub, d.name, "SKILL.md")))
        .map((d) => d.name)
    } catch {
      return []
    }
  }
  inv.skills = dirEntries("skills")
  try {
    inv.agents = fs
      .readdirSync(path.join(root, "agent"), { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(".md") && isExtensionName(d.name.slice(0, -3)))
      .map((d) => d.name.slice(0, -3))
  } catch {
    /* no agent dir */
  }
  const file = legacyConfigFile(root)
  if (file) {
    try {
      const parsed = parse(fs.readFileSync(file, "utf8")) as { mcp?: Record<string, unknown>; plugin?: unknown } | undefined
      if (parsed?.mcp && typeof parsed.mcp === "object") {
        for (const [name, config] of Object.entries(parsed.mcp)) {
          if (isExtensionName(name) && config && typeof config === "object") {
            inv.mcp.push({ name, config: config as Record<string, unknown> })
          }
        }
      }
      if (Array.isArray(parsed?.plugin)) {
        for (const p of parsed!.plugin as unknown[]) {
          if (typeof p === "string") inv.plugins.push(p)
          else if (Array.isArray(p) && typeof p[0] === "string") inv.plugins.push(p[0])
        }
      }
    } catch {
      /* unreadable legacy config → nothing to migrate from it */
    }
  }
  return inv
}

function removeConfigKey(keyPath: string[]): void {
  const root = legacyConfigDir()
  const file = legacyConfigFile(root)
  if (!file) return
  try {
    const text = fs.readFileSync(file, "utf8")
    const edits = modify(text, keyPath, undefined, { formattingOptions: { tabSize: 2, insertSpaces: true } })
    const result = applyEdits(text, edits)
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, result, "utf8")
    fs.renameSync(tmp, file)
  } catch {
    /* best-effort — the new install already exists; leaving a stale legacy entry is non-fatal */
  }
}

export type MigrateRemoveResult = { ok: true; removed: string[] } | { ok: false; reason: string }

/** Remove a migrated item from the legacy root ONLY (the new copy is created by the renderer first). */
export function removeLegacy(type: "skill" | "agent" | "mcp" | "plugin", name: string): MigrateRemoveResult {
  const root = legacyConfigDir()
  const removed: string[] = []
  try {
    if (type === "skill") {
      if (!isExtensionName(name)) return { ok: false, reason: "invalid name" }
      const dir = path.join(root, "skills", name)
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true })
        removed.push(dir)
      }
    } else if (type === "agent") {
      if (!isExtensionName(name)) return { ok: false, reason: "invalid name" }
      const file = path.join(root, "agent", `${name}.md`)
      if (fs.existsSync(file)) {
        fs.rmSync(file, { force: true })
        removed.push(file)
      }
    } else if (type === "mcp") {
      if (!isExtensionName(name)) return { ok: false, reason: "invalid name" }
      removeConfigKey(["mcp", name])
      removed.push(`mcp.${name}`)
    } else if (type === "plugin") {
      // name = the package spec; drop it from the array by rebuilding without it.
      const file = legacyConfigFile(root)
      if (file) {
        const parsed = parse(fs.readFileSync(file, "utf8")) as { plugin?: unknown } | undefined
        const current = Array.isArray(parsed?.plugin) ? (parsed!.plugin as unknown[]) : []
        const base = (s: string) => (s.lastIndexOf("@") > 0 ? s.slice(0, s.lastIndexOf("@")) : s)
        const next = current.filter((p) => {
          if (typeof p === "string") return base(p) !== base(name)
          if (Array.isArray(p) && typeof p[0] === "string") return base(p[0]) !== base(name)
          return true
        })
        if (next.length !== current.length) {
          const text = fs.readFileSync(file, "utf8")
          const edits = modify(text, ["plugin"], next, { formattingOptions: { tabSize: 2, insertSpaces: true } })
          fs.writeFileSync(file, applyEdits(text, edits), "utf8")
          removed.push(`plugin:${name}`)
        }
      }
    }
    return { ok: true, removed }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "failed to remove legacy install" }
  }
}

// Gate the user-facing migration prompt. Migration re-persists MCP configs (secret/env handling that
// A6 governs) → stays off until A6 is verified on a real machine (S12 T8), then flipped on.
export function isMigrationEnabled(): boolean {
  return process.env.ALPHA_MIGRATE_ENABLE === "1"
}

// ---------------------------------------------------------------------------
// REQ-044 ① — migration provenance. Name-matching alone lets a user-authored skill that happens to
// share a catalog name be offered as a migration candidate; "migrating" it reinstalls the catalog
// version and removes the legacy copy — i.e. it would replace the user's own content (S21
// real-machine finding). ADR-019 §4 says migrate alpha's own installs only, but pre-T2 installs
// predate the receipts ledger, so provenance must be proven structurally:
//   · skill  — legacy dir byte-identical to the packaged builtin asset (the pre-T2 installer
//              copied the asset verbatim; any drift ⇒ user-authored or user-modified);
//   · mcp    — legacy config exactly alpha-shaped for that catalog entry: same runner + package
//              base (version pin ignored — pre-A2 installs were unpinned) + same arg count + same
//              pre-package flags, no keys outside what alpha writes, env names ⊆ requiredEnvVars;
//   · plugin — same package base and (unpinned ∨ pinned to the catalog's exact version).
// Unprovable ⇒ EXCLUDED (fail-closed): we may skip a genuine alpha install, but we never touch
// user content. Electron-free (resources root injected) like the rest of this module.

export type ProvenanceRequest =
  | { type: "skill"; name: string; builtinAssetKey?: string }
  | {
      type: "mcp"
      name: string
      spec: {
        mcpType: "local" | "remote"
        command?: string[]
        mirrorCommand?: string[]
        url?: string
        requiredEnvVars?: string[]
        headerNames?: string[]
      }
    }
  | { type: "plugin"; name: string; package: string }

export type ProvenanceVerdict = { type: "skill" | "mcp" | "plugin"; name: string; verified: boolean; reason: string }

/** npm-style spec → package base (strip a trailing @version; scoped names keep their leading @). */
function specBase(spec: string): string {
  const at = spec.lastIndexOf("@")
  return at > 0 ? spec.slice(0, at) : spec
}

/** Recursive byte-equality of two directories. Symlinks and type mismatches fail (fail-closed);
 *  .DS_Store is ignored on both sides (Finder droppings carry no skill content). */
function dirsByteEqual(a: string, b: string): boolean {
  const entries = (dir: string) =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.name !== ".DS_Store")
      .sort((x, y) => x.name.localeCompare(y.name))
  const ea = entries(a)
  const eb = entries(b)
  if (ea.length !== eb.length) return false
  for (let i = 0; i < ea.length; i++) {
    const da = ea[i]!
    const db = eb[i]!
    if (da.name !== db.name) return false
    if (da.isSymbolicLink() || db.isSymbolicLink()) return false
    if (da.isDirectory() !== db.isDirectory()) return false
    const pa = path.join(a, da.name)
    const pb = path.join(b, da.name)
    if (da.isDirectory()) {
      if (!dirsByteEqual(pa, pb)) return false
    } else if (da.isFile() && db.isFile()) {
      if (!fs.readFileSync(pa).equals(fs.readFileSync(pb))) return false
    } else {
      return false
    }
  }
  return true
}

/** Legacy command is alpha-shaped for a catalog command iff: same length, same runner, identical
 *  pre-package flags, and same package base (version pin ignored). Trailing args are compared by
 *  count only — templates like {workspace} were substituted with concrete paths at install time. */
function commandAlphaShaped(legacy: string[], spec: string[]): boolean {
  if (legacy.length !== spec.length) return false
  if (legacy[0] !== spec[0]) return false
  let pkgIndex = -1
  for (let i = 1; i < spec.length; i++) {
    if (!spec[i]!.startsWith("-")) {
      pkgIndex = i
      break
    }
  }
  if (pkgIndex < 0) return false
  for (let i = 1; i < pkgIndex; i++) if (legacy[i] !== spec[i]) return false
  return specBase(legacy[pkgIndex]!) === specBase(spec[pkgIndex]!)
}

function verifyMcpShape(spec: Extract<ProvenanceRequest, { type: "mcp" }>["spec"], legacy: Record<string, unknown>): string | null {
  if (spec.mcpType === "remote") {
    const allowed = new Set(["type", "url", "headers", "enabled"])
    for (const k of Object.keys(legacy)) if (!allowed.has(k)) return `foreign key "${k}" in legacy config`
    if (legacy.type !== "remote") return "legacy entry is not remote"
    if (typeof legacy.url !== "string" || legacy.url !== spec.url) return "url differs from catalog"
    const headerNames = new Set(spec.headerNames ?? [])
    const legacyHeaders = legacy.headers && typeof legacy.headers === "object" ? Object.keys(legacy.headers as object) : []
    for (const h of legacyHeaders) if (!headerNames.has(h)) return `header "${h}" not in catalog template`
    return null
  }
  const allowed = new Set(["type", "command", "environment", "enabled"])
  for (const k of Object.keys(legacy)) if (!allowed.has(k)) return `foreign key "${k}" in legacy config`
  if (legacy.type !== "local") return "legacy entry is not local"
  const cmd = legacy.command
  if (!Array.isArray(cmd) || !cmd.every((c): c is string => typeof c === "string")) return "legacy command malformed"
  const specCommands = [spec.command, spec.mirrorCommand].filter((c): c is string[] => Array.isArray(c) && c.length > 0)
  if (!specCommands.some((sc) => commandAlphaShaped(cmd, sc))) return "command differs from catalog (runner/package/args)"
  const required = new Set(spec.requiredEnvVars ?? [])
  const envNames = legacy.environment && typeof legacy.environment === "object" ? Object.keys(legacy.environment as object) : []
  for (const v of envNames) if (!required.has(v)) return `env var "${v}" not declared by catalog`
  return null
}

function verifyPluginSpec(catalogPackage: string, legacySpecs: string[]): string | null {
  const base = specBase(catalogPackage)
  const matches = legacySpecs.filter((s) => specBase(s) === base)
  if (matches.length === 0) return "no legacy entry"
  const catAt = catalogPackage.lastIndexOf("@")
  const catVersion = catAt > 0 ? catalogPackage.slice(catAt + 1) : null
  for (const m of matches) {
    if (m.startsWith("/") || m.startsWith(".") || m.startsWith("~")) return "legacy entry is a path, not a catalog package"
    const at = m.lastIndexOf("@")
    if (at > 0) {
      const pin = m.slice(at + 1)
      if (!catVersion || pin !== catVersion) return `pinned to a different version (${pin})`
    }
  }
  return null
}

/** Verify each name-matched candidate's provenance against the legacy root + packaged assets.
 *  reason is set only when verified=false. Any per-item error ⇒ excluded (fail-closed). */
export function verifyLegacyProvenance(requests: ProvenanceRequest[], resourcesRoot: string): ProvenanceVerdict[] {
  const inv = scanLegacy()
  const legacyRoot = legacyConfigDir()
  return requests.map((req): ProvenanceVerdict => {
    const fail = (reason: string): ProvenanceVerdict => ({ type: req.type, name: req.name, verified: false, reason })
    const pass = (): ProvenanceVerdict => ({ type: req.type, name: req.name, verified: true, reason: "" })
    try {
      if (!isExtensionName(req.name)) return fail("invalid name")
      if (req.type === "skill") {
        if (
          !req.builtinAssetKey?.startsWith("skills/") ||
          !isExtensionName(req.builtinAssetKey.slice("skills/".length))
        )
          return fail("no packaged asset to verify against")
        const assetDir = path.join(resourcesRoot, req.builtinAssetKey)
        if (!fs.existsSync(path.join(assetDir, "SKILL.md"))) return fail("asset not bundled in this build")
        const legacyDir = path.join(legacyRoot, "skills", req.name)
        if (!fs.existsSync(path.join(legacyDir, "SKILL.md"))) return fail("no legacy copy")
        if (!dirsByteEqual(legacyDir, assetDir)) return fail("content differs from packaged asset — user-authored or user-modified")
        return pass()
      }
      if (req.type === "mcp") {
        const legacy = inv.mcp.find((m) => m.name === req.name)
        if (!legacy) return fail("no legacy entry")
        const reason = verifyMcpShape(req.spec, legacy.config)
        return reason ? fail(reason) : pass()
      }
      const reason = verifyPluginSpec(req.package, inv.plugins)
      return reason ? fail(reason) : pass()
    } catch (error) {
      return fail(`verify failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}
