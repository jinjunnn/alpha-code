// REQ-125 C5 — 助手 Markdown 的唯一渲染通道。
//
// I1/I3:本模块是 session-timeline 里唯一允许 import 内容引擎的位置,引擎 =
// `@opencode-ai/session-ui/markdown`(既有 marked→DOMPurify sanitize→Shiki worker 管线,
// 与上游时间线同一条经审计通道)。alpha 侧不存在任何绕过该管线的 HTML 注入路径。
// I6:链接协议白名单与 target=_blank + noopener 由该管线(marked link renderer + DOMPurify
// afterSanitizeAttributes hook)落实;外开由主进程 setWindowOpenHandler(windows.ts)裁决。
// I7:进引擎前经 boundedText 截断,超限时渲染诚实的截断提示。
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { Show } from "solid-js"
import { t } from "../../i18n"
import { boundedText, MARKDOWN_MAX_CHARS } from "./timeline-model"

export function TimelineMarkdown(props: { text: string; cacheKey: string; streaming: boolean }) {
  const bounded = () => boundedText(props.text, MARKDOWN_MAX_CHARS)
  return (
    <>
      <Markdown class="a-tl-md-engine" text={bounded().text} cacheKey={props.cacheKey} streaming={props.streaming} />
      <Show when={bounded().truncated}>
        <div class="a-tl-truncated" role="note">
          {t("alpha.timeline.truncated")}
        </div>
      </Show>
    </>
  )
}
