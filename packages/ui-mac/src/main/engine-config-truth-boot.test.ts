import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { reconcileEngineConfigTruth } from "./engine-config-truth-boot"

// Reconcile: legacy ~/.opencode + XDG provider → ~/.alpha/alpha.jsonc, skills.paths injection (T3),
// and ~/.opencode cleanup (T3: unbridge + delete migrated config + junk-only dir removal).
// Temp-dir isolated via the same env knobs ext-config uses. Receipts gate ownership.
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

const ISO = "2026-07-07T00:00:00.000Z"
const writeLegacy = (obj: unknown) => fs.writeFileSync(path.join(homeTmp, "opencode.jsonc"), JSON.stringify(obj))
const writeXdg = (obj: unknown) => fs.writeFileSync(path.join(xdgTmp, "opencode.jsonc"), JSON.stringify(obj))
const writeLedger = (receipts: unknown[]) =>
  fs.writeFileSync(path.join(alphaTmp, "installs.json"), JSON.stringify({ version: 1, receipts }))
const mcpReceipt = (name: string) => ({ id: `mcp:${name}`, name, type: "mcp", scope: "global", installedAt: ISO, origin: "catalog", configKey: `mcp.${name}` })
const readTruth = (): Record<string, any> => JSON.parse(fs.readFileSync(path.join(alphaTmp, "alpha.jsonc"), "utf8"))
const truthExists = () => fs.existsSync(path.join(alphaTmp, "alpha.jsonc"))
const homeExists = () => fs.existsSync(homeTmp)

describe("reconcile — migration + skills.paths", () => {
  test("escape hatch → skipped, no write", () => {
    process.env.ALPHA_JSONC_TRUTH_DISABLE = "1"
    writeLegacy({ mcp: { markitdown: { type: "local" } } })
    const r = reconcileEngineConfigTruth()
    expect(r.skipped).toBe(true)
    expect(truthExists()).toBe(false)
  })

  test("legacy mcp (in receipts) migrates + skills.paths injected", () => {
    writeLegacy({ mcp: { markitdown: { type: "local" } } })
    writeLedger([mcpReceipt("markitdown")])
    const r = reconcileEngineConfigTruth()
    expect(r.skipped).toBe(false)
    if (!r.skipped) expect(r.migrated).toBe(true)
    const t = readTruth()
    expect(t.mcp.markitdown).toEqual({ type: "local" })
    expect(t.skills).toContain(path.join(alphaTmp, "skills")) // T3 skills.paths
  })

  test("skills.paths injected even with nothing to migrate (truth created)", () => {
    const r = reconcileEngineConfigTruth()
    expect(r.skipped).toBe(false)
    if (!r.skipped) expect(r.migrated).toBe(true) // skills.paths write
    expect(readTruth().skills).toContain(path.join(alphaTmp, "skills"))
  })

  test("XDG provider lifted into alpha.jsonc; XDG file untouched", () => {
    writeXdg({ provider: { deepseek: { options: { baseURL: "https://api.deepseek.com" } } } })
    const r = reconcileEngineConfigTruth()
    expect(r.skipped).toBe(false)
    expect(readTruth().provider.deepseek).toBeDefined()
    expect(fs.existsSync(path.join(xdgTmp, "opencode.jsonc"))).toBe(true) // XDG belongs to engine
  })

  test("idempotent: second reconcile makes no new change", () => {
    writeLegacy({ mcp: { markitdown: { type: "local" } } })
    writeLedger([mcpReceipt("markitdown")])
    reconcileEngineConfigTruth()
    const second = reconcileEngineConfigTruth()
    expect(second.skipped).toBe(false)
    if (!second.skipped) expect(second.migrated).toBe(false)
  })
})

