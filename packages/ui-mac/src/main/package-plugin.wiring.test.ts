// REQ-128 Phase 4 `#809` managed OpenCode Plugin 生产接线闸(子进程宿主)。
//
// 用例本体在 `test-component/package-plugin.wiring.cases.ts`:它要 mock `electron` 与
// `ext-transaction`,必须独占一个进程,否则 mock 会泄漏给同批其它文件。这里只负责把它跑起来、
// 把输出原样抬出来,并**钉住条数** —— 用例被删掉或悄悄跳过时,这条会红。
import { resolve } from "node:path"
import { expect, test } from "bun:test"

test("managed plugin 的安装图、落盘字节、alpha.jsonc 投影与整包卸载全部跑在生产 IPC 路径上", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", resolve(import.meta.dir, "../../test-component/package-plugin.wiring.cases.ts")],
    cwd: resolve(import.meta.dir, "../.."),
    env: process.env,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(output)
  expect(output).toMatch(/\b7 pass\b/)
  expect(output).toMatch(/\b0 fail\b/)
  expect(output).toMatch(/Ran 7 tests across 1 file/)
}, 300_000)
