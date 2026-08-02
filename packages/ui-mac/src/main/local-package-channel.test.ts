// REQ-128 Phase 3 `[T3-channel]`(#782):两段式通道的生产闸。
//
// 子进程跑,理由与 `package-admission.wiring.test.ts` 逐字相同:这些用例要 `mock.module`
// 掉 electron 与安装端口,再 `await import` 真的 `ext-ipc` —— 模块图必须干净地只建一次。
// (顺序纪律:`await import("../src/main/*")` 必须排在 `mock.module("electron", …)` **之后**,
//  否则真 electron 会被拉起来。)
import { resolve } from "node:path"
import { expect, test } from "bun:test"

test("生产 IPC 上的 preview→confirm 绑定(G6)与 preview 预算/释放(G19)", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", resolve(import.meta.dir, "../../test-component/local-package-channel.cases.ts")],
    cwd: resolve(import.meta.dir, "../.."),
    env: process.env,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(output)
  // 用词边界而非 toContain:`"20 pass"` 含 `"0 pass"`,子串匹配会在用例数增减时假绿。
  expect(output).toMatch(/\b20 pass\b/)
  expect(output).toMatch(/\b0 fail\b/)
  // 「跑了几个文件、几条用例」也要断言:子进程若因夹具报错跑了 0 条,上面两条**都不会**红
  //  —— `0 fail` 恒成立。测不到就该说测不到,不是给一个好看的数字。
  expect(output).toMatch(/Ran 20 tests across 1 file/)
}, 180_000)

test("`local:` 命名空间双向闸(G8)与已装包只读投影的来源维", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", resolve(import.meta.dir, "../../test-component/local-package-namespace.cases.ts")],
    cwd: resolve(import.meta.dir, "../.."),
    env: process.env,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(output)
  expect(output).toMatch(/\b5 pass\b/)
  expect(output).toMatch(/\b0 fail\b/)
  expect(output).toMatch(/Ran 5 tests across 1 file/)
}, 180_000)
