// Extension Hub file installer (main process). Writes user-authored / catalog skills and agents as
// markdown into opencode's globally-scanned config dir (~/.config/opencode/{skills,agent}) so they
// are discovered on the next scan without touching opencode source. Skills land in
// skills/<name>/SKILL.md (opencode scans `{skill,skills}/**/SKILL.md` under each config dir); agents
// land in agent/<name>.md. Everything is name-validated and confined to ~/.config/opencode
// (ADR-014 §8) — no path escapes, no writes outside that root.

import { app } from "electron"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

export type FsResult = { ok: true } | { ok: false; reason: string }

const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

function opencodeConfigDir(): string {
  // REQ-017:与 ext-config.userConfigDir / 上游 core/global.ts 同规则(OPENCODE_CONFIG_DIR >
  // XDG_CONFIG_HOME/opencode > ~/.config/opencode)。此前硬编码 ~/.config → 设 XDG 的用户
  // skill/agent 写进引擎不扫描的目录(写读分叉)。
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, "opencode")
  return path.join(os.homedir(), ".config", "opencode")
}

// Resolve a target inside ~/.config/opencode and assert (via realpath of the existing ancestor) that
// it can't escape that root through symlinks or `..`.
function safeResolve(...segments: string[]): string | null {
  const root = opencodeConfigDir()
  const target = path.resolve(root, ...segments)
  if (target !== root && !target.startsWith(root + path.sep)) return null
  // Walk up to the nearest existing ancestor and realpath it — defeats symlinked intermediate dirs.
  let probe = target
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe)
    if (parent === probe) break
    probe = parent
  }
  try {
    const real = fs.realpathSync(probe)
    const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : root
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null
  } catch {
    return null
  }
  return target
}

function oneLine(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/"/g, "'").trim()
}

/** Write a SKILL.md (frontmatter composed here for a valid result) under skills/<name>/. */
export function writeSkill(name: string, description: string, body: string): FsResult {
  if (!SAFE_NAME.test(name)) return { ok: false, reason: "invalid skill name" }
  const dir = safeResolve("skills", name)
  if (!dir) return { ok: false, reason: "refused: path escapes config dir" }
  const file = path.join(dir, "SKILL.md")
  const content = `---\nname: ${name}\ndescription: ${oneLine(description) || name}\n---\n\n${body || ""}\n`
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, content, "utf8")
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "failed to write skill" }
  }
}

/** Write an agent definition (caller composes the markdown) under agent/<name>.md. */
export function writeAgent(name: string, content: string): FsResult {
  if (!SAFE_NAME.test(name)) return { ok: false, reason: "invalid agent name" }
  const dir = safeResolve("agent")
  if (!dir) return { ok: false, reason: "refused: path escapes config dir" }
  const file = path.join(dir, `${name}.md`)
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, content.endsWith("\n") ? content : `${content}\n`, "utf8")
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "failed to write agent" }
  }
}

// Resolve the app's bundled-resources root the same way windows.ts does: process.resourcesPath when
// packaged, else the in-repo resources/ dir relative to the built main bundle (out/main).
function resourcesRoot(): string {
  return app.isPackaged
    ? process.resourcesPath
    : path.join(path.dirname(fileURLToPath(import.meta.url)), "../../resources")
}

// builtinAssetKey is author-controlled (the catalog), but validate it anyway so a bad entry can't
// escape the resources/skills tree.
const SAFE_ASSET_KEY = /^skills\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

/**
 * Install a builtin (app-bundled) skill: copy resources/<builtinAssetKey>/ into the user's globally
 * scanned skills/<name>/. Fails honestly when the asset isn't bundled in this build, rather than
 * writing a misleading placeholder.
 */
export function installBuiltinSkill(builtinAssetKey: string, name: string): FsResult {
  if (!SAFE_NAME.test(name)) return { ok: false, reason: "invalid skill name" }
  if (!SAFE_ASSET_KEY.test(builtinAssetKey)) return { ok: false, reason: "invalid asset key" }
  const srcDir = path.join(resourcesRoot(), builtinAssetKey)
  if (!fs.existsSync(path.join(srcDir, "SKILL.md"))) {
    return { ok: false, reason: "技能内容未随此版本打包" }
  }
  const destDir = safeResolve("skills", name)
  if (!destDir) return { ok: false, reason: "refused: path escapes config dir" }
  try {
    fs.mkdirSync(destDir, { recursive: true })
    // Bundled content is trusted (we authored it); copy the whole skill dir (SKILL.md + any assets).
    fs.cpSync(srcDir, destDir, { recursive: true })
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "failed to install skill" }
  }
}
