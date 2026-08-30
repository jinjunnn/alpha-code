// ac#1187:账户浮层版本行的组件端闸门入口。真实判据在
// packages/ui-mac/test-component/account-version.cases.ts —— 生产 AlphaSidebar + 真路由 +
// 真点击,断言浮层 DOM 里出现 preload 桥给的哨兵版本号(登录/登出两分支)。
// 起子进程同 overlay-close.test.ts:cases 里的 mock.module 会污染同进程其它测试文件。

import { expect, test } from "bun:test"
import path from "node:path"

test(
  "账户浮层显示当前版本号(取值来自 window.api.appVersion,登录/登出两分支)",
  () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "test", path.resolve(import.meta.dir, "../../../test-component/account-version.cases.ts")],
      cwd: path.resolve(import.meta.dir, "../../.."),
      env: process.env,
    })
    const output = `${result.stdout.toString()}${result.stderr.toString()}`
    if (result.exitCode !== 0) throw new Error(output)
    expect(output.match(/(\d+) fail\b/)?.[1], output).toBe("0")
    expect(output.match(/(\d+) pass\b/)?.[1], output).toBe("2")
  },
  120_000,
)
