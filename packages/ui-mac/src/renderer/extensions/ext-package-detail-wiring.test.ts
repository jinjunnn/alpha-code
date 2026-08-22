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
  // `#765` 起 13:新增「整包卸载的具名 warning 也到得了用户面」那条。
  // `#771` 起 14:再加「那条 warning 是**常驻**的,不随 toast 计时消失」。
  // 这个数每次都是**先确认新用例真的跑起来了**才同步上来的 —— 反过来用它去确认新增,
  // 会在「块替换吞掉前一条 + 新增一条」时净数对上而两轮审计都看不见。
  expect(output).toContain(" 14 pass")
  expect(output).toContain(" 0 fail")
  expect(output).toMatch(/Ran 14 tests across 1 file/)
  // `#771`:显式 60s。子进程里那条常驻判据要**真的等过**一闪而过的窗口(4s),整批因此从
  // ~2.5s 涨到 ~7s,越过了 bun 默认的 5s ——「等过计时器」正是那条断言的全部内容,所以是
  // 期限跟着它走,不是它迁就期限。宽余量留给真实安装/事务在负载下的抖动。
}, 60_000)
