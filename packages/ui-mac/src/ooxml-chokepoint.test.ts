// REQ-123 (#1174) 的咽喉闸,两条不变量(baseline ③ M3):
//
//  1. 整棵 src 生产树里,**只有** `shared/ooxml.ts` 允许够到解压面
//     (`ZipReader` / `DecompressionStream`)。一切不可信 zip 字节都必须走它的
//     preflight + 有界 inflate + 双帽;第二条解压路径就是把那些帽全部作废。
//  2. **只有** `renderers/ooxml-content.ts` 允许调 `DOMParser`。字节 → Document 的唯一
//     通路是那一个函数:解码 → 对解码后的字符串扫 DOCTYPE/ENTITY/CDATA → parseFromString。
//     绕开它 = 把 billion-laughs DoS 放进右栏渲染(Chromium 静默接受 DOCTYPE,实测)。
//
// 如实标注(退出条件点名要求):这道闸判的是**源码文本**,防的是「误开第二条路径」——
// 一个新文件顺手 `import { ZipReader }` 或 `new DOMParser()`,这里变红;它**不防恶意实现**
// (间接取值、动态属性名等存心躲法绕得过去,那不在本票的威胁模型里)。注释里出现同样的
// 字面同样算违规,不做注释剥离 —— 判据越简单,越不会自己长出漏洞。
//
// 已知且刻意保留的例外:`main/logging.ts` import 了 `@zip.js/zip.js` 的**写侧**
// (ZipWriter/BlobWriter/BlobReader,导出日志打包)。写侧不解压不可信输入,不在
// 不变量 1 的面上;规则 3 钉住它永远够不到读侧。
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"

const SRC_ROOT = resolve(import.meta.dir)

/** 唯一允许够到解压面的文件(相对 src)。 */
const INFLATE_CHOKEPOINT = "shared/ooxml.ts"
/** 唯一允许调 DOMParser 的文件(相对 src)。 */
const DOM_PARSER_CHOKEPOINT = "renderer/alpha-ui/artifact-workbench/renderers/ooxml-content.ts"
/** @zip.js 写侧的既有消费者(只允许 writer 符号,由规则 3 看住)。 */
const ZIP_WRITER_EXCEPTION = "main/logging.ts"

const INFLATE_SURFACE = /\b(?:ZipReader|DecompressionStream)\b/
const ZIP_JS_MODULE = /@zip\.js/
const DOM_PARSER = /\bDOMParser\b/

function productionSources(): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(abs)
        continue
      }
      if (!/\.tsx?$/.test(entry.name)) continue
      // 测试与测试运行时可以造 zip 夹具、搭 DOM 桩,不在闸内。
      if (/\.(test|cases)\.tsx?$/.test(entry.name)) continue
      if (/-test-runtime\.tsx?$/.test(entry.name)) continue
      if (/\.test-support\.tsx?$/.test(entry.name)) continue
      found.push(relative(SRC_ROOT, abs).split(sep).join("/"))
    }
  }
  walk(SRC_ROOT)
  return found.sort()
}

const read = (path: string) => readFileSync(join(SRC_ROOT, path), "utf8")

describe("REQ-123 #1174 OOXML 咽喉(import 图/文本闸)", () => {
  // 前提自检:先证明手段能看到已知的坏 —— 走查到的树足够大,且两个咽喉文件自己命中自己的正则。
  test("前提:src 生产树被真的走查到了,且已知正样本命中", () => {
    const files = productionSources()
    expect(files.length).toBeGreaterThan(200)
    expect(files).toContain(INFLATE_CHOKEPOINT)
    expect(files).toContain(DOM_PARSER_CHOKEPOINT)
    expect(files).toContain(ZIP_WRITER_EXCEPTION)
    expect(INFLATE_SURFACE.test(read(INFLATE_CHOKEPOINT))).toBe(true)
    expect(ZIP_JS_MODULE.test(read(INFLATE_CHOKEPOINT))).toBe(true)
    expect(DOM_PARSER.test(read(DOM_PARSER_CHOKEPOINT))).toBe(true)
  })

  test("规则 1:只有 shared/ooxml.ts 够得到解压面(ZipReader / DecompressionStream)", () => {
    const offenders = productionSources().filter(
      (path) => path !== INFLATE_CHOKEPOINT && INFLATE_SURFACE.test(read(path)),
    )
    expect(offenders).toEqual([])
  })

  test("规则 2:@zip.js 模块引用只允许咽喉与既名写侧例外", () => {
    const offenders = productionSources().filter(
      (path) =>
        path !== INFLATE_CHOKEPOINT && path !== ZIP_WRITER_EXCEPTION && ZIP_JS_MODULE.test(read(path)),
    )
    expect(offenders).toEqual([])
  })

  test("规则 3:写侧例外永远够不到读侧", () => {
    expect(INFLATE_SURFACE.test(read(ZIP_WRITER_EXCEPTION))).toBe(false)
  })

  test("规则 4:只有 renderers/ooxml-content.ts 调得到 DOMParser", () => {
    const offenders = productionSources().filter(
      (path) => path !== DOM_PARSER_CHOKEPOINT && DOM_PARSER.test(read(path)),
    )
    expect(offenders).toEqual([])
  })
})
