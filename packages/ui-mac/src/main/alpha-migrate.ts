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

const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

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
        .filter((d) => d.isDirectory() && SAFE_NAME.test(d.name) && fs.existsSync(path.join(root, sub, d.name, "SKILL.md")))
        .map((d) => d.name)
    } catch {
      return []
    }
  }
  inv.skills = dirEntries("skills")
  try {
    inv.agents = fs
      .readdirSync(path.join(root, "agent"), { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(".md") && SAFE_NAME.test(d.name.slice(0, -3)))
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
          if (SAFE_NAME.test(name) && config && typeof config === "object") {
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
      if (!SAFE_NAME.test(name)) return { ok: false, reason: "invalid name" }
      const dir = path.join(root, "skills", name)
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true })
        removed.push(dir)
      }
    } else if (type === "agent") {
      if (!SAFE_NAME.test(name)) return { ok: false, reason: "invalid name" }
      const file = path.join(root, "agent", `${name}.md`)
      if (fs.existsSync(file)) {
        fs.rmSync(file, { force: true })
        removed.push(file)
      }
    } else if (type === "mcp") {
      if (!SAFE_NAME.test(name)) return { ok: false, reason: "invalid name" }
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