describe("reconcile — ownership bail-out", () => {
  test("legacy stray key (user-authored) → not migrated, loud, legacy kept", () => {
    writeLegacy({ mcp: {}, keybinds: { leader: "ctrl+x" } })
    const warns: string[] = []
    const r = reconcileEngineConfigTruth({ log: () => {}, warn: (m) => warns.push(m) })
    expect(r.skipped).toBe(false)
    if (!r.skipped) expect(r.bailedOut).toContain("keybinds")
    expect(warns.some((w) => w.includes("not alpha-owned"))).toBe(true)
    expect(fs.existsSync(path.join(homeTmp, "opencode.jsonc"))).toBe(true) // legacy kept in place
    // T3 fix: bail-out does NOT migrate legacy, but skills.paths IS still injected (factory skills
    // must not go dark on machines whose legacy mcp lacks a receipt).
    expect(truthExists()).toBe(true)
    const t = readTruth()
    expect(t.skills).toContain(path.join(alphaTmp, "skills")) // skills.paths injected despite bail
    expect(t.keybinds).toBeUndefined() // legacy stray key NOT migrated
    expect(t.mcp).toBeUndefined()
  })

  test("mcp not in receipts → STILL migrated (.opencode = alpha territory), loud unaccounted", () => {
    writeLegacy({ mcp: { myServer: { type: "remote" } } })
    writeLedger([]) // no receipts — but .opencode is alpha's write territory
    const warns: string[] = []
    const r = reconcileEngineConfigTruth({ log: () => {}, warn: (m) => warns.push(m) })
    expect(r.skipped).toBe(false)
    if (!r.skipped) expect(r.bailedOut).toBeUndefined() // 放宽:不 bail
    expect(readTruth().mcp.myServer).toBeDefined() // migrated into truth
    expect(warns.some((w) => w.includes("without receipts"))).toBe(true) // loud bookkeeping note
  })
})

describe("reconcile — T3 ~/.opencode cleanup", () => {
  test("junk-only ~/.opencode removed after migration", () => {
    writeLegacy({ mcp: { markitdown: { type: "local" } } })
    writeLedger([mcpReceipt("markitdown")])
    fs.writeFileSync(path.join(homeTmp, "package.json"), "{}") // engine bootstrap junk
    reconcileEngineConfigTruth()
    expect(homeExists()).toBe(false) // migrated + junk-only → whole dir removed
  })

  test("alpha skills dir-link unbridged", () => {
    const alphaSkills = path.join(alphaTmp, "skills")
    fs.mkdirSync(alphaSkills, { recursive: true })
    fs.symlinkSync(alphaSkills, path.join(homeTmp, "skills"), "dir")
    reconcileEngineConfigTruth()
    // link removed (and dir removed since only the link was there)
    expect(homeExists()).toBe(false)
  })

  test("user-authored content in ~/.opencode retained + loud", () => {
    fs.mkdirSync(path.join(homeTmp, "skill"), { recursive: true }) // user's own real dir
    fs.writeFileSync(path.join(homeTmp, "skill", "mine.md"), "# mine")
    const warns: string[] = []
    reconcileEngineConfigTruth({ log: () => {}, warn: (m) => warns.push(m) })
    expect(homeExists()).toBe(true) // retained
    expect(warns.some((w) => w.includes("retained"))).toBe(true)
  })

  test("migrated config file deleted, alpha-bak residual deleted", () => {
    writeLegacy({ mcp: { markitdown: { type: "local" } } })
    fs.writeFileSync(path.join(homeTmp, "opencode.jsonc.alpha-bak-102952"), "{}")
    fs.writeFileSync(path.join(homeTmp, "package.json"), "{}")
    writeLedger([mcpReceipt("markitdown")])
    reconcileEngineConfigTruth()
    expect(homeExists()).toBe(false) // both config + bak removed, junk-only → dir gone
  })

  test("foreign symlink (not into ~/.alpha) NOT unbridged", () => {
    const foreign = path.join(tmp, "somewhere-else")
    fs.mkdirSync(foreign, { recursive: true })
    fs.symlinkSync(foreign, path.join(homeTmp, "skills"), "dir")
    reconcileEngineConfigTruth({ log: () => {}, warn: () => {} })
    expect(homeExists()).toBe(true) // foreign link = user content → retained
    expect(fs.existsSync(path.join(homeTmp, "skills"))).toBe(true) // not unbridged
  })
})
