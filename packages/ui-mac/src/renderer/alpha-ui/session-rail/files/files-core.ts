/**
 * REQ-125 C3-files — pure helpers for the right-rail files panel.
 *
 * Path discipline (baseline §③.3): the renderer only ever holds *workspace-relative*
 * identifiers. Everything that arrives from outside (SDK file nodes, diff entries, layout
 * tabs, watcher events) is normalized through `normalizeToRel`/`isSafeRelPath` and dropped
 * fail-closed when it cannot be proven relative. Absolute paths never reach the UI model,
 * and the renderer never joins the workspace root onto a path.
 *
 * Parity notes: `base64UrlEncode`, `sessionStateKey`, `relPathToTab` and `relPathFromTab`
 * intentionally reproduce the upstream encodings (core/util/encode, app/utils/server-scope,
 * app/context/file/path) so the panel shares the upstream opened-tabs store. Parity is
 * asserted in files-core.test.ts against the real upstream implementations.
 */

export type FileChangeKind = "added" | "modified" | "deleted"

export interface TreeEntry {
  name: string
  path: string
  type: "file" | "directory"
  ignored: boolean
}

function stripQueryAndHash(input: string) {
  const hashIndex = input.indexOf("#")
  const queryIndex = input.indexOf("?")
  if (hashIndex !== -1 && queryIndex !== -1) return input.slice(0, Math.min(hashIndex, queryIndex))
  if (hashIndex !== -1) return input.slice(0, hashIndex)
  if (queryIndex !== -1) return input.slice(0, queryIndex)
  return input
}

function decodeSafe(input: string) {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

export function isSafeRelPath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0) return false
  if (path.includes("\u0000")) return false
  if (path.includes("\\")) return false
  if (path.startsWith("/")) return false
  if (/^[A-Za-z]:/.test(path)) return false
  return path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
}

/**
 * Canonicalize a raw *relative* path: backslashes are treated as separators (Windows nodes),
 * a "./" prefix and trailing separators (directory semantics, e.g. `src/`) are stripped.
 * Returns `undefined` unless the result is a safe relative path (traversal, absolutes, and
 * empty mid-segments stay refused fail-closed).
 */
export function canonicalRelPath(input: string): string | undefined {
  if (typeof input !== "string" || input.length === 0) return undefined
  let path = input.replace(/\\/g, "/")
  if (path.startsWith("./")) path = path.slice(2)
  while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1)
  if (path.endsWith("/")) return undefined
  return isSafeRelPath(path) ? path : undefined
}

/**
 * Reduce an untrusted path (possibly absolute, file://-prefixed, or ./-prefixed) to a safe
 * workspace-relative path, or `undefined` when that cannot be proven (fail-closed).
 */
export function normalizeToRel(root: string, input: string): string | undefined {
  if (typeof input !== "string" || input.length === 0) return undefined
  let path = input
  if (path.startsWith("file://")) path = path.slice("file://".length)
  const canonRoot = root.replace(/\\/g, "/").replace(/\/+$/, "")
  path = path.replace(/\\/g, "/")
  if (canonRoot.length > 0) {
    if (path === canonRoot) return undefined
    if (path.startsWith(`${canonRoot}/`)) path = path.slice(canonRoot.length + 1)
  }
  // Anything still absolute points outside the workspace — refuse, never reinterpret
  // (canonicalRelPath ends in isSafeRelPath, which rejects leading "/" and drive letters).
  return canonicalRelPath(path)
}

export function fileName(path: string): string {
  const index = path.lastIndexOf("/")
  return index === -1 ? path : path.slice(index + 1)
}

export function parentDir(path: string): string {
  const index = path.lastIndexOf("/")
  return index === -1 ? "" : path.slice(0, index)
}

