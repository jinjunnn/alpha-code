import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { parse } from "jsonc-parser"
import { executeClear, planClear, type ClearRoots, type FsDeps } from "./data-clear"
import { tryAcquireBundleLock } from "./ext-bundle-lock"
import {
  planDanglingSweep,
  sweepEngineConfigDanglingUnlocked,
  type DanglingPathInspection,
} from "./engine-config-dangling"
import { withConfigWriteLock } from "./ext-config"

const ENV_KEYS = [
  "ALPHA_GLOBAL_DIR",
  "ALPHA_OPENCODE_HOME",
  "OPENCODE_CONFIG_DIR",
  "ALPHA_JSONC_TRUTH_DISABLE",
  "ALPHA_LEGACY_INSTALL_ROOT",
] as const

let temporary = ""
let roots: ClearRoots
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  ENV_KEYS.forEach((key) => saved[key] = process.env[key])
  temporary = realpathSync(mkdtempSync(join(tmpdir(), "alpha-dangling-")))
  roots = {
    userData: join(temporary, "user-data"),
    alphaGlobal: join(temporary, "alpha-global"),
    opencodeHome: join(temporary, "opencode-home"),
    engineData: join(temporary, "engine-data"),
  }
  ;[roots.userData, roots.alphaGlobal, roots.opencodeHome, roots.engineData, join(temporary, "xdg")].forEach((directory) =>
    mkdirSync(directory, { recursive: true }),
  )
  process.env.ALPHA_GLOBAL_DIR = roots.alphaGlobal
  process.env.ALPHA_OPENCODE_HOME = roots.opencodeHome
  process.env.OPENCODE_CONFIG_DIR = join(temporary, "xdg")
  delete process.env.ALPHA_JSONC_TRUTH_DISABLE
  delete process.env.ALPHA_LEGACY_INSTALL_ROOT
})

afterEach(() => {
  ENV_KEYS.forEach((key) => {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  })
  rmSync(temporary, { recursive: true, force: true })
})

function inspector(options?: { absent?: string[]; uncertain?: string[] }) {
  const absent = new Set((options?.absent ?? []).map((file) => resolve(file)))
  const uncertain = new Set((options?.uncertain ?? []).map((file) => resolve(file)))
  return (file: string): DanglingPathInspection => {
    const resolved = resolve(file)
    if (uncertain.has(resolved))
      return { identity: { forms: [resolved], certain: true }, status: "uncertain", reason: "EACCES" }
    return { identity: { forms: [resolved], certain: true }, status: absent.has(resolved) ? "absent" : "present" }
  }
}

