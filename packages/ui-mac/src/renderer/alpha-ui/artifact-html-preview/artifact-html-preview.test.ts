// #907 —— 隔离 HTML 预览「诚实呈现被阻断资源 + 显式带出出口」的宿主闸。
//
// 三半场,各自钉不同的东西:
//   ① 行为(子进程真 Solid 挂载):被阻断清单真的到得了界面、计数诚实、复制必须由用户按;
//   ② 渲染侧通道白名单(集合等式):修 UI 时不许顺手给组件开一条 openExternal/openPath/shell
//      之类的外开通道 —— 存在性+黑名单不是白名单,未列通道会溜过去;
//   ③ main 侧只读面的两条锚(safeOrigin 仍只记 origin、记录上限只有一份真源):五条拦截
//      策略本身的行为判据**不在本文件复述** —— 它们由 delegates_to 点名的
//      packages/ui-mac/src/main/html-preview-host.test.ts 执行,该文件已按精确条数登记进
//      scripts/gate-files.tsv,删掉其中任何一条用例登记簿即红。复述一遍只会制造第二份真源。

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const component = readFileSync(join(import.meta.dir, "ArtifactHtmlPreview.tsx"), "utf8")
// 禁词扫描只看**代码**:注释里出现 `innerHTML`/`iframe` 恰恰是在说明「我们不用它」,
// 拿散文当判据会把一份正确的说明判成违规(首版即如此),也会让真违规靠改注释洗白。
const componentCode = component
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("//"))
  .join("\n")
const host = readFileSync(join(import.meta.dir, "../../../main/html-preview-host.ts"), "utf8")

describe("#907 blocked-resource surfacing — real Solid mount", () => {
  test("component cases run green in a real Solid+happy-dom mount", () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "test", resolve(import.meta.dir, "../../../../test-component/artifact-html-preview.cases.ts")],
      cwd: resolve(import.meta.dir, "../../../.."),
      env: process.env,
    })
    const output = `${result.stdout.toString()}${result.stderr.toString()}`
    if (result.exitCode !== 0) throw new Error(output)
    expect(output).toContain("7 pass")
    expect(output).toContain("0 fail")
  })
})

describe("#907 the fix must not open a way out of the sandbox", () => {
  test("the component touches EXACTLY the sanctioned bridge channels (set equality)", () => {
    const faces = [...componentCode.matchAll(/window\.api\.(\w+)/g)].map((match) => match[1]!)
    expect([...new Set(faces)].sort()).toEqual(["htmlPreview", "writeClipboard"])

    const methods = [...componentCode.matchAll(/window\.api\.htmlPreview\s*\.\s*(\w+)\(/g)].map((match) => match[1]!)
    expect([...new Set(methods)].sort()).toEqual(["close", "onClosed", "open", "status"])
  })

  test("no external-open, shell, or navigation escape is introduced in the renderer", () => {
    for (const token of ["openExternal", "openPath", "quickLook", "shell.", "window.open", "location.href", "<a "]) {
      expect(componentCode).not.toContain(token)
    }
  })

  test("the blocked list is inert text — never an anchor, never innerHTML", () => {
    for (const token of ["innerHTML", "iframe", "webview", "dangerously"]) {
      expect(componentCode).not.toContain(token)
    }
  })
})

describe("#907 the host's read-only face is not widened while fixing the UI", () => {
  test("the host still records origins only — the status face is not widened into a data channel", () => {
    // safeOrigin 是刻意的:不留 path/query,不给不可信文档经状态面外带数据的机会。
    expect(host).toContain("function safeOrigin(")
    expect(host).toContain("return new URL(rawUrl).origin")
    expect(host).toContain("recordBlocked(record, safeOrigin(details.url))")
  })

  test("the record cap is one shared source of truth, so the UI count cannot drift from it", () => {
    expect(host).toContain("HTML_PREVIEW_MAX_BLOCKED_ENTRIES")
    expect(host).not.toContain("MAX_BLOCKED_ENTRIES = 50")
    expect(component).toContain("HTML_PREVIEW_MAX_BLOCKED_ENTRIES")
  })
})
