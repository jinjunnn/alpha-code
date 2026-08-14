// REQ-053 AC1 `#966` 生产接线闸的**宿主**。真判据在子进程,见 test-component/req053-clear-wiring.cases.ts。
//
// 为什么必须起子进程:用例要 mock `electron` / `./logging` / `./alpha-auth` / `./alpha-environment`,
// 而 bun 的 `mock.module` **跨测试文件泄漏**(仓内两次实锤)—— 同进程注册这些会按执行顺序压过
// 别的文件的 mock,制造一批与本票无关的红,而那批红看起来像「我改坏了什么」。
//
// 条数写死在这里,是因为「子进程一条用例都没跑却 exit 0」时 `0 fail` 恒成立(本仓记过的假绿形态)。
import { resolve } from "node:path"
import { expect, test } from "bun:test"

test("createDataClearAction really sweeps the dangling refs before logout() and before app.exit(0)", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", resolve(import.meta.dir, "../../test-component/req053-clear-wiring.cases.ts")],
    cwd: resolve(import.meta.dir, "../.."),
    env: process.env,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(output)
  expect(output).toMatch(/\b5 pass\b/)
  expect(output).toMatch(/\b0 fail\b/)
  expect(output).toMatch(/Ran 5 tests across 1 file/)
}, 120_000)