describe("planDanglingSweep", () => {
  test("strips a confirmed-absent guarded absolute plugin but leaves npm and user-foreign paths", () => {
    const guarded = join(roots.userData, "plugins", "gone.js")
    const present = join(roots.userData, "plugins", "present.js")
    const foreign = join(temporary, "user-project", "plugin.js")
    const plan = planDanglingSweep(
      { plugin: [guarded, "opencode-plugin", present, foreign], other: { plugin: [guarded] } },
      { configDir: roots.alphaGlobal, guardRoots: [roots.userData], inspectPath: inspector({ absent: [guarded, foreign] }) },
    )

    expect(plan.edits.map((edit) => edit.keyPath)).toEqual([["plugin", 0]])
    expect(plan.uncertain).toEqual([])
  })

  test("strips only {file:} values resolved inside a guard root", () => {
    const guarded = join(roots.userData, "alpha-mcp-secrets", "demo", "TOKEN")
    const foreign = join(temporary, "user-secrets", "TOKEN")
    const relativeGuarded = relative(roots.alphaGlobal, join(roots.userData, "alpha-mcp-secrets", "demo", "RELATIVE"))
    const resolvedRelative = resolve(roots.alphaGlobal, relativeGuarded)
    const plan = planDanglingSweep(
      {
        mcp: {
          demo: {
            environment: {
              TOKEN: `{file:${guarded}}`,
              RELATIVE: `{file:${relativeGuarded}}`,
              USER_TOKEN: `{file:${foreign}}`,
            },
            headers: { Authorization: { nested: `Bearer {file:${guarded}}` } },
          },
        },
      },
      {
        configDir: roots.alphaGlobal,
        guardRoots: [roots.userData],
        inspectPath: inspector({ absent: [guarded, resolvedRelative, foreign] }),
      },
    )

    expect(plan.edits.map((edit) => edit.keyPath)).toEqual([
      ["mcp", "demo", "environment", "TOKEN"],
      ["mcp", "demo", "environment", "RELATIVE"],
      ["mcp", "demo", "headers", "Authorization"],
    ])
  })

  test("keeps an EACCES/uncertain reference for fail-closed enforcement", () => {
    const guarded = join(roots.userData, "alpha-mcp-secrets", "demo", "TOKEN")
    const absent = join(roots.userData, "alpha-mcp-secrets", "demo", "ABSENT")
    const plan = planDanglingSweep(
      { mcp: { demo: { environment: { TOKEN: `{file:${guarded}}:{file:${absent}}` } } } },
      {
        configDir: roots.alphaGlobal,
        guardRoots: [roots.userData],
        inspectPath: inspector({ absent: [absent], uncertain: [guarded] }),
      },
    )

    expect(plan.edits).toEqual([])
    expect(plan.uncertain).toHaveLength(1)
    expect(plan.uncertain[0].reason).toBe("EACCES")
  })

  test("uses canonical identity so a symlink prefix cannot escape a guard root", () => {
    const lexical = join(roots.userData, "alias", "gone.js")
    const canonical = join(temporary, "user-project", "gone.js")
    const plan = planDanglingSweep(
      { plugin: [lexical] },
      {
        configDir: roots.alphaGlobal,
        guardRoots: [roots.userData],
        inspectPath: (file) => file === lexical
          ? { identity: { forms: [lexical, canonical], certain: true }, status: "absent" }
          : { identity: { forms: [resolve(file)], certain: true }, status: "present" },
      },
    )

    expect(plan.edits).toEqual([])
  })
})

