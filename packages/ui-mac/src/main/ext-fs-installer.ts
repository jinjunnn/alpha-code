// Extension Hub file installer (main process) — REQ-018 T2 rework. User-authored / catalog skills
// and agents now land in the ALPHA truth root (`~/.alpha/{skills,agents}` for global scope,
// `<project>/.alpha/...` for project scope) and reach the engine through the `.opencode` symlink
// bridge (alpha-bridge.ts, REQ-004-validated). Every successful install writes a receipt
// (alpha-installs.ts) recording the exact files it owns, so installed-state/uninstall/update work.
// Legacy behavior (writing the shared XDG config dir) is gone — migration of old installs is T3
// (`ALPHA_LEGACY_INSTALL_ROOT=1` keeps the old root for escape).
//
// Security unchanged (ADR-014 §8): names validated, every path confined to its root via the
// realpath anti-escape walk; asset keys confined to resources/skills.

import { app } from "electron"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { bridgeItem, opencodeHomeDir, unbridgeItem } from "./alpha-bridge"
import { addReceipt, alphaGlobalRoot, removeReceipt } from "./alpha-installs"
import { alphaRoot, ensureAlphaScaffold } from "./alpha-workdir"
import type { InstallMeta, InstallReceipt, InstallTarget } from "../preload/types"

export type FsResult = { ok: true; files?: string[] } | { ok: false; reason: string }

const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

function opencodeConfigDir(): string {
  // REQ-017:与 ext-config.userConfigDir / 上游 core/global.ts 同规则(OPENCODE_CONFIG_DIR >
  // XDG_CONFIG_HOME/opencode > ~/.config/opencode)。REQ-018 起仅用于 legacy 逃生根(见下)。
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, "opencode")
  return path.join(os.homedir(), ".config", "opencode")
}

// REQ-018 逃生阀:置 1 回到旧行为(写共享 XDG 根,不桥接、不记账)。
function legacyRootActive(): boolean {
  return process.env.ALPHA_LEGACY_INSTALL_ROOT === "1"
}

// Resolve a target inside `root` and assert (via realpath of the existing ancestor) that it can't
// escape that root through symlinks or `..`.
function safeResolveUnder(root: string, ...segments: string[]): string | null {
  const target = path.resolve(root, ...segments)
  if (target !== root && !target.startsWith(root + path.sep)) return null
  let probe = target
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe)
    if (parent === probe) break
    probe = parent
  }
  try {
    const real = fs.realpathSync(probe)
    const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : root
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      // before the root exists, the nearest ancestor may be its (legitimate) parent dir
      const parentOfRoot = path.dirname(root)
      if (!(fs.existsSync(parentOfRoot) && real === fs.realpathSync(parentOfRoot))) return null
    }
  } catch {
    return null
  }
  return target
}

type Roots = { alphaDir: string; opencodeDir: string; scope: "global" | "project" }

function resolveRoots(target: InstallTarget | undefined): Roots | { error: string } {
  const t = target ?? { scope: "global" as const }
  if (t.scope === "global") {
    return { alphaDir: alphaGlobalRoot(), opencodeDir: opencodeHomeDir(), scope: "global" }
  }
  if (typeof t.projectDir !== "string") return { error: "invalid project directory" }
  const root = alphaRoot(t.projectDir)
  if (!root) return { error: `invalid project directory: ${t.projectDir}` }
  if (!ensureAlphaScaffold(t.projectDir)) return { error: "failed to prepare .alpha" }
  return { alphaDir: root, opencodeDir: path.join(t.projectDir, ".opencode"), scope: "project" }
}

function recordReceipt(
  roots: Roots,
  entry: { name: string; type: InstallReceipt["type"]; files: string[]; meta?: InstallMeta; origin?: InstallReceipt["origin"] },
): string | undefined {
  const receipt: InstallReceipt = {
    id: entry.meta?.catalogId ?? `user:${entry.name}`,
    name: entry.name,
    type: entry.type,
    scope: roots.scope,
    version: entry.meta?.version,
    installedAt: new Date().toISOString(),
    origin: entry.origin ?? (entry.meta?.catalogId ? "catalog" : "created"),
    files: entry.files,
  }
  const written = addReceipt(roots.alphaDir, receipt)
  return written.ok ? written.warning : `receipt not recorded: ${written.reason}`
}

function oneLine(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/"/g, "'").trim()
}

