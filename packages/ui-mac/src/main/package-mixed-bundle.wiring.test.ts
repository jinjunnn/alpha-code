// REQ-128 `#697` canonical mixed Bundle 的生产接线闸(子进程宿主)。
//
// 用例本体在 `test-component/package-mixed-bundle.wiring.cases.ts`:它要 mock `electron` 与
// `ext-transaction`,必须独占一个进程,否则 mock 会泄漏给同批其它文件。这里只负责把它跑起来、
// 把输出原样抬出来,并**钉住条数** —— 用例被删掉或悄悄跳过时,这条会红。
import { resolve } from "node:path"
import { expect, test } from "bun:test"

test("mixed Bundle activation, named faults, and the crash matrix all run through the production IPC path", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", resolve(import.meta.dir, "../../test-component/package-mixed-bundle.wiring.cases.ts")],
    cwd: resolve(import.meta.dir, "../.."),
    env: process.env,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(output)
  // `#828`:3 → 6(「单文件技能仍装得上」「整包卸载删掉每一个文件」「逃逸路径零写入」)。
  // `#817`:6 → 7(「signed package child 在生产启停通道上拨开 + catalog 漂移 fail-closed」)。
  expect(output).toMatch(/\b7 pass\b/)
  expect(output).toMatch(/\b0 fail\b/)
  expect(output).toMatch(/Ran 7 tests across 1 file/)
}, 300_000)
