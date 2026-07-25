// REQ-109 #595 的 main 侧闸门在子进程里跑:cases 文件必须 mock electron,而 bun 的 mock.module
// 在同一进程内会泄漏到后续测试文件(教训在案),故整体隔离。
import { expect, test } from "bun:test"
import { join } from "node:path"

test("effective catalog 失败域隔离 + BYOK 目录主权(#595 退出条件 4/5)", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", join(import.meta.dir, "alpha-platform-catalog.cases.ts")],
    cwd: join(import.meta.dir, "../.."),
    env: process.env,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(output)
  expect(output).toContain("5 pass")
  expect(output).toContain("0 fail")
})
