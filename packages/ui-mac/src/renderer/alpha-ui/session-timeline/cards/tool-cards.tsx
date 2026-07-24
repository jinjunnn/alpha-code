// REQ-125 C6 — alpha 时间线卡片全集(呈现层)。
//
// 形态权威 = docs/design/current/conversation-timeline/design.html ②③④⑥ 节帧:
// 通用工具卡四态(运行扫线/呼吸)、各工具分支体、task v2(agent 色点+环形+打开子会话)、
// 回合级错误卡 / 工具级错误态 / 重试卡、「已探索」折叠组、媒体预览行、产物链接行。
// 数据全部经 store proxy 反应式读取(行对象引用稳定);内容一律纯文本节点(I3),
// 输出体有界(I7,tool-card-model 的双帽);CSS 只用 --a-* 令牌(I5)。
// 未知工具 fail-closed:有界纯文本通用卡。
import type { FilePart, ToolPart } from "@opencode-ai/sdk/v2/client"
import { createMemo, createSignal, For, type JSX, Show } from "solid-js"
import { t } from "../../../i18n"
import type { TimelineRow } from "../timeline-model"
import {
  basenameOf,
  contextGroupSummaryOf,
  contextRowOf,
  dirnameOf,
  mediaLabelOf,
  mediaThumbable,
  taskCardInfoOf,
  toolCardBodyOf,
  toolCardHeadOf,
  type ToolCardBody,
  type ToolCardHead,
} from "./tool-card-model"
import { diffViewOf } from "./tool-diff"
import { useTimelineIntents } from "./timeline-intents"
import "./cards.css"

// ── 图标(design.html 帧内路径的本地内联版) ─────────────────────────────────
function icons(kind: string): JSX.Element {
  switch (kind) {
    case "read":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
          <circle cx="12" cy="12" r="2.5" />
        </svg>
      )
    case "list":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
        </svg>
      )
    case "glob":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 7l2-3h5l2 3h7v11H3z" />
          <path d="M8 13h8" />
        </svg>
      )
    case "grep":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.3-4.3" />
        </svg>
      )
    case "webfetch":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
          <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
        </svg>
      )
    case "websearch":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z" />
        </svg>
      )
    case "bash":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 17l6-6-6-6M12 19h8" />
        </svg>
      )
    case "edit":
    case "apply_patch":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
        </svg>
      )
    case "write":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
          <path d="M14 3v6h6" />
        </svg>
      )
    case "skill":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3l2.5 5.5L20 11l-5.5 2.5L12 19l-2.5-5.5L4 11l5.5-2.5z" />
        </svg>
      )
    case "task":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      )
    default:
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 7l8-4 8 4-8 4z" />
          <path d="M4 7v10l8 4 8-4V7" />
          <path d="M12 11v10" />
        </svg>
      )
  }
}

function chevron() {
  return (
    <svg class="a-tc-chev" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 6l6 6-6 6" />
    </svg>
  )
}

// ── 状态徽标 ────────────────────────────────────────────────────────────────
function StatusChip(props: { head: ToolCardHead }) {
  const label = () => {
    const head = props.head
    if (head.status === "pending") return t("alpha.timeline.toolPending")
    if (head.status === "running") return t("alpha.timeline.toolRunning")
    if (head.status === "error") return t("alpha.timeline.toolError")
    if (head.kind === "bash" && head.exit !== undefined) return t("alpha.timeline.exit", { code: head.exit })
    if (head.kind === "skill") return t("alpha.timeline.skillLoaded")
    if (head.count) {
      if (head.count.unit === "matches") return t("alpha.timeline.countMatches", { count: head.count.value })
      return t("alpha.timeline.countFiles", { count: head.count.value })
    }
    return t("alpha.timeline.toolCompleted")
  }
  const tone = () => {
    const head = props.head
    if (head.status === "running") return "running"
    if (head.status === "error") return "error"
    if (head.status === "pending") return "muted"
    if (head.kind === "bash" && head.exit !== undefined) return head.exit === 0 ? "ok" : "error"
    if (head.kind === "skill") return "ok"
    return "muted"
  }
  return (
    <span class="a-tc-status" data-tone={tone()}>
      <Show when={props.head.status === "running"}>
        <span class="a-tc-spin" aria-hidden="true" />
      </Show>
      {label()}
    </span>
  )
}

function StatBadge(props: { stat: { additions: number; deletions: number } }) {
  return (
    <span class="a-tc-stat">
      <Show when={props.stat.additions > 0}>
        <span class="a-tc-stat-add">+{props.stat.additions}</span>
      </Show>
      <Show when={props.stat.deletions > 0}>
        <span class="a-tc-stat-del">−{props.stat.deletions}</span>
      </Show>
    </span>
  )
}

