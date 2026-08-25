// REQ-105(#319):详情页头部的「执行物 digest」判据必须在真 Solid DOM 上跑,所以它住在独立进程
// (`test-component/receipt-artifact-display.cases.ts`)—— 与本仓其它组件级用例同因同法:
// 本文件里静态 import 任何牵出 solid 的东西,会让整个测试文件拿到 server 构建。

import { expect, test } from "bun:test"
import path from "node:path"

test("the production ExtensionDetail header states the recorded artifact digest, or says it is not recorded", () => {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "test",
      path.resolve(import.meta.dir, "../../../test-component/receipt-artifact-display.cases.ts"),
    ],
    cwd: path.resolve(import.meta.dir, "../../.."),
    env: process.env,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(output)
  // 计数按本仓纪律钉死:先确认新用例真的跑起来了才把数字同步上来。只判「0 fail」会让
  // 「一个都没跑」直接读成通过(本机陷阱:跑了 0 条时 0 fail 恒成立)。
  expect(output).toContain(" 4 pass")
  expect(output).toContain(" 0 fail")
  expect(output).toMatch(/Ran 4 tests across 1 file/)
}, 60_000)
