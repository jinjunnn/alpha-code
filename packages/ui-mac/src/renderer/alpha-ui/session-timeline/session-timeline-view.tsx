// REQ-125 C5 — alpha 时间线视图(呈现层,数据源无关)。
//
// 形态权威 = docs/design/current/conversation-timeline/design.html ①②④ 节帧
// (用户气泡/附件卡/内联评论卡/助手 Markdown/推理块/流式光标/回合分隔/会话内空态)。
// 数据经 props 注入(rows 来自 timeline-model 投影),本文件零上游 session DOM/选择器依赖,
// CSS 只用 --a-* 令牌;工具/媒体等 part 渲染为占位行,C6 以真卡替换。
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { t } from "../../i18n"
import { TimelineMarkdown } from "./timeline-markdown"
import { boundedText, REASONING_MAX_CHARS, type TimelineComment, type TimelineRow } from "./timeline-model"
import { isAtBottom, restoreAfterPrepend, shouldLoadOlder } from "./timeline-scroll"
import "./session-timeline.css"

export interface SessionTimelineHistory {
  more: boolean
  loading: boolean
}

export interface SessionTimelineViewProps {
  rows: TimelineRow[]
  /** 消息页是否已加载(false = 首次 sync 进行中,不渲染空态)。 */
  ready: boolean
  /** I8:serverKey+directory+sessionID 的合成键;变更即换代,滞后的滚动补偿被丢弃。 */
  epoch: string
  emptyTitle: string
  history: SessionTimelineHistory
  onLoadOlder: () => Promise<void>
}

const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: "short" })

function formatTime(createdAt: number) {
  return timeFormat.format(createdAt)
}

export function SessionTimelineView(props: SessionTimelineViewProps) {
  let scrollRef: HTMLDivElement | undefined
  let columnRef: HTMLDivElement | undefined
  let olderInFlight = false
  const [atBottom, setAtBottom] = createSignal(true)

  const scrollToEnd = () => {
    if (!scrollRef) return
    scrollRef.scrollTop = scrollRef.scrollHeight
    setAtBottom(true)
  }

  const schedule = (task: () => void) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(task)
    else setTimeout(task, 0)
  }

  const triggerLoadOlder = () => {
    const el = scrollRef
    if (!el || olderInFlight || !props.history.more || props.history.loading) return
    const epoch = props.epoch
    const prevTop = el.scrollTop
    const prevHeight = el.scrollHeight
    olderInFlight = true
    void props
      .onLoadOlder()
      .catch(() => {})
      .finally(() => {
        olderInFlight = false
        if (props.epoch !== epoch) return
        schedule(() => {
          if (!scrollRef || props.epoch !== epoch) return
          scrollRef.scrollTop = restoreAfterPrepend(prevTop, prevHeight, scrollRef.scrollHeight)
        })
      })
  }

  const handleScroll = () => {
    const el = scrollRef
    if (!el) return
    setAtBottom(isAtBottom(el.scrollTop, el.clientHeight, el.scrollHeight))
    if (shouldLoadOlder({ scrollTop: el.scrollTop, more: props.history.more, loading: props.history.loading }))
      triggerLoadOlder()
  }

  // 会话进入/切换(epoch)且消息页就绪 → 视口落到最新一条。
  createEffect(
    on(
      () => `${props.epoch}|${props.ready}`,
      () => {
        if (!props.ready) return
        setAtBottom(true)
        schedule(scrollToEnd)
      },
    ),
  )

  // 跟随流式:内容高度变化时,仅在贴底状态下续贴底。
  onMount(() => {
    if (typeof ResizeObserver === "undefined" || !columnRef) return
    const observer = new ResizeObserver(() => {
      if (atBottom()) scrollToEnd()
    })
    observer.observe(columnRef)
    onCleanup(() => observer.disconnect())
  })

  return (
    <div class="a-tl-root" data-alpha-session-timeline>
      <div
        class="a-tl-scroll"
        ref={scrollRef}
        role="log"
        aria-label={t("alpha.session.timelineHost")}
        tabindex="0"
        onScroll={handleScroll}
      >
        <div class="a-tl-column" ref={columnRef}>
          <Show when={props.rows.length > 0 && (props.history.more || props.history.loading)}>
            <div class="a-tl-history" data-alpha-timeline-history data-loading={props.history.loading ? "true" : undefined}>
              <Show
                when={props.history.loading}
                fallback={
                  <button type="button" class="a-tl-history-button" onClick={triggerLoadOlder}>
                    {t("alpha.timeline.loadOlder")}
                  </button>
                }
              >
                <span class="a-tl-history-loading">
                  <span class="a-tl-spinner" aria-hidden="true" />
                  {t("alpha.timeline.loadingOlder")}
                </span>
              </Show>
            </div>
          </Show>
          <For each={props.rows}>{(row) => <TimelineRowView row={row} />}</For>
        </div>
      </div>
      <Show when={props.ready && props.rows.length === 0}>
        <div class="a-tl-empty" data-alpha-timeline-empty>
          <div class="a-tl-empty-name">{props.emptyTitle}</div>
          <p class="a-tl-empty-hint">{t("alpha.timeline.emptyHint")}</p>
          <svg class="a-tl-empty-arrow" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14M5 12l7 7 7-7" />
          </svg>
        </div>
      </Show>
      <Show when={!atBottom()}>
        <button type="button" class="a-tl-jump" aria-label={t("alpha.timeline.jumpLatest")} onClick={scrollToEnd}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14M5 12l7 7 7-7" />
          </svg>
        </button>
      </Show>
    </div>
  )
}

