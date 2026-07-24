// REQ-125 C5/C6 — alpha 时间线视图(呈现层,数据源无关)。
//
// 形态权威 = docs/design/current/conversation-timeline/design.html ①②③④⑥ 节帧
// (用户气泡/附件卡/内联评论卡/助手 Markdown/推理块/流式光标/回合分隔/会话内空态,
// 以及 C6 卡片全集:工具卡四态/折叠组/回合级错误/重试/媒体预览行/产物链接行)。
// 数据经 props 注入(rows 来自 timeline-model 投影),本文件零上游 session DOM/选择器依赖,
// CSS 只用 --a-* 令牌;卡片交互经可选 intents(缺席即降级为纯展示,fail-closed)。
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { t } from "../../i18n"
import {
  ContextToolGroupCard,
  RetryCard,
  TimelineArtifactRows,
  TimelineMediaRow,
  TimelineToolCard,
  TurnErrorCard,
} from "./cards/tool-cards"
import { TimelineIntentsContext, type TimelineIntents } from "./cards/timeline-intents"
import { TimelineMarkdown } from "./timeline-markdown"
import { boundedText, REASONING_MAX_CHARS, type TimelineComment, type TimelineRow } from "./timeline-model"
import { anchorDelta, createPrependCoordinator, isAtBottom, shouldLoadOlder } from "./timeline-scroll"
import "./session-timeline.css"

// ── Major-1:Markdown 引擎窗口化 ─────────────────────────────────────────────
// 引擎(parse/sanitize/Shiki/DOM)只在视口±overscan 内实例化:离屏行渲染占位并保留
// 实测高度,进窗才挂引擎、出窗即卸载 —— 万行会话的常驻引擎实例数以窗口为上限。
// 共享一个 IntersectionObserver;不可用时(降级环境)直接实例化,不改变正确性。
const ENGINE_WINDOW_OVERSCAN = "800px 0px"
const engineWindowCallbacks = new WeakMap<Element, (visible: boolean) => void>()
let engineWindowObserver: IntersectionObserver | undefined

function observeEngineWindow(el: Element, callback: (visible: boolean) => void) {
  if (typeof IntersectionObserver === "undefined") {
    callback(true)
    return () => {}
  }
  engineWindowObserver ??= new IntersectionObserver(
    (entries) => entries.forEach((entry) => engineWindowCallbacks.get(entry.target)?.(entry.isIntersecting)),
    { rootMargin: ENGINE_WINDOW_OVERSCAN },
  )
  engineWindowCallbacks.set(el, callback)
  engineWindowObserver.observe(el)
  return () => {
    engineWindowCallbacks.delete(el)
    engineWindowObserver?.unobserve(el)
  }
}

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
  /** C6 卡片交互意图(可选):focusArtifact 接线归收口;openSession 由绑定层供给。 */
  intents?: TimelineIntents
}

const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: "short" })

function formatTime(createdAt: number) {
  return timeFormat.format(createdAt)
}