// ── 输出体分支 ──────────────────────────────────────────────────────────────
function TruncatedNote() {
  return <div class="a-tc-truncated">{t("alpha.timeline.truncated")}</div>
}

function CardBody(props: { head: ToolCardHead; body: ToolCardBody }) {
  const term = () => (props.body.type === "term" ? props.body : undefined)
  const text = () => (props.body.type === "text" ? props.body : undefined)
  const files = () => (props.body.type === "files" ? props.body : undefined)
  const links = () => (props.body.type === "links" ? props.body : undefined)
  const diff = () => (props.body.type === "diff" ? props.body : undefined)
  const write = () => (props.body.type === "write" ? props.body : undefined)
  const patch = () => (props.body.type === "patch" ? props.body : undefined)
  const error = () => (props.body.type === "error" ? props.body : undefined)
  return (
    <>
      <Show when={term()}>
        {(body) => (
          <div class="a-tc-term" data-streaming={body().streaming ? "true" : undefined}>
            <Show when={props.head.target}>
              <span class="a-tc-pmt">$ </span>
              {props.head.target}
              {"\n"}
            </Show>
            {body().output}
            <Show when={body().streaming}>
              <span class="a-tc-cursor" aria-hidden="true" />
            </Show>
            <Show when={body().truncated}>
              <TruncatedNote />
            </Show>
          </div>
        )}
      </Show>
      <Show when={text()}>
        {(body) => (
          <div class="a-tc-out">
            {body().text}
            <Show when={body().truncated}>
              <TruncatedNote />
            </Show>
          </div>
        )}
      </Show>
      <Show when={files()}>
        {(body) => (
          <div class="a-tc-files">
            <For each={body().files}>
              {(file) => (
                <div class="a-tc-file-row">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
                    <path d="M14 3v6h6" />
                  </svg>
                  <span class="a-tc-file-dir">{dirnameOf(file)}</span>
                  <span class="a-tc-file-name">{basenameOf(file)}</span>
                </div>
              )}
            </For>
            <Show when={body().truncated}>
              <TruncatedNote />
            </Show>
          </div>
        )}
      </Show>
      <Show when={links()}>
        {(body) => (
          <div class="a-tc-links">
            <For each={body().urls}>
              {(url) => (
                <a class="a-tc-link" href={url} target="_blank" rel="noopener noreferrer">
                  {url}
                </a>
              )}
            </For>
            <Show when={body().truncated}>
              <TruncatedNote />
            </Show>
          </div>
        )}
      </Show>
      <Show when={diff()}>{(body) => <DiffBody patch={body().patch} />}</Show>
      <Show when={write()}>
        {(body) => (
          <div class="a-tc-out">
            {body().preview.join("\n")}
            <div class="a-tc-write-note">{t("alpha.timeline.writeLines", { count: body().totalLines })}</div>
          </div>
        )}
      </Show>
      <Show when={patch()}>
        {(body) => (
          <div class="a-tc-patch">
            <For each={body().files}>
              {(file) => (
                <div class="a-tc-patch-row">
                  <FileBadge badge={file.badge} />
                  <span class="a-tc-file-dir">{dirnameOf(file.path)}</span>
                  <span class="a-tc-file-name">{basenameOf(file.path)}</span>
                  <StatBadge stat={{ additions: file.additions, deletions: file.deletions }} />
                </div>
              )}
            </For>
            <Show when={body().truncated}>
              <TruncatedNote />
            </Show>
          </div>
        )}
      </Show>
      <Show when={error()}>
        {(body) => (
          <div class="a-tc-error-body" role="alert">
            {body().message}
            <Show when={body().truncated}>
              <TruncatedNote />
            </Show>
          </div>
        )}
      </Show>
    </>
  )
}

const BADGE_KEYS = {
  add: "alpha.timeline.badgeAdd",
  modify: "alpha.timeline.badgeModify",
  delete: "alpha.timeline.badgeDelete",
  move: "alpha.timeline.badgeMove",
  read: "alpha.timeline.badgeRead",
  write: "alpha.timeline.badgeWrite",
} as const

/** 文件行徽章六态(读取/写入/移动/新增/修改/删除)。 */
export function FileBadge(props: { badge: keyof typeof BADGE_KEYS }) {
  return (
    <span class="a-tc-badge" data-badge={props.badge}>
      {t(BADGE_KEYS[props.badge])}
    </span>
  )
}

