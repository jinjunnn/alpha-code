// REQ-053 `#982` — spawn throat latch at spawnLocalServer (subprocess host).
// True criteria live in test-component/req053-spawn-throat-latch.cases.ts.
import { resolve } from "node:path"
import { expect, test } from "bun:test"

test("spawnLocalServer refuses fork when dangling sweep has not been credited", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", resolve(import.meta.dir, "../../test-component/req053-spawn-throat-latch.cases.ts")],
    cwd: resolve(import.meta.dir, "../.."),
    env: process.env,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(output)
  expect(output).toMatch(/\b2 pass\b/)
  expect(output).toMatch(/\b0 fail\b/)
  expect(output).toMatch(/Ran 2 tests across 1 file/)
}, 120_000)