describe("config target safety and writes", () => {
  test("the sweep wrapper admits all four Alpha guard roots", () => {
    const guarded = [
      join(roots.userData, "gone.js"),
      join(roots.alphaGlobal, "plugins", "gone.js"),
      join(roots.engineData, "gone.js"),
      join(temporary, ".alpha", "gone.js"),
    ]
    const target = join(roots.alphaGlobal, "alpha.jsonc")
    writeFileSync(target, JSON.stringify({ plugin: guarded }))

    const outcome = sweepEngineConfigDanglingUnlocked({
      phase: "boot",
      userDataPath: roots.userData,
      engineDataPath: roots.engineData,
      homeDir: temporary,
      inspectPath: inspector({ absent: guarded }),
    })

    expect((parse(readFileSync(target, "utf8")) as { plugin: string[] }).plugin).toEqual([])
    expect(outcome.stripped).toHaveLength(4)
  })

  test("trailing-comma configs match engine parsing for healthy and dangling refs", () => {
    const live = join(roots.userData, "alpha-mcp-secrets", "demo", "LIVE")
    const dangling = join(roots.userData, "alpha-mcp-secrets", "demo", "GONE")
    const target = join(roots.alphaGlobal, "alpha.jsonc")
    mkdirSync(dirname(live), { recursive: true })
    writeFileSync(live, "secret")
    const config = (secret: string) => `{
  "mcp": {
    "demo": {
      "environment": {
        "TOKEN": ${JSON.stringify(`{file:${secret}}`)}
      }
    }
  },
}\n`
    const healthy = config(live)
    writeFileSync(target, healthy)

    const healthyOutcome = sweepEngineConfigDanglingUnlocked({
      phase: "boot",
      userDataPath: roots.userData,
      engineDataPath: roots.engineData,
      homeDir: temporary,
      inspectPath: inspector(),
    })

    expect(readFileSync(target, "utf8")).toBe(healthy)
    expect(healthyOutcome.stripped).toEqual([])
    expect(healthyOutcome.enforcementGap).toEqual([])

    writeFileSync(target, config(dangling))
    const danglingOutcome = sweepEngineConfigDanglingUnlocked({
      phase: "boot",
      userDataPath: roots.userData,
      engineDataPath: roots.engineData,
      homeDir: temporary,
      inspectPath: inspector({ absent: [dangling] }),
    })

    const parsed = parse(readFileSync(target, "utf8"), [], { allowTrailingComma: true }) as {
      mcp: { demo: { environment: Record<string, unknown> } }
    }
    expect(parsed.mcp.demo.environment).toEqual({})
    expect(danglingOutcome.stripped).toHaveLength(1)
    expect(danglingOutcome.enforcementGap).toEqual([])
  })

  test("mixed legacy ownership bails out and leaves the file byte-for-byte unchanged", () => {
    const plugin = join(roots.userData, "gone.js")
    const legacy = join(roots.opencodeHome, "opencode.jsonc")
    const original = JSON.stringify({ theme: "user", plugin: [plugin] }, null, 2)
    writeFileSync(legacy, original)

    const outcome = sweepEngineConfigDanglingUnlocked({
      phase: "credentials-clear",
      userDataPath: roots.userData,
      engineDataPath: roots.engineData,
      homeDir: temporary,
      inspectPath: inspector({ absent: [plugin] }),
    })

    expect(readFileSync(legacy, "utf8")).toBe(original)
    expect(outcome.changedFiles).toEqual([])
    expect(outcome.warnings.some((warning) => warning.includes("ownership bail-out"))).toBe(true)
  })

  test("data-level sweep edits owned legacy only and never rewrites surviving alpha.jsonc", () => {
    const plugin = join(roots.userData, "gone.js")
    const alpha = join(roots.alphaGlobal, "alpha.jsonc")
    const legacy = join(roots.opencodeHome, "opencode.jsonc")
    const original = JSON.stringify({ plugin: [plugin] })
    writeFileSync(alpha, original)
    writeFileSync(legacy, original)

    const outcome = sweepEngineConfigDanglingUnlocked({
      phase: "data-clear",
      userDataPath: roots.userData,
      engineDataPath: roots.engineData,
      homeDir: temporary,
      inspectPath: inspector({ absent: [plugin] }),
    })

    expect(readFileSync(alpha, "utf8")).toBe(original)
    expect((parse(readFileSync(legacy, "utf8")) as { plugin: string[] }).plugin).toEqual([])
    expect(outcome.changedFiles).toEqual([legacy])
  })

  test("parse-error target gets zero writes", () => {
    const target = join(roots.alphaGlobal, "alpha.jsonc")
    const original = `{ "mcp": { "demo": { "environment": { "TOKEN": "{file:${join(roots.userData, "gone")}}" } }`
    writeFileSync(target, original)

    const outcome = sweepEngineConfigDanglingUnlocked({
      phase: "boot",
      userDataPath: roots.userData,
      engineDataPath: roots.engineData,
      homeDir: temporary,
    })

    expect(readFileSync(target, "utf8")).toBe(original)
    expect(existsSync(`${target}.tmp`)).toBe(false)
    expect(existsSync(`${target}.bak`)).toBe(false)
    expect(outcome.enforcementGap).toHaveLength(1)
  })

  test("boot keeps an uncertain ref and raises the existing fail-closed gap", () => {
    const plugin = join(roots.userData, "uncertain.js")
    const target = join(roots.alphaGlobal, "alpha.jsonc")
    const original = JSON.stringify({ plugin: [plugin] })
    writeFileSync(target, original)

    const outcome = sweepEngineConfigDanglingUnlocked({
      phase: "boot",
      userDataPath: roots.userData,
      engineDataPath: roots.engineData,
      homeDir: temporary,
      inspectPath: inspector({ uncertain: [plugin] }),
    })

    expect(readFileSync(target, "utf8")).toBe(original)
    expect(outcome.enforcementGap).toHaveLength(1)
  })

  test("XDG is loud read-only even when it contains a guarded dangling reference", () => {
    const plugin = join(roots.userData, "gone.js")
    const target = join(process.env.OPENCODE_CONFIG_DIR!, "opencode.jsonc")
    const original = JSON.stringify({ plugin: [plugin] })
    writeFileSync(target, original)

    const outcome = sweepEngineConfigDanglingUnlocked({
      phase: "boot",
      userDataPath: roots.userData,
      engineDataPath: roots.engineData,
      homeDir: temporary,
      inspectPath: inspector({ absent: [plugin] }),
    })

    expect(readFileSync(target, "utf8")).toBe(original)
    expect(outcome.changedFiles).toEqual([])
    expect(outcome.enforcementGap.some((gap) => gap.includes("user-foreign"))).toBe(true)
  })

  test("ALPHA_JSONC_TRUTH_DISABLE sweeps only the routed owned legacy config", () => {
    process.env.ALPHA_JSONC_TRUTH_DISABLE = "1"
    const plugin = join(roots.userData, "gone.js")
    const alpha = join(roots.alphaGlobal, "alpha.jsonc")
    const legacy = join(roots.opencodeHome, "opencode.json")
    const original = JSON.stringify({ plugin: [plugin] })
    writeFileSync(alpha, original)
    writeFileSync(legacy, original)

    const outcome = sweepEngineConfigDanglingUnlocked({
      phase: "boot",
      userDataPath: roots.userData,
      engineDataPath: roots.engineData,
      homeDir: temporary,
      inspectPath: inspector({ absent: [plugin] }),
    })

    expect(readFileSync(alpha, "utf8")).toBe(original)
    expect((parse(readFileSync(legacy, "utf8")) as { plugin: string[] }).plugin).toEqual([])
    expect(outcome.changedFiles).toEqual([legacy])
  })

  test("ALPHA_LEGACY_INSTALL_ROOT leaves every config untouched because XDG is foreign", () => {
    process.env.ALPHA_LEGACY_INSTALL_ROOT = "1"
    const plugin = join(roots.userData, "gone.js")
    const targets = [
      join(roots.alphaGlobal, "alpha.jsonc"),
      join(roots.opencodeHome, "opencode.jsonc"),
      join(process.env.OPENCODE_CONFIG_DIR!, "opencode.jsonc"),
    ]
    const original = JSON.stringify({ plugin: [plugin] })
    targets.forEach((target) => writeFileSync(target, original))

    const outcome = sweepEngineConfigDanglingUnlocked({
      phase: "boot",
      userDataPath: roots.userData,
      engineDataPath: roots.engineData,
      homeDir: temporary,
      inspectPath: inspector({ absent: [plugin] }),
    })

    targets.forEach((target) => expect(readFileSync(target, "utf8")).toBe(original))
    expect(outcome.changedFiles).toEqual([])
    expect(outcome.enforcementGap.some((gap) => gap.includes("user-foreign"))).toBe(true)
  })

  test("a busy config lock prevents the sweep callback from writing", () => {
    const plugin = join(roots.userData, "gone.js")
    const target = join(roots.alphaGlobal, "alpha.jsonc")
    const original = JSON.stringify({ plugin: [plugin] })
    writeFileSync(target, original)
    const held = tryAcquireBundleLock(roots.alphaGlobal, { txId: "held-by-test" })
    expect(held.ok).toBe(true)
    if (!held.ok) return

    try {
      const result = withConfigWriteLock(() => sweepEngineConfigDanglingUnlocked({
        phase: "credentials-clear",
        userDataPath: roots.userData,
        engineDataPath: roots.engineData,
        homeDir: temporary,
        inspectPath: inspector({ absent: [plugin] }),
      }))
      expect(result).toMatchObject({ ok: false })
      expect(readFileSync(target, "utf8")).toBe(original)
    } finally {
      held.lock.release()
    }
  })
})

