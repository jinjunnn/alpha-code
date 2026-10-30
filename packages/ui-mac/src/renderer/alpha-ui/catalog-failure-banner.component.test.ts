import { expect, test } from "bun:test"
import path from "node:path"

// #1084(#987 CHOICE=A)—— 子进程宿主:用例文件用 `mock.module("solid-js", …)` 换 dom 构建,
// 同进程会污染其它测试文件(与 draft-route-gate.component.test.ts 同因)。
//
// 判据主体在 `test-component/catalog-failure-banner.cases.ts`(真挂载生产 `ContractFailureBanner`,
// 喂 preload 桥替身,对真 DOM 断言)。这里只负责「那些用例真的跑了、且全绿」。
//
// #1557 起目录刷新失败不再走全局横幅,提示在输入框与选择器里(判据在 alpha-composer-model.cases.ts 的
// #1557 组);这道闸守全局层那一半:目录横幅不回来、模型目录契约不兼容不走全局契约横幅。反向验证记在用例文件抬头。
test(
  "#1557 模型目录刷新失败不在全局层(真组件用例)",
  () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "test",
        path.resolve(import.meta.dir, "../../../test-component/catalog-failure-banner.cases.ts"),
      ],
      cwd: path.resolve(import.meta.dir, "../../.."),
      env: process.env,
    })
    const output = `${result.stdout.toString()}${result.stderr.toString()}`
    if (result.exitCode !== 0) throw new Error(output)
    // 取回真实数字再比:`toContain("0 fail")` 会被 "10 fail" 满足。文件数一并核对,
    // 否则子进程匹配 0 个文件时「0 fail」是假绿。
    const fail = output.match(/(\d+) fail\b/)?.[1]
    const pass = Number(output.match(/(\d+) pass\b/)?.[1] ?? 0)
    expect({ fail, pass }).toEqual({ fail: "0", pass: 4 })
    expect(output.match(/Ran \d+ tests? across (\d+) files?/)?.[1]).toBe("1")
  },
  60_000,
)
