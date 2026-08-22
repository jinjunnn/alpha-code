import { expect, test } from "bun:test"
import path from "node:path"

// alpha-code #903 —— 子进程宿主:用例文件用 `mock.module("solid-js", …)` 换 dom 构建,
// 同进程会污染其它测试文件(与 new-session-workspace.component.test.ts 同因)。
//
// 判据主体在 `test-component/draft-route-gate.cases.ts`(真挂载 packages/app 的生产守卫模块,
// 断言真 DOM 与真回调)。这里只负责「那些用例真的跑了、且全绿」。
test(
  "#903 /new-session 非法 draft 与水合中的真组件用例",
  () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "test", path.resolve(import.meta.dir, "../../../test-component/draft-route-gate.cases.ts")],
      cwd: path.resolve(import.meta.dir, "../../.."),
      env: process.env,
    })
    const output = `${result.stdout.toString()}${result.stderr.toString()}`
    if (result.exitCode !== 0) throw new Error(output)
    // 取回真实数字再比:`toContain("0 fail")` 会被 "10 fail" 满足。文件数一并核对,
    // 否则子进程匹配 0 个文件时「0 fail」是假绿。
    const fail = output.match(/(\d+) fail\b/)?.[1]
    const pass = Number(output.match(/(\d+) pass\b/)?.[1] ?? 0)
    expect({ fail, ran: pass > 0 }).toEqual({ fail: "0", ran: true })
    expect(output.match(/Ran \d+ tests? across (\d+) files?/)?.[1]).toBe("1")
  },
  60_000,
)
