// REQ-125 C2 — right-rail review panel, presentational half.
//
// `SessionRailReviewPanelView` owns layout, interaction, and CSS with zero
// upstream session DOM/components (I1) and bounded rendering (I7: cards start
// collapsed, unchanged runs fold, reveals are chunked). It is deliberately free
// of any data-channel import so the component harness can mount it directly;
// the typed data container lives in `review-panel.tsx`.
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { t } from "../../../i18n"
import {
  effectiveDiffView,
  foldRevealCount,
  parseReviewPatch,
  REVIEW_SPLIT_MIN_WIDTH,
  reviewPatchOversized,
  reviewTotals,
  splitRowsOf,
  type ReviewDiffView,
  type ReviewFileChange,
  type ReviewLine,
  type ReviewPhase,
  type ReviewSegment,
} from "./review-core"
import "./review-panel.css"

export interface ReviewLineCommentIntent {
  file: string
  line: ReviewLine
}

export interface ReviewPanelViewProps {
  phase: ReviewPhase
  changes: readonly ReviewFileChange[]
  /** I8: any identity change resets panel-local view state. */
  resetKey: string
  onLineComment?: (intent: ReviewLineCommentIntent) => void
}

function reducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
}

function FileGlyph() {
  return (
    <svg class="a-rvw-fic" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6" />
    </svg>
  )
}

function ChevronGlyph(props: { class?: string }) {
  return (
    <svg class={props.class} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 6l6 6-6 6" />
    </svg>
  )
}

function UnfoldGlyph(props: { class?: string }) {
  return (
    <svg class={props.class} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 13l5 5 5-5M7 7l5 5 5-5" />
    </svg>
  )
}

function StatPair(props: { additions: number; deletions: number }) {
  return (
    <span class="a-rvw-stat" aria-label={t("alpha.review.fileStat", { additions: props.additions, deletions: props.deletions })}>
      <Show when={props.additions > 0 || props.deletions === 0}>
        <span class="a-rvw-stat-add">+{props.additions}</span>
      </Show>
      <Show when={props.deletions > 0}>
        <span class="a-rvw-stat-del">−{props.deletions}</span>
      </Show>
    </span>
  )
}

function UnifiedLine(props: { file: string; line: ReviewLine; onLineComment?: ReviewPanelViewProps["onLineComment"] }) {
  const gutter = () => {
    const value = props.line.kind === "del" ? props.line.oldLine : props.line.newLine
    return value === undefined ? "" : String(value)
  }
  return (
    <div
      class="a-rvw-dl"
      classList={{ "a-rvw-dl--add": props.line.kind === "add", "a-rvw-dl--del": props.line.kind === "del" }}
    >
      <span class="a-rvw-gut" aria-hidden="true">
        {gutter()}
      </span>
      <span class="a-rvw-sign" aria-hidden="true">
        {props.line.kind === "add" ? "+" : props.line.kind === "del" ? "−" : ""}
      </span>
      <span class="a-rvw-text">{props.line.text}</span>
      <button
        type="button"
        class="a-rvw-cmt"
        aria-label={t("alpha.review.addComment")}
        onClick={() => props.onLineComment?.({ file: props.file, line: props.line })}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
    </div>
  )
}

function SplitCell(props: { line: ReviewLine | undefined; side: "old" | "new" }) {
  const gutter = () => {
    const value = props.side === "old" ? props.line?.oldLine : props.line?.newLine
    return value === undefined ? "" : String(value)
  }
  return (
    <div
      class="a-rvw-sl"
      classList={{
        "a-rvw-sl--add": props.line?.kind === "add",
        "a-rvw-sl--del": props.line?.kind === "del",
        "a-rvw-sl--blank": props.line === undefined,
      }}
    >
      <span class="a-rvw-gut" aria-hidden="true">
        {gutter()}
      </span>
      <span class="a-rvw-text">{props.line?.text ?? ""}</span>
    </div>
  )
}

function SplitRun(props: { rows: { left?: ReviewLine; right?: ReviewLine }[] }) {
  return (
    <div class="a-rvw-split">
      <div class="a-rvw-col">
        <For each={props.rows}>{(row) => <SplitCell line={row.left} side="old" />}</For>
      </div>
      <div class="a-rvw-col">
        <For each={props.rows}>{(row) => <SplitCell line={row.right} side="new" />}</For>
      </div>
    </div>
  )
}

