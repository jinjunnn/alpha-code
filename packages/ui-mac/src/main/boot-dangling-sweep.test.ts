import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { parse } from "jsonc-parser"
import { runBootDanglingSweep } from "./boot-dangling-sweep"

const ENV_KEYS = [
  "ALPHA_GLOBAL_DIR",
  "ALPHA_OPENCODE_HOME",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_TEST_ONBOARDING",
] as const

let temporary = ""
let userData = ""
let alphaGlobal = ""
let engineData = ""
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  ENV_KEYS.forEach((key) => (saved[key] = process.env[key]))
  temporary = realpathSync(mkdtempSync(join(tmpdir(), "alpha-boot-sweep-")))
  userData = join(temporary, "user-data")
  alphaGlobal = join(temporary, "alpha-global")
  engineData = join(temporary, "engine-data")
  ;[userData, alphaGlobal, engineData, join(temporary, "opencode-home"), join(temporary, "xdg")].forEach((directory) =>
    mkdirSync(directory, { recursive: true }),
  )
  process.env.ALPHA_GLOBAL_DIR = alphaGlobal
  process.env.ALPHA_OPENCODE_HOME = join(temporary, "opencode-home")
  process.env.OPENCODE_CONFIG_DIR = join(temporary, "xdg")
})

afterEach(() => {
  ENV_KEYS.forEach((key) => {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  })
  rmSync(temporary, { recursive: true, force: true })
})

test("OPENCODE_TEST_ONBOARDING=1 still strips confirmed-absent guarded {file:} refs at boot", () => {
  process.env.OPENCODE_TEST_ONBOARDING = "1"
  const gone = join(userData, "alpha-mcp-secrets", "demo", "GONE")
  const target = join(alphaGlobal, "alpha.jsonc")
  mkdirSync(dirname(gone), { recursive: true })
  writeFileSync(
    target,
    `{
  "mcp": {
    "demo": {
      "type": "local",
      "environment": {
        "TOKEN": ${JSON.stringify(`{file:${gone}}`)}
      }
    }
  }
}\n`,
  )

  const result = runBootDanglingSweep({
    userDataPath: userData,
    engineDataPath: engineData,
    homeDir: temporary,
  })

  const parsed = parse(readFileSync(target, "utf8")) as {
    mcp: { demo: { environment: Record<string, unknown> } }
  }
  expect(parsed.mcp.demo.environment).toEqual({})
  expect(result.outcome.stripped).toHaveLength(1)
  expect(result.enforcementGap).toEqual([])
})

test("boot enforcement gap from an unparseable dangling-shaped config still surfaces", () => {
  process.env.OPENCODE_TEST_ONBOARDING = "1"
  const target = join(alphaGlobal, "alpha.jsonc")
  writeFileSync(target, `{ "plugin": ["/abs/gone.js"], `)

  const errors: string[] = []
  const result = runBootDanglingSweep({
    userDataPath: userData,
    engineDataPath: engineData,
    homeDir: temporary,
    log: { error: (message) => errors.push(message) },
  })

  expect(result.outcome.stripped).toEqual([])
  expect(result.enforcementGap).toHaveLength(1)
  expect(errors.some((line) => line.includes("boot enforcement gap"))).toBe(true)
})
