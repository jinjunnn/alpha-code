// Extension Hub config writer (main process). Persists MCP servers to the user's global opencode
// config so they survive restart — opencode reads config once and caches it, so the renderer's live
// sdk.mcp.add covers "this session" while this covers "next launch". We replicate the CLI's
// jsonc-modify approach (packages/opencode/src/cli/cmd/mcp.ts) WITHOUT importing opencode internals
// at runtime (ADR-006): jsonc-parser only + Node built-ins.
//
// Security (ADR-014 §8): everything is validated before any disk I/O — the MCP name, the allowed
// config fields, the local command head (whitelist), and remote URLs (https / loopback only).
// Writes are atomic (temp + rename) with a .bak rollback, and only ever touch mcp[<name>].

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"

export type ConfigResult = { ok: true } | { ok: false; reason: string }

const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const SAFE_MCP_FIELDS = new Set([
  "type",
  "command",
  "url",
  "environment",
  "headers",
  "disabled",
  "enabled",
  "cwd",
  "timeout",
  "oauth",
])
// Command heads we allow for local (stdio) MCP servers. Absolute paths under the standard mac
// package-manager bin dirs are also accepted (Homebrew / system).
const SAFE_COMMAND_HEADS = new Set(["uv", "uvx", "node", "npx", "bun", "bunx", "python", "python3", "git", "deno"])
const SAFE_ABS_PREFIXES = ["/opt/homebrew/bin/", "/usr/local/bin/", "/usr/bin/"]

function userConfigPath(): string {
  const dir = path.join(os.homedir(), ".config", "opencode")
  const jsonc = path.join(dir, "opencode.jsonc")
  const json = path.join(dir, "opencode.json")
  if (fs.existsSync(jsonc)) return jsonc
  if (fs.existsSync(json)) return json
  return jsonc // default to .jsonc (preserves comments)
}

function validateServer(server: Record<string, unknown>): ConfigResult {
  for (const key of Object.keys(server)) {
    if (!SAFE_MCP_FIELDS.has(key)) return { ok: false, reason: `field not allowed: ${key}` }
  }
  const command = (server as { command?: unknown }).command
  if (Array.isArray(command) && command.length > 0) {
    const head = String(command[0])
    const base = path.basename(head)
    const allowed = SAFE_COMMAND_HEADS.has(base) || SAFE_ABS_PREFIXES.some((p) => head.startsWith(p))
    if (!allowed) return { ok: false, reason: `command not allowed: ${head}` }
  }
  const url = (server as { url?: unknown }).url
  if (typeof url === "string") {
    const ok = url.startsWith("https://") || url.startsWith("http://localhost") || url.startsWith("http://127.0.0.1")
    if (!ok) return { ok: false, reason: "only https (or loopback http) URLs are allowed" }
  }
  return { ok: true }
}

function writeKey(keyPath: string[], value: unknown): ConfigResult {
  const target = userConfigPath()
  const bak = `${target}.bak`
  const tmp = `${target}.tmp`
  let text = "{}"
  try {
    if (fs.existsSync(target)) text = fs.readFileSync(target, "utf8")
  } catch {
    return { ok: false, reason: "failed to read config" }
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    if (fs.existsSync(target)) fs.writeFileSync(bak, text)
    const edits = modify(text, keyPath, value, { formattingOptions: { tabSize: 2, insertSpaces: true } })
    const result = applyEdits(text, edits)
    const errors: ParseError[] = []
    parse(result, errors)
    if (errors.length > 0) throw new Error("resulting config is not valid jsonc")
    fs.writeFileSync(tmp, result, "utf8")
    fs.renameSync(tmp, target)
    if (fs.existsSync(bak)) {
      try {
        fs.unlinkSync(bak)
      } catch {
        /* best-effort cleanup */
      }
    }
    return { ok: true }
  } catch (error) {
    // Roll back from the backup so a failed write never leaves a corrupt config.
    try {
      if (fs.existsSync(bak)) fs.copyFileSync(bak, target)
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
    } catch {
      /* nothing more we can do */
    }
    return { ok: false, reason: error instanceof Error ? error.message : "failed to write config" }
  }
}

/** Persist an MCP server under mcp[<name>] in the user's opencode config (durable). */
export function persistMcp(name: string, server: Record<string, unknown>): ConfigResult {
  if (!SAFE_NAME.test(name)) return { ok: false, reason: "invalid server name" }
  if (!server || typeof server !== "object") return { ok: false, reason: "invalid server config" }
  const valid = validateServer(server)
  if (!valid.ok) return valid
  return writeKey(["mcp", name], server)
}

/** Remove mcp[<name>] from the user's opencode config. */
export function removeMcp(name: string): ConfigResult {
  if (!SAFE_NAME.test(name)) return { ok: false, reason: "invalid server name" }
  return writeKey(["mcp", name], undefined)
}

// npm package name (optional scope), optionally pinned with @version. No shell metacharacters —
// opencode installs the package itself on next launch (loader.ts resolvePluginTarget), so we never
// shell out; this only gates what we write into the config.
const SAFE_PACKAGE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[a-z0-9][a-z0-9.+~^*<>=|-]*)?$/i

// Strip a trailing @version while preserving a leading @scope (so "@a/b@1" → "@a/b", "b@1" → "b").
function pkgBase(spec: string): string {
  const at = spec.lastIndexOf("@")
  return at > 0 ? spec.slice(0, at) : spec
}

/**
 * Append a plugin package to the config `plugins` array (opencode auto-installs it from npm on the
 * next launch). Idempotent. The caller should prompt for a restart — opencode reads `plugins` at
 * boot only.
 */
export function persistPlugin(pkg: string): ConfigResult {
  if (!SAFE_PACKAGE.test(pkg)) return { ok: false, reason: "invalid package name" }
  const target = userConfigPath()
  let text = "{}"
  try {
    if (fs.existsSync(target)) text = fs.readFileSync(target, "utf8")
  } catch {
    return { ok: false, reason: "failed to read config" }
  }
  const errors: ParseError[] = []
  const parsed = parse(text, errors) as { plugins?: unknown } | undefined
  const current: unknown[] = Array.isArray(parsed?.plugins) ? (parsed!.plugins as unknown[]) : []
  const base = pkgBase(pkg)
  const exists = current.some((p) => {
    if (typeof p === "string") return pkgBase(p) === base
    if (p && typeof p === "object") return pkgBase(String((p as { package?: string }).package ?? "")) === base
    return false
  })
  if (exists) return { ok: true }
  return writeKey(["plugins"], [...current, pkg])
}
