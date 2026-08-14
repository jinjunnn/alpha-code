// [#963] 删自动化的云端幂等容忍判据。真断言在 automation-ipc-delete.cases.ts ——
// 子进程跑(alpha-cloud-schedules.test.ts 同款),因为 mock.module 会污染同进程的其它测试文件。
import { expect, test } from "bun:test"
import { join } from "node:path"

test("automation delete idempotency cases run green in an isolated child process", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", join(import.meta.dir, "automation-ipc-delete.cases.ts")],
    cwd: join(import.meta.dir, "../.."),
    env: process.env,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(output)
  expect(output).toContain(" 4 pass")
  expect(output).toContain(" 0 fail")
})
