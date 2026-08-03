// ADR-040(`#825`)扩展安装不得写引擎 `plugin[]` 的**生产接线**闸(子进程宿主)。
// 原为 REQ-128 Phase 4 `#809` 的 managed OpenCode Plugin 安装闸(8 条);那条路径已封死,
// 用例随之从「怎么装进去」换成「在哪一步、以什么理由停下」+ 对照组 + `@alpha-code/ext` 不受影响。
//
// 用例本体在 `test-component/package-plugin.wiring.cases.ts`:它要 mock `electron` 与
// `ext-transaction`,必须独占一个进程,否则 mock 会泄漏给同批其它文件。这里只负责把它跑起来、
// 把输出原样抬出来,并**钉住条数** —— 用例被删掉或悄悄跳过时,这条会红。
import { resolve } from "node:path"
import { expect, test } from "bun:test"

test("带 plugin 组件的包在生产 IPC 路径上被整包拒绝,对照组照常装成,alpha 自有 ext 不受影响", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", resolve(import.meta.dir, "../../test-component/package-plugin.wiring.cases.ts")],
    cwd: resolve(import.meta.dir, "../.."),
    env: process.env,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(output)
  expect(output).toMatch(/\b3 pass\b/)
  expect(output).toMatch(/\b0 fail\b/)
  expect(output).toMatch(/Ran 3 tests across 1 file/)
}, 300_000)