function DiffBody(props: { patch: string }) {
  const view = createMemo(() => diffViewOf(props.patch))
  return (
    <Show when={!view().unavailable} fallback={<div class="a-tc-out">{t("alpha.timeline.diffUnavailable")}</div>}>
      <div class="a-tc-diff">
        <For each={view().rows}>
          {(row) => (
            <Show when={row.kind !== "gap"} fallback={<div class="a-tc-diff-gap" aria-hidden="true" />}>
              <div class="a-tc-diff-line" data-kind={row.kind}>
                <span class="a-tc-diff-gut">{row.kind === "add" ? row.newLine : row.oldLine}</span>
                <span class="a-tc-diff-sign">{row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}</span>
                <span class="a-tc-diff-text">{row.text}</span>
              </div>
            </Show>
          )}
        </For>
        <Show when={view().truncated}>
          <TruncatedNote />
        </Show>
      </div>
    </Show>
  )
}

// ── 通用工具卡(四态外壳 + 分派) ───────────────────────────────────────────
export function TimelineToolCard(props: { part: ToolPart }) {
  const head = createMemo(() => toolCardHeadOf(props.part))
  const body = createMemo(() => toolCardBodyOf(props.part))
  const hasBody = () => body().type !== "none"
  // 默认展开:终端流(bash)/错误体;其余折叠,用户可切换(状态机只认显式选择)。
  const [chosen, setChosen] = createSignal<boolean>()
  const open = () => chosen() ?? (body().type === "term" || body().type === "error")
  const description = () => {
    const input = props.part.state.input
    const value =
      typeof input === "object" && input !== null ? (input as { description?: unknown }).description : undefined
    return typeof value === "string" && value && head().kind === "bash" ? value : undefined
  }
  const task = createMemo(() => (head().kind === "task" ? taskCardInfoOf(props.part) : undefined))
  const intents = useTimelineIntents()

  const headInner = () => (
    <>
      <span class="a-tc-ico" data-kind={head().kind} aria-hidden="true">
        {icons(head().kind)}
      </span>
      <span class="a-tc-title">
        <Show when={head().titleKey} fallback={<b class="a-tc-name">{head().toolName}</b>}>
          <b>{t(head().titleKey! as Parameters<typeof t>[0])}</b>
        </Show>
        <Show when={head().target}>
          <span class="a-tc-target">{head().target}</span>
        </Show>
        <Show when={head().detail}>
          <span class="a-tc-detail">{head().detail}</span>
        </Show>
        <Show when={task()?.agent}>
          <span class="a-tc-agent">
            <i aria-hidden="true" />
            {task()!.agent}
          </span>
        </Show>
      </span>
      <Show when={head().stat}>{(stat) => <StatBadge stat={stat()} />}</Show>
      <Show when={task() && head().status === "running"}>
        <span class="a-tc-ring" aria-hidden="true" />
      </Show>
      <StatusChip head={head()} />
    </>
  )

  return (
    <section
      class="a-tl-row a-tc"
      data-alpha-timeline-row="tool"
      data-alpha-tool-card
      data-kind={head().kind}
      data-tool={props.part.tool}
      data-status={head().status}
      data-open={hasBody() && open() ? "true" : undefined}
    >
      <Show when={hasBody()} fallback={<div class="a-tc-head">{headInner()}</div>}>
        <button type="button" class="a-tc-head" aria-expanded={open()} onClick={() => setChosen(!open())}>
          {headInner()}
          {chevron()}
        </button>
      </Show>
      <Show when={task()?.childSessionID && intents.openSession}>
        <div class="a-tc-actions">
          <button type="button" class="a-tc-open" onClick={() => intents.openSession!(task()!.childSessionID!)}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M15 3h6v6M10 14L21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
            </svg>
            {t("alpha.timeline.openSubtask")}
          </button>
        </div>
      </Show>
      <Show when={description()}>
        <div class="a-tc-subdesc">{description()}</div>
      </Show>
      <Show when={hasBody() && open()}>
        <div class="a-tc-body">
          <CardBody head={head()} body={body()} />
        </div>
      </Show>
    </section>
  )
}

