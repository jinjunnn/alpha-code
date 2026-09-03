/**
 * #1227 —— 真 OOXML 容器夹具的读取面。
 *
 * 容器字节由 renderers/fixtures/office-containers/make-containers.py 生成:仓内**真实生成器
 * 产出的 part 字节**(py-docx / py-pptx / xlsxwriter,见各自 fixtures 目录)+ OPC 外壳,
 * 用 Python 的 zipfile 装箱。为什么不手写 part、也不在测试里现打包,见那个脚本的文件头。
 *
 * 用例吃到的就是这三串字节,之后整条路与生产同源:detectOoxmlContainer → officeViewerContentOf。
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

const CONTAINERS = join(
  import.meta.dir,
  "../src/renderer/alpha-ui/artifact-workbench/renderers/fixtures/office-containers",
)

/**
 * 夹具以 base64 落盘 —— 仓里的 NUL 字节闸默认拒绝未登记的二进制格式,而那道闸守的正是
 * 「grep 遇到 NUL 会静默返回空」这个观测缺陷;为三个夹具去登记 `.bin` 会把门开得过宽。
 */
const read = (name: string) =>
  new Uint8Array(Buffer.from(readFileSync(join(CONTAINERS, name), "utf8").replace(/\s+/g, ""), "base64"))

/** py-docx 夹具的真 docx 容器。 */
export const docxContainer = () => read("report.docx.b64")

/** py-pptx 夹具的真 pptx 容器(多页 + 备注;页序由 presentation.xml.rels 决定)。 */
export const pptxContainer = () => read("deck.pptx.b64")

/** xlsxwriter 夹具的真 xlsx 容器(共享串 + 数值 + 布尔 + 缓存公式,双表)。 */
export const xlsxContainer = () => read("book.xlsx.b64")
