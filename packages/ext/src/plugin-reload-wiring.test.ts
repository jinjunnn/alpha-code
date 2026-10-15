// REQ-234 `#1531`:宿主 —— 在子进程里跑 plugin-reload-wiring.cases.ts(理由见那个文件的抬头:parentPort 必须在插件模块
// 装载之前就在,同进程的别的测试早已把它装成没有 port 的那一份)。
import { expect, test } from "bun:test"
import path from "node:path"

test("plugin.ts 模块作用域接线:parentPort → 调度器 → 本实例 → 报告(子进程)", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", path.resolve(import.meta.dir, "plugin-reload-wiring.cases.ts")],
    cwd: path.resolve(import.meta.dir, ".."),
    env: process.env,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(output)
  expect(output).toMatch(/\b1 pass\b/)
  expect(output).toMatch(/\b0 fail\b/)
}, 60_000)
