// REQ-125 C4 — right-rail artifacts host, presentational half.
//
// This is an embedding context, not a redesign (approved frame: "产物面板…既批形态原样"):
// card list, state chips, preview tabs, and preview body all reuse the artifact-workbench
// language verbatim — its class names, label keys, and renderer components (I5). The file
// owns only the rail-specific chrome (caption, quiet empty state, focus mount point) with
// `--a-*` tokens. It is deliberately free of any IPC import so the component harness can
// mount it directly; the typed data container lives in `session-rail-artifacts.tsx`.
import { createEffect, createMemo, createSignal, ErrorBoundary, For, Index, onCleanup, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import { t } from "../../../i18n"
import { MetadataView, STATE_LABEL_KEYS, TAB_LABEL_KEYS } from "../../artifact-workbench/artifact-workbench"
import { formatBytes, type ArtifactCard } from "../../artifact-workbench/workbench-core"
import {
  RENDERER_COMPONENTS,
  SourceView,
  type PreviewContext,
} from "../../artifact-workbench/renderers/renderer-views"
import type { OfficeStructurePresentation } from "../../artifact-workbench/renderers/office-structure"
import { rovingKey, rovingTabIndex } from "../../roving-focus"
import type { ArtifactsPhase } from "./artifacts-core"
import "./session-rail-artifacts.css"

type PreviewMode = "preview" | "source" | "metadata"

const MODES: readonly PreviewMode[] = ["preview", "source", "metadata"]

export interface ArtifactsPanelViewProps {
  phase: ArtifactsPhase
  errorReason?: string
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
}

function officeStatusLabel(status: OfficeStructurePresentation): string {
  if (status.status === "checking") return t("alpha.wb.office.status.checking")
  if (status.status === "pass") return t("alpha.wb.office.status.pass")
  return t("alpha.wb.office.status.rejected")
}

export function SessionRailArtifactsView(props: ArtifactsPanelViewProps) {
  const [mode, setMode] = createSignal<PreviewMode>("preview")
  const cardEls = new Map<string, HTMLElement>()
  const selectedCard = createMemo(() => props.cards.find((card) => card.key === props.selectedKey) ?? null)

  // Mode is per-selection presentation state: switching artifacts returns to Preview.
  createEffect(() => {
    props.selectedKey
    setMode("preview")
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
    rovingKey(event, MODES, mode(), (next) => {
      setMode(next)
      document.getElementById(`a-rart-tab-${next}`)?.focus()
    })

  const onRootKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return
    props.onEscape?.()
  }

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
      <Show when={props.phase === "cards"}>
        <div class="a-rart-scroll">
          <div class="a-rart-caption">{t("alpha.session.artifactsTurn")}</div>
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
                  </li>
                )
              }}
            </Index>
          </ul>
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
