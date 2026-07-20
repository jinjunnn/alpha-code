import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

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
  test("operational source and write-guiding resources cannot restore retired migration or fallback surfaces", () => {
    const files = [
      ...readOperationalFiles(join(import.meta.dir, ".."), [".ts", ".tsx"]),
      ...readOperationalFiles(join(import.meta.dir, "../../../ext/src"), [".ts"]),
      ...readOperationalFiles(join(import.meta.dir, "../../resources"), [".md"]),
    ]
    const forbidden = [
      { name: "retired environment migration module", pattern: /\b(?:alpha-env-migrate|runEnvMigration)\b/ },
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
})
