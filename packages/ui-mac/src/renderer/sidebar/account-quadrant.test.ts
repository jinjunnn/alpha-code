// REQ-146(ac#1194):账户浮层「订阅×余额」四象限的组件端闸门入口。真实判据在
// packages/ui-mac/test-component/account-quadrant.cases.ts —— 生产 AlphaSidebar + 真路由 +
// 真点击,断言 chip 三态(免费版/按量付费/计划名)、未订阅时两行显示 summary.usage 真实
// 用量、未订阅且无余额时面板不新增提示行。
// 起子进程同 overlay-close.test.ts:cases 里的 mock.module 会污染同进程其它测试文件。

import { expect, test } from "bun:test"
import path from "node:path"

test(
  "账户浮层按「订阅×余额」四象限如实呈现(chip 三态 + 用量两行 + 无余额格静默)",
  () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "test", path.resolve(import.meta.dir, "../../../test-component/account-quadrant.cases.ts")],
      cwd: path.resolve(import.meta.dir, "../../.."),
      env: process.env,
    })
    const output = `${result.stdout.toString()}${result.stderr.toString()}`
    if (result.exitCode !== 0) throw new Error(output)
    expect(output.match(/(\d+) fail\b/)?.[1], output).toBe("0")
    expect(output.match(/(\d+) pass\b/)?.[1], output).toBe("5")
  },
  120_000,
)
