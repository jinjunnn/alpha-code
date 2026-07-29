// REQ-125 C4 — right-rail artifacts host, presentational half.
//
// This is an embedding context, not a redesign (approved frame: "产物面板…既批形态原样"):
// card list, state chips, preview tabs, and preview body all reuse the artifact-workbench
// language verbatim — its class names, label keys, and renderer components (I5). The file
// owns only the rail-specific chrome with `--a-*` tokens: the #660 run bar family
// (`.a-rart-runbar/-runsheet/-runrow/-runfoot/-newrun`), the quiet empty states, and the
// focus mount point. It is deliberately free of any IPC import so the component harness can
// mount it directly; the typed data container lives in `session-rail-artifacts.tsx`.
//
// #660 discipline (design §① / decision D): no copy in this panel may make a session-level
// claim over project-level data — the run bar states which run is shown, nothing more.
import { createEffect, createMemo, createSignal, ErrorBoundary, For, Index, onCleanup, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import { t } from "../../../i18n"
import { MetadataView, STATE_LABEL_KEYS, TAB_LABEL_KEYS } from "../../artifact-workbench/artifact-workbench"
import {
  downloadBusy,
  formatBytes,
  type ArtifactCard,
  type DownloadPhase,
} from "../../artifact-workbench/workbench-core"
import {
  RENDERER_COMPONENTS,
  SourceView,
  type PreviewContext,
} from "../../artifact-workbench/renderers/renderer-views"
import type { OfficeStructurePresentation } from "../../artifact-workbench/renderers/office-structure"
import { rovingKey, rovingTabIndex } from "../../roving-focus"
import { shortRunId, type ArtifactsPhase, type RunMoment, type RunRowModel } from "./artifacts-core"
import "./session-rail-artifacts.css"

type PreviewMode = "preview" | "source" | "metadata"

const MODES: readonly PreviewMode[] = ["preview", "source", "metadata"]

export interface ArtifactsPanelViewProps {
  phase: ArtifactsPhase
  errorReason?: string
  /** #660: this project's runs, already in true chronological order (B1). */
  runs: readonly RunRowModel[]
  selectedRunId?: string
  onSelectRun: (runId: string) => void
  onRefresh: () => void
  /** #660 A1: a foreign run landed — prompt bar + dot; never steals focus or switches. */
  newRunHint: boolean
  onViewNewRun: () => void
  quota?: { usedBytes: number; maxBytes: number }
  /** Honest degradation: platform listing unreachable — local cards still render. */
  cloudUnavailable: boolean
  cards: readonly ArtifactCard[]
  selectedKey: string | null
  onSelect: (key: string) => void
  onRetry: () => void
  verifying: boolean
  /** REQ-093 AC#4: a failed pre-open re-check renders honestly instead of a preview. */
  verifyFailure?: string
  previewCtx: PreviewContext | null
  /** Focus mount point (timeline linkage): each bump moves DOM focus to the selected card. */
  focusSeq: number
  /** Approved linkage contract: Esc returns focus to the originating row. */
  onEscape?: () => void
  /** #660: single-item retrieval state, keyed by original artifact id. */
  downloadPhases: Record<string, DownloadPhase>
  onDownload: (card: ArtifactCard) => void
  onCancelDownload: (card: ArtifactCard) => void
}

function officeStatusLabel(status: OfficeStructurePresentation): string {
  if (status.status === "checking") return t("alpha.wb.office.status.checking")
  if (status.status === "pass") return t("alpha.wb.office.status.pass")
  return t("alpha.wb.office.status.rejected")
}

/** RunMoment → user copy. Callers fall back to the short id when the moment is null (B1 fail-closed). */
function momentLabel(moment: RunMoment): string {
  if (moment.kind === "today") return t("alpha.session.artifactsRunToday", { time: moment.time })
  if (moment.kind === "yesterday") return t("alpha.session.artifactsRunYesterday", { time: moment.time })
  if (moment.kind === "date")
    return t("alpha.session.artifactsRunDate", { month: String(moment.month), day: String(moment.day), time: moment.time })
  return t("alpha.session.artifactsRunDateYear", {
    year: String(moment.year),
    month: String(moment.month),
    day: String(moment.day),
    time: moment.time,
  })
}

function ordinalLabel(row: RunRowModel): string | undefined {
  if (row.ordinal === "latest") return t("alpha.session.artifactsRunLatest")
  if (row.ordinal === "previous") return t("alpha.session.artifactsRunPrevious")
  return undefined
}

/** Original artifact id for download-phase lookup (never card.key — legacy keys differ). */
function downloadIdOf(card: ArtifactCard): string | undefined {
  const payload = card.downloadPayload
  return payload && typeof payload.id === "string" ? payload.id : card.descriptor?.id
}

export function SessionRailArtifactsView(props: ArtifactsPanelViewProps) {
  const [mode, setMode] = createSignal<PreviewMode>("preview")
  const [runsOpen, setRunsOpen] = createSignal(false)
  const cardEls = new Map<string, HTMLElement>()
  const selectedCard = createMemo(() => props.cards.find((card) => card.key === props.selectedKey) ?? null)
  const barRow = createMemo(() => props.runs.find((row) => row.runId === props.selectedRunId))
  const phaseOf = (card: ArtifactCard): DownloadPhase => {
    const id = downloadIdOf(card)
    return (id ? props.downloadPhases[id] : undefined) ?? { status: "idle" }
  }
  const downloadFailure = createMemo(() => {
    for (const card of props.cards) {
      const phase = phaseOf(card)
      if (phase.status === "error") return phase.message
    }
    return undefined
  })
  // aria-live download progress (polite, non-interrupting — REQ-094 AC#6 language).
  const liveDownloadText = createMemo(() => {
    for (const card of props.cards) {
      const phase = phaseOf(card)
      if (phase.status === "downloading")
        return t("alpha.wb.downloadingLive", {
          name: card.name,
          progress: phase.percent !== undefined ? `${phase.percent}%` : formatBytes(phase.bytes),
        })
    }
    return ""
  })

  // Mode is per-selection presentation state: switching artifacts returns to Preview.
  createEffect(() => {
    props.selectedKey
    setMode("preview")
  })
  // Switching runs closes the sheet (the pick is done; the panel below changes content).
  createEffect(() => {
    props.selectedRunId
    setRunsOpen(false)
  })

  // Focus mount point: the container bumps `focusSeq` after applying a timeline focus
  // request; DOM focus lands on the selected card (Esc then returns via onEscape).
  createEffect(() => {
    if (props.focusSeq === 0) return
    const key = props.selectedKey
    if (key === null) return
    cardEls.get(key)?.focus()
  })

  const onModeKey = (event: KeyboardEvent) =>
    rovingKey(event, "horizontal-tabs", MODES, mode(), (next) => {
      setMode(next)
      document.getElementById(`a-rart-tab-${next}`)?.focus()
    })

  const onRootKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return
    props.onEscape?.()
  }

  const quotaPercent = () => {
    const quota = props.quota
    if (!quota || quota.maxBytes <= 0) return 0
    return Math.min(100, Math.round((quota.usedBytes / quota.maxBytes) * 100))
  }

  const cardActions = (card: ArtifactCard) => (
    <Show when={card.downloadable}>
      <span class="alpha-wb-card-actions">
        <Show
          when={phaseOf(card).status === "done"}
          fallback={
            <>
              <Show
                when={downloadBusy(phaseOf(card))}
                fallback={
                  <button type="button" class="a-wb-btn" data-variant="primary" onClick={() => props.onDownload(card)}>
                    {phaseOf(card).status === "error" ? t("alpha.wb.retry") : t("alpha.wb.download")}
                  </button>
                }
              >
                <span class="alpha-wb-progress">
                  {(() => {
                    const phase = phaseOf(card)
                    return phase.status === "downloading" && phase.percent !== undefined
                      ? `${phase.percent}%`
                      : t("alpha.wb.downloading")
                  })()}
                </span>
                <button type="button" class="a-wb-btn" onClick={() => props.onCancelDownload(card)}>
                  {t("alpha.wb.cancel")}
                </button>
              </Show>
              <Show when={phaseOf(card).status === "error"}>
                <span class="a-wb-chip" data-kind="error" data-download-error>
                  {t("alpha.wb.downloadFailed")}
                </span>
              </Show>
            </>
          }
        >
          {/* Major-3: bytes landed, manifest reread in flight — a non-clickable 已验证,
              never a second 「下载」. The container resets this phase once the reread
              replaces the card with the local verified one. */}
          <span class="a-wb-chip" data-state="verified" data-download-done>
            {t("alpha.wb.state.verified")}
          </span>
        </Show>
      </span>
    </Show>
  )

  return (
    <section
      class="a-rart-root"
      data-alpha-session-artifacts
      data-artifacts-phase={props.phase}
      aria-label={t("alpha.session.artifactsPanelLabel")}
      onKeyDown={onRootKey}
    >
      <Show when={props.phase === "loading"}>
        <div class="a-rart-status">{t("alpha.wb.loading")}</div>
      </Show>
      {/* #660 run bar: outside the scroll column on purpose — an unreadable run must not
          drag the switcher down with it (the bar is the way OUT of a broken run). It renders
          whenever a run is selected; with zero runs there is nothing to switch, so no bar. */}
      <Show when={barRow()}>
        {(row) => (
          <>
            <div class="a-rart-runbar" data-artifacts-runbar>
              <button
                type="button"
                class="a-rart-runhead"
                aria-expanded={runsOpen()}
                aria-controls="a-rart-runsheet"
                onClick={() => setRunsOpen((open) => !open)}
              >
                <span class="a-rart-runhead-tm">
                  {row().moment ? momentLabel(row().moment!) : shortRunId(row().runId)}
                </span>
                <Show when={ordinalLabel(row())}>
                  <span class="a-rart-runhead-lb">{ordinalLabel(row())}</span>
                </Show>
                {/* B1: the id is demoted to this one tertiary slot — full value on hover. */}
                <span class="a-rart-runhead-id" title={row().runId}>
                  {shortRunId(row().runId)}
                </span>
                <svg class="a-rart-runhead-chev" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
              <button
                type="button"
                class="a-rart-iconbtn"
                aria-label={t("alpha.session.artifactsRefresh")}
                data-alert={props.newRunHint ? "" : undefined}
                onClick={props.onRefresh}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M20 11a8 8 0 1 0-.6 4" />
                  <path d="M20 5v6h-6" />
                </svg>
              </button>
            </div>
            <Show when={runsOpen()}>
              <div class="a-rart-runsheet" id="a-rart-runsheet">
                <ul class="a-rart-runlist" role="list" aria-label={t("alpha.session.artifactsRunsLabel")}>
                  <For each={props.runs}>
                    {(runRow) => (
                      <li>
                        <button
                          type="button"
                          class="a-rart-runrow"
                          data-run-row={runRow.runId}
                          data-active={props.selectedRunId === runRow.runId ? "" : undefined}
                          onClick={() => props.onSelectRun(runRow.runId)}
                        >
                          <span class="a-rart-runrow-t">
                            {/* Rows carry no id — unless the time is unreadable, then the id
                                is the honest fallback (never an invented time). */}
                            <span class="a-rart-runrow-tm">
                              {runRow.moment ? momentLabel(runRow.moment) : shortRunId(runRow.runId)}
                            </span>
                            <Show when={ordinalLabel(runRow)}>
                              <span class="a-rart-runrow-nm">{ordinalLabel(runRow)}</span>
                            </Show>
                          </span>
                          <span class="a-rart-runrow-m">
                            {t("alpha.wb.runMeta", {
                              count: String(runRow.artifactCount),
                              bytes: formatBytes(runRow.diskBytes),
                            })}
                            <Show when={runRow.missingCount > 0}>
                              <span class="a-wb-chip" data-kind="warn">
                                {t("alpha.wb.runMissing", { count: String(runRow.missingCount) })}
                              </span>
                            </Show>
                            <Show when={runRow.readOnly}>
                              <span class="a-wb-chip" data-kind="warn">
                                {t("alpha.wb.runReadOnly")}
                              </span>
                            </Show>
                          </span>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
                <Show when={props.quota}>
                  {(quota) => (
                    <div class="a-rart-runfoot">
                      <span>
                        {t("alpha.wb.usageProject", {
                          bytes: formatBytes(quota().usedBytes),
                          limit: formatBytes(quota().maxBytes),
                        })}
                      </span>
                      <span class="a-rart-runfoot-bar" aria-hidden="true">
                        <i style={{ width: `${quotaPercent()}%` }} />
                      </span>
                    </div>
                  )}
                </Show>
              </div>
            </Show>
            <Show when={props.newRunHint}>
              {/* A1 committed form: pointable prompt + dot. role=status (polite) — it must
                  never steal focus or auto-switch away from what the user is reading. */}
              <div class="a-rart-newrun" role="status" data-artifacts-newrun>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 3v12" />
                  <path d="M7 10l5 5 5-5" />
                  <path d="M4 20h16" />
                </svg>
                <span class="a-rart-newrun-tx">{t("alpha.session.artifactsNewRun")}</span>
                <button type="button" class="a-rart-newrun-lk" onClick={props.onViewNewRun}>
                  {t("alpha.session.artifactsNewRunView")}
                </button>
              </div>
            </Show>
          </>
        )}
      </Show>
      <Show when={props.phase === "error"}>
        <div class="a-rart-status">
          <div class="a-wb-notice" data-kind="error">
            {t("alpha.wb.listFailed")}
            <Show when={props.errorReason}>:{props.errorReason}</Show>
          </div>
          <button type="button" class="a-wb-btn" onClick={props.onRetry}>
            {t("alpha.wb.retry")}
          </button>
        </div>
      </Show>
      <Show when={props.phase === "empty"}>
        {/* Proven empty at project level: no runs at all — no bar (a switcher over an empty
            set is noise), the stock quiet copy. */}
        <div class="a-rart-empty" data-artifacts-empty>
          <span class="a-rart-empty-ic" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
              <path d="M14 3v6h6" />
            </svg>
          </span>
          <b>{t("alpha.session.artifactsEmptyTitle")}</b>
          <p>{t("alpha.session.artifactsEmptyDetail")}</p>
        </div>
      </Show>
      <Show when={props.phase === "empty-run"}>
        {/* PROVEN empty at run level: local list AND the platform listing both answered and
            the merged result is empty. The bar stays — the user must be able to switch away
            from here (never merged with the project empty). */}
        <div class="a-rart-empty" data-artifacts-empty-run>
          <span class="a-rart-empty-ic" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
              <path d="M14 3v6h6" />
            </svg>
          </span>
          <b>{t("alpha.session.artifactsRunEmptyTitle")}</b>
          <p>{t("alpha.session.artifactsRunEmptyDetail")}</p>
        </div>
      </Show>
      <Show when={props.phase === "empty-unknown"}>
        {/* Major-2: local shows nothing and the platform listing is unreachable — say only
            that, never claim the run is empty. The bar stays so the user can switch away. */}
        <div class="a-rart-status" data-artifacts-cloud-unknown>
          <div class="a-wb-notice" data-cloud-unavailable>{t("alpha.wb.cloudListFailed")}</div>
        </div>
      </Show>
      <Show when={props.phase === "cards"}>
        <div class="a-rart-scroll">
          <ul class="alpha-wb-cardlist" role="list">
            {/* Index (not For): list refreshes (e.g. after verify) update rows in place, so a
                card that just received DOM focus via the linkage is never torn down. */}
            <Index each={props.cards}>
              {(card) => {
                let buttonEl!: HTMLButtonElement
                createEffect(() => {
                  cardEls.set(card().key, buttonEl)
                  onCleanup(() => {
                    if (cardEls.get(card().key) === buttonEl) cardEls.delete(card().key)
                  })
                })
                return (
                  <li
                    class="alpha-wb-card"
                    data-active={props.selectedKey === card().key ? "" : undefined}
                    data-state={card().state}
                  >
                    <button
                      type="button"
                      class="alpha-wb-card-main"
                      data-artifact-card={card().key}
                      ref={buttonEl}
                      onClick={() => props.onSelect(card().key)}
                    >
                      <span class="alpha-wb-card-name" title={card().name}>
                        {card().name}
                      </span>
                      <span class="alpha-wb-card-meta">
                        <span class="a-wb-chip" data-state={card().state}>
                          {t(STATE_LABEL_KEYS[card().state])}
                        </span>
                        <Show when={props.selectedKey === card().key && props.previewCtx?.officeStructure}>
                          {(status) => (
                            <span
                              class="a-wb-chip"
                              data-kind={
                                status().status === "pass"
                                  ? "success"
                                  : status().status === "rejected"
                                    ? "error"
                                    : undefined
                              }
                            >
                              <Show when={status().status === "checking"}>
                                <span class="a-wb-spinner" aria-hidden="true" />
                              </Show>
                              {officeStatusLabel(status())}
                            </span>
                          )}
                        </Show>
                        <span class="alpha-wb-card-size">{formatBytes(card().bytes)}</span>
                        <Show when={card().warnings.length > 0}>
                          <span class="a-wb-chip" data-kind="warn" title={card().warnings.join("\n")}>
                            {t("alpha.wb.warnings")} {card().warnings.length}
                          </span>
                        </Show>
                      </span>
                    </button>
                    {cardActions(card())}
                  </li>
                )
              }}
            </Index>
          </ul>
          <div class="alpha-wb-live" aria-live="polite">{liveDownloadText()}</div>
          <Show when={downloadFailure()}>
            <div class="a-wb-notice" data-kind="error" data-download-failure>
              {t("alpha.wb.downloadFailed")}:{downloadFailure()}
            </div>
          </Show>
          <Show when={props.cloudUnavailable}>
            {/* Honest degradation, distinct from any single download failure — the two
                notices coexist and never mask each other (design §② 降级路径). */}
            <div class="a-wb-notice" data-cloud-unavailable>{t("alpha.wb.cloudListFailed")}</div>
          </Show>
          <Show when={selectedCard()}>
            {(card) => (
              <>
                <div class="alpha-wb-preview-head">
                  <div role="tablist" aria-label={t("alpha.session.artifactsPanelLabel")} class="alpha-wb-tabs" onKeyDown={onModeKey}>
                    <For each={MODES}>
                      {(m) => (
                        <button
                          type="button"
                          role="tab"
                          id={`a-rart-tab-${m}`}
                          aria-selected={mode() === m}
                          aria-controls="a-rart-panel"
                          tabIndex={rovingTabIndex(mode() === m)}
                          data-on={mode() === m ? "" : undefined}
                          onClick={() => setMode(m)}
                        >
                          {t(TAB_LABEL_KEYS[m])}
                        </button>
                      )}
                    </For>
                  </div>
                  <Show when={props.verifying}>
                    <span class="a-wb-chip">{t("alpha.wb.verifying")}</span>
                  </Show>
                  <Show when={props.previewCtx && !props.previewCtx.officeStructure}>
                    <span class="a-wb-chip" title={props.previewCtx!.decision.reason}>
                      {props.previewCtx!.decision.rendererId}
                    </span>
                  </Show>
                  <Show when={props.previewCtx?.officeStructure}>
                    {(status) => (
                      <span
                        class="a-wb-chip"
                        data-kind={
                          status().status === "pass"
                            ? "success"
                            : status().status === "rejected"
                              ? "error"
                              : undefined
                        }
                      >
                        <Show when={status().status === "checking"}>
                          <span class="a-wb-spinner" aria-hidden="true" />
                        </Show>
                        {officeStatusLabel(status())}
                      </span>
                    )}
                  </Show>
                </div>
                <Show when={props.previewCtx && !props.previewCtx.officeStructure && props.previewCtx.decision.warnings.length}>
                  <For each={props.previewCtx!.decision.warnings}>
                    {(warning) => (
                      <div class="a-wb-notice" data-kind="warn">
                        {warning}
                      </div>
                    )}
                  </For>
                </Show>
                <Show when={card().state === "mismatch"}>
                  <div class="a-wb-notice" data-kind="error">
                    {t("alpha.wb.mismatchBanner")}
                  </div>
                </Show>
                <div id="a-rart-panel" role="tabpanel" aria-labelledby={`a-rart-tab-${mode()}`} class="a-rart-preview">
                  <Show
                    when={!props.verifyFailure}
                    fallback={
                      <div class="a-rart-status" data-artifacts-verify-failed>
                        <div class="a-wb-notice" data-kind="error" role="alert">
                          {t("alpha.session.artifactsVerifyFailed")}:{props.verifyFailure}
                        </div>
                        <button type="button" class="a-wb-btn" onClick={props.onRetry}>
                          {t("alpha.wb.retry")}
                        </button>
                      </div>
                    }
                  >
                  <Show
                    when={!props.verifying}
                    fallback={
                      <div class="a-rart-status" data-artifacts-verifying>
                        {t("alpha.wb.verifying")}
                      </div>
                    }
                  >
                  <Show
                    when={props.previewCtx}
                    fallback={
                      <div class="alpha-wb-empty">
                        <p>{card().state === "cloud-only" ? t("alpha.wb.notDownloaded") : t("alpha.wb.fileMissing")}</p>
                        {/* Major-3: the detail-area entry obeys the same rule — no 「下载」
                            while busy AND none after done (the bytes are already local). */}
                        <Show when={card().downloadable && !downloadBusy(phaseOf(card())) && phaseOf(card()).status !== "done"}>
                          <button type="button" class="a-wb-btn" data-variant="primary" onClick={() => props.onDownload(card())}>
                            {t("alpha.wb.download")}
                          </button>
                        </Show>
                      </div>
                    }
                  >
                    {(ctx) => (
                      <Show
                        when={mode() === "metadata"}
                        fallback={
                          /* 单 renderer 崩溃只影响本预览区(沿 REQ-094 AC#7 合同) */
                          <ErrorBoundary
                            fallback={(err, reset) => (
                              <div class="a-wb-notice" data-kind="error" role="alert">
                                {t("alpha.wb.previewCrashed")}:{String((err as Error)?.message ?? err)}
                                <button type="button" class="a-wb-btn" onClick={reset}>
                                  {t("alpha.wb.retry")}
                                </button>
                              </div>
                            )}
                          >
                            <Show when={mode() === "preview"} fallback={<SourceView ctx={ctx()} />}>
                              <Dynamic component={RENDERER_COMPONENTS[ctx().decision.rendererId]} ctx={ctx()} />
                            </Show>
                          </ErrorBoundary>
                        }
                      >
                        <MetadataView ctx={ctx()} />
                      </Show>
                    )}
                  </Show>
                  </Show>
                  </Show>
                </div>
              </>
            )}
          </Show>
        </div>
      </Show>
    </section>
  )
}
