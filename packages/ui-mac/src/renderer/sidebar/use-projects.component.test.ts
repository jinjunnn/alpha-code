import { expect, test } from "bun:test"
import path from "node:path"

// #594/#577:use-projects 的 generation 恢复语义(有界自探 / failed 终态 / 现值重放)
// 需要真实 Solid 客户端构建 + happy-dom,与其他测试缓存的 server 条件导出互斥,
// 故与 alpha-composer-model.component.test.ts 同构地在独立进程运行。
test("use-projects generation 恢复语义(#594/#577)", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", path.resolve(import.meta.dir, "../../../test-component/use-projects.cases.ts")],
    cwd: path.resolve(import.meta.dir, "../../.."),
    env: process.env,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(output)
  expect(output).toContain("4 pass")
  expect(output).toContain("0 fail")
})
