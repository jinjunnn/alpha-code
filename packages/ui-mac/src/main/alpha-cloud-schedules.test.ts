// [#940] 云档 schedule 错误呈现判据。真断言在 alpha-cloud-schedules.cases.ts ——
// 子进程跑(alpha-cloud-jobs.test.ts 同款),因为 mock.module 会污染同进程的其它测试文件。
import { expect, test } from "bun:test"
import { join } from "node:path"

test("cloud schedule error-surfacing cases run green in an isolated child process", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", join(import.meta.dir, "alpha-cloud-schedules.cases.ts")],
    cwd: join(import.meta.dir, "../.."),
    env: process.env,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(output)
  expect(output).toContain(" 6 pass")
  expect(output).toContain(" 0 fail")
  // [#969] 「跑了 0 个文件」也是 `0 fail`。核对 bun 自己报的文件数与条数,否则这一步能假绿。
  expect(output).toContain("Ran 6 tests across 1 file")
})
