import { expect, test } from "bun:test"
import path from "node:path"

// REQ-236 `#1553` —— 子进程宿主:用例文件用 `mock.module("solid-js", …)` 换 dom 构建,同进程会污染其它测试文件。
// 判据主体在 `test-component/attachment-cards.cases.ts`(真挂载生产附件卡,对真 DOM 断言)。这里只负责「那些用例真的跑了、且全绿」。
test(
  "#1553 附件卡:读取路径标签随引擎能力与登录状态变化、发送前拒绝、读取结果与重新读取(真组件用例)",
  () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "test", path.resolve(import.meta.dir, "../../../test-component/attachment-cards.cases.ts")],
      cwd: path.resolve(import.meta.dir, "../../.."),
      env: process.env,
    })
    const output = `${result.stdout.toString()}${result.stderr.toString()}`
    if (result.exitCode !== 0) throw new Error(output)
    // 取回真实数字再比:`toContain("0 fail")` 会被 "10 fail" 满足;文件数一并核对,子进程匹配 0 个文件时「0 fail」是假绿。
    const fail = output.match(/(\d+) fail\b/)?.[1]
    const pass = Number(output.match(/(\d+) pass\b/)?.[1] ?? 0)
    expect({ fail, pass }).toEqual({ fail: "0", pass: 3 })
    expect(output.match(/Ran \d+ tests? across (\d+) files?/)?.[1]).toBe("1")
  },
  60_000,
)
