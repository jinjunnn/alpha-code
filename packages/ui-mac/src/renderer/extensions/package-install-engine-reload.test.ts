// REQ-128 Phase 4 `#810`:签名 package / 套件安装路径收口到 `useExtensions` 并接引擎重扫。
//
// 独立进程运行(happy-dom + Solid DOM 构建 + 生产 main IPC 表),原因与
// `ext-package-detail-wiring.test.ts` 逐字相同:`GlobalRegistrator` 必须在任何会牵出
// solid-js 的模块之前注册,而 `bun test src` 的其余文件不该被这套全局污染。
import { expect, test } from "bun:test"
import path from "node:path"

// 超时给足:这条线里有真 admission、真事务、真账本落盘与两次真 legacy planner 安装。
// bun 默认 5s 会把它变成一条**间歇性**红 —— 而间歇红比没有闸更贵。
test("REQ-128 `#810` 三个生产安装入口经同一个 useExtensions 方法出站并接引擎重扫", { timeout: 180_000 }, () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", path.resolve(import.meta.dir, "../../../test-component/package-install-engine-reload.cases.ts")],
    cwd: path.resolve(import.meta.dir, "../../.."),
    env: process.env,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(output)
  // 这个数**先确认新用例真的跑起来了**才同步上来 —— 反过来用它去确认新增,会在
  // 「块替换吞掉前一条 + 新增一条」时净数对上而两轮审计都看不见。
  expect(output).toContain(" 5 pass")
  expect(output).toContain(" 0 fail")
  expect(output).toMatch(/Ran 5 tests across 1 file/)
})
