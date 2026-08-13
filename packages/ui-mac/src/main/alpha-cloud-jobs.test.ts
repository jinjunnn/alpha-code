// #727:Cloud job 客户端 action 选择闸门。真断言在 alpha-cloud-jobs.cases.ts ——
// 子进程跑(cloud-ipc.test.ts 同款),因为 mock.module("./alpha-auth" 等) 会污染同进程的其它测试文件。
import { expect, test } from "bun:test"
import { join } from "node:path"

test("cloud job action-selection cases run green in an isolated child process", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", join(import.meta.dir, "alpha-cloud-jobs.cases.ts")],
    cwd: join(import.meta.dir, "../.."),
    env: process.env,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(output)
  expect(output).toContain(" 10 pass")
  expect(output).toContain(" 0 fail")
})
