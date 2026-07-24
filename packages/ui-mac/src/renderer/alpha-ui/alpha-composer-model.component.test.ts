import { expect, test } from "bun:test"
import path from "node:path"

test("生产 model picker 的 Solid 组件状态机", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", path.resolve(import.meta.dir, "../../../test-component/alpha-composer-model.cases.ts")],
    cwd: path.resolve(import.meta.dir, "../../.."),
    env: process.env,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(output)
  expect(output).toContain("32 pass")
  expect(output).toContain("0 fail")
})
