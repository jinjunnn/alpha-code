// REQ-128 #712 生产接线闸(子进程跑,因为它要 mock electron 与整条 main 装载链)。
// 断言的是「崩溃恢复的生产接线真的会释放受限密钥版本」,不是「释放函数能用」——
// 判据:把 ext-ipc.ts 的 recoveryOpts 里 `releasePrepared:` 一行删掉,子进程内孤儿版本目录
// 原样留在盘上,本用例转红。
import { resolve } from "node:path"
import { expect, test } from "bun:test"

test("production crash recovery really releases the prepared secret version and spares the live one", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", resolve(import.meta.dir, "../../test-component/package-secret-recovery-wiring.cases.ts")],
    cwd: resolve(import.meta.dir, "../.."),
    env: process.env,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(output)
  expect(output).toMatch(/\b1 pass\b/)
  expect(output).toMatch(/\b0 fail\b/)
}, 120_000)
