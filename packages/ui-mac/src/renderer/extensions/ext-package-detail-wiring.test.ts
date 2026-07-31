import { expect, test } from "bun:test"
import path from "node:path"

test("package safe view and admission traverse the production ExtensionHub card and ExtensionDetail paths", () => {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "test",
      path.resolve(import.meta.dir, "../../../test-component/ext-package-detail-wiring.cases.ts"),
    ],
    cwd: path.resolve(import.meta.dir, "../../.."),
    env: process.env,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(output)
  expect(output).toContain(" 9 pass")
  expect(output).toContain(" 0 fail")
  expect(output).toMatch(/Ran 9 tests across 1 file/)
})
