import { expect, test } from "bun:test"
import { join } from "node:path"

// #420:子进程跑 cloud-job-notify.cases.ts(mock.module("electron") 会污染同进程的其它测试文件;
// cloud-ipc.test.ts / app-version-ipc.wiring.test.ts 同款宿主)。
test("#420 云任务终态 → 系统通知的接线(SSE sink 与 cloud-save-run 状态查询两路,取消不通知,同终态只一次)", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", join(import.meta.dir, "cloud-job-notify.cases.ts")],
    cwd: join(import.meta.dir, "../.."),
    env: process.env,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(output)
  // 真实数字判据:fail 恰为 0 且 pass 恰为 8(cases 里的用例数;少了 = 有用例被删)。
  expect(output.match(/(\d+) fail\b/)?.[1], output).toBe("0")
  expect(output.match(/(\d+) pass\b/)?.[1], output).toBe("8")
})
