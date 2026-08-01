// REQ-128 #705 production wiring gate（子进程跑,因为它要 mock electron 与整条 main 装载链）。
// 断言的是「生产路径真的经过 builders 与 probe router」,不是「builders 能用」——
// 判据:把 package-admission 的 builder 调用换回内联、或把 ext-ipc 的 recoveryOpts.probe 换回
// 手写组合,子进程内的计数即归零,本用例转红。
import { resolve } from "node:path"
import { expect, test } from "bun:test"

test("single-install and recovery both really go through the builders and the health probe router", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", resolve(import.meta.dir, "../../test-component/package-builders-wiring.cases.ts")],
    cwd: resolve(import.meta.dir, "../.."),
    env: process.env,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(output)
  expect(output).toMatch(/\b4 pass\b/)
  expect(output).toMatch(/\b0 fail\b/)
}, 120_000)
