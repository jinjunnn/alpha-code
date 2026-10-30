// REQ-237 `#1556` —— BYOK 预置目录采纳规则(方案 docs/design/req236-catalog-and-model.md §2.3 规则 1–5)的子进程宿主。
// 判据在 byok-catalog-adopt.cases.ts:被测的纯函数 adoptByokCatalog 住在 catalog-refresher.ts(方案指定),那个模块
// 一 import 就拖入 electron,而 bun 的 mock.module 在同一进程内会泄漏到后续测试文件,故整体隔离。
// 本文件钉住子进程用例的精确条数 —— 少一条 = 有判据被删。
import { expect, test } from "bun:test"
import { join } from "node:path"

test("BYOK catalog adoption: envelope, version, unknown provider, option keys, bundled bootstrap (#1556)", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", join(import.meta.dir, "byok-catalog-adopt.cases.ts")],
    cwd: join(import.meta.dir, "../.."),
    env: process.env,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(output)
  expect(output).toMatch(/^\s*7 pass\s*$/m)
  expect(output).toMatch(/^\s*0 fail\s*$/m)
}, 60000)