test("credential-level clear leaves alpha.jsonc with no guarded dangling refs and preserves the mcp leaf", () => {
  const plugin = join(roots.userData, "alpha-secrets", "plugin.js")
  const secret = join(roots.userData, "alpha-mcp-secrets", "demo", "TOKEN")
  mkdirSync(dirname(plugin), { recursive: true })
  mkdirSync(dirname(secret), { recursive: true })
  writeFileSync(plugin, "export default {}")
  writeFileSync(secret, "secret")
  const target = join(roots.alphaGlobal, "alpha.jsonc")
  writeFileSync(
    target,
    `{
  // comments survive the leaf edits
  "plugin": [${JSON.stringify(plugin)}, "npm-plugin"],
  "mcp": { "demo": { "type": "local", "environment": { "TOKEN": ${JSON.stringify(`{file:${secret}}`)} } } }
}\n`,
  )
  const realFs: FsDeps = {
    exists: existsSync,
    lstat: (file) => {
      try {
        const stat = lstatSync(file)
        return { isSymlink: stat.isSymbolicLink(), isDir: stat.isDirectory(), size: stat.size }
      } catch {
        return null
      }
    },
    readdir: readdirSync,
    readlink: (file) => {
      try {
        return readlinkSync(file)
      } catch {
        return null
      }
    },
    realpath: (file) => {
      try {
        return realpathSync(file)
      } catch {
        return null
      }
    },
    remove: (file) => rmSync(file, { recursive: true, force: true }),
  }
  const clearPlan = planClear(realFs, "credentials", roots)
  executeClear(realFs, clearPlan, roots, { includeShared: true })
  const result = withConfigWriteLock(() => {
    return {
      acquired: true as const,
      sweep: sweepEngineConfigDanglingUnlocked({
        phase: "credentials-clear",
        userDataPath: roots.userData,
        engineDataPath: roots.engineData,
        homeDir: temporary,
      }),
    }
  })
  expect("acquired" in result).toBe(true)
  if (!("acquired" in result)) return

  const text = readFileSync(target, "utf8")
  const config = parse(text) as Record<string, unknown>
  expect(text).toContain("comments survive")
  expect(config.plugin).toEqual(["npm-plugin"])
  expect(config.mcp).toEqual({ demo: { type: "local", environment: {} } })
  expect(result.sweep.stripped).toHaveLength(2)
  expect(planDanglingSweep(config, {
    configDir: dirname(target),
    guardRoots: [roots.userData, roots.alphaGlobal, roots.engineData, join(temporary, ".alpha")],
  }).edits).toEqual([])
})

