import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CLOUD_MCP_OAUTH_INFLIGHT_FILE,
  CLOUD_MCP_OAUTH_INFLIGHT_MAX_AGE_MS,
  cloudMcpOAuthInflightPath,
  isCloudMcpOAuthInflight,
} from "./cloud-mcp-oauth-gate"

describe("#1044 cloud MCP OAuth inflight gate", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  function plant(entry: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "ac-1044-oauth-"))
    dirs.push(dir)
    writeFileSync(cloudMcpOAuthInflightPath(dir), JSON.stringify(entry), { mode: 0o600 })
    return dir
  }

  test("missing marker ⇒ not inflight", () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-1044-oauth-"))
    dirs.push(dir)
    expect(isCloudMcpOAuthInflight(dir, 1_000_000)).toBe(false)
  })

  test("fresh cloud marker ⇒ inflight (defers token-only respawn)", () => {
    const now = 1_700_000_000_000
    const dir = plant({ mcpName: "cloud", startedAt: now - 60_000 })
    expect(isCloudMcpOAuthInflight(dir, now)).toBe(true)
    expect(CLOUD_MCP_OAUTH_INFLIGHT_FILE).toBe("cloud-mcp-oauth-inflight.json")
  })

  test("stale marker past max age ⇒ not inflight (rotation must resume)", () => {
    const now = 1_700_000_000_000
    const dir = plant({ mcpName: "cloud", startedAt: now - CLOUD_MCP_OAUTH_INFLIGHT_MAX_AGE_MS - 1 })
    expect(isCloudMcpOAuthInflight(dir, now)).toBe(false)
  })

  test("wrong mcpName or corrupt JSON ⇒ not inflight (fail closed toward rotation)", () => {
    expect(isCloudMcpOAuthInflight(plant({ mcpName: "other", startedAt: Date.now() }))).toBe(false)
    expect(isCloudMcpOAuthInflight(plant({ mcpName: "cloud" }))).toBe(false)
    const dir = mkdtempSync(join(tmpdir(), "ac-1044-oauth-"))
    dirs.push(dir)
    writeFileSync(join(dir, CLOUD_MCP_OAUTH_INFLIGHT_FILE), "not-json", { mode: 0o600 })
    expect(isCloudMcpOAuthInflight(dir)).toBe(false)
  })
})
