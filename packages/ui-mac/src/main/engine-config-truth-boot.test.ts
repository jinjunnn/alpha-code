import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { reconcileEngineConfigTruth } from "./engine-config-truth-boot"

// Migration reconcile: legacy ~/.opencode + XDG provider → ~/.alpha/alpha.jsonc. Temp-dir isolated via
// the same env knobs ext-config uses. Receipts gate ownership; the ledger lives under ALPHA_GLOBAL_DIR.
let tmp = ""
let alphaTmp = ""
let homeTmp = ""
let xdgTmp = ""
const saved: Record<string, string | undefined> = {}
const KEYS = ["ALPHA_GLOBAL_DIR", "ALPHA_OPENCODE_HOME", "OPENCODE_CONFIG_DIR", "ALPHA_JSONC_TRUTH_DISABLE", "ALPHA_LEGACY_INSTALL_ROOT"]

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k]
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-reconcile-"))
  alphaTmp = path.join(tmp, "alpha")
  homeTmp = path.join(tmp, "opencode-home")
  xdgTmp = path.join(tmp, "xdg")
  fs.mkdirSync(alphaTmp, { recursive: true })
  fs.mkdirSync(homeTmp, { recursive: true })
  fs.mkdirSync(xdgTmp, { recursive: true })
  process.env.ALPHA_GLOBAL_DIR = alphaTmp
  process.env.ALPHA_OPENCODE_HOME = homeTmp
  process.env.OPENCODE_CONFIG_DIR = xdgTmp
  delete process.env.ALPHA_JSONC_TRUTH_DISABLE
  delete process.env.ALPHA_LEGACY_INSTALL_ROOT
})
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

const writeLegacy = (obj: unknown) => fs.writeFileSync(path.join(homeTmp, "opencode.jsonc"), JSON.stringify(obj))
const writeXdg = (obj: unknown) => fs.writeFileSync(path.join(xdgTmp, "opencode.jsonc"), JSON.stringify(obj))
const writeLedger = (receipts: unknown[]) =>
  fs.writeFileSync(path.join(alphaTmp, "installs.json"), JSON.stringify({ version: 1, receipts }))
const readTruth = (): Record<string, any> => JSON.parse(fs.readFileSync(path.join(alphaTmp, "alpha.jsonc"), "utf8"))
const truthExists = () => fs.existsSync(path.join(alphaTmp, "alpha.jsonc"))

describe("reconcileEngineConfigTruth", () => {
  test("escape hatch → skipped, no write", () => {
    process.env.ALPHA_JSONC_TRUTH_DISABLE = "1"
    writeLegacy({ mcp: { markitdown: { type: "local" } } })
    const r = reconcileEngineConfigTruth()
    expect(r.skipped).toBe(true)
    expect(truthExists()).toBe(false)
  })

  test("legacy mcp (in receipts) migrates into alpha.jsonc", () => {
    writeLegacy({ mcp: { markitdown: { type: "local" } } })
    writeLedger([{ id: "mcp:markitdown", name: "markitdown", type: "mcp", scope: "global", installedAt: "2026-07-07T00:00:00.000Z", origin: "catalog", configKey: "mcp.markitdown" }])
    const r = reconcileEngineConfigTruth()
    expect(r.skipped).toBe(false)
    if (!r.skipped) expect(r.migrated).toBe(true)
    expect(readTruth().mcp.markitdown).toEqual({ type: "local" })
  })

  test("copy-don't-delete: legacy file kept in place after migration", () => {
    writeLegacy({ mcp: { markitdown: { type: "local" } } })
    writeLedger([{ id: "mcp:markitdown", name: "markitdown", type: "mcp", scope: "global", installedAt: "2026-07-07T00:00:00.000Z", origin: "catalog" }])
    reconcileEngineConfigTruth()
    expect(fs.existsSync(path.join(homeTmp, "opencode.jsonc"))).toBe(true) // source untouched
  })

  test("XDG provider lifted into alpha.jsonc", () => {
    writeXdg({ provider: { deepseek: { options: { baseURL: "https://api.deepseek.com" } } } })
    const r = reconcileEngineConfigTruth()
    expect(r.skipped).toBe(false)
    expect(readTruth().provider.deepseek).toBeDefined()
  })

  test("bail-out: legacy has user-authored stray key → not migrated, loud", () => {
    writeLegacy({ mcp: {}, keybinds: { leader: "ctrl+x" } })
    const warns: string[] = []
    const r = reconcileEngineConfigTruth({ log: () => {}, warn: (m) => warns.push(m) })
    expect(r.skipped).toBe(false)
    if (!r.skipped) {
      expect(r.migrated).toBe(false)
      expect(r.bailedOut).toContain("keybinds")
    }
    expect(warns.some((w) => w.includes("not alpha-owned"))).toBe(true)
    expect(truthExists()).toBe(false)
  })

  test("bail-out: mcp not in receipts (user-built) → not migrated", () => {
    writeLegacy({ mcp: { myServer: { type: "remote" } } })
    writeLedger([]) // no receipts
    const r = reconcileEngineConfigTruth()
    expect(r.skipped).toBe(false)
    if (!r.skipped) expect(r.bailedOut).toContain("myServer")
  })

  test("idempotent: second reconcile is a no-op", () => {
    writeLegacy({ mcp: { markitdown: { type: "local" } } })
    writeLedger([{ id: "mcp:markitdown", name: "markitdown", type: "mcp", scope: "global", installedAt: "2026-07-07T00:00:00.000Z", origin: "catalog" }])
    reconcileEngineConfigTruth()
    const second = reconcileEngineConfigTruth()
    expect(second.skipped).toBe(false)
    if (!second.skipped) expect(second.migrated).toBe(false)
  })

  test("nothing to migrate → no write, no crash", () => {
    const r = reconcileEngineConfigTruth()
    expect(r.skipped).toBe(false)
    if (!r.skipped) expect(r.migrated).toBe(false)
    expect(truthExists()).toBe(false)
  })
})
