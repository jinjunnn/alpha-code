// #1113(REQ-092 AC1 桌面消费侧)—— status/artifact-list 开放 `result` 清洗接线闸的子进程宿主。
// 真断言在 cloud-result-scrub.cases.ts(须 mock electron ⇒ mock.module 会污染同进程的其它
// 测试文件,子进程跑,cloud-ipc.test.ts 同款)。
import { expect, test } from "bun:test"
import { join } from "node:path"

test("cloud result scrub cases run green in an isolated child process", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", join(import.meta.dir, "cloud-result-scrub.cases.ts")],
    cwd: join(import.meta.dir, "../.."),
    env: process.env,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(output)
  expect(output).toContain(" 3 pass")
  expect(output).toContain(" 0 fail")
})
