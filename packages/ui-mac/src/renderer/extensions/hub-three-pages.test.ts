import { expect, test } from "bun:test"
import path from "node:path"

// `#1594`(REQ-236 T18/T19):定制中心收成连接器 / 技能 / 助手三页,AC1–AC7 各一条具名判据。
//
// 独立进程:`.cases.ts` 里要在 `GlobalRegistrator.register()` 之后才动态 import 生产组件,
// 与仓内其他测试同进程会互相污染 Solid 的条件导出(server vs dom 构建)。
test("定制中心三页结构:页签、页头、列表行、「添加 ▾」、已安装与系统分段、缺什么直接说、默认关闭与待生效(真 useExtensions + 真 ExtensionHub)", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", path.resolve(import.meta.dir, "../../../test-component/hub-three-pages.cases.ts")],
    cwd: path.resolve(import.meta.dir, "../../.."),
    env: process.env,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(output)
  // 条数是先单跑 cases 文件确认 pass 数之后才写上来的:AC1–AC7 各一条(7);审计 r1 补「全部更新只管本页」与「菜单不重复开启」两条(9)。
  expect(output).toContain(" 9 pass")
  expect(output).toContain(" 0 fail")
  expect(output).toMatch(/Ran 9 tests across 1 file/)
})
