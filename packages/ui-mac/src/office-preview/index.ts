/**
 * alpha-code#1229 —— Office 版式预览宿主页的入口。
 *
 * 这段代码跑在**隔离 WebContentsView** 里(persist 分区、零 preload、`sandbox: true`、
 * 权限三面全拒、webRequest 只放行本协议),它拿得到的东西只有两样:自己那张固定资产表,
 * 和一份文档字节。没有 `window.api`、没有 Node、没有出网面 —— 渲染库即使被恶意文档带偏,
 * 能碰到的也只有这个空房间。
 *
 * 它与 renderer 主世界**没有任何共享代码**(除了 `shared/office-preview.ts` 里的纯常量),
 * 所以这里不 import i18n、不 import Solid:多引一样东西,就是往这个房间里多搬一件家具。
 * 界面文案由 main 在装载时经 query 传入(渲染失败时右栏会盖上自己的兜底卡,见 file-viewer)。
 */

import {
  OFFICE_PREVIEW_DOCUMENT_PATH,
  officeSubtypeFromSearch,
  type OfficePreviewSubtype,
} from "../shared/office-preview"

/** 宿主页把结局写进这个属性;main 侧轮询它来判「画出来了没有」(叠放层没有 DOM 探针)。 */
export type OfficeHostOutcome =
  | { status: "rendered"; subtype: OfficePreviewSubtype; detail: string }
  | { status: "failed"; subtype: OfficePreviewSubtype | null; code: string; detail: string }

declare global {
  interface Window {
    __alphaOfficeOutcome?: OfficeHostOutcome
  }
}

const root = document.getElementById("root") as HTMLDivElement

function settle(outcome: OfficeHostOutcome) {
  window.__alphaOfficeOutcome = outcome
  document.documentElement.setAttribute("data-alpha-office-status", outcome.status)
}

async function documentBytes(): Promise<Uint8Array> {
  // 文档只作为**数据**取回:同源 fetch,`connect-src 'self'`,永不作为脚本来源。
  const response = await fetch(`/${OFFICE_PREVIEW_DOCUMENT_PATH}`)
  if (!response.ok) throw new Error(`document fetch failed: ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

async function renderDocx(bytes: Uint8Array): Promise<string> {
  const { renderAsync } = await import("docx-preview")
  await renderAsync(new Blob([bytes as BlobPart]), root, undefined, {
    className: "alpha-docx",
    inWrapper: true,
    breakPages: true,
    renderHeaders: true,
    renderFooters: true,
    renderFootnotes: true,
    renderEndnotes: true,
    // 图片走 data: URL —— CSP 的 img-src 放行 data:,不需要 blob 生命周期管理。
    useBase64URL: true,
    experimental: true,
  })
  const pages = root.querySelectorAll("section").length
  if (root.textContent!.trim().length === 0 && pages === 0) throw new Error("empty document")
  return `${pages} page(s)`
}

async function renderPptx(bytes: Uint8Array): Promise<string> {
  const { PptxViewer } = await import("@file-viewer/pptx")
  const css = (await import("@file-viewer/pptx/styles.css", { with: { type: "text" } })).default as unknown as string
  const style = document.createElement("style")
  style.textContent = css
  document.head.append(style)
  const viewer = await PptxViewer.open(bytes.buffer as ArrayBuffer, root, {
    fitMode: "contain",
    zoomPercent: 100,
    lazySlides: false,
    lazyMedia: false,
    // worker 必须显式给地址:默认解析会落到打包器写死的路径,在自定义协议下取不到。
    workerUrl: new URL("./pptx.worker.js", location.href).href,
  })
  for (let i = 0; i < 100 && viewer.slideCount === 0; i++) await new Promise((r) => setTimeout(r, 100))
  if (viewer.slideCount === 0) throw new Error("no slides rendered")
  return `${viewer.slideCount} slide(s)`
}

async function renderXlsx(bytes: Uint8Array): Promise<string> {
  const { renderFileViewerSpreadsheet } = await import("@file-viewer/renderer-spreadsheet")
  await renderFileViewerSpreadsheet(bytes.buffer as ArrayBuffer, root, "xlsx")
  for (let i = 0; i < 100 && root.querySelectorAll("canvas").length === 0; i++)
    await new Promise((r) => setTimeout(r, 100))
  if (root.querySelectorAll("canvas").length === 0) throw new Error("no sheet surface rendered")
  return "workbook"
}

const RENDERERS: Record<OfficePreviewSubtype, (bytes: Uint8Array) => Promise<string>> = {
  docx: renderDocx,
  pptx: renderPptx,
  xlsx: renderXlsx,
}

async function main() {
  const subtype = officeSubtypeFromSearch(location.search)
  if (!subtype) {
    settle({ status: "failed", subtype: null, code: "UNKNOWN_SUBTYPE", detail: "no renderable subtype in url" })
    return
  }
  // 高度链要在渲染**之前**定下来:表格载体按容器的确定高度算 canvas 尺寸(见 host.html)。
  document.documentElement.setAttribute("data-alpha-office-kind", subtype)
  try {
    const bytes = await documentBytes()
    const detail = await RENDERERS[subtype](bytes)
    settle({ status: "rendered", subtype, detail })
  } catch (error) {
    // 诚实失败:宿主页不画半成品,右栏据此换回文字提取兜底(见 file-viewer)。
    root.replaceChildren()
    settle({
      status: "failed",
      subtype,
      code: "RENDER_FAILED",
      detail: String((error as Error)?.message ?? error).slice(0, 200),
    })
  }
}

void main()
