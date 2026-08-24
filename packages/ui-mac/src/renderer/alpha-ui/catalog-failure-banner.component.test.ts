import { expect, test } from "bun:test"
import path from "node:path"

// #1084(#987 CHOICE=A)—— 子进程宿主:用例文件用 `mock.module("solid-js", …)` 换 dom 构建,
// 同进程会污染其它测试文件(与 draft-route-gate.component.test.ts 同因)。
//
// 判据主体在 `test-component/catalog-failure-banner.cases.ts`(真挂载生产 `CatalogFailureBanner`,
// 喂 preload 桥替身,对真 DOM 断言)。这里只负责「那些用例真的跑了、且全绿」。
//
// 这道闸删掉会失去什么:平台目录刷新失败就只剩 main 侧的 IPC 证据(models-catalog-v2.wiring),
// 而 #1084 要的正是最后那一跳 —— renderer 真的把分类码渲染出来。三条反向验证记在用例文件抬头。
test(
  "#1084 平台目录刷新失败的 renderer 出口(真组件用例)",
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
    expect({ fail, pass }).toEqual({ fail: "0", pass: 3 })
    expect(output.match(/Ran \d+ tests? across (\d+) files?/)?.[1]).toBe("1")
  },
  60_000,
)
