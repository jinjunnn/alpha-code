// REQ-123(#1176)—— xlsx 表格呈现组件用例(真 Solid + happy-dom 挂载)。
// 驱动器:src/renderer/alpha-ui/artifact-workbench/renderers/xlsx-view.test.ts(子进程绿判据)。
// 模型来自真实生成器夹具(xlsxwriter,共享串 + 数值 + 多 sheet + 缓存公式);
// 字节 → 文档在 buildXlsxWorkbook 内部走 #1174 的 parseOoxmlContentPart,与生产同一条路。

import { transformAsync } from "@babel/core"
import presetTypescript from "@babel/preset-typescript"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import presetSolid from "babel-preset-solid"

GlobalRegistrator.register()
const solid = await import("solid-js/dist/solid.js")
mock.module("solid-js", () => solid)
const solidWeb = await import("solid-js/web/dist/web.js")
mock.module("solid-js/web", () => solidWeb)
const solidStore = await import("solid-js/store/dist/store.js")
mock.module("solid-js/store", () => solidStore)

Bun.plugin({
  name: "xlsx-view-component-test",
  setup(builder) {
    builder.onLoad({ filter: /packages\/ui-mac\/src\/.*\.tsx$/ }, async (args) => {
      const transformed = await transformAsync(await Bun.file(args.path).text(), {
        filename: args.path,
        presets: [
          [presetSolid, { generate: "dom", hydratable: false }],
          [presetTypescript, { allExtensions: true, isTSX: true, onlyRemoveTypeImports: true }],
        ],
        sourceMaps: "inline",
      })
      return { contents: transformed?.code ?? "", loader: "js" }
    })
  },
})

const model = await import("../src/renderer/alpha-ui/artifact-workbench/renderers/xlsx-model")
const viewModule = await import("../src/renderer/alpha-ui/artifact-workbench/renderers/xlsx-view")
const { XlsxWorkbookView } = viewModule as unknown as {
  XlsxWorkbookView: (props: { workbook: import("../src/renderer/alpha-ui/artifact-workbench/renderers/xlsx-model").XlsxWorkbook }) => unknown
}

function loadFixtureParts(generator: string): Map<string, Uint8Array> {
  const root = resolve(import.meta.dir, "../src/renderer/alpha-ui/artifact-workbench/renderers/fixtures/xlsx", generator)
  const parts = new Map<string, Uint8Array>()
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry)
      const rel = prefix === "" ? entry : `${prefix}/${entry}`
      if (statSync(abs).isDirectory()) walk(abs, rel)
      else parts.set(rel, new Uint8Array(readFileSync(abs)))
    }
  }
  walk(root, "")
  return parts
}

const disposers: Array<() => void> = []

afterEach(() => {
  disposers
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose())
  document.body.replaceChildren()
})

afterAll(() => GlobalRegistrator.unregister())

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function mount(component: () => unknown) {
  const host = document.createElement("div")
  document.body.append(host)
  disposers.push(solidWeb.render(component as never, host))
  return host
}

function buildFixtureWorkbook() {
  const result = model.buildXlsxWorkbook(loadFixtureParts("xlsxwriter"))
  if (!result.ok) throw new Error(result.code)
  return result.workbook
}

function tdTexts(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll("td")).map((td) => td.textContent ?? "")
}

