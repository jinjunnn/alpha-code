// REQ-125 C5/C6 — alpha 时间线视图(呈现层,数据源无关)。
//
// 形态权威 = docs/design/current/conversation-timeline/design.html ①②③④⑥ 节帧
// (用户气泡/附件卡/内联评论卡/助手 Markdown/推理块/流式光标/回合分隔/会话内空态,
// 以及 C6 卡片全集:工具卡四态/折叠组/回合级错误/重试/媒体预览行/产物链接行)。
// 数据经 props 注入(rows 来自 timeline-model 投影),本文件零上游 session DOM/选择器依赖,
// CSS 只用 --a-* 令牌;卡片交互经可选 intents(缺席即降级为纯展示,fail-closed)。
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { t } from "../../i18n"
import {
  ContextToolGroupCard,
  RetryCard,
  TimelineArtifactRows,
  TimelineMediaRow,
  TimelineToolCard,
  TurnDiffSummaryRow,
  TurnErrorCard,
} from "./cards/tool-cards"
import { TimelineIntentsContext, type TimelineIntents, useTimelineIntents } from "./cards/timeline-intents"
import { TimelineMarkdown } from "./timeline-markdown"
import {
  boundedText,
  MARKDOWN_MAX_CHARS,
  REASONING_MAX_CHARS,
  reasoningSummary,
  type TimelineComment,
  type TimelineRow,
  type TimelineSegment,
} from "./timeline-model"
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
  /** settling 生命周期上限(测试注入用;缺省 SETTLE_TIMEOUT_MS)。 */
  settleTimeoutMs?: number
  /** 卡片交互意图(可选):#568 起由绑定层接 C4 rail api;handler 缺席即降级纯展示。 */
  intents?: TimelineIntents
  /** SDK 目录的可读显示名投影；缺席/异常时诚实回落原始 id。 */
  displayNames?: TimelineDisplayNames
}