export function SessionTimelineView(props: SessionTimelineViewProps) {
  let scrollRef: HTMLDivElement | undefined
  let columnRef: HTMLDivElement | undefined
  const prepend = createPrependCoordinator()
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

  // ── Major-3:连续锚定(settling) ─────────────────────────────────────────
  // 一次性补偿会被窗口化绕过:锚上方的 deferred Markdown 行在补偿之后才实测高度。
  // 因此 prepend 开始即锁锚进入 settling 窗口:凡内容高度变化(ResizeObserver)就
  // 重算并再应用 anchorDelta,直到稳定(连续 2 次无位移)或超时;加载期间用户滚动
  // → 以滚动后的首个可见行重捕获锚,继续 settling(不放弃、不拉拽)。
  const SETTLE_QUIET_EVENTS = 2
  const SETTLE_TIMEOUT_MS = 2000

  type SettlingState = {
    epoch: string
    anchor: { el: Element; top: number } | undefined
    loadDone: boolean
    quiet: number
    timer?: ReturnType<typeof setTimeout>
  }
  let settling: SettlingState | undefined

  const endSettling = () => {
    if (settling?.timer !== undefined) clearTimeout(settling.timer)
    settling = undefined
  }
  onCleanup(endSettling)

  // 锚 = 首个进入视口的「行」元素 + 其相对滚动容器的偏移(跳过历史驻点等非行子元素,
  // 它们会随加载态消失,不配当锚)。
  const findAnchor = () => {
    if (!scrollRef || !columnRef) return undefined
    const containerTop = scrollRef.getBoundingClientRect().top
    for (const child of Array.from(columnRef.children)) {
      if (!child.hasAttribute("data-alpha-timeline-row")) continue
      const rect = child.getBoundingClientRect()
      if (rect.bottom > containerTop) return { el: child, top: rect.top - containerTop }
    }
    return undefined
  }

  /** 量一次锚、应用一次复位。返回 true = 本事件由 settling 消费(不再走贴底跟随)。 */
  const applySettling = (): boolean => {
    const state = settling
    if (!state) return false
    if (props.epoch !== state.epoch || !scrollRef) {
      // I8:换代即终结,滞后的 settling 不得触碰新会话的视口。
      endSettling()
      return false
    }
    if (!state.anchor || !state.anchor.el.isConnected) state.anchor = findAnchor()
    const anchor = state.anchor
    if (!anchor) return true
    const containerTop = scrollRef.getBoundingClientRect().top
    const nextTop = anchor.el.getBoundingClientRect().top - containerTop
    const delta = anchorDelta(anchor.top, nextTop)
    if (delta !== 0) {
      // 复位量只由锚偏移导出 —— 锚下方(底部流式)的增高不改变锚偏移,天然免疫。
      scrollRef.scrollTop += delta
      state.quiet = 0
      return true
    }
    state.quiet += 1
    if (state.loadDone && state.quiet >= SETTLE_QUIET_EVENTS) endSettling()
    return true
  }

  const triggerLoadOlder = () => {
    const epoch = props.epoch
    if (!scrollRef || !epoch || prepend.busy(epoch) || !props.history.more || props.history.loading) return
    prepend.begin(epoch)
    endSettling()
    settling = { epoch, anchor: findAnchor(), loadDone: false, quiet: 0 }
    void props
      .onLoadOlder()
      .catch(() => {})
      .finally(() => {
        prepend.finish(epoch)
        if (!settling || settling.epoch !== epoch) return
        if (props.epoch !== epoch) {
          endSettling()
          return
        }
        settling.loadDone = true
        // 同帧先复位一次(solid 同步渲染,新行已在 DOM);其余高度变化
        // (占位行进窗挂引擎等)由 RO 事件持续复位,直到稳定或超时。
        applySettling()
        if (settling) {
          if (settling.timer !== undefined) clearTimeout(settling.timer)
          settling.timer = setTimeout(endSettling, SETTLE_TIMEOUT_MS)
        }
      })
  }

  const handleScroll = () => {
    const el = scrollRef
    if (!el) return
    if (settling) {
      if (settling.epoch === props.epoch) {
        // 审计口径:加载期间滚动 → 以滚动后的首个可见行为新锚,继续 settling。
        settling.anchor = findAnchor()
        settling.quiet = 0
      } else endSettling()
    }
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

  // 内容高度变化的统一入口:settling 活跃(当前 epoch)时归锚定复位;否则做贴底跟随。
  // 贴底跟随按「当前 epoch」判定 in-flight(I8 minor):A 会话的滞后加载不得阻塞
  // B 会话的贴底跟随。
  onMount(() => {
    if (typeof ResizeObserver === "undefined" || !columnRef) return
    const observer = new ResizeObserver(() => {
      if (applySettling()) return
      if (!prepend.busy(props.epoch) && atBottom()) scrollToEnd()
    })
    observer.observe(columnRef)
    onCleanup(() => observer.disconnect())
  })

  return (
    <div class="a-tl-root" data-alpha-session-timeline>
      <TimelineIntentsContext.Provider value={props.intents ?? {}}>
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
              <div
                class="a-tl-history"
                data-alpha-timeline-history
                data-loading={props.history.loading ? "true" : undefined}
              >
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
      </TimelineIntentsContext.Provider>
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
  if (row.kind === "tool") return <TimelineToolCard part={row.part} />
  if (row.kind === "toolgroup") return <ContextToolGroupCard parts={row.parts} />
  if (row.kind === "media") return <TimelineMediaRow media={row.media} />
  if (row.kind === "artifacts") return <TimelineArtifactRows row={row} />
  if (row.kind === "retry") return <RetryCard row={row} />
  if (row.kind === "turnError") return <TurnErrorCard row={row} />
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
  // Major-1:离屏不实例化引擎。占位保留最近一次实测高度,出窗卸载、进窗重挂
  // (引擎的 block cache 使重挂只做增量工作);流式行在视口内,始终有引擎。
  const [engineLive, setEngineLive] = createSignal(false)
  const [reservedHeight, setReservedHeight] = createSignal<number>()
  let rootRef: HTMLDivElement | undefined
  onMount(() => {
    const el = rootRef
    if (!el) return
    const dispose = observeEngineWindow(el, (visible) => {
      if (visible) {
        setEngineLive(true)
        return
      }
      const height = el.getBoundingClientRect().height
      if (height > 0) setReservedHeight(height)
      setEngineLive(false)
    })
    onCleanup(dispose)
  })
  return (
    <div
      class="a-tl-row a-tl-ai"
      data-alpha-timeline-row="markdown"
      data-streaming={props.row.streaming ? "true" : undefined}
      data-engine={engineLive() ? "live" : "deferred"}
      style={!engineLive() && reservedHeight() ? { "min-height": `${reservedHeight()}px` } : undefined}
      ref={rootRef}
    >
      <Show when={engineLive()} fallback={<div class="a-tl-md-deferred" aria-hidden="true" />}>
        <TimelineMarkdown
          text={props.row.part.text ?? ""}
          cacheKey={props.row.part.id}
          streaming={props.row.streaming}
        />
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
