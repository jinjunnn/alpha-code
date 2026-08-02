// REQ-128 Phase 3 `[T5-verify]`(#783):本地导入矩阵回归夹具的**宿主**。
//
// 判据本体在 `test-component/claude-plugin-import-matrix.cases.ts`。为什么是子进程 + 写死
// 用例数(与仓内 `package-admission.wiring.test.ts` / `claude-plugin-intake.ipc.test.ts` 同形):
// 这份用例的价值全在**成员集与口径**上,而「悄悄删掉一条」照样是 `0 fail`。
// 把用例数钉死,少一条就变红。
import { resolve } from "node:path"
import { expect, test } from "bun:test"

test("真实语料三个合成数字 + `.bak` 同待 + G18 真实实例 + 六处恒真式登记", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", resolve(import.meta.dir, "../../test-component/claude-plugin-import-matrix.cases.ts")],
    cwd: resolve(import.meta.dir, "../.."),
    env: process.env,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(output)
  expect(output).toMatch(/\b13 pass\b/)
  expect(output).toMatch(/\b0 fail\b/)
}, 180_000)