/** Sanitize raw SDK file nodes into tree entries; unprovable entries are dropped fail-closed. */
export function toTreeEntries(parent: string, nodes: readonly unknown[] | undefined): TreeEntry[] {
  const prefix = parent === "" ? "" : `${parent}/`
  const seen = new Set<string>()
  const entries: TreeEntry[] = []
  for (const raw of nodes ?? []) {
    if (!raw || typeof raw !== "object") continue
    const node = raw as { name?: unknown; path?: unknown; type?: unknown; ignored?: unknown }
    if (typeof node.name !== "string" || node.name.length === 0 || node.name.includes("/")) continue
    if (node.type !== "file" && node.type !== "directory") continue
    // Real servers emit trailing separators on directories and backslashes on Windows —
    // canonicalize those separator forms; anything unprovable stays dropped fail-closed.
    const path = typeof node.path === "string" ? canonicalRelPath(node.path) : undefined
    if (!path) continue
    // Hidden directories (.git, .github, .vscode, …) are workspace noise the approved frame
    // omits (REQ-125 #576). Drop any entry that IS a dot-directory or lives inside one — check
    // every *directory* segment of the canonical path (all segments for a directory; all but
    // the leaf for a file) so an untrusted/fail-closed response like `src/.git/config` is
    // dropped too, not just root-level dot dirs. Dotfiles (leaf `.gitignore`) stay visible.
    // Mirrors the `.git` special-case already honored in watcherRefreshTarget.
    const dirSegments = node.type === "directory" ? path.split("/") : path.split("/").slice(0, -1)
    if (dirSegments.some((segment) => segment.startsWith("."))) continue
    if (prefix && !path.startsWith(prefix)) continue
    if (seen.has(path)) continue
    seen.add(path)
    entries.push({ name: node.name, path, type: node.type, ignored: node.ignored === true })
  }
  return entries
}

/** Session change set → map of workspace-relative file path → change kind. */
export function statusByFile(
  diffs: readonly { file?: string; status?: string }[] | undefined,
  root: string,
): Map<string, FileChangeKind> {
  const map = new Map<string, FileChangeKind>()
  for (const diff of diffs ?? []) {
    const status = diff.status
    if (status !== "added" && status !== "modified" && status !== "deleted") continue
    if (typeof diff.file !== "string") continue
    const rel = normalizeToRel(root, diff.file)
    if (!rel) continue
    map.set(rel, status)
  }
  return map
}

/** Sanitize find.files results into bounded, deduplicated workspace-relative rows. */
export function sanitizeSearchRows(paths: readonly unknown[] | undefined, root: string, limit: number): string[] {
  const rows: string[] = []
  const seen = new Set<string>()
  for (const item of paths ?? []) {
    if (rows.length >= limit) break
    if (typeof item !== "string") continue
    const rel = normalizeToRel(root, item)
    if (!rel || seen.has(rel)) continue
    seen.add(rel)
    rows.push(rel)
  }
  return rows
}

/** Parity clone of @opencode-ai/core `base64Encode` (base64url, unpadded). */
export function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

/**
 * Parity clone of the upstream session state key
 * (`SessionStateKey.from(scope, SessionRouteKey.fromRoute(base64Encode(dir), sessionID))`)
 * so the panel reads/writes the same persisted opened-tabs store as the upstream layout.
 */
export function sessionStateKey(scope: string, directory: string, sessionID: string): string {
  return `${scope}\u0000${base64UrlEncode(directory)}/${sessionID}`
}

/** Parity clone of upstream `path.tab` for safe workspace-relative inputs. */
export function relPathToTab(path: string): string {
  const decoded = decodeSafe(stripQueryAndHash(path))
  return `file://${decoded
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`
}

/**
 * Parity clone of upstream `path.pathFromTab` for tabs holding workspace-relative files,
 * hardened: tabs that decode to anything but a safe relative path are dropped fail-closed.
 */
export function relPathFromTab(tab: string): string | undefined {
  if (typeof tab !== "string" || !tab.startsWith("file://")) return undefined
  let path = decodeSafe(stripQueryAndHash(tab.slice("file://".length)))
  if (path.startsWith("./")) path = path.slice(2)
  // A tab decoding to an absolute or escaping path is hostile/foreign — drop it fail-closed.
  return isSafeRelPath(path) ? path : undefined
}

/**
 * Decide which loaded directory (if any) a watcher event should refresh.
 * Mirrors upstream invalidateFromWatcher's tree half: add/unlink refresh the loaded parent,
 * change refreshes the loaded directory itself.
 */
export function watcherRefreshTarget(input: {
  kind: string
  path: string
  isDirLoaded: (dir: string) => boolean
  isDirEntry: (path: string) => boolean
}): string | undefined {
  const path = input.path
  if (path === ".git" || path.startsWith(".git/")) return undefined
  if (input.kind === "change") {
    if (!input.isDirEntry(path)) return undefined
    return input.isDirLoaded(path) ? path : undefined
  }
  if (input.kind !== "add" && input.kind !== "unlink") return undefined
  const parent = parentDir(path)
  return input.isDirLoaded(parent) ? parent : undefined
}
