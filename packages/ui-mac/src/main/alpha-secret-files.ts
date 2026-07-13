// A6 (sidecar env allowlist): the {file:} secret channel that replaces secret env inheritance.
//
// Upstream spawns every MCP/LSP child with `{ ...process.env }` (mcp/index.ts:334, lsp/lsp.ts:176) —
// not editable under ADR-005. So secrets must never ENTER the sidecar's env at all. Instead:
//
//   main (spawnLocalServer, every fork/respawn)          sidecar (injectAlphaConfig)
//   ────────────────────────────────────────────         ─────────────────────────────────────────
//   syncSecretFiles(): mirror each secret env var   ──▶  hasSecretFile(): gate providers on FILE
//   into <userData>/alpha-secrets/<VAR> (0600),          presence (env no longer carries keys);
//   delete files whose var is gone (logout / key         secretFileRef(): emit "{file:<abs path>}"
//   removed), then fork with the ALLOWLISTED env          into OPENCODE_CONFIG_CONTENT. opencode's
//   (sidecar-env.ts) that excludes all of these.          ConfigVariable.substitute resolves it at
//                                                         config load — the value never hits env.
//
// This closes BOTH leak channels at once: (1) raw secret env vars inherited by children, and
// (2) OPENCODE_CONFIG_CONTENT itself — previously it carried inlined BYOK keys / a Bearer token and
// is also inherited by children; now it carries only file paths.
//
// Accepted residual risk: the files are 0600
// but a same-UID process that goes LOOKING can still read them — same exposure as alpha.env today.
// A6's target is the passive channel (children dumping/logging their env), which this eliminates.
//
// Electron-free on purpose: main calls syncSecretFiles; the sidecar (utilityProcess) reaches
// hasSecretFile/secretFileRef through alpha-models.ts/sidecar.ts.

import * as fs from "node:fs"
import * as path from "node:path"
import catalog from "./alpha-models.json"
import type { AlphaModelCatalog } from "../shared/alpha-model-types"

const SECRET_DIR = "alpha-secrets"

/** Every env var main materializes into the file channel: platform + cloud MCP + all catalog BYOK keys. */
export function secretEnvVars(): string[] {
  const byok = (catalog as unknown as AlphaModelCatalog).byokProviders.map((p) => p.keyEnv).filter(Boolean)
  return ["ALPHA_API_KEY", "ALPHA_CLOUD_TOKEN", ...byok]
}

export function secretFilePath(userDataPath: string, varName: string): string {
  return path.join(userDataPath, SECRET_DIR, varName)
}

export function hasSecretFile(userDataPath: string, varName: string): boolean {
  return fs.existsSync(secretFilePath(userDataPath, varName))
}

/** The config token opencode resolves at load time (config/variable.ts). Paths may contain spaces
 * (…/Application Support/…) — the upstream matcher is `\{file:[^}]+\}`, so anything but `}` is fine. */
export function secretFileRef(userDataPath: string, varName: string): string {
  return `{file:${secretFilePath(userDataPath, varName)}}`
}

export type SecretSyncResult = { written: string[]; removed: string[] }

/**
 * Mirror the secret env vars into <userData>/alpha-secrets, one file per var (0600, dir 0700).
 * Vars absent/empty in `env` get their file DELETED — logout and key-removal must revoke, or a stale
 * file would keep resurrecting a dead provider. Unknown leftover files (catalog removals) are also
 * swept. Values never touch the log — callers may log the returned NAMES only.
 */
export function syncSecretFiles(userDataPath: string, env: NodeJS.ProcessEnv = process.env): SecretSyncResult {
  const dir = path.join(userDataPath, SECRET_DIR)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700) // mkdirSync's mode is ignored when the dir already exists

  const written: string[] = []
  const removed: string[] = []
  const wanted = new Set<string>()

  for (const name of secretEnvVars()) {
    const value = env[name]
    const file = path.join(dir, name)
    if (value) {
      wanted.add(name)
      fs.writeFileSync(file, value, { mode: 0o600 })
      fs.chmodSync(file, 0o600) // writeFileSync's mode is ignored when the file already exists
      written.push(name)
      continue
    }
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true })
      removed.push(name)
    }
  }

  for (const leftover of fs.readdirSync(dir)) {
    if (wanted.has(leftover)) continue
    if (removed.includes(leftover)) continue
    fs.rmSync(path.join(dir, leftover), { force: true })
    removed.push(leftover)
  }

  return { written, removed }
}
