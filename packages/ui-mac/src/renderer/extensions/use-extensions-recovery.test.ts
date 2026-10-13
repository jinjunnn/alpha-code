import { expect, test } from "bun:test"
import { join } from "node:path"

// Keep the browser globals and fetch observation out of the rest of bun test src.
test("#1505 production hook + SDK recovery regression", { timeout: 120_000 }, () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", join(import.meta.dir, "use-extensions-recovery.cases.ts")],
    cwd: join(import.meta.dir, "../../.."),
    env: process.env,
  })
  const output = result.stdout.toString() + result.stderr.toString()
  if (result.exitCode !== 0) throw new Error(output)
  expect(output).toContain("4 pass")
  expect(output).toContain("0 fail")
})