// Legacy path (escape hatch): the pre-REQ-018 behavior — write straight into the shared XDG config
// dir the engine scans, no bridge, no receipt.
function legacyWrite(kindDir: "skills" | "agent", name: string, write: (dir: string) => string): FsResult {
  const root = opencodeConfigDir()
  const dir = safeResolveUnder(root, kindDir === "skills" ? path.join("skills", name) : "agent")
  if (!dir) return { ok: false, reason: "refused: path escapes config dir" }
  try {
    fs.mkdirSync(dir, { recursive: true })
    const file = write(dir)
    return { ok: true, files: [file] }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "write failed" }
  }
}

/** Write a SKILL.md (frontmatter composed here) into the alpha truth root + bridge + receipt. */
export function writeSkill(
  name: string,
  description: string,
  body: string,
  target?: InstallTarget,
  meta?: InstallMeta,
): FsResult {
  if (!SAFE_NAME.test(name)) return { ok: false, reason: "invalid skill name" }
  const content = `---\nname: ${name}\ndescription: ${oneLine(description) || name}\n---\n\n${body || ""}\n`
  if (legacyRootActive()) {
    return legacyWrite("skills", name, (dir) => {
      const file = path.join(dir, "SKILL.md")
      fs.writeFileSync(file, content, "utf8")
      return file
    })
  }
  const roots = resolveRoots(target)
  if ("error" in roots) return { ok: false, reason: roots.error }
  const dir = safeResolveUnder(roots.alphaDir, "skills", name)
  if (!dir) return { ok: false, reason: "refused: path escapes alpha root" }
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "SKILL.md"), content, "utf8")
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "failed to write skill" }
  }
  const bridge = bridgeItem(roots.alphaDir, roots.opencodeDir, "skills", name)
  if (!bridge.ok) return { ok: false, reason: `已写入 ${dir},但引擎桥接失败:${bridge.reason}` }
  const files = [dir, ...bridge.created]
  recordReceipt(roots, { name, type: "skill", files, meta })
  return { ok: true, files }
}

/** Write an agent definition (caller composes the markdown) into the alpha truth root + bridge + receipt. */
export function writeAgent(name: string, content: string, target?: InstallTarget, meta?: InstallMeta): FsResult {
  if (!SAFE_NAME.test(name)) return { ok: false, reason: "invalid agent name" }
  const normalized = content.endsWith("\n") ? content : `${content}\n`
  if (legacyRootActive()) {
    return legacyWrite("agent", name, (dir) => {
      const file = path.join(dir, `${name}.md`)
      fs.writeFileSync(file, normalized, "utf8")
      return file
    })
  }
  const roots = resolveRoots(target)
  if ("error" in roots) return { ok: false, reason: roots.error }
  const dir = safeResolveUnder(roots.alphaDir, "agents")
  if (!dir) return { ok: false, reason: "refused: path escapes alpha root" }
  const file = path.join(dir, `${name}.md`)
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, normalized, "utf8")
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "failed to write agent" }
  }
  const bridge = bridgeItem(roots.alphaDir, roots.opencodeDir, "agents", name)
  if (!bridge.ok) return { ok: false, reason: `已写入 ${file},但引擎桥接失败:${bridge.reason}` }
  const files = [file, ...bridge.created]
  recordReceipt(roots, { name, type: "agent", files, meta })
  return { ok: true, files }
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
 * Read a bundled builtin skill's SKILL.md for the detail page (REQ-019 T3). Read-only, key
 * validated against the resources/skills tree, size-capped. Fails honestly when the asset isn't
 * bundled in this build (same wording as install).
 */
export function readBuiltinSkill(builtinAssetKey: string): { ok: true; content: string } | { ok: false; reason: string } {
  if (!SAFE_ASSET_KEY.test(builtinAssetKey)) return { ok: false, reason: "invalid asset key" }
  const file = path.join(resourcesRoot(), builtinAssetKey, "SKILL.md")
  try {
    if (!fs.existsSync(file)) return { ok: false, reason: "技能内容未随此版本打包" }
    if (fs.statSync(file).size > 256 * 1024) return { ok: false, reason: "SKILL.md 过大,略过预览" }
    return { ok: true, content: fs.readFileSync(file, "utf8") }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "failed to read skill" }
  }
}