describe("REQ-123 AC2 xlsx view real Solid mount", () => {
  test("多工作表:清单齐全,首表以表格呈现,共享串是文本不是索引数字", async () => {
    const host = mount(() => XlsxWorkbookView({ workbook: buildFixtureWorkbook() }))
    await flush()

    const tabs = Array.from(host.querySelectorAll("[data-alpha-xlsx-tab]"))
    expect(tabs.map((el) => el.getAttribute("data-alpha-xlsx-tab"))).toEqual(["Overview", "数据"])
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true")

    const texts = tdTexts(host)
    for (const expected of ["Item", "Widget", "42", "Alpha 部件", "Gadget", "3.5", "TRUE"]) {
      expect({ expected, present: texts.includes(expected) }).toEqual({ expected, present: true })
    }
    // 丢共享串的实现会把 A1 显示成索引 "0" —— 网格里不允许出现。
    expect(texts.includes("0")).toBe(false)
  })

  test("公式格显示缓存值,title 带公式原文 —— 不求值也不丢公式", async () => {
    const host = mount(() => XlsxWorkbookView({ workbook: buildFixtureWorkbook() }))
    await flush()
    const formulaCell = host.querySelector('td[data-cellkind="formula"]')
    expect(formulaCell?.textContent).toBe("45.5")
    expect(formulaCell?.getAttribute("title")).toBe("=SUM(B2:B3)")
  })

  test("切换到第二张表:内容换成该表的,首表内容退场(只渲染第一 sheet 的实现在此变红)", async () => {
    const host = mount(() => XlsxWorkbookView({ workbook: buildFixtureWorkbook() }))
    await flush()
    const secondTab = host.querySelector('[data-alpha-xlsx-tab="数据"]') as HTMLButtonElement
    secondTab.click()
    await flush()

    expect(secondTab.getAttribute("aria-selected")).toBe("true")
    const texts = tdTexts(host)
    for (const expected of ["地区", "华东", "1200", "Item"]) {
      expect({ expected, present: texts.includes(expected) }).toEqual({ expected, present: true })
    }
    expect(texts.includes("Widget")).toBe(false)
  })

  test("tablist 键盘巡航:→ 移到第二张表并切换内容(W3C Tabs Pattern 接线)", async () => {
    const host = mount(() => XlsxWorkbookView({ workbook: buildFixtureWorkbook() }))
    await flush()
    const firstTab = host.querySelector('[data-alpha-xlsx-tab="Overview"]') as HTMLButtonElement
    // roving tabindex:恰好一个落点在 Tab 序列里。
    const tabs = Array.from(host.querySelectorAll("[data-alpha-xlsx-tab]"))
    expect(tabs.map((el) => el.getAttribute("tabindex"))).toEqual(["0", "-1"])
    firstTab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }))
    await flush()
    const secondTab = host.querySelector('[data-alpha-xlsx-tab="数据"]')
    expect(secondTab?.getAttribute("aria-selected")).toBe("true")
    expect(tdTexts(host).includes("华东")).toBe(true)
  })

  test("单工作表不出清单;空表给诚实空态", async () => {
    const workbook = {
      sheets: [
        {
          name: "Only",
          status: "ok" as const,
          grid: { rows: [], columnCount: 0, truncatedRows: false, truncatedColumns: false },
        },
      ],
    }
    const host = mount(() => XlsxWorkbookView({ workbook }))
    await flush()
    expect(host.querySelector("[role='tablist']")).toBeNull()
    expect(host.querySelector(".a-wb-notice")).not.toBeNull()
  })

  test("读不出的表在清单里可见,切过去是诚实错误卡不是空白", async () => {
    const workbook = {
      sheets: [
        {
          name: "Good",
          status: "ok" as const,
          grid: {
            rows: [[{ text: "x", kind: "text" as const }]],
            columnCount: 1,
            truncatedRows: false,
            truncatedColumns: false,
          },
        },
        { name: "Broken", status: "missing" as const, reason: "missing-part" as const },
      ],
    }
    const host = mount(() => XlsxWorkbookView({ workbook }))
    await flush()
    const brokenTab = host.querySelector('[data-alpha-xlsx-tab="Broken"]') as HTMLButtonElement
    expect(brokenTab).not.toBeNull()
    brokenTab.click()
    await flush()
    const notice = host.querySelector('.a-wb-notice[data-kind="error"]')
    expect(notice).not.toBeNull()
    expect(notice?.textContent ?? "").toContain("Broken")
  })
})
