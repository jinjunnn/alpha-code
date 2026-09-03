/**
 * 「已检测的 OOXML 容器 → 可呈现内容」的唯一装配点(#1227)。
 *
 * 在此之前 #1175 的 docx/pptx 文本视图只接在产物面板上,#1176 的 xlsx 表格视图**一处也没接**
 * (`buildXlsxWorkbook` / `XlsxWorkbookView` 的唯一消费者是测试)。两个面板各自拼装的结果是
 * 同一个格式在两处呈现不同、且 xlsx 在两处都呈现不出来。本模块把这一步收成一份:
 * 上游只交 `detectOoxmlContainer` 的结论(权威身份来自容器结构,不是扩展名),下游只拿
 * 一个已判好的 union 去画。
 *
 * 字节纪律不变:parts 只可能来自 #1174 的检测咽喉(`retainContentParts: true`),
 * 本模块不读盘、不接受 part 名、不做第二次解析。
 */

import { officeTextExtractionOf, type OfficeTextFailureCode, type OfficeTextModel } from "./office-text"
import type { OoxmlDetection } from "./ooxml"
import { buildXlsxWorkbook, type XlsxWorkbook, type XlsxWorkbookResult } from "./xlsx-model"

export type OfficeViewerContent =
  /** docx / pptx —— 提取文本(排版不保真,呈现方须给保真声明)。 */
  | { status: "text"; model: OfficeTextModel }
  /** xlsx —— 工作表网格(公式字面呈现,不求值)。 */
  | { status: "sheets"; workbook: XlsxWorkbook }
  /** 结构过闸但内容取不出 —— 诚实失败,不退回「看起来是空文档」。 */
  | { status: "failed"; code: OfficeTextFailureCode | XlsxWorkbookFailureCode }

export type XlsxWorkbookFailureCode = Extract<XlsxWorkbookResult, { ok: false }>["code"]

/**
 * 未过结构闸(checking / rejected / 无 parts)一律返回 undefined —— 呈现方据此走它自己的
 * 「检测中 / 已拒绝」分支,本模块绝不为没过闸的容器编内容。
 */
export function officeViewerContentOf(detection: OoxmlDetection | undefined): OfficeViewerContent | undefined {
  if (!detection || detection.status !== "detected" || !detection.parts) return undefined
  if (detection.subtype === "xlsx") {
    const result = buildXlsxWorkbook(detection.parts)
    return result.ok ? { status: "sheets", workbook: result.workbook } : { status: "failed", code: result.code }
  }
  const extraction = officeTextExtractionOf(detection)
  if (!extraction) return undefined
  return extraction.status === "extracted"
    ? { status: "text", model: extraction.model }
    : { status: "failed", code: extraction.code }
}
