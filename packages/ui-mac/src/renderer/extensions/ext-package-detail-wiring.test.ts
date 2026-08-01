import { expect, test } from "bun:test"
import path from "node:path"

test("package safe view and admission traverse the production ExtensionHub card and ExtensionDetail paths", () => {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "test",
      path.resolve(import.meta.dir, "../../../test-component/ext-package-detail-wiring.cases.ts"),
    ],
    cwd: path.resolve(import.meta.dir, "../../.."),
    env: process.env,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(output)
  // `#765` 起 13:新增「整包卸载的具名 warning 也到得了用户面」那条。这个数是**先确认新用例
  // 真的跑起来了**才同步上来的 —— 反过来用它去确认新增,会在「块替换吞掉前一条 + 新增一条」
  // 时净数对上而两轮审计都看不见。
  expect(output).toContain(" 13 pass")
  expect(output).toContain(" 0 fail")
  expect(output).toMatch(/Ran 13 tests across 1 file/)
})
