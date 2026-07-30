// REQ-127 #681 / ADR-039 §4 —— 生产 wiring 闸门的 runner。
//
// 真判据在 models-catalog-v2.wiring.cases.ts,子进程里跑:那个文件必须 mock electron 才能拿到
// 生产 `registerModelsIpcHandlers` 注册的两个 handler,而 bun 的 mock.module 在同一进程内会泄漏到
// 后续测试文件(教训在案)。本文件**直接执行**判据并钉住子进程用例条数下界 —— 不是委派。
//
// 这道闸删掉会失去什么:V1→V2 硬切就只剩类型与 fixture 层的证据,而 ADR-039 §4 明确说那不够 ——
// 判据必须从真实 IPC 用户入口出发。子进程里有一条**持久 negative gate**(V1 响应 → 无 basis、
// 无 pricing、contract-health 亮),把 alpha-platform-models.ts 的 decodeJsonContract 改回
// ModelCatalogV1 会让本闸变红;2026-07-29 实测过一次(docs/verification/2026-07-29-req127-681-v2-cutover/)。
import { expect, test } from "bun:test"
import { join } from "node:path"

test("production IPC refreshes through the V2 fetch decoder and returns the persisted projection", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", join(import.meta.dir, "models-catalog-v2.wiring.cases.ts")],
    cwd: join(import.meta.dir, "../.."),
    env: process.env,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(output)
  expect(output).toContain("7 pass")
  expect(output).toContain("0 fail")
})
