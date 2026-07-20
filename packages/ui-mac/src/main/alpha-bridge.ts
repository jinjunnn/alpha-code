// `.alpha` ↔ `.opencode` symlink bridge (REQ-018 T2 / ADR-019 修订). Truth lives under an alpha
// root (the frozen current-environment root or `<project>/.alpha`); the engine discovers it through symlinks placed in the
// adjacent engine-scanned `.opencode` dir. REQ-004 spike facts
// (audits/2026-07-03-req004-alpha-bridge-spike.md): upstream scans pass symlink:true (npm glob
// follow), directory chains work for `**` patterns (skills/agents/commands), but single-level `*`
// scans (tool/plugin) do NOT see through a DIRECTORY symlink — those would need per-file links
// (deliberately not implemented until a local-plugin install path exists; npm plugins go through
// the config `plugin[]` array instead). Engine accepts singular/plural dir names; we use plural.

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

export type BridgeKind = "skills" | "agents" | "commands"
export type BridgeResult =
  | { ok: true; mode: "dir-link" | "item-link" | "covered"; created: string[] }
  | { ok: false; reason: string }

/**
 * `~/.opencode` — the engine's home-level scan root (upstream config/paths.ts). Overridable so
 * tests and OPENCODE_TEST_ONBOARDING builds never touch the real home dir (os.homedir() is not
 * env-redirectable under bun).
 */
export function opencodeHomeDir(): string {
  return process.env.ALPHA_OPENCODE_HOME || path.join(os.homedir(), ".opencode")
}

const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

// Skills are directories (skills/<name>/SKILL.md); agents/commands are single markdown files.
function itemRelPath(kind: BridgeKind, name: string): string {
  return kind === "skills" ? name : `${name}.md`
}

function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p)
  } catch {
    return null
  }
}

/**
 * Make `<opencodeDir>/<kind>` expose `<alphaDir>/<kind>/<name>` to the engine:
 * - nothing there yet → ONE directory symlink covering all current & future items (preferred);
 * - already links to our truth dir → covered (nothing to create);
 * - a real directory (user has own content) or a foreign dir-link → per-item symlink for `name`;
 * - a non-directory in the way → honest failure (never deletes user files).
 * The shared dir-link is bridge infrastructure — uninstall must NOT remove it (only item links).
 */
export function bridgeItem(alphaDir: string, opencodeDir: string, kind: BridgeKind, name: string): BridgeResult {
  if (!SAFE_NAME.test(name)) return { ok: false, reason: "invalid name" }
  const truthDir = path.join(alphaDir, kind)
  const bridgePath = path.join(opencodeDir, kind)
  try {
    fs.mkdirSync(truthDir, { recursive: true })
    let stat: fs.Stats | null = null
    try {
      stat = fs.lstatSync(bridgePath)
    } catch {
      stat = null
    }
    if (!stat) {
      fs.mkdirSync(opencodeDir, { recursive: true })
      fs.symlinkSync(truthDir, bridgePath, "dir")
      return { ok: true, mode: "dir-link", created: [bridgePath] }
    }
    if (stat.isSymbolicLink()) {
      const real = realpathOrNull(bridgePath)
      const realTruth = realpathOrNull(truthDir)
      if (real && realTruth && real === realTruth) return { ok: true, mode: "covered", created: [] }
      const resolvedDir = real
        ? (() => {
            try {
              return fs.statSync(real).isDirectory()
            } catch {
              return false
            }
          })()
        : false
      if (!resolvedDir) return { ok: false, reason: `cannot bridge: ${bridgePath} is a broken link` }
      // foreign dir-link: fall through and place the item link inside the resolved directory
    } else if (!stat.isDirectory()) {
      return { ok: false, reason: `cannot bridge: ${bridgePath} exists and is not a directory` }
    }
    const rel = itemRelPath(kind, name)
    const itemLink = path.join(bridgePath, rel)
    const itemTruth = path.join(truthDir, rel)
    let itemStat: fs.Stats | null = null
    try {
      itemStat = fs.lstatSync(itemLink)
    } catch {
      itemStat = null
    }
    if (itemStat) {
      if (!itemStat.isSymbolicLink()) return { ok: false, reason: `已存在同名条目:${itemLink}` }
      const real = realpathOrNull(itemLink)
      const realTruth = realpathOrNull(itemTruth)
      if (real && realTruth && real === realTruth) return { ok: true, mode: "covered", created: [] }
      fs.unlinkSync(itemLink) // stale/broken alpha link — safe to replace
    }
    fs.symlinkSync(itemTruth, itemLink, kind === "skills" ? "dir" : "file")
    return { ok: true, mode: "item-link", created: [itemLink] }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "bridge failed" }
  }
}

/**
 * Uninstall-side cleanup: remove the PER-ITEM link if it is a symlink pointing into our truth dir.
 * A shared kind-level dir-link is infrastructure and is never removed here.
 */
export function unbridgeItem(alphaDir: string, opencodeDir: string, kind: BridgeKind, name: string): { removed: string[] } {
  if (!SAFE_NAME.test(name)) return { removed: [] }
  const itemLink = path.join(opencodeDir, kind, itemRelPath(kind, name))
  try {
    const stat = fs.lstatSync(itemLink)
    if (!stat.isSymbolicLink()) return { removed: [] }
    const target = fs.readlinkSync(itemLink)
    const resolvedTarget = path.isAbsolute(target) ? target : path.resolve(path.dirname(itemLink), target)
    const truthItem = path.join(alphaDir, kind, itemRelPath(kind, name))
    if (path.resolve(resolvedTarget) !== path.resolve(truthItem)) return { removed: [] }
    fs.unlinkSync(itemLink)
    return { removed: [itemLink] }
  } catch {
    return { removed: [] }
  }
}
