// REQ-128 Phase 4 `#809` wrapper 运行期 ABI 闸(子进程宿主)。
//
// 用例本体在 `test-component/managed-plugin-wrapper.cases.ts`,必须独占一个进程并**带着换过的
// `HOME`** 启动:它会真的 import 第三方那份 `plugin.js`,而它顶层就往 `~/.opencode-notify.log`
// 写盘(固定路径、从不轮换)。`os.homedir()` 在进程启动之后改 `process.env.HOME` 不生效,
// 所以换 home 只能发生在 spawn 这一层。这里同时**钉住条数** —— 用例被删或悄悄跳过时会红。
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, test } from "bun:test"

test("wrapper 的 default 形状、顶层零副作用与固定 canary 的 server() 返回值,全部在真 import 里验", () => {
  const home = mkdtempSync(join(tmpdir(), "req128-809-home-"))
  try {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "test", resolve(import.meta.dir, "../../test-component/managed-plugin-wrapper.cases.ts")],
      cwd: resolve(import.meta.dir, "../.."),
      env: { ...process.env, HOME: home, ALPHA_TEST_FAKE_HOME: home },
    })
    const output = `${result.stdout.toString()}${result.stderr.toString()}`
    if (result.exitCode !== 0) throw new Error(output)
    expect(output).toMatch(/\b8 pass\b/)
    expect(output).toMatch(/\b0 fail\b/)
    expect(output).toMatch(/Ran 8 tests across 1 file/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}, 300_000)