function TimelineRowView(props: { row: TimelineRow }) {
  // 行对象引用稳定(reuseTimelineRows),kind 不随内容变化;内容字段经 store proxy 反应式读取。
  const row = props.row
  if (row.kind === "turn") return <TurnRow row={row} />
  if (row.kind === "user") return <UserRow row={row} />
  if (row.kind === "reasoning") return <ReasoningRow row={row} />
  if (row.kind === "markdown") return <MarkdownRow row={row} />
  if (row.kind === "placeholder") return <PlaceholderRow row={row} />
  if (row.kind === "divider") return <DividerRow row={row} />
  if (row.kind === "thinking") return <ThinkingRow row={row} />
  // fail-closed:未知行类型不渲染任何内容。
  return null
}

function TurnRow(props: { row: Extract<TimelineRow, { kind: "turn" }> }) {
  return (
    <div class="a-tl-row a-tl-turn" data-alpha-timeline-row="turn">
      {formatTime(props.row.createdAt)} · {t("alpha.timeline.newTurn")}
    </div>
  )
}

function commentRange(comment: TimelineComment) {
  if (comment.startLine === undefined) return ""
  if (comment.endLine === undefined || comment.endLine === comment.startLine)
    return t("alpha.timeline.commentLine", { line: comment.startLine })
  return t("alpha.timeline.commentLines", { start: comment.startLine, end: comment.endLine })
}

