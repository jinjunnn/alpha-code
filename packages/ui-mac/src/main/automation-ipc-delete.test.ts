// [#963] 删自动化的云端幂等容忍判据 + [#969] `automations-save` 两条云端腿的 `code` 透传。
// 真断言在 automation-ipc-delete.cases.ts(走真实注册的生产 handler)——
// 子进程跑(alpha-cloud-schedules.test.ts 同款),因为 mock.module 会污染同进程的其它测试文件。
import { expect, test } from "bun:test"
import { join } from "node:path"

test("automation IPC cloud-leg cases run green in an isolated child process", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", join(import.meta.dir, "automation-ipc-delete.cases.ts")],
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
