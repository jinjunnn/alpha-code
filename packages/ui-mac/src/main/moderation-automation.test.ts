// REQ-160 AC2(`#1353`)—— 自动化那两个发送入口的判据。
// 真断言在 moderation-automation.cases.ts(走生产 `runAutomationNow` / `llmParseAutomation`);
// 那里的 `mock.module("electron" | "@opencode-ai/sdk/v2/client" | …)` 是进程级的,会污染同进程
// 其它测试文件,所以由本文件起子进程跑(automation-ipc-delete.test.ts 同款)。
import { expect, test } from "bun:test"
import { join } from "node:path"

test("automation moderation cases run green in an isolated child process", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", join(import.meta.dir, "moderation-automation.cases.ts")],
    cwd: join(import.meta.dir, "../.."),
    env: process.env,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(output)
  expect(output).toContain(" 5 pass")
  expect(output).toContain(" 0 fail")
  // 「跑了 0 个文件」也是 `0 fail`。核对 bun 自己报的文件数与条数,否则这一步能假绿。
  expect(output).toContain("Ran 5 tests across 1 file")
})