function ReviewFileCard(props: {
  change: ReviewFileChange
  open: boolean
  view: ReviewDiffView
  onToggle: () => void
  onLineComment?: ReviewPanelViewProps["onLineComment"]
}) {
  const kindKey = () =>
    props.change.kind === "added"
      ? ("alpha.review.kindAdded" as const)
      : props.change.kind === "deleted"
        ? ("alpha.review.kindDeleted" as const)
        : ("alpha.review.kindModified" as const)

  return (
    <article class="a-rvw-file" classList={{ "a-rvw-file--open": props.open }} data-review-file={props.change.file}>
      <button type="button" class="a-rvw-fhead" aria-expanded={props.open} onClick={props.onToggle}>
        <FileGlyph />
        <span class="a-rvw-fn">
          <Show when={props.change.dir}>
            <span class="a-rvw-dir">{props.change.dir}</span>
          </Show>
          {props.change.name}
        </span>
        <span class={`a-rvw-kind a-rvw-kind--${props.change.kind}`}>{t(kindKey())}</span>
        <StatPair additions={props.change.additions} deletions={props.change.deletions} />
        <ChevronGlyph class="a-rvw-chev" />
      </button>
      <Show when={props.open}>
        <ReviewFileBody
          change={props.change}
          view={props.view}
          onLineComment={props.onLineComment}
        />
      </Show>
    </article>
  )
}

