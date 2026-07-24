// REQ-125 C5 — 助手 Markdown 的唯一渲染通道。
//
// I1/I3:本模块是 session-timeline 里唯一允许 import 内容引擎的位置,引擎 =
// `@opencode-ai/session-ui/markdown`(既有 marked→DOMPurify sanitize→Shiki worker 管线,
// 与上游时间线同一条经审计通道)。alpha 侧不存在任何绕过该管线的 HTML 注入路径。
// I6:链接协议白名单与 target=_blank + noopener 由该管线(marked link renderer + DOMPurify
// afterSanitizeAttributes hook)落实;外开由主进程 setWindowOpenHandler(windows.ts)裁决。
// I7:进引擎前经 boundedText 截断,且截断结果走等值稳定 memo —— 截断串不变则引擎零重跑;
// 超限即冻结 streaming(截断视为完成态,后续 delta 不再进引擎,光标随之熄灭)。
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { createMemo, Show } from "solid-js"
import { t } from "../../i18n"
import { boundedText, MARKDOWN_MAX_CHARS } from "./timeline-model"

export function TimelineMarkdown(props: { text: string; cacheKey: string; streaming: boolean }) {
  // 等值稳定:text/truncated 均未变(字符串值比较)时不通知下游 —— 超限后任意多 delta
  // 产生的截断前缀恒等,引擎(parse/sanitize/Shiki)零重处理。
  const bounded = createMemo(() => boundedText(props.text, MARKDOWN_MAX_CHARS), undefined, {
    equals: (a, b) => a.truncated === b.truncated && a.text === b.text,
  })
  // 截断即完成态:冻结 streaming,引擎按完整块收尾,不再跟随后续 delta。
  const streaming = () => props.streaming && !bounded().truncated
  return (
    <>
      <Markdown class="a-tl-md-engine" text={bounded().text} cacheKey={props.cacheKey} streaming={streaming()} />
      <Show when={streaming()}>
        <span class="a-tl-cursor" aria-hidden="true" />
      </Show>
      <Show when={bounded().truncated}>
        <div class="a-tl-truncated" role="note">
          {t("alpha.timeline.truncated")}
        </div>
      </Show>
    </>
  )
}