/**
 * Install a builtin (app-bundled) skill: copy resources/<builtinAssetKey>/ into the alpha truth
 * root + bridge + receipt. Fails honestly when the asset isn't bundled in this build, rather than
 * writing a misleading placeholder.
 */
export function installBuiltinSkill(
  builtinAssetKey: string,
  name: string,
  target?: InstallTarget,
  meta?: InstallMeta,
): FsResult {
  if (!SAFE_NAME.test(name)) return { ok: false, reason: "invalid skill name" }
  if (!SAFE_ASSET_KEY.test(builtinAssetKey)) return { ok: false, reason: "invalid asset key" }
  const srcDir = path.join(resourcesRoot(), builtinAssetKey)
  if (!fs.existsSync(path.join(srcDir, "SKILL.md"))) {
    return { ok: false, reason: "技能内容未随此版本打包" }
  }
  if (legacyRootActive()) {
    return legacyWrite("skills", name, (dir) => {
      fs.cpSync(srcDir, dir, { recursive: true })
      return dir
    })
  }
  const roots = resolveRoots(target)
  if ("error" in roots) return { ok: false, reason: roots.error }
  const destDir = safeResolveUnder(roots.alphaDir, "skills", name)
  if (!destDir) return { ok: false, reason: "refused: path escapes alpha root" }
  try {
    fs.mkdirSync(destDir, { recursive: true })
    // Bundled content is trusted (we authored/vendored it); copy the whole skill dir.
    fs.cpSync(srcDir, destDir, { recursive: true })
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "failed to install skill" }
  }
  const bridge = bridgeItem(roots.alphaDir, roots.opencodeDir, "skills", name)
  if (!bridge.ok) return { ok: false, reason: `已写入 ${destDir},但引擎桥接失败:${bridge.reason}` }
  const files = [destDir, ...bridge.created]
  recordReceipt(roots, { name, type: "skill", files, meta, origin: "catalog" })
  return { ok: true, files }
}

// Resolve roots WITHOUT scaffolding — for uninstall (never create dirs we're about to delete from).
function resolveRootsReadonly(target: InstallTarget | undefined): Roots | { error: string } {
  const t = target ?? { scope: "global" as const }
  if (t.scope === "global") return { alphaDir: alphaGlobalRoot(), opencodeDir: opencodeHomeDir(), scope: "global" }
  if (typeof t.projectDir !== "string") return { error: "invalid project directory" }
  const root = alphaRoot(t.projectDir)
  if (!root) return { error: `invalid project directory: ${t.projectDir}` }
  return { alphaDir: root, opencodeDir: path.join(t.projectDir, ".opencode"), scope: "project" }
}

/**
 * Uninstall a skill/agent: remove its truth dir/file under .alpha, unbridge its .opencode link, and
 * drop the receipt. Legacy installs (ALPHA_LEGACY_INSTALL_ROOT era, no bridge/receipt) are removed
 * from the old XDG root by name. Missing target = already-gone success (idempotent).
 */
export function removeFsInstall(type: "skill" | "agent", name: string, target?: InstallTarget): FsResult {
  if (!SAFE_NAME.test(name)) return { ok: false, reason: "invalid name" }
  const removed: string[] = []
  // legacy XDG location (best-effort, pre-migration installs)
  const legacyRoot = opencodeConfigDir()
  const legacyTarget = type === "skill" ? path.join(legacyRoot, "skills", name) : path.join(legacyRoot, "agent", `${name}.md`)
  try {
    if (fs.existsSync(legacyTarget)) {
      fs.rmSync(legacyTarget, { recursive: true, force: true })
      removed.push(legacyTarget)
    }
  } catch {
    /* best-effort */
  }
  const roots = resolveRootsReadonly(target)
  if ("error" in roots) return removed.length ? { ok: true, files: removed } : { ok: false, reason: roots.error }
  const kind = type === "skill" ? "skills" : "agents"
  const truth = type === "skill" ? path.join(roots.alphaDir, "skills", name) : path.join(roots.alphaDir, "agents", `${name}.md`)
  try {
    if (fs.existsSync(truth)) {
      fs.rmSync(truth, { recursive: true, force: true })
      removed.push(truth)
    }
    unbridgeItem(roots.alphaDir, roots.opencodeDir, kind, name).removed.forEach((r) => removed.push(r))
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "failed to remove" }
  }
  removeReceipt(roots.alphaDir, type, name)
  return { ok: true, files: removed }
}
