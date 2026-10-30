// REQ-237 `#1555` —— 远程目录刷新器的子进程宿主(AC2 触发点 / AC3 单飞与身份仲裁 / AC6 接口形状)。
// 判据在 catalog-refresher.cases.ts:它必须 mock electron,而 bun 的 mock.module 在同一进程内会泄漏到
// 后续测试文件,故整体隔离。本文件钉住子进程用例的精确条数 —— 少一条 = 有判据被删。
import { expect, test } from "bun:test"
import { join } from "node:path"

test("catalog refresher: triggers, single flight, identity arbitration and interface shape (#1555)", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", join(import.meta.dir, "catalog-refresher.cases.ts")],
    cwd: join(import.meta.dir, "../.."),
    env: process.env,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(output)
  expect(output).toContain("8 pass")
  expect(output).toContain("0 fail")
}, 120000)
