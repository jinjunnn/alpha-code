import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { reconcileEngineConfigTruth } from "./engine-config-truth-boot"

// Reconcile: legacy ~/.opencode + XDG provider → current-environment alpha.jsonc, skills.paths injection (T3),
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
  alphaTmp = path.join(fs.realpathSync(tmp), "alpha-code-state", "env", "dev")
  homeTmp = path.join(tmp, "opencode-home")
  xdgTmp = path.join(tmp, "xdg")
  fs.mkdirSync(alphaTmp, { recursive: true })
  alphaTmp = fs.realpathSync(alphaTmp)
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
    expect((t.skills as any).paths).toContain(path.join(alphaTmp, "skills")) // T3 skills.paths
  })

  test("skills.paths injected even with nothing to migrate (truth created)", () => {
    const r = reconcileEngineConfigTruth()
    expect(r.skipped).toBe(false)
    if (!r.skipped) expect(r.migrated).toBe(true) // skills.paths write
    expect((readTruth().skills as any).paths).toContain(path.join(alphaTmp, "skills"))
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
    expect((t.skills as any).paths).toContain(path.join(alphaTmp, "skills")) // skills.paths injected despite bail
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
  test("所有提前返回前只断退休 kind/item 桥，退休根 sentinel 原封不动", () => {
    const retiredHome = path.join(tmp, "retired-home")
    const retired = path.join(retiredHome, ".alpha")
    for (const kind of ["skills", "agents", "commands"])
      fs.mkdirSync(path.join(retired, kind), { recursive: true })
    fs.writeFileSync(path.join(retired, "skills", "sentinel.txt"), "skill sentinel")
    fs.writeFileSync(path.join(retired, "agents", "legacy.md"), "agent sentinel")
    fs.writeFileSync(path.join(retired, "commands", "legacy.md"), "command sentinel")

    fs.symlinkSync(path.join(retired, "skills"), path.join(homeTmp, "skills"), "dir")
    fs.mkdirSync(path.join(homeTmp, "agents"))
    fs.symlinkSync(path.join(retired, "agents", "legacy.md"), path.join(homeTmp, "agents", "legacy.md"), "file")
    fs.mkdirSync(path.join(homeTmp, "commands"))
    fs.symlinkSync(path.join(retired, "commands", "legacy.md"), path.join(homeTmp, "commands", "legacy.md"), "file")

    process.env.ALPHA_JSONC_TRUTH_DISABLE = "1"
    const result = reconcileEngineConfigTruth(undefined, { retiredHomeDir: retiredHome })

    expect(result.skipped).toBe(true)
    expect(fs.existsSync(path.join(homeTmp, "skills"))).toBe(false)
    expect(fs.existsSync(path.join(homeTmp, "agents", "legacy.md"))).toBe(false)
    expect(fs.existsSync(path.join(homeTmp, "commands", "legacy.md"))).toBe(false)
    expect(fs.readFileSync(path.join(retired, "skills", "sentinel.txt"), "utf8")).toBe("skill sentinel")
    expect(fs.readFileSync(path.join(retired, "agents", "legacy.md"), "utf8")).toBe("agent sentinel")
    expect(fs.readFileSync(path.join(retired, "commands", "legacy.md"), "utf8")).toBe("command sentinel")
    expect(fs.readdirSync(retired).sort()).toEqual(["agents", "commands", "skills"])
  })

  test("退休桥目录不可写(EACCES)→ reconcile 抛错且不继续，桥与 truth 均不动", () => {
    const retiredHome = path.join(tmp, "retired-home-eacces")
    const retired = path.join(retiredHome, ".alpha", "skills")
    fs.mkdirSync(retired, { recursive: true })
    const bridge = path.join(homeTmp, "skills")
    fs.symlinkSync(retired, bridge, "dir")
    fs.chmodSync(homeTmp, 0o555)
    try {
      expect(() => reconcileEngineConfigTruth(undefined, { retiredHomeDir: retiredHome })).toThrow()
      expect(fs.lstatSync(bridge).isSymbolicLink()).toBe(true)
      expect(truthExists()).toBe(false)
    } finally {
      fs.chmodSync(homeTmp, 0o755)
    }
  })

  test("退休桥在 unlink 紧邻重验时换成另一条退休链→ 按新身份重验后删链，退休 truth 原封不动", () => {
    const retiredHome = path.join(tmp, "retired-home-race-retired")
    const retired = path.join(retiredHome, ".alpha")
    const firstTarget = path.join(retired, "skills-first")
    const replacementTarget = path.join(retired, "skills-replacement")
    fs.mkdirSync(firstTarget, { recursive: true })
    fs.mkdirSync(replacementTarget, { recursive: true })
    fs.writeFileSync(path.join(firstTarget, "sentinel.txt"), "first truth")
    fs.writeFileSync(path.join(replacementTarget, "sentinel.txt"), "replacement truth")
    const bridge = path.join(homeTmp, "skills")
    fs.symlinkSync(firstTarget, bridge, "dir")
    let bridgeStats = 0
    process.env.ALPHA_JSONC_TRUTH_DISABLE = "1"

    const result = reconcileEngineConfigTruth(undefined, {
      retiredHomeDir: retiredHome,
      retiredBridgeFs: {
        lstatSync: (file) => {
          if (file === bridge && ++bridgeStats === 2) {
            fs.unlinkSync(bridge)
            fs.symlinkSync(replacementTarget, bridge, "dir")
          }
          return fs.lstatSync(file)
        },
        readlinkSync: (file) => fs.readlinkSync(file),
        readdirSync: (directory) => fs.readdirSync(directory),
        unlinkSync: (file) => fs.unlinkSync(file),
      },
    })

    expect(result.skipped).toBe(true)
    expect(fs.existsSync(bridge)).toBe(false)
    expect(fs.readFileSync(path.join(firstTarget, "sentinel.txt"), "utf8")).toBe("first truth")
    expect(fs.readFileSync(path.join(replacementTarget, "sentinel.txt"), "utf8")).toBe("replacement truth")
  })

  test("退休桥在 unlink 紧邻重验时已换成非退休对象→ 跳过且不删竞争换位对象", () => {
    const retiredHome = path.join(tmp, "retired-home-race")
    const retired = path.join(retiredHome, ".alpha", "skills")
    fs.mkdirSync(retired, { recursive: true })
    const bridge = path.join(homeTmp, "skills")
    fs.symlinkSync(retired, bridge, "dir")
    let bridgeStats = 0
    process.env.ALPHA_JSONC_TRUTH_DISABLE = "1"

    const result = reconcileEngineConfigTruth(undefined, {
      retiredHomeDir: retiredHome,
      retiredBridgeFs: {
        lstatSync: (file) => {
          if (file === bridge && ++bridgeStats === 2) {
            fs.unlinkSync(bridge)
            fs.writeFileSync(bridge, "competitor")
          }
          return fs.lstatSync(file)
        },
        readlinkSync: (file) => fs.readlinkSync(file),
        readdirSync: (directory) => fs.readdirSync(directory),
        unlinkSync: (file) => fs.unlinkSync(file),
      },
    })

    expect(result.skipped).toBe(true)
    expect(fs.lstatSync(bridge).isFile()).toBe(true)
    expect(fs.readFileSync(bridge, "utf8")).toBe("competitor")
    expect(fs.readdirSync(retired)).toEqual([])
  })

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

describe("reconcile — REQ-065 factory skills.paths group", () => {
  test("factorySkillDirs injected alongside current-environment skills", () => {
    const dirs = ["/App.app/Contents/Resources/skills/skill-creator", "/App.app/Contents/Resources/factory-skills/agent-creator"]
    const r = reconcileEngineConfigTruth(undefined, { factorySkillDirs: dirs })
    expect(r.skipped).toBe(false)
    expect(r.added).toContain("skills.factory[]")
    const paths = readTruth().skills.paths as string[]
    expect(paths).toContain(path.join(alphaTmp, "skills"))
    for (const d of dirs) expect(paths).toContain(d)
  })
  test("app moved: stale factory entries rewritten to the current install; user entries kept", () => {
    fs.writeFileSync(
      path.join(alphaTmp, "alpha.jsonc"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        skills: { paths: [path.join(alphaTmp, "skills"), "/users/own/path", "/Old.app/Contents/Resources/skills/skill-creator"] },
      }),
    )
    const dirs = ["/New.app/Contents/Resources/skills/skill-creator"]
    const r = reconcileEngineConfigTruth(undefined, { factorySkillDirs: dirs })
    expect(r.added).toContain("skills.factory[]")
    const paths = readTruth().skills.paths as string[]
    expect(paths).toEqual([path.join(alphaTmp, "skills"), "/users/own/path", "/New.app/Contents/Resources/skills/skill-creator"])
  })
  test("opts omitted (legacy callers/tests): factory group untouched", () => {
    fs.writeFileSync(
      path.join(alphaTmp, "alpha.jsonc"),
      JSON.stringify({ skills: { paths: [path.join(alphaTmp, "skills"), "/Old.app/Contents/Resources/skills/skill-creator"] } }),
    )
    reconcileEngineConfigTruth()
    const paths = readTruth().skills.paths as string[]
    expect(paths).toContain("/Old.app/Contents/Resources/skills/skill-creator")
  })
})

// ── #395(Codex r5)步骤4:alpha.jsonc 读错误只容缺席,其余 fail-closed ───────────────────────────
describe("reconcile — #395 读错误收窄(非缺席 fail-closed)", () => {
  test("truth 不可读(EISDIR)→ 整体 skip,不写盘(不以不完整基底重建)", () => {
    fs.mkdirSync(path.join(alphaTmp, "alpha.jsonc")) // 目录占位 → readFileSync EISDIR(非缺席)
    writeLegacy({ mcp: { demo: { type: "local" } } })
    writeLedger([mcpReceipt("demo")])
    const out = reconcileEngineConfigTruth()
    expect(out.skipped).toBe(true)
    if (out.skipped) expect(out.reason).toContain("unreadable")
    expect(homeExists()).toBe(true) // 未清理
  })

  test("legacy 不可读(EISDIR)→ bail-out(不迁不清理),truth 仍注入 skills.paths", () => {
    fs.rmSync(path.join(homeTmp, "opencode.jsonc"), { force: true })
    fs.mkdirSync(path.join(homeTmp, "opencode.jsonc"))
    const out = reconcileEngineConfigTruth()
    expect(out.skipped).toBe(false)
    if (!out.skipped) {
      expect(out.bailedOut).toContain("unreadable")
      expect(truthExists()).toBe(true) // skills.paths 注入不受 bail 阻断(REQ-059 既有契约)
    }
    expect(fs.existsSync(path.join(homeTmp, "opencode.jsonc"))).toBe(true) // 保留原样
  })
})