function ReviewFileBody(props: {
  change: ReviewFileChange
  view: ReviewDiffView
  onLineComment?: ReviewPanelViewProps["onLineComment"]
}) {
  // Oversized patches never reach the parser (I6/I7): bounded placeholder instead.
  const oversized = () => !!props.change.patch && reviewPatchOversized(props.change.patch)
  // Parsed only while the card is open (I7: collapsed cards cost nothing); the
  // parsed file name must agree with the record's file (fail-closed).
  const parsed = createMemo(() =>
    props.change.patch && !oversized() ? parseReviewPatch(props.change.patch, props.change.file) : undefined,
  )
  // Fold reveals and the block cursor are card-local: collapsing a card releases them.
  const [revealClicks, setRevealClicks] = createSignal<Record<number, number>>({})
  const [blockPos, setBlockPos] = createSignal(0)
  const blockEls = new Map<number, HTMLElement>()

  const revealFold = (segmentIndex: number) =>
    setRevealClicks((current) => ({ ...current, [segmentIndex]: (current[segmentIndex] ?? 0) + 1 }))

  const goBlock = (delta: number) => {
    const total = parsed()?.blockCount ?? 0
    if (total === 0) return
    const next = Math.min(total - 1, Math.max(0, blockPos() + delta))
    setBlockPos(next)
    blockEls.get(next)?.scrollIntoView?.({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" })
  }

  const segmentView = (segment: ReviewSegment, index: number) => {
    if (segment.type === "block") {
      const lines = segment.lines
      return (
        <div
          class="a-rvw-block"
          data-review-block={segment.index}
          ref={(el) => blockEls.set(segment.index, el)}
        >
          <Show
            when={props.view === "split"}
            fallback={<For each={lines}>{(line) => <UnifiedLine file={props.change.file} line={line} onLineComment={props.onLineComment} />}</For>}
          >
            <SplitRun rows={splitRowsOf(lines)} />
          </Show>
        </div>
      )
    }
    const expandable = segment.lines.length === segment.count
    const shown = () => (expandable ? foldRevealCount(segment.count, revealClicks()[index] ?? 0) : 0)
    const remaining = () => segment.count - shown()
    const visible = () => segment.lines.slice(0, shown())
    return (
      <>
        <Show when={shown() > 0}>
          <Show
            when={props.view === "split"}
            fallback={<For each={visible()}>{(line) => <UnifiedLine file={props.change.file} line={line} onLineComment={props.onLineComment} />}</For>}
          >
            <SplitRun rows={visible().map((line) => ({ left: line, right: line }))} />
          </Show>
        </Show>
        <Show when={remaining() > 0}>
          <button
            type="button"
            class="a-rvw-fold"
            data-review-fold
            disabled={!expandable}
            onClick={() => revealFold(index)}
          >
            <UnfoldGlyph class="a-rvw-fold-ic" />
            {t("alpha.review.foldExpand", { count: remaining() })}
          </button>
        </Show>
      </>
    )
  }

  return (
    <div class="a-rvw-fbody">
      <Show when={oversized()}>
        <div class="a-rvw-nodiff" data-review-oversized>
          {t("alpha.review.oversized")}
          <StatPair additions={props.change.additions} deletions={props.change.deletions} />
        </div>
      </Show>
      <Show when={!oversized()}>
      <Show when={parsed()} fallback={<div class="a-rvw-nodiff">{t("alpha.review.noTextDiff")}</div>}>
        {(diff) => (
          <>
            <Show when={diff().blockCount > 1}>
              <div class="a-rvw-hunknav">
                <span>{t("alpha.review.hunkLabel")}</span>
                <span class="a-rvw-hunknum">
                  {Math.min(blockPos(), diff().blockCount - 1) + 1} / {diff().blockCount}
                </span>
                <span class="a-rvw-grow" aria-hidden="true" />
                <button type="button" aria-label={t("alpha.review.hunkPrev")} onClick={() => goBlock(-1)}>
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M18 15l-6-6-6 6" />
                  </svg>
                </button>
                <button type="button" aria-label={t("alpha.review.hunkNext")} onClick={() => goBlock(1)}>
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>
              </div>
            </Show>
            <div class="a-rvw-diff">
              <For each={diff().segments}>{(segment, index) => segmentView(segment, index())}</For>
            </div>
          </>
        )}
      </Show>
      </Show>
    </div>
  )
}

function ReviewEmpty(props: { kind: "no-vcs" | "clean" }) {
  return (
    <div class="a-rvw-empty" data-review-empty={props.kind}>
      <span class="a-rvw-empty-ic" aria-hidden="true">
        <Show
          when={props.kind === "no-vcs"}
          fallback={
            <svg viewBox="0 0 24 24">
              <path d="M20 6L9 17l-5-5" />
            </svg>
          }
        >
          <svg viewBox="0 0 24 24">
            <circle cx="6" cy="6" r="2.4" />
            <circle cx="6" cy="18" r="2.4" />
            <circle cx="18" cy="9" r="2.4" />
            <path d="M6 8.4v7.2M18 11.4a6 6 0 0 1-6 6H8.4" />
          </svg>
        </Show>
      </span>
      <b>{props.kind === "no-vcs" ? t("alpha.review.emptyNoVcsTitle") : t("alpha.review.emptyCleanTitle")}</b>
      <p>{props.kind === "no-vcs" ? t("alpha.review.emptyNoVcsBody") : t("alpha.review.emptyCleanBody")}</p>
    </div>
  )
}

export function SessionRailReviewPanelView(props: ReviewPanelViewProps) {
  let rootEl: HTMLElement | undefined
  const [selectedView, setSelectedView] = createSignal<ReviewDiffView>("unified")
  // A Map keeps attacker-controlled file names ("__proto__", "constructor", …)
  // from ever reading through a prototype chain; membership is a strict boolean.
  const [openFiles, setOpenFiles] = createSignal<ReadonlyMap<string, boolean>>(new Map())
  const [width, setWidth] = createSignal<number | undefined>(undefined)

  // I8: identity switches drop every piece of panel-local view state.
  createEffect(() => {
    props.resetKey
    setOpenFiles(new Map())
    setSelectedView("unified")
  })

  onMount(() => {
    if (typeof ResizeObserver === "undefined" || !rootEl) return
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width
      // Zero width means hidden/not laid out — no basis for the narrow fallback.
      if (measured) setWidth(measured)
    })
    observer.observe(rootEl)
    onCleanup(() => observer.disconnect())
  })

  // Below the approved width the split view cannot apply: the seg control must
  // show (and only offer) the state that is actually in effect.
  const narrow = () => {
    const measured = width()
    return measured !== undefined && measured < REVIEW_SPLIT_MIN_WIDTH
  }
  const view = () => effectiveDiffView(selectedView(), width())
  const totals = createMemo(() => reviewTotals(props.changes))
  const isOpen = (file: string) => openFiles().get(file) === true
  const allOpen = () => props.changes.length > 0 && props.changes.every((change) => isOpen(change.file))
  const toggleAll = () => {
    const next = !allOpen()
    setOpenFiles(new Map(props.changes.map((change) => [change.file, next])))
  }
  const toggleFile = (file: string) =>
    setOpenFiles((current) => {
      const next = new Map(current)
      next.set(file, current.get(file) !== true)
      return next
    })

  return (
    <section
      class="a-rvw-root"
      data-alpha-session-review
      data-review-phase={props.phase}
      aria-label={t("alpha.review.panelLabel")}
      ref={(el) => (rootEl = el)}
    >
      <Show when={props.phase === "no-vcs"}>
        <ReviewEmpty kind="no-vcs" />
      </Show>
      <Show when={props.phase === "clean"}>
        <ReviewEmpty kind="clean" />
      </Show>
      <Show when={props.phase === "changes"}>
        <div class="a-rvw-sum">
          <span class="a-rvw-sum-title">{t("alpha.review.title")}</span>
          <StatPair additions={totals().additions} deletions={totals().deletions} />
          <span class="a-rvw-grow" aria-hidden="true" />
          <div class="a-rvw-seg" role="group" aria-label={t("alpha.review.viewMode")}>
            <button
              type="button"
              classList={{ "a-rvw-seg--on": view() === "unified" }}
              aria-pressed={view() === "unified"}
              onClick={() => setSelectedView("unified")}
            >
              {t("alpha.review.viewUnified")}
            </button>
            <button
              type="button"
              classList={{ "a-rvw-seg--on": view() === "split" }}
              aria-pressed={view() === "split"}
              disabled={narrow()}
              onClick={() => setSelectedView("split")}
            >
              {t("alpha.review.viewSplit")}
            </button>
          </div>
          <button type="button" class="a-rvw-expand" onClick={toggleAll}>
            {allOpen() ? t("alpha.review.collapseAll") : t("alpha.review.expandAll")}
            <UnfoldGlyph class="a-rvw-expand-ic" />
          </button>
        </div>
        <div class="a-rvw-list">
          <For each={props.changes}>
            {(change) => (
              <ReviewFileCard
                change={change}
                open={isOpen(change.file)}
                view={view()}
                onToggle={() => toggleFile(change.file)}
                onLineComment={props.onLineComment}
              />
            )}
          </For>
        </div>
      </Show>
    </section>
  )
}
