// REQ-128 Phase 3 `[T1-intake]`(#780):生产接线闸的**宿主**。
//
// 判据本体在 `test-component/claude-plugin-intake.ipc.cases.ts` —— 它跑 `ext-ipc.ts` 里
// **已注册的那个** `ext-import-skill-folder` handler(不是直接调 `previewLocalClaudePlugin`),
// 并对「输入语料树 + 隔离的 alpha 根(`installs.json` 在其中)+ userData」三处做前后逐字节指纹。
//
// 为什么要开子进程:那套用例必须 `mock.module("electron", …)`,而 bun 的 module mock 是
// **进程级**的 —— 实测把它留在 `src/**` 里,同一次 `bun test src` 会连带打红 39 条别处的用例
// (MCP / plugin / governance…),而单跑它自己 0 fail。这与仓内既有
// `package-admission.wiring.test.ts` / `desktop-menu-publication.test.ts` 是同一条理由、同一种写法。

import { resolve } from "node:path"
import { expect, test } from "bun:test"

test("生产 ext-import-skill-folder 分流到本地插件预览,且这一次导入三处写面逐字节不变", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", resolve(import.meta.dir, "../../test-component/claude-plugin-intake.ipc.cases.ts")],
    cwd: resolve(import.meta.dir, "../.."),
    env: process.env,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(output)
  // 用例数写死:少一条就是有人把生产接线闸悄悄摘了一半,而 `0 fail` 照样成立。
  expect(output).toMatch(/\b11 pass\b/)
  expect(output).toMatch(/\b0 fail\b/)
}, 180_000)
