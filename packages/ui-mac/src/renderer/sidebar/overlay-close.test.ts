// REQ-126 AC2(#655)覆盖层随导航关闭闸门的入口。
//
// 真实判据在 packages/ui-mac/test-component/overlay-close.cases.ts —— 那里挂生产 AlphaSidebar +
// 生产 ExtensionHub/AutomationPanel + 真 @solidjs/router,对「每个已登记覆盖层 × 每类导航路径」
// 参数化断言覆盖层 DOM 消失。之所以起子进程而不是就地跑:cases 里的 mock.module 会把 solid 实例、
// 上游 ui 组件与 SDK 传输层整个换成替身,同进程会污染 `bun test src` 里其它文件 —— 仓内既有的
// 组件级用例(test-component/*.cases.ts)同因同法。
//
// 这不是「把主判据委派给另一个已登记测试」那种形态:本文件**直接执行**判据(子进程跑不起来、
// 或 cases 文件被删,spawn 非零退出即红),所以登记簿里 delegates_to = `-`。
//
// 本文件不只看"子进程绿":还钉住**跑过的用例条数下界**。否则删掉矩阵里的某一格
// (比如"点当前正在看的那个会话"——本票的核心缺口)子进程照样 0 fail,闸门静默变窄。
//
// 下界必须**等于**当前条数,不能留余量(#655 审计 Major):留 2 条余量时,删一格 → 15、
// 删整条导航路径 → 14,两者都仍 ≥ 下界,棘轮形同虚设。合法**新增**用例不会因此误红
// (只判 ≥),而删任何一条现有用例立刻红。新增用例时同步上调这个数。

import { expect, test } from "bun:test"
import path from "node:path"

/** 2 条前提自检 + 2 覆盖层 × 7 导航路径 = 16。等于实际条数,不留余量(见抬头)。 */
const CASE_FLOOR = 16

test(
  "覆盖层随导航关闭:真实宿主 × 真实点击的参数化矩阵",
  () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "test", path.resolve(import.meta.dir, "../../../test-component/overlay-close.cases.ts")],
      cwd: path.resolve(import.meta.dir, "../../.."),
      env: process.env,
    })
    const output = `${result.stdout.toString()}${result.stderr.toString()}`
    if (result.exitCode !== 0) throw new Error(output)
    // 取回真实数字再比:`toContain("0 fail")` 会被 "10 fail" 匹配上,而钉死总数会在别人合法
    // 新增一格时误红 —— 所以判据是「fail 恰为 0」+「pass 不低于矩阵下界」。
    const fail = output.match(/(\d+) fail\b/)?.[1]
    const pass = Number(output.match(/(\d+) pass\b/)?.[1] ?? 0)
    expect({ fail, enough: pass >= CASE_FLOOR }, output).toEqual({ fail: "0", enough: true })
  },
  120_000,
)
