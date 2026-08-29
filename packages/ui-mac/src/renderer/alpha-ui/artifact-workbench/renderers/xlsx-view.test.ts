// REQ-123(#1176)—— xlsx 表格呈现:组件用例驱动器 + 源级 ratchet。
// 组件行为判据在 test-component/xlsx-view.cases.ts(真 Solid + happy-dom);
// 这里另钉基线③的两条不变量的减速带(如实标注:防误开,不防恶意实现,真闸在 #1174/#1177):
//   · 模型/视图不得自己做「字节 → 文档」、不得触 IO 面(fetch / window.api / zip);
//   · 视图零 innerHTML / iframe 注入路径。

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const modelSource = readFileSync(join(import.meta.dir, "xlsx-model.ts"), "utf8")
const viewSource = readFileSync(join(import.meta.dir, "xlsx-view.tsx"), "utf8")

describe("REQ-123 AC2 xlsx view real Solid mount", () => {
  test("component cases run green in a real Solid+happy-dom mount", () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "test", resolve(import.meta.dir, "../../../../../test-component/xlsx-view.cases.ts")],
      cwd: resolve(import.meta.dir, "../../../../.."),
      env: process.env,
    })
    const output = `${result.stdout.toString()}${result.stderr.toString()}`
    if (result.exitCode !== 0) throw new Error(output)
    const fail = output.match(/(\d+) fail\b/)?.[1]
    const pass = Number(output.match(/(\d+) pass\b/)?.[1] ?? 0)
    expect({ fail, ran: pass > 0 }).toEqual({ fail: "0", ran: true })
  })
})

describe("REQ-123 基线③ 减速带(误开检测,不替代 #1174 的闸)", () => {
  test("模型是纯函数:不解析字节、不触 IO、不解 zip", () => {
    const forbidden = ["DOMParser", "parseFromString", "fetch", "window.api", "@zip.js", "DecompressionStream", "XMLHttpRequest", "innerHTML"]
    const offenders = forbidden.filter((token) => modelSource.includes(token))
    expect(offenders).toEqual([])
  })

  test("视图只经 Solid 文本节点呈现:零 innerHTML / iframe / IO", () => {
    const forbidden = [".innerHTML", "<iframe", "dangerously", "window.api", "fetch(", "DOMParser"]
    const offenders = forbidden.filter((token) => viewSource.includes(token))
    expect(offenders).toEqual([])
  })
})
