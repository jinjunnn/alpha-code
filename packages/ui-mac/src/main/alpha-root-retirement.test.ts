import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __resetAlphaEnvironmentForTests, initAlphaEnvironment } from "./alpha-environment"
import { reconcileEngineConfigTruth } from "./engine-config-truth-boot"
import { resolveProjectAlphaRoot } from "./alpha-workdir"
import { projectDirectoryIdentity } from "../../../ext/src/project-config"

type SourceFile = { path: string; text: string }

function readOperationalFiles(root: string, extensions: string[]): SourceFile[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) return readOperationalFiles(path, extensions)
    if (!extensions.some((extension) => entry.name.endsWith(extension)) || entry.name.includes(".test.")) return []
    return [{ path, text: readFileSync(path, "utf8") }]
  })
}

describe("retired global-root operational ratchet", () => {
  test("composition root、旧桥与 main/ext 项目入口对退休 sentinel/alias 均不读不写不迁", () => {
    const root = mkdtempSync(join(tmpdir(), "alpha-retirement-ratchet-"))
    const home = join(root, "home")
    const retired = join(home, ".alpha")
    const alias = join(root, "home-alias")
    const opencode = join(root, "opencode-home")
    const appData = join(root, "app-data")
    mkdirSync(join(retired, "skills"), { recursive: true })
    mkdirSync(opencode)
    mkdirSync(appData)
    writeFileSync(join(retired, "sentinel"), "untouched")
    writeFileSync(join(retired, "skills", "sentinel.txt"), "skill untouched")
    symlinkSync(home, alias, "dir")
    symlinkSync(join(retired, "skills"), join(opencode, "skills"), "dir")

    const previousOpencode = process.env.ALPHA_OPENCODE_HOME
    const previousDisable = process.env.ALPHA_JSONC_TRUTH_DISABLE
    process.env.ALPHA_OPENCODE_HOME = opencode
    process.env.ALPHA_JSONC_TRUTH_DISABLE = "1"
    try {
      expect(() =>
        initAlphaEnvironment({
          isPackaged: true,
          channel: "prod",
          appDataDir: appData,
          homeDir: home,
          baseRoot: join(alias, ".alpha"),
          env: {},
        }),
      ).toThrow()
      expect(resolveProjectAlphaRoot(alias, home).status).toBe("retired-home")
      expect(projectDirectoryIdentity(alias, home).status).toBe("retired-home")

      const reconciled = reconcileEngineConfigTruth(undefined, { retiredHomeDir: home })
      expect(reconciled.skipped).toBe(true)
      expect(readdirSync(opencode)).toEqual([])
      expect(readFileSync(join(retired, "sentinel"), "utf8")).toBe("untouched")
      expect(readFileSync(join(retired, "skills", "sentinel.txt"), "utf8")).toBe("skill untouched")
      expect(readdirSync(retired).sort()).toEqual(["sentinel", "skills"])
    } finally {
      __resetAlphaEnvironmentForTests()
      if (previousOpencode === undefined) delete process.env.ALPHA_OPENCODE_HOME
      else process.env.ALPHA_OPENCODE_HOME = previousOpencode
      if (previousDisable === undefined) delete process.env.ALPHA_JSONC_TRUTH_DISABLE
      else process.env.ALPHA_JSONC_TRUTH_DISABLE = previousDisable
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("operational source and write-guiding resources cannot restore retired migration or fallback surfaces", () => {
    const files = [
      ...readOperationalFiles(join(import.meta.dir, ".."), [".ts", ".tsx"]),
      ...readOperationalFiles(join(import.meta.dir, "../../../ext/src"), [".ts"]),
      ...readOperationalFiles(join(import.meta.dir, "../../resources"), [".md"]),
    ]
    const forbidden = [
      { name: "retired environment migration module", pattern: /\b(?:alpha-env-migrate|runEnvMigration)\b/ },
      { name: "retired environment migration constant", pattern: /\bENV_MIGRATION_/ },
      { name: "retired snapshot field", pattern: /\.legacyRoot\b/ },
      { name: "retired migration receipt", pattern: /env-migration-receipt\.json/ },
      { name: "retired rollback marker", pattern: /\.alpha-env-rollback\.json/ },
      { name: "ALPHA_GLOBAL_DIR fallback operator", pattern: /ALPHA_GLOBAL_DIR\s*(?:\|\||\?\?)/ },
      {
        name: "home .alpha fallback constructor",
        pattern: /(?:join|resolve)\(\s*(?:os\.)?homedir\(\)\s*,\s*["']\.alpha["']\s*\)/,
      },
    ]
    const violations = files.flatMap((file) =>
      forbidden
        .filter((rule) => rule.pattern.test(file.text))
        .map((rule) => `${file.path}: ${rule.name}`),
    )
    expect(violations).toEqual([])
  })

  test("startup 把 engine reconcile 异常置为 sidecar fail-closed gate", () => {
    const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8")
    const failure = source.indexOf("bootEnforcementGap = [`engine config reconcile failed:")
    const gate = source.indexOf("if (bootEnforcementGap)")
    const spawn = source.indexOf("spawning sidecar")
    expect(failure).toBeGreaterThan(-1)
    expect(gate).toBeGreaterThan(failure)
    expect(spawn).toBeGreaterThan(gate)
  })
})
