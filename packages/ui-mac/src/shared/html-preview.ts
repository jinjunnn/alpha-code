// REQ-096(alpha-code#188)—— 隔离 HTML artifact preview 的跨运行时契约。main(html-preview-host)
// 与 renderer(alpha-ui/artifact-html-preview)两个世界都要用(ADR-006),故与 ephemeral-server-url.ts
// 同风格落 shared:纯函数/常量,零 electron、零 node 依赖。
//
// host 本体、session/window 硬化与一次性 token 生命周期都在 src/main/html-preview-host.ts;
// 本文件只承载:scheme 名、静态 CSP 文本、能力判定(canPreviewHtml)与 IPC 结果形状。

import type { ArtifactDescriptor } from "./cloud-artifact-descriptor"

/** 一次性静态 host 的自定义协议名。仅注册 `standard: true`(host/相对路径解析需要);
 *  不给 secure、不给 supportFetchAPI —— 能力面越窄越好(REQ-096 交付 3/4)。 */
export const HTML_PREVIEW_SCHEME = "alpha-artifact-preview"

/** 并发预览上限(REQ-096 生命周期约束的礼貌上限;超限拒绝而非静默 LRU 关窗)。 */
export const HTML_PREVIEW_MAX_CONCURRENT = 3

/**
 * blockedPaths 的记录上限(诊断供数,防无界增长)。#907 起落 shared:renderer 要拿它判「清单是否
 * 已到上限」——到上限时界面必须说「至少 N 项」,不能把一个被截断的清单当成完整计数报出去。
 * 提高/降低它就是同时改变 main 的记录面与界面的诚实口径,故只此一份真源。
 */
export const HTML_PREVIEW_MAX_BLOCKED_ENTRIES = 50

/**
 * 默认静态 CSP(REQ-096 交付 3):default/script/connect/frame/object/form/base 全 'none';
 * 仅放行受控 inline style 与同 run artifacts/ 内经自定义协议供给的图片/字体(+ data: 内联形态)。
 * `sandbox` 裸指令追加一层文档级禁脚本/禁表单/禁弹窗(纵深防御,不依赖单点)。
 * host 对每个响应注入本头 —— 主 renderer 的 RENDERER_CSP 不因预览放宽(AC#7)。
 */
export const HTML_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "style-src 'unsafe-inline'",
  `img-src data: ${HTML_PREVIEW_SCHEME}:`,
  `font-src data: ${HTML_PREVIEW_SCHEME}:`,
  "media-src 'none'",
  "frame-ancestors 'none'",
  "sandbox",
].join("; ")

// ---- IPC 结果形状(renderer 只见 opaque previewId;URL/token/绝对路径永不过 IPC)----

export type HtmlPreviewOpenResult = { ok: true; previewId: string } | { ok: false; reason: string }

export type HtmlPreviewCloseReason = "closed" | "crashed" | "shutdown"

export type HtmlPreviewClosedEvent = { previewId: string; reason: HtmlPreviewCloseReason }

/** blockedPaths:被 host 拒绝的资源清单(REQ-096 交付 7 的供数面)——
 *  同 run 内相对路径,或外部请求的 origin;绝无 token/完整 URL/绝对路径。 */
export type HtmlPreviewStatus =
  | { ok: true; previewId: string; open: boolean; blockedPaths: string[] }
  | { ok: false; reason: string }

// ---- 能力判定 ----

const HTML_MIME_RE = /^(text\/html|application\/xhtml\+xml)\s*(;|$)/i
const HTML_EXT_RE = /\.html?$/i

/**
 * 该 artifact 是否可进静态 HTML 预览。诚实原则(REQ-093):detectedMime(magic 检测)存在时是
 * 唯一裁决 —— 声明为 html 但检测为其他类型 = 冲突,拒绝预览;无检测结论时才看 claimedMime/扩展名。
 * `localDetectedMime` = 本地登记时的检测结果(manifest entry.local.detectedMime),优先于
 * descriptor 携带的产出端检测。
 */
export function canPreviewHtml(
  descriptor: Pick<ArtifactDescriptor, "name" | "claimedMime" | "detectedMime">,
  localDetectedMime?: string,
): boolean {
  const detected = localDetectedMime ?? descriptor.detectedMime
  if (detected) return HTML_MIME_RE.test(detected.trim())
  if (descriptor.claimedMime && HTML_MIME_RE.test(descriptor.claimedMime.trim())) return true
  return HTML_EXT_RE.test(descriptor.name)
}
