// #918:桌面派发的信封在 alpha-platform 诚实门下的可达性闸门。真断言在 cloud-dispatch-gate.cases.ts ——
// 子进程跑(alpha-cloud-jobs.test.ts 同款),因为 mock.module("./alpha-auth" 等)与替换 globalThis.fetch
// 会污染同进程的其它测试文件。
//
// 「6 pass」这个数字本身也是判据:批量跑测试最贵的假绿是**一条都没跑而 0 fail 恒成立**
// (CLAUDE.md《观测手段自己有盲区》)。所以这里核对条数,不只核对 0 fail。
import { expect, test } from "bun:test"
import { join } from "node:path"

test("cloud dispatch gate cases run green in an isolated child process", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", join(import.meta.dir, "cloud-dispatch-gate.cases.ts")],
    cwd: join(import.meta.dir, "../.."),
    env: process.env,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(output)
  expect(output).toContain(" 6 pass")
  expect(output).toContain(" 0 fail")
})
