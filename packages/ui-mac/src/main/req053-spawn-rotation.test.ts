// REQ-053 AC4 `#966` 生产接线闸的**宿主**。真判据在子进程,见 test-component/req053-spawn-rotation.cases.ts。
//
// 为什么必须起子进程:用例要 mock `electron` 但**不 mock `./logging`**(真 rotateServerLogs 要跑),
// 而 bun 的 `mock.module` 跨测试文件泄漏 —— 同进程再加一份 electron mock 会按执行顺序压过
// `src/main/server` 自己那套单测里的那一份,制造一批与本票无关的红。
//
// 条数写死在这里,是因为「子进程一条用例都没跑却 exit 0」时 `0 fail` 恒成立(本仓记过的假绿形态);
// `Ran N tests across 1 file` 与 `N pass` 一起断,才排得掉「跑了 0 个文件」。
import { resolve } from "node:path"
import { expect, test } from "bun:test"

test("spawnLocalServer really archives an oversized engine log before it forks the sidecar", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", resolve(import.meta.dir, "../../test-component/req053-spawn-rotation.cases.ts")],
    cwd: resolve(import.meta.dir, "../.."),
    env: process.env,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(output)
  expect(output).toMatch(/\b3 pass\b/)
  expect(output).toMatch(/\b0 fail\b/)
  expect(output).toMatch(/Ran 3 tests across 1 file/)
}, 120_000)
