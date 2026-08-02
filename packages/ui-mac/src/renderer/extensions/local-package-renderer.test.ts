// REQ-128 Phase 3 `[T4-renderer]`(`#784`):整条用户可达竖线的九跳闸。
//
// 独立进程运行(happy-dom + Solid DOM 构建 + 生产 main IPC 表),原因与
// `ext-package-detail-wiring.test.ts` 逐字相同:GlobalRegistrator 必须在任何会牵出
// solid-js 的模块之前注册,而 `bun test src` 的其余文件不该被这套全局污染。
import { expect, test } from "bun:test"
import path from "node:path"

// 超时给足:这条线里有真事务、真 CAS 提升、真账本落盘,本机实测约 7s。
// bun 默认 5s 会把它变成一条**间歇性**红 —— 而间歇红比没有闸更贵:它训练人忽略这道门。
test("REQ-128 Phase 3 第 1→9 跳在生产 renderer × 生产 main 上端到端可达", { timeout: 180_000 }, () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", path.resolve(import.meta.dir, "../../../test-component/local-package-renderer.cases.ts")],
    cwd: path.resolve(import.meta.dir, "../../.."),
    env: process.env,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(output)
  // 这个数**先确认新用例真的跑起来了**才同步上来 —— 反过来用它去确认新增,会在
  // 「块替换吞掉前一条 + 新增一条」时净数对上而两轮审计都看不见。
  expect(output).toContain(" 15 pass")
  expect(output).toContain(" 0 fail")
  expect(output).toMatch(/Ran 15 tests across 1 file/)
})
