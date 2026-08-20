// #1044 — gate token-only sidecar respawn while cloud MCP OAuth is mid-flight.
//
// Evidence (2026-08-20 #721): every ~10 min `alpha-secrets sync` + token-only respawn kills the
// sidecar. `MCP.authenticate` waits for the loopback callback **inside that process**, so a
// mid-flight browser auth never writes `tokens` into mcp-auth.json — only codeVerifier/oauthState
// remain, and the next connect rewrites them.
//
// The engine (`packages/opencode/src/mcp/index.ts`, north-star-excluded) writes this marker for the
// `cloud` server while authenticate is waiting; main reads it before token-only respawn.

import * as fs from "node:fs"
import * as path from "node:path"

/** Same basename the engine writes under Global.Path.data (= engineDataDir). */
export const CLOUD_MCP_OAUTH_INFLIGHT_FILE = "cloud-mcp-oauth-inflight.json"

/** Bound the deferral so a stuck marker cannot freeze token rotation forever. */
export const CLOUD_MCP_OAUTH_INFLIGHT_MAX_AGE_MS = 15 * 60 * 1000

export type CloudMcpOAuthInflight = {
  mcpName: string
  startedAt: number
}

export function cloudMcpOAuthInflightPath(engineDataPath: string): string {
  return path.join(engineDataPath, CLOUD_MCP_OAUTH_INFLIGHT_FILE)
}

/** Pure read+age check — electron-free so unit tests do not need the app. */
export function isCloudMcpOAuthInflight(
  engineDataPath: string,
  nowMs: number = Date.now(),
  maxAgeMs: number = CLOUD_MCP_OAUTH_INFLIGHT_MAX_AGE_MS,
): boolean {
  const file = cloudMcpOAuthInflightPath(engineDataPath)
  let raw: string
  try {
    raw = fs.readFileSync(file, "utf8")
  } catch {
    return false
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return false
  }
  if (!parsed || typeof parsed !== "object") return false
  const o = parsed as Record<string, unknown>
  if (o.mcpName !== "cloud") return false
  if (typeof o.startedAt !== "number" || !Number.isFinite(o.startedAt)) return false
  const age = nowMs - o.startedAt
  if (age < 0 || age > maxAgeMs) return false
  return true
}
