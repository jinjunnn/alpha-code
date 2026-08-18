import { expect, test } from "bun:test"
import path from "node:path"

// `#733`(REQ-130):`needs_auth` 的用户出口,整条链跑生产件。
//
// 独立进程:`.cases.ts` 里要在 `GlobalRegistrator.register()` 之后才动态 import 生产组件,
// 与仓内其他测试同进程会互相污染 Solid 的条件导出(server vs dom 构建)。
test("needs_auth 从引擎状态一路走到用户能点的按钮(真 useExtensions + 真 ExtensionHub)", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", path.resolve(import.meta.dir, "../../../test-component/mcp-needs-auth-wiring.cases.ts")],
    cwd: path.resolve(import.meta.dir, "../../.."),
    env: process.env,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(output)
  // 条数是**先确认新用例真的跑起来了**才写上来的。反过来用它去确认新增,会在
  // 「块替换吞掉一条 + 新增一条」时净数对上而看不见 —— `#765` 已经栽过。
  expect(output).toContain(" 9 pass")
  expect(output).toContain(" 0 fail")
  expect(output).toMatch(/Ran 9 tests across 1 file/)
})