function UserRow(props: { row: Extract<TimelineRow, { kind: "user" }> }) {
  const meta = () => {
    const message = props.row.message
    const items = [
      message.agent ? t("alpha.timeline.sentTo", { agent: message.agent }) : "",
      message.model?.modelID ?? "",
      formatTime(message.time.created),
    ]
    return items.filter(Boolean).join(" · ")
  }
  return (
    <article class="a-tl-row a-tl-user" data-alpha-timeline-row="user">
      <Show when={props.row.attachments.length > 0}>
        <div class="a-tl-attachments">
          <For each={props.row.attachments}>
            {(attachment) => (
              <span class="a-tl-attach" data-media={attachment.media}>
                <span class="a-tl-attach-badge" data-media={attachment.media} aria-hidden="true">
                  <Show
                    when={attachment.media === "image"}
                    fallback={<span class="a-tl-attach-ext">{attachment.label.slice(0, 4)}</span>}
                  >
                    <svg viewBox="0 0 24 24">
                      <rect x="3" y="4" width="18" height="16" rx="2" />
                      <circle cx="8.5" cy="10" r="1.6" />
                      <path d="M21 16l-5-5L6 20" />
                    </svg>
                  </Show>
                </span>
                <span class="a-tl-attach-name">
                  <b>{attachment.name}</b>
                  <small>{attachment.label}</small>
                </span>
              </span>
            )}
          </For>
        </div>
      </Show>
      <Show when={props.row.comments.length > 0}>
        <div class="a-tl-comments">
          <For each={props.row.comments}>
            {(comment) => (
              <div class="a-tl-comment">
                <div class="a-tl-comment-ref">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
                    <path d="M14 3v6h6" />
                  </svg>
                  <span class="a-tl-comment-path">{comment.path}</span>
                  <Show when={commentRange(comment)}>
                    <span class="a-tl-comment-range">{commentRange(comment)}</span>
                  </Show>
                </div>
                <div class="a-tl-comment-text">{comment.comment}</div>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={props.row.text}>
        <div class="a-tl-bubble">
          <For each={props.row.segments}>
            {(segment) => (
              <Show when={segment.kind} fallback={<span>{segment.text}</span>}>
                <span class="a-tl-mention" data-mention={segment.kind}>
                  {segment.text}
                </span>
              </Show>
            )}
          </For>
          <Show when={props.row.truncated}>
            <span class="a-tl-truncated-inline">{t("alpha.timeline.truncated")}</span>
          </Show>
        </div>
      </Show>
      <div class="a-tl-user-meta">{meta()}</div>
    </article>
  )
}

function ReasoningRow(props: { row: Extract<TimelineRow, { kind: "reasoning" }> }) {
  const [open, setOpen] = createSignal(false)
  const seconds = () => {
    const time = props.row.part.time
    if (typeof time?.end !== "number") return undefined
    return Math.max(0, Math.round((time.end - time.start) / 1000))
  }
  const body = () => boundedText(props.row.part.text ?? "", REASONING_MAX_CHARS)
  return (
    <section
      class="a-tl-row a-tl-reason"
      data-alpha-timeline-row="reasoning"
      data-streaming={props.row.streaming ? "true" : undefined}
      data-open={open() ? "true" : undefined}
    >
      <button type="button" class="a-tl-reason-head" aria-expanded={open()} onClick={() => setOpen((value) => !value)}>
        <svg class="a-tl-reason-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9.5 2a4.5 4.5 0 0 0-4.3 5.8A4 4 0 0 0 6 15.5a4 4 0 0 0 7 1 4 4 0 0 0 7-1 4 4 0 0 0 .8-7.7A4.5 4.5 0 0 0 14.5 2 4.5 4.5 0 0 0 12 3.3 4.5 4.5 0 0 0 9.5 2z" />
        </svg>
        <span class="a-tl-reason-label">
          {props.row.streaming ? t("alpha.timeline.thinking") : t("alpha.timeline.reasoning")}
        </span>
        <Show when={seconds() !== undefined}>
          <span class="a-tl-reason-duration">{t("alpha.timeline.reasoningDuration", { seconds: seconds()! })}</span>
        </Show>
        <svg class="a-tl-reason-chev" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9 6l6 6-6 6" />
        </svg>
      </button>
      <Show when={open()}>
        <div class="a-tl-reason-body">
          {body().text}
          <Show when={body().truncated}>
            <span class="a-tl-truncated-inline">{t("alpha.timeline.truncated")}</span>
          </Show>
        </div>
      </Show>
    </section>
  )
}

function MarkdownRow(props: { row: Extract<TimelineRow, { kind: "markdown" }> }) {
  return (
    <div class="a-tl-row a-tl-ai" data-alpha-timeline-row="markdown" data-streaming={props.row.streaming ? "true" : undefined}>
      <TimelineMarkdown text={props.row.part.text ?? ""} cacheKey={props.row.part.id} streaming={props.row.streaming} />
      <Show when={props.row.streaming}>
        <span class="a-tl-cursor" aria-hidden="true" />
      </Show>
    </div>
  )
}

function PlaceholderRow(props: { row: Extract<TimelineRow, { kind: "placeholder" }> }) {
  const status = () => (props.row.part.type === "tool" ? props.row.part.state.status : undefined)
  const statusLabel = () => {
    const value = status()
    if (value === "pending") return t("alpha.timeline.toolPending")
    if (value === "running") return t("alpha.timeline.toolRunning")
    if (value === "error") return t("alpha.timeline.toolError")
    if (value === "completed") return t("alpha.timeline.toolCompleted")
    return ""
  }
  const name = () => {
    if (props.row.tool) return props.row.tool
    if (props.row.part.type === "subtask") return t("alpha.timeline.subtask")
    if (props.row.part.type === "file") return t("alpha.timeline.media")
    return props.row.part.type
  }
  return (
    <div
      class="a-tl-row a-tl-part-pending"
      data-alpha-timeline-row="placeholder"
      data-part-type={props.row.part.type}
      data-tool={props.row.tool}
      data-status={status()}
    >
      <span class="a-tl-part-pending-name">{name()}</span>
      <Show when={statusLabel()}>
        <span class="a-tl-part-pending-status" data-status={status()}>
          {statusLabel()}
        </span>
      </Show>
    </div>
  )
}

function DividerRow(props: { row: Extract<TimelineRow, { kind: "divider" }> }) {
  return (
    <div class="a-tl-row a-tl-divider" data-alpha-timeline-row="divider" data-label={props.row.label}>
      <span class="a-tl-divider-pill">
        {props.row.label === "compaction" ? t("alpha.timeline.compacted") : t("alpha.timeline.interrupted")}
      </span>
    </div>
  )
}

function ThinkingRow(props: { row: Extract<TimelineRow, { kind: "thinking" }> }) {
  void props
  return (
    <div class="a-tl-row a-tl-thinking" data-alpha-timeline-row="thinking" role="status">
      <span class="a-tl-thinking-label">{t("alpha.timeline.thinking")}</span>
      <span class="a-tl-thinking-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </div>
  )
}