test("wiring orders boot and respawn sweeps before their sidecar forks", () => {
  const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8")
  const reconcile = source.indexOf("reconcileEngineConfigTruth(logger")
  const bootSweep = source.indexOf('phase: "boot"')
  const firstFork = source.indexOf("spawnLocalServer(hostname, port, password")
  const respawnSweep = source.indexOf('phase: "respawn"')
  const secondFork = source.indexOf("spawnLocalServer(hostname, port, password", firstFork + 1)
  expect(reconcile).toBeGreaterThan(-1)
  expect(bootSweep).toBeGreaterThan(reconcile)
  expect(firstFork).toBeGreaterThan(bootSweep)
  expect(respawnSweep).toBeGreaterThan(firstFork)
  expect(secondFork).toBeGreaterThan(respawnSweep)
})

test("clear wiring sweeps after deletion and before logout/exit under the config lock", () => {
  const source = readFileSync(join(import.meta.dir, "data-clear-boot.ts"), "utf8")
  const execute = source.indexOf("const results = DataClear.executeClear")
  const lock = source.indexOf("const locked = withConfigWriteLock", execute)
  const sweep = source.indexOf("sweepEngineConfigDanglingUnlocked", lock)
  const credentialCall = source.indexOf('executeClearWithDanglingSweep("credentials"')
  const logout = source.indexOf("await logout()", credentialCall)
  const dataCall = source.indexOf('executeClearWithDanglingSweep("data"')
  const exit = source.indexOf("app.exit(0)", dataCall)
  expect(lock).toBeGreaterThan(execute)
  expect(sweep).toBeGreaterThan(lock)
  expect(logout).toBeGreaterThan(credentialCall)
  expect(exit).toBeGreaterThan(dataCall)
  expect(source).toContain("Alpha 自有配置中指向已清除数据的悬空连接器/插件引用会一并清理")
  expect(source).not.toContain("事后手动清理其条目")
})
