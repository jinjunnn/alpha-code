// REQ-125 #579 —— 子进程宿主:在 solid 的 **dom** 构建下跑 `terminal-command.cases.ts`。
//
// 为什么要子进程:`packages/app` 的单测 lane(package.json `test:unit`,以及
// scripts/bun-test-app.sh 逐字镜像的那条)**不带** `--conditions=browser` ⇒ solid 的
// exports map 走 `node` 条件 ⇒ `dist/server.js` ⇒ 真 `createWorkspaceTerminalSession`
// 在 `utils/persist.ts` 的 `createResource` 处直接抛(`getNextContextId cannot be used
// under non-hydrating context`)。判据的核心恰恰是「必须跑真的生产写入路径」,所以不能
// 靠 mock 掉 `@/utils/persist` 或退回只调 `migrateTerminalState` 来绕开 —— 那两条退路
// 会把「只改 alpha 投影层、上游 store 一字未动」的错误实现全绿放行。
// 形态同 packages/ui-mac 的 `*.cases.ts` 子进程宿主(terminal-engine-adapter.test.ts)。
//
// 条数取真实数字再比较,不用 `toContain("4 pass")`:后者会被 `"14 pass"` 满足 —— 这道
// 断言本身就是 cases 文件的登记簿,粗一格就守不住自己。
import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"

const CASES = resolve(import.meta.dir, "terminal-command.cases.ts")
const APP_ROOT = resolve(import.meta.dir, "../..")

describe("REQ-125 #579 terminal command cases run green under the real solid dom build", () => {
  test("the workspace terminal store keeps the server-reported command (4 cases, subprocess)", () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "test", "--conditions=browser", "--preload", "./happydom.ts", CASES],
      cwd: APP_ROOT,
      env: process.env,
    })
    const output = `${result.stdout.toString()}${result.stderr.toString()}`
    if (result.exitCode !== 0) throw new Error(output)
    expect(output.match(/(\d+) pass\b/)?.[1]).toBe("4")
    expect(output.match(/(\d+) fail\b/)?.[1]).toBe("0")
    // 「跑了 0 条」恒 0 fail —— 文件数也要核对,否则子进程匹配 0 个文件时这条是假绿。
    expect(output.match(/Ran (\d+) tests? across (\d+) files?/)?.slice(1, 3)).toEqual(["4", "1"])
  })
})
