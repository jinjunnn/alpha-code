import { expect, test } from "bun:test"
import path from "node:path"

// 子进程跑:用例文件用 mock.module 顶替 `@opencode-ai/app` / `@solidjs/router` / providers,
// 同进程会污染其它测试文件(与 alpha-composer-model.component.test.ts 同因)。
test(
  "REQ-126 CODE-D 新对话页工作区选择器与切目录内容保护的真组件用例",
  () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "test",
        path.resolve(import.meta.dir, "../../../test-component/new-session-workspace.cases.ts"),
      ],
      cwd: path.resolve(import.meta.dir, "../../.."),
      env: process.env,
    })
    const output = `${result.stdout.toString()}${result.stderr.toString()}`
    if (result.exitCode !== 0) throw new Error(output)
    // 判据只有「子进程绿」:钉总数会在别人合法新增一条用例时误红,而 `toContain("0 fail")`
    // 反过来能被 "10 fail" 匹配上 —— 取回真实数字再比,并要求至少跑过一条。
    const fail = output.match(/(\d+) fail\b/)?.[1]
    const pass = Number(output.match(/(\d+) pass\b/)?.[1] ?? 0)
    expect({ fail, ran: pass > 0 }).toEqual({ fail: "0", ran: true })
  },
  60_000,
)
