// #660 A1:cloud-run-saved 广播接线闸门。真断言在 cloud-ipc.cases.ts ——
// 子进程跑(alpha-auth.test.ts 同款),因为 mock.module("electron") 会污染同进程的其它测试文件。
import { expect, test } from "bun:test"
import { join } from "node:path"

test("cloud-ipc broadcast cases run green in an isolated child process", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", join(import.meta.dir, "cloud-ipc.cases.ts")],
    cwd: join(import.meta.dir, "../.."),
    env: process.env,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(output)
  expect(output).toContain(" 3 pass")
  expect(output).toContain(" 0 fail")
})
