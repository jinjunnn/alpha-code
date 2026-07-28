import { expect, test } from "bun:test"
import path from "node:path"

// #594/#577:use-projects 的 generation 恢复语义(有界自探 / failed 终态 / provisional
// 刷新 / replay 单调性 / composer 链唤醒 / 真实「立即重试」按钮)需要真实 Solid 客户端
// 构建 + happy-dom,与其他测试缓存的 server 条件导出互斥,故与
// alpha-composer-model.component.test.ts 同构地在独立进程运行。
// REQ-126 CODE-C(#656)追加 2 例:①`ensureDefaultWorkspace` 必须如实回报 `{ok:false}` ——
// 侧栏的「ensure 失败就不建 draft」全靠这个返回值,而这条 IPC 不 throw,try/catch 看不见它;
// ②默认目录**查询**失败不得连坐普通项目的会话创建(两次 IPC 的失败必须分开处理)。
// 行为断言全部在 cases 文件内;本包装只核对「全部用例都跑了且零失败」——
// bun test 对通过用例不输出逐条行,计数 + 退出码是包装层能拿到的最强信号。
test("use-projects generation 恢复语义(#594/#577,R1 加固后 8 例)+ REQ-126 供给回报(2 例)", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", path.resolve(import.meta.dir, "../../../test-component/use-projects.cases.ts")],
    cwd: path.resolve(import.meta.dir, "../../.."),
    env: process.env,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(output)
  expect(output).toContain(" 10 pass")
  expect(output).toContain(" 0 fail")
  expect(output).toMatch(/Ran 10 tests across 1 file/)
})
