// [ac#1207] REQ-147:更新状态呈现的组件端闸门入口。真实判据在
// packages/ui-mac/test-component/updater-surface.cases.ts —— 生产 AlphaSidebar + 真路由 +
// 真点击:AC1(主动检查后五状态可见文案互不相同)、AC2(订阅回放 ready 即见安装入口且可点)、
// 反例(未主动检查时 up-to-date 不常亮)。
// 起子进程同 account-version.test.ts:cases 里的 mock.module 会污染同进程其它测试文件。

import { expect, test } from "bun:test"
import path from "node:path"

test(
  "footer 更新条:AC1 五状态呈现互不相同 / AC2 ready 回放即见安装入口 / up-to-date 不常亮",
  () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "test", path.resolve(import.meta.dir, "../../../test-component/updater-surface.cases.ts")],
      cwd: path.resolve(import.meta.dir, "../../.."),
      env: process.env,
    })
    const output = `${result.stdout.toString()}${result.stderr.toString()}`
    if (result.exitCode !== 0) throw new Error(output)
    expect(output.match(/(\d+) fail\b/)?.[1], output).toBe("0")
    expect(output.match(/(\d+) pass\b/)?.[1], output).toBe("3")
  },
  120_000,
)