export interface TimelineDisplayNames {
  agent: (agent: string) => string
  model: (providerID: string, modelID: string) => string
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
    // settling 的生命周期上限在进入那一刻无条件建立,不依赖任何后续事件
    // (load 挂起/中途换代都不会让 settling 泄漏);用户滚动重锚只换锚,
    // 复用同一 timer,不重置时限。
    settling = { epoch, anchor: findAnchor(), loadDone: false, quiet: 0 }
    settling.timer = setTimeout(endSettling, props.settleTimeoutMs ?? SETTLE_TIMEOUT_MS)
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
            <For each={props.rows}>{(row) => <TimelineRowView row={row} displayNames={props.displayNames} />}</For>
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

function TimelineRowView(props: { row: TimelineRow; displayNames?: TimelineDisplayNames }) {
  // 行对象引用稳定(reuseTimelineRows),kind 不随内容变化;内容字段经 store proxy 反应式读取。
  const row = props.row
  if (row.kind === "turn") return <TurnRow row={row} />
  if (row.kind === "user") return <UserRow row={row} displayNames={props.displayNames} />
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
  if (row.kind === "footnote") return <FootnoteRow row={row} />
  if (row.kind === "diffsum") return <TurnDiffSummaryRow row={row} />
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

// ── 回合末富脚注(A6/A7):agent·model·时长·tokens + hover 复制;字段诚实缺席 ──
function formatDurationSeconds(ms: number): string {
  const seconds = ms / 1000
  if (seconds < 10) return (Math.round(seconds * 10) / 10).toString()
  return Math.round(seconds).toString()
}

function formatTokens(count: number): string {
  if (count >= 1000) return `${Math.round(count / 100) / 10}k`
  return String(count)
}

/** 效率档:命中率 ≥60% 高、≥25% 中、其余低(段本身只在有缓存读取时出现,见 footnoteOf)。 */
function efficiencyLabel(percent: number): string {
  if (percent >= 60) return t("alpha.timeline.efficiencyHigh")
  if (percent >= 25) return t("alpha.timeline.efficiencyMedium")
  return t("alpha.timeline.efficiencyLow")
}

function FootnoteRow(props: { row: Extract<TimelineRow, { kind: "footnote" }> }) {
  const footnote = () => props.row.footnote
  // 复制动作:剪贴板通道缺席即不渲染按钮(fail-closed)。重试/分支钮按 owner 直令登记跳过:
  // 引擎无「重试」操作(SDK 无对应端点),分支只有 v1 `session.fork`(建新会话 + 导航,
  // 属另建链路)—— 两者均不在时间线的数据面内,不为凑形态伪造。
  const canCopy = typeof navigator !== "undefined" && !!navigator.clipboard && !!props.row.copyText()
  const copy = () => {
    try {
      void navigator.clipboard.writeText(props.row.copyText()).catch(() => {})
    } catch {
      // 剪贴板拒绝(权限/环境)→ 静默;不阻断时间线。
    }
  }
  return (
    <div class="a-tl-row a-tl-footnote" data-alpha-timeline-row="footnote">
      <Show when={footnote().provider || footnote().agent}>
        <span class="a-tl-fn-item a-tl-fn-agent">
          <Show when={footnote().provider}>
            <i class="a-tl-fn-prov" aria-hidden="true">
              {footnote().provider!.slice(0, 1).toUpperCase()}
            </i>
          </Show>
          {footnote().agent}
        </span>
      </Show>
      <Show when={footnote().model}>
        <span class="a-tl-fn-item">{footnote().model}</span>
      </Show>
      <Show when={footnote().cacheHit !== undefined}>
        <span class="a-tl-fn-item" title={t("alpha.timeline.cacheHit", { percent: footnote().cacheHit! })}>
          {efficiencyLabel(footnote().cacheHit!)}
        </span>
      </Show>
      <Show when={footnote().durationMs !== undefined}>
        <span class="a-tl-fn-item a-tl-fn-num">
          {t("alpha.timeline.reasoningDuration", { seconds: formatDurationSeconds(footnote().durationMs!) })}
        </span>
      </Show>
      <Show when={footnote().tokens !== undefined}>
        <span class="a-tl-fn-item a-tl-fn-num">
          {t("alpha.timeline.tokens", { tokens: formatTokens(footnote().tokens!) })}
        </span>
      </Show>
      <Show when={canCopy}>
        <span class="a-tl-fn-actions">
          <button
            type="button"
            title={t("alpha.timeline.copyResponse")}
            aria-label={t("alpha.timeline.copyResponse")}
            onClick={copy}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="9" y="9" width="11" height="11" rx="2" />
              <path d="M5 15V5a2 2 0 0 1 2-2h10" />
            </svg>
          </button>
        </span>
      </Show>
    </div>
  )
}

function commentRange(comment: TimelineComment) {
  if (comment.startLine === undefined) return ""
  if (comment.endLine === undefined || comment.endLine === comment.startLine)
    return t("alpha.timeline.commentLine", { line: comment.startLine })
  return t("alpha.timeline.commentLines", { start: comment.startLine, end: comment.endLine })
}

/** 连接器徽标:取来源名里的大写字母(GitHub → GH),不足两个则退回前两个字符。 */
function connectorInitials(name: string): string {
  const capitals = name.replace(/[^A-Z]/g, "").slice(0, 2)
  return capitals.length >= 2 ? capitals : name.slice(0, 2).toUpperCase()
}

/** 用户正文片段:普通文本 / 文件·子代理提及 / 连接器 chip(TL-06)。 */
function UserSegment(props: { segment: TimelineSegment }) {
  const segment = props.segment
  if (segment.kind === "resource") {
    const name = segment.label ?? segment.text
    return (
      <span class="a-tl-conn" data-mention="resource">
        <i aria-hidden="true">{connectorInitials(name)}</i>
        {name}
      </span>
    )
  }
  if (segment.kind)
    return (
      <span class="a-tl-mention" data-mention={segment.kind}>
        {segment.text}
      </span>
    )
  return <span>{segment.text}</span>
}

function displayName(read: () => string, fallback: string) {
  try {
    return read().trim() || fallback
  } catch {
    return fallback
  }
}

function UserRow(props: { row: Extract<TimelineRow, { kind: "user" }>; displayNames?: TimelineDisplayNames }) {
  const intents = useTimelineIntents()
  const meta = () => {
    const message = props.row.message
    const agent = message.agent
      ? displayName(() => props.displayNames?.agent(message.agent!) ?? message.agent!, message.agent)
      : ""
    const modelID = message.model?.modelID ?? ""
    const model = message.model
      ? displayName(
          () => props.displayNames?.model(message.model!.providerID, message.model!.modelID) ?? modelID,
          modelID,
        )
      : ""
    const items = [agent ? t("alpha.timeline.sentTo", { agent }) : "", model, formatTime(message.time.created)]
    return items.filter(Boolean).join(" · ")
  }
  const canCopy = typeof navigator !== "undefined" && !!navigator.clipboard && !!props.row.copyText()
  const copy = () => {
    try {
      void navigator.clipboard.writeText(props.row.copyText()).catch(() => {})
    } catch {
      // 剪贴板拒绝不阻断时间线。
    }
  }
  const edit = () => {
    const handler = intents.editUserMessage
    const text = props.row.copyText()
    if (!handler || !text) return
    try {
      void Promise.resolve(
        handler({ sessionID: props.row.message.sessionID, messageID: props.row.message.id, text }),
      ).catch(() => {})
    } catch {
      // 同步 handler 异常同样不得击穿时间线；生产宿主会自行给失败反馈。
    }
  }
  // 斜杠命令 chip(U 节):展开提示词默认折叠;正文缺席则 chip 不可展开。
  const [promptOpen, setPromptOpen] = createSignal(false)
  const bubbleInner = () => (
    <>
      <For each={props.row.segments}>{(segment) => <UserSegment segment={segment} />}</For>
      <Show when={props.row.truncated}>
        <span class="a-tl-truncated-inline">{t("alpha.timeline.truncated")}</span>
      </Show>
    </>
  )
  // E3/E4(对照稿 `#user` 帧1):chip 按引擎声明的 source 分型 —— skill 橙星形、mcp 紫立方、
  // 其余(含 source 缺席)保持通用「运行命令」形。来源只读声明,不从命令名反推(基线 §6/T3)。
  const chipInner = (slash: { command: string; arguments?: string; source?: "command" | "mcp" | "skill" }) => (
    <>
      <span class="a-tl-cmd-slash" aria-hidden="true">
        {slash.source === "skill" ? (
          <svg viewBox="0 0 24 24">
            <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
          </svg>
        ) : slash.source === "mcp" ? (
          <svg viewBox="0 0 24 24">
            <path d="M4 7l8-4 8 4-8 4z" />
            <path d="M4 7v10l8 4 8-4V7" />
            <path d="M12 11v10" />
          </svg>
        ) : (
          "/"
        )}
      </span>
      <span class="a-tl-cmd-lab">
        {slash.source === "skill"
          ? t("alpha.timeline.slashSkill")
          : slash.source === "mcp"
            ? t("alpha.timeline.slashMcp")
            : t("alpha.timeline.slashCommand")}
      </span>
      <span class="a-tl-cmd-name">{slash.command}</span>
      <Show when={slash.arguments}>
        <span class="a-tl-cmd-args">{slash.arguments}</span>
      </Show>
    </>
  )
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
      <Show
        when={props.row.slash}
        fallback={
          <Show when={props.row.text}>
            <div class="a-tl-bubble">{bubbleInner()}</div>
          </Show>
        }
      >
        {(slash) => (
          <div class="a-tl-cmd" data-alpha-timeline-slash data-open={promptOpen() ? "true" : undefined}>
            <Show
              when={props.row.text}
              fallback={
                <span class="a-tl-cmd-chip" data-source={slash().source}>
                  {chipInner(slash())}
                </span>
              }
            >
              <button
                type="button"
                class="a-tl-cmd-chip"
                data-source={slash().source}
                aria-expanded={promptOpen()}
                onClick={() => setPromptOpen((value) => !value)}
              >
                {chipInner(slash())}
                <span class="a-tl-cmd-more">
                  {t("alpha.timeline.slashViewPrompt")}
                  <svg class="a-tl-cmd-chev" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                </span>
              </button>
            </Show>
            <Show when={promptOpen() && props.row.text}>
              <div class="a-tl-cmd-body">{bubbleInner()}</div>
            </Show>
          </div>
        )}
      </Show>
      <div class="a-tl-user-meta">
        <span>{meta()}</span>
        <Show when={canCopy || (!!intents.editUserMessage && !!props.row.copyText())}>
          <span class="a-tl-user-actions">
            <Show when={canCopy}>
              <button
                type="button"
                title={t("alpha.timeline.copyMessage")}
                aria-label={t("alpha.timeline.copyMessage")}
                onClick={copy}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="9" y="9" width="11" height="11" rx="2" />
                  <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                </svg>
              </button>
            </Show>
            <Show when={intents.editUserMessage && !!props.row.copyText()}>
              <button
                type="button"
                title={t("alpha.timeline.editResend")}
                aria-label={t("alpha.timeline.editResend")}
                onClick={edit}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
                </svg>
              </button>
            </Show>
          </span>
        </Show>
      </div>
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
  // 流式期不读取不断增长的正文：完成态一次提取，避免折叠头随分片跳变。
  const summary = createMemo(() => (props.row.streaming ? undefined : reasoningSummary(props.row.part.text ?? "")))
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
        <Show when={seconds() !== undefined || summary()}>
          <span class="a-tl-reason-meta">
            <Show when={seconds() !== undefined}>
              <span class="a-tl-reason-duration">{t("alpha.timeline.reasoningDuration", { seconds: seconds()! })}</span>
            </Show>
            <Show when={summary()}>
              <Show when={seconds() !== undefined}>
                <span class="a-tl-reason-separator" aria-hidden="true">
                  ·
                </span>
              </Show>
              <span class="a-tl-reason-summary" title={summary()}>
                {summary()}
              </span>
            </Show>
          </span>
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
  // label 随行身份定格;compaction 的 rev 在完成态 summary 到达时变化,两种形态互不重建。
  const row = props.row
  if (row.label === "interrupted") return <InterruptedRow />
  const [open, setOpen] = createSignal(false)
  const expandable = () => row.summaryParts.length > 0
  return (
    <div
      class="a-tl-row a-tl-divider"
      data-alpha-timeline-row="divider"
      data-label={row.label}
      data-expanded={open() ? "true" : "false"}
    >
      <button
        type="button"
        class="a-tl-divider-pill"
        aria-expanded={expandable() ? open() : undefined}
        disabled={!expandable()}
        onClick={() => setOpen((value) => !value)}
      >
        <svg class="a-tl-compaction-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M8 12h8" />
        </svg>
        <span>{t("alpha.timeline.compacted")}</span>
        <Show when={expandable()}>
          <span aria-hidden="true">·</span>
          <span>{t("alpha.timeline.retainedHighlights")}</span>
          <svg class="a-tl-compaction-chevron" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9 6l6 6-6 6" />
          </svg>
        </Show>
      </button>
      <Show when={open() && expandable()}>
        <div class="a-tl-compaction-body" data-alpha-compaction-summary="true">
          <For each={row.summaryParts}>
            {(part) => (
              <TimelineMarkdown
                text={boundedText(part.text ?? "", MARKDOWN_MAX_CHARS).text}
                cacheKey={`compaction:${part.id}`}
                streaming={false}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

// 中断态(design ② .interrupted 帧):左对齐安静行,不是居中告警 pill。
// 「继续生成」经 continueTurn intent 接绑定层的现有会话发送入口;intent 缺席即只剩事实陈述
// (fail-closed,不给一个点不动的按钮)。发送失败(admission 前被拒/网络断开)不产生任何
// session_status 事件,typed 通道呈现不了 —— rejection 在此就地给出失败提示,再点即重试
// (审计 R1 Major:此前同步与异步错误全被吞掉,用户点了没反应)。
function InterruptedRow() {
  const intents = useTimelineIntents()
  const [sendFailed, setSendFailed] = createSignal(false)
  return (
    <div class="a-tl-row a-tl-interrupted" data-alpha-timeline-row="divider" data-label="interrupted">
      <svg class="a-tl-int-stop" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="7" y="7" width="10" height="10" rx="2" />
      </svg>
      <span>{t("alpha.timeline.interrupted")}</span>
      <Show when={intents.continueTurn}>
        {(handler) => (
          <>
            <span class="a-tl-int-dot" aria-hidden="true" />
            <button
              type="button"
              class="a-tl-int-continue"
              onClick={() => {
                setSendFailed(false)
                void Promise.resolve(handler()()).catch(() => setSendFailed(true))
              }}
            >
              {t("alpha.timeline.continueTurn")}
            </button>
            <Show when={sendFailed()}>
              <span class="a-tl-int-failed" role="status">
                {t("alpha.timeline.continueFailed")}
              </span>
            </Show>
          </>
        )}
      </Show>
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
