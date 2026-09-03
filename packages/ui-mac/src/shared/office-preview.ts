/**
 * REQ / alpha-code#1229 —— Office 版式预览的跨运行时契约。
 *
 * 与 `html-preview.ts` 同纪律:纯常量与纯函数,零 electron、零 node —— main(rail-preview-host)
 * 与 Office 宿主页(src/office-preview,跑在隔离 WebContentsView 里)两边都要用。
 *
 * 为什么 Office 需要**自己的一份 CSP**,而不是复用 HTML_PREVIEW_CSP:
 * HTML 产物那份的守卫核心是 `script-src 'none'` + 裸 `sandbox` —— 文档一行脚本都不许跑。
 * Office 这条路恰恰要跑**我们自己打包进去的那段渲染代码**,`sandbox` 会连它一起禁掉
 * (实测:带 `sandbox` 时控制台只有 `Blocked script execution … frame is sandboxed`)。
 * 所以这里换一种守法:**允许的脚本只有 `'self'` 这一个来源,而 `'self'` 下我们只服务
 * 一张固定文件表**(见 OFFICE_PREVIEW_ASSETS)——文档字节永远只作为**数据**被 fetch,
 * 永远不会成为可执行来源。文档本身仍然到不了 `script-src`。
 *
 * 隔离面的其余部分与 html/pdf 载体逐条相同(persist 分区、权限三面全拒、零 preload、
 * webRequest 只放行本协议、导航面全拒),一条没放宽 —— 见 rail-preview-host 文件头。
 */

import { HTML_PREVIEW_SCHEME } from "./html-preview"

/** Office 宿主页与它的资产在 URL 里的固定前缀。工作区文件永远不经这个前缀供给。 */
export const OFFICE_PREVIEW_PREFIX = "__alpha_office__"

/** 宿主页地址(不含 scheme/token)。 */
export const OFFICE_PREVIEW_HOST_PATH = `${OFFICE_PREVIEW_PREFIX}/host.html`

/** 文档字节的固定地址 —— **工作区相对路径从不出现在 URL 里**,由 main 侧按记录解析。 */
export const OFFICE_PREVIEW_DOCUMENT_PATH = `${OFFICE_PREVIEW_PREFIX}/document`

/**
 * 宿主页可以取到的全部文件,连同它们的 Content-Type。
 * **默认拒**:不在这张表里的一律 403 —— 包括工作区里的任何同伴文件(与 html 载体不同,
 * Office 载体不服务同伴资产:版式所需的图片/字体都在容器内部,由渲染库自己解出来)。
 */
export const OFFICE_PREVIEW_ASSETS: Readonly<Record<string, string>> = {
  "host.html": "text/html; charset=utf-8",
  "app.js": "text/javascript; charset=utf-8",
  "pptx.worker.js": "text/javascript; charset=utf-8",
  "sheet.worker.js": "text/javascript; charset=utf-8",
}

/** 打包产物目录名(out/ 下,与 main/renderer 平级;electron-builder 的 `out/**` 已覆盖)。 */
export const OFFICE_PREVIEW_OUT_DIR = "office-preview"

/**
 * 宿主页 CSP。与 HTML_PREVIEW_CSP 的差别只有两处,且两处都是**为了让我们自己的代码能跑**:
 *   · `script-src 'self'`(那份是 `'none'`)—— 来源仅限上面那张固定表;
 *   · 没有裸 `sandbox` —— 它会禁掉同源脚本本身。
 * 其余一律更严或相同:`connect-src 'self'` 只够取文档字节,出网面为空(`webRequest` 另有一道)。
 */
export const OFFICE_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'unsafe-inline' 'self'",
  `img-src data: blob: ${HTML_PREVIEW_SCHEME}:`,
  `font-src data: ${HTML_PREVIEW_SCHEME}:`,
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "media-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ")

/** 载体能渲染的 Office 子类型 —— 与 OOXML 检测结论一一对应,绝不由扩展名合成。 */
export const OFFICE_PREVIEW_SUBTYPES = ["docx", "pptx", "xlsx"] as const
export type OfficePreviewSubtype = (typeof OFFICE_PREVIEW_SUBTYPES)[number]

export function isOfficePreviewSubtype(value: unknown): value is OfficePreviewSubtype {
  return typeof value === "string" && (OFFICE_PREVIEW_SUBTYPES as readonly string[]).includes(value)
}

/**
 * 宿主页从自己的 URL 里读子类型。放在 query 而不是路径里,是为了让宿主页与资产表都保持定长。
 * 认不出来的一律返回 null —— 宿主页据此画「读不出」,不猜。
 */
export function officeSubtypeFromSearch(search: string): OfficePreviewSubtype | null {
  const raw = new URLSearchParams(search).get("kind")
  return isOfficePreviewSubtype(raw) ? raw : null
}
