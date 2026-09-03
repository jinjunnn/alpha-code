#!/usr/bin/env bun
/**
 * alpha-code#1229 —— 打包 Office 版式预览宿主页。
 *
 * 为什么单独一步、不进 electron-vite 的 renderer 配置:那份配置服务的是**主渲染世界**
 * (带 preload 桥、带上游 app、带 i18n)。Office 宿主页恰恰要跑在一个什么都没有的隔离房间里,
 * 把它挂进同一份配置,迟早会有人顺手 import 一个主世界的模块进来 —— 房间就不空了。
 * 分开打包让「这个包里能有什么」由这份文件单独说了算。
 *
 * 产物(out/office-preview/,electron-builder 的 `out/**` 已覆盖):
 *   host.html · app.js · pptx.worker.js · sheet.worker.js
 * 这四个名字与 shared/office-preview.ts 的 OFFICE_PREVIEW_ASSETS 一一对应 —— main 侧只服务
 * 这张表,多一个文件不会被服务,少一个文件会在装载时 404。故本脚本产完自检一遍。
 */
import { $ } from "bun"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { OFFICE_PREVIEW_ASSETS, OFFICE_PREVIEW_OUT_DIR } from "../src/shared/office-preview"

const root = path.resolve(import.meta.dir, "..")
const outDir = path.join(root, "out", OFFICE_PREVIEW_OUT_DIR)

await fs.rm(outDir, { recursive: true, force: true })
await fs.mkdir(outDir, { recursive: true })

await $`bun build ${path.join(root, "src/office-preview/index.ts")} --outfile ${path.join(outDir, "app.js")} --target=browser --format=esm --minify`.quiet()
await fs.copyFile(path.join(root, "src/office-preview/host.html"), path.join(outDir, "host.html"))

// 两个渲染库的 worker 是**独立文件**(它们按 URL 起 worker,不是打包进主 chunk),
// 原样搬过来;宿主页用 workerUrl 指到这里。
const workers: Array<[string, string]> = [
  ["node_modules/@file-viewer/pptx/dist/worker/pptx.worker.js", "pptx.worker.js"],
  ["node_modules/@file-viewer/renderer-spreadsheet/dist/spreadsheet/worker/sheetjs/sheet.worker.js", "sheet.worker.js"],
]
for (const [from, to] of workers) {
  const src = path.join(root, from)
  if (!(await Bun.file(src).exists())) throw new Error(`office-preview: worker 源文件不在:${from}(依赖结构变了?)`)
  await fs.copyFile(src, path.join(outDir, to))
}

// 自检:产物与资产表必须**逐条相同**。少了 = 装载 404;多了 = 有个文件永远不会被服务,
// 那是「打了但没接上」,同样是缺陷。
const produced = (await fs.readdir(outDir)).sort()
const declared = Object.keys(OFFICE_PREVIEW_ASSETS).sort()
if (JSON.stringify(produced) !== JSON.stringify(declared))
  throw new Error(`office-preview: 产物与 OFFICE_PREVIEW_ASSETS 不符\n  产物: ${produced}\n  表:   ${declared}`)

const bytes = await Promise.all(produced.map(async (n) => [n, (await Bun.file(path.join(outDir, n)).arrayBuffer()).byteLength] as const))
console.log(`✓ office-preview → out/${OFFICE_PREVIEW_OUT_DIR}/`, bytes.map(([n, b]) => `${n} ${(b / 1024).toFixed(0)}KB`).join(" · "))