// ── 「已探索」折叠组 ────────────────────────────────────────────────────────
export function ContextToolGroupCard(props: { parts: ToolPart[] }) {
  const [open, setOpen] = createSignal(false)
  const summary = createMemo(() => contextGroupSummaryOf(props.parts))
  const summaryText = () => {
    const value = summary()
    const segments: string[] = []
    if (value.reads > 0) segments.push(t("alpha.timeline.exploreReads", { count: value.reads }))
    if (value.searches > 0) segments.push(t("alpha.timeline.exploreSearches", { count: value.searches }))
    if (value.lists > 0) segments.push(t("alpha.timeline.exploreLists", { count: value.lists }))
    return segments.join(" · ")
  }
  return (
    <section class="a-tl-row a-explore" data-alpha-timeline-row="toolgroup" data-open={open() ? "true" : undefined}>
      <button type="button" class="a-explore-head" aria-expanded={open()} onClick={() => setOpen((value) => !value)}>
        <span class="a-explore-ico" aria-hidden="true">
          {icons("read")}
        </span>
        <span class="a-explore-label">{t("alpha.timeline.explored")}</span>
        <span class="a-explore-count">· {summaryText()}</span>
        {chevron()}
      </button>
      <Show when={open()}>
        <div class="a-explore-body">
          <For each={props.parts}>
            {(part) => {
              const row = () => contextRowOf(part)
              return (
                <div class="a-explore-row" data-tool={part.tool}>
                  <span class="a-explore-ri" data-kind={row().tool} aria-hidden="true">
                    {icons(row().tool)}
                  </span>
                  <span class="a-explore-verb" data-kind={row().tool}>
                    <Show when={row().titleKey} fallback={row().tool}>
                      {t(row().titleKey! as Parameters<typeof t>[0])}
                    </Show>
                  </span>
                  <Show when={row().target}>
                    <span class="a-explore-target">{row().target}</span>
                  </Show>
                  <Show when={row().args.length > 0}>
                    <span class="a-explore-arg">{row().args.join(" ")}</span>
                  </Show>
                </div>
              )
            }}
          </For>
        </div>
      </Show>
    </section>
  )
}

// ── 回合级错误卡(全宽,纯文本,无动作) ────────────────────────────────────
export function TurnErrorCard(props: { row: Extract<TimelineRow, { kind: "turnError" }> }) {
  return (
    <div class="a-tl-row a-turn-err" data-alpha-timeline-row="turn-error" role="alert">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v5M12 16h.01" />
      </svg>
      <div class="a-turn-err-content">
        <b>{t("alpha.timeline.turnErrorTitle")}</b>
        <Show when={props.row.message}>
          <p>{props.row.message}</p>
        </Show>
        <span class="a-turn-err-code">{props.row.name}</span>
      </div>
    </div>
  )
}

// ── 重试卡 ──────────────────────────────────────────────────────────────────
export function RetryCard(props: { row: Extract<TimelineRow, { kind: "retry" }> }) {
  return (
    <div class="a-tl-row a-retry" data-alpha-timeline-row="retry" role="status">
      <span class="a-retry-spin" aria-hidden="true" />
      <span>{t("alpha.timeline.retrying", { attempt: props.row.attempt })}</span>
      <Show when={props.row.message}>
        <span class="a-retry-message">{props.row.message}</span>
      </Show>
    </div>
  )
}

// ── 助手侧媒体预览行 ────────────────────────────────────────────────────────
export function TimelineMediaRow(props: { part: FilePart }) {
  const intents = useTimelineIntents()
  const name = () => props.part.filename?.trim() || props.part.mime
  const label = () => mediaLabelOf(props.part.mime, name())
  const inner = (
    <>
      <span class="a-media-thumb" aria-hidden="true">
        <Show
          when={mediaThumbable(props.part.url)}
          fallback={
            <svg viewBox="0 0 24 24">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <circle cx="8.5" cy="10" r="1.6" />
              <path d="M21 16l-5-5L6 20" />
            </svg>
          }
        >
          <img src={props.part.url} alt="" loading="lazy" />
        </Show>
      </span>
      <span class="a-media-name">
        <b>{name()}</b>
        <small>{label()}</small>
      </span>
    </>
  )
  return (
    <div class="a-tl-row a-media" data-alpha-timeline-row="media">
      <Show when={intents.focusArtifact} fallback={<div class="a-media-row">{inner}</div>}>
        <button
          type="button"
          class="a-media-row"
          onClick={() => intents.focusArtifact!({ name: name(), partID: props.part.id, mime: props.part.mime })}
        >
          {inner}
        </button>
      </Show>
    </div>
  )
}

// ── 产物链接行(§⑥ 已批形态) ──────────────────────────────────────────────
export function TimelineArtifactRows(props: { row: Extract<TimelineRow, { kind: "artifacts" }> }) {
  const intents = useTimelineIntents()
  return (
    <div
      class="a-tl-row a-artrows"
      data-alpha-timeline-row="artifacts"
      role="list"
      aria-label={t("alpha.timeline.artifactsLabel")}
    >
      <For each={props.row.links}>
        {(link) => (
          <button
            type="button"
            class="a-artrow"
            role="listitem"
            disabled={!intents.focusArtifact}
            onClick={() => intents.focusArtifact?.({ name: link.name, runId: link.runId })}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
              <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
            </svg>
            <span class="a-artrow-name">{link.name}</span>
          </button>
        )}
      </For>
    </div>
  )
}
