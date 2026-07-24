import { createEffect, createSignal, For, Show, type Accessor, type JSX } from "solid-js"
import { t } from "../../i18n"
import { TerminalRailPanel } from "../session-rail/terminal/terminal-rail-panel"
import {
  clampRailWidth,
  RAIL_MAX_WIDTH,
  RAIL_MIN_WIDTH,
  readRailWidths,
  rememberRailWidth,
} from "./rail-width"
import { sameSessionIdentity, type AlphaSessionIdentity, type AlphaSessionLiveSnapshot } from "./session-workspace-core"

export interface AlphaSessionLiveContext {
  current: Accessor<AlphaSessionLiveSnapshot | undefined>
  accepts: (identity: AlphaSessionIdentity) => boolean
}

// REQ-125 rail state machine. Panels are isomorphic: each is one union member, one tab in the
// rail strip, and (optionally) one injected renderer. C4 added "artifacts" as the fourth member.
export type SessionRailPanel = "review" | "files" | "terminal" | "artifacts"

/**
 * C4 mount point for the approved timeline→artifacts linkage (rows land with #544/#449).
 * I8: the request carries the session identity it was minted for, mirroring
 * SessionRailReviewTarget — it is only ever exposed while that identity is live.
 */
export interface ArtifactFocusRequest {
  identity: AlphaSessionIdentity
  artifactId: string
  /** Focus origin at request time; Esc inside the artifacts panel returns focus here. */
  origin?: HTMLElement
}

// I8: a review target carries the session identity it was minted for; it is only ever
// exposed while that identity is still the live one.
export interface SessionRailReviewTarget {
  identity: AlphaSessionIdentity
  file: string
}

// Narrow api handed to injected panels. `jumpToReview` implements the approved linkage contract
// (badged file row → review panel's file card); the review lane consumes `reviewTarget`.
// `focusArtifact` is the C4 twin for timeline artifact rows; the artifacts panel consumes
// `artifactTarget`. Both targets reset on session switch (I8).
export interface SessionRailApi {
  reviewTarget: Accessor<SessionRailReviewTarget | undefined>
  jumpToReview: (file: string) => void
  artifactTarget: Accessor<ArtifactFocusRequest | undefined>
  focusArtifact: (artifactId: string) => void
}

// Panels are injected by the workspace (which owns the app contexts) so the shell itself stays
// context-free and harness-mountable.
export type SessionRailPanelRenderers = Partial<Record<SessionRailPanel, (rail: SessionRailApi) => JSX.Element>>

/** Tab-strip live decorations. Absent accessors fail closed: no badge, no running dot. */
export interface SessionRailMeta {
  /** Review tab badge — changed-file count from the C2 typed diff channel. */
  reviewCount?: Accessor<number | undefined>
  /** Terminal tab breathing dot — any terminal running (wired by the terminal lane). */
  terminalRunning?: Accessor<boolean>
}

const RAIL_PANELS: readonly SessionRailPanel[] = ["review", "files", "terminal", "artifacts"]

function railPanelLabel(panel: SessionRailPanel) {
  if (panel === "review") return t("alpha.session.review")
  if (panel === "files") return t("alpha.session.files")
  if (panel === "terminal") return t("alpha.session.terminal")
  return t("alpha.session.artifacts")
}

function WorkspaceTopbar(props: {
  live: AlphaSessionLiveContext
  panel: Accessor<SessionRailPanel | undefined>
  terminalAvailable: boolean
  toggleRail: () => void
  toggleTerminal: () => void
}) {
  const snapshot = () => props.live.current()
  const running = () => snapshot()?.activity === "running"
  const railOpen = () => props.panel() !== undefined
  return (
    <header class="a-swk-topbar" data-alpha-session-workspace-topbar>
      <span class="a-swk-project-pill">
        <span class="a-swk-project-avatar" aria-hidden="true">
          {snapshot()?.project.slice(0, 1).toUpperCase() || "α"}
        </span>
        <span class="a-swk-project-label">{snapshot()?.project || t("alpha.session.session")}</span>
      </span>
      <span class="a-swk-separator" aria-hidden="true">
        ›
      </span>
      <span class="a-swk-session-title">{snapshot()?.title || t("alpha.session.session")}</span>
      <span
        class="a-swk-status"
        classList={{ "a-swk-status--running": running() }}
        data-alpha-session-status={running() ? "running" : "idle"}
        role="status"
        aria-live="polite"
      >
        <span class="a-swk-status-dot" aria-hidden="true" />
        {running() ? t("alpha.session.statusRunning") : t("alpha.session.statusIdle")}
      </span>
      <span class="a-swk-grow" aria-hidden="true" />
      <button
        type="button"
        class="a-swk-panel-button"
        classList={{ "a-swk-panel-button--active": props.panel() === "terminal" }}
        aria-label={t("alpha.session.terminal")}
        aria-pressed={props.panel() === "terminal"}
        aria-controls="alpha-session-rail-host"
        disabled={!props.terminalAvailable}
        onClick={props.toggleTerminal}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 17l6-6-6-6M12 19h8" />
        </svg>
      </button>
      <span class="a-swk-control-separator" aria-hidden="true" />
      <button
        type="button"
        class="a-swk-panel-button"
        classList={{ "a-swk-panel-button--active": railOpen() }}
        aria-label={railOpen() ? t("alpha.session.closeRail") : t("alpha.session.openRail")}
        aria-expanded={railOpen()}
        aria-controls="alpha-session-rail-host"
        onClick={props.toggleRail}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M15 4v16" />
        </svg>
      </button>
    </header>
  )
}

export function SessionWorkspaceShell(props: {
  live: AlphaSessionLiveContext
  panels?: SessionRailPanelRenderers
  railMeta?: SessionRailMeta
}) {
  // Panel renderers: injected slot first; terminal falls back to the shell-built-in
  // C550 panel (fail-closed empty state until the engine channel lands — I8 via
  // live.accepts). Every other absent slot stays a disabled tab and no open path works.
  const rendererFor = (kind: SessionRailPanel): ((rail: SessionRailApi) => JSX.Element) | undefined => {
    const injected = props.panels?.[kind]
    if (injected) return injected
    if (kind === "terminal") return () => <TerminalRailPanel accepts={props.live.accepts} />
    return undefined
  }
  const available = (kind: SessionRailPanel) => rendererFor(kind) !== undefined
  const firstAvailable = RAIL_PANELS.find(available)
  const [panel, setPanel] = createSignal<SessionRailPanel | undefined>(firstAvailable)
  const [lastPanel, setLastPanel] = createSignal<SessionRailPanel | undefined>(firstAvailable)
  // Panels visited while the rail is open stay mounted (hidden) so switching tabs does not throw
  // away panel state (tree expansion, scroll…). Closing the rail unmounts everything.
  const [visited, setVisited] = createSignal<readonly SessionRailPanel[]>(firstAvailable ? [firstAvailable] : [])
  const [reviewTarget, setReviewTarget] = createSignal<SessionRailReviewTarget>()
  const [artifactTarget, setArtifactTarget] = createSignal<ArtifactFocusRequest>()
  // I8: any change of the live session identity (including to undefined) invalidates every
  // pending linkage target — none may ever be consumed by another session.
  createEffect((previous: AlphaSessionIdentity | undefined) => {
    const identity = props.live.current()?.identity
    if (previous && !sameSessionIdentity(previous, identity)) {
      setReviewTarget(undefined)
      setArtifactTarget(undefined)
    }
    return identity
  })
  // Per-panel rail width, persisted (approved contract: 320–560, remembered per panel).
  const [widths, setWidths] = createSignal<Record<string, number>>(readRailWidths())
  const [resizing, setResizing] = createSignal(false)
  const railWidth = () => {
    const kind = panel()
    return clampRailWidth(kind ? widths()[kind] : undefined)
  }
  const openPanel = (next: SessionRailPanel) => {
    if (!available(next)) return
    setLastPanel(next)
    setPanel(next)
    setVisited((seen) => (seen.includes(next) ? seen : [...seen, next]))
  }
  const closeRail = () => {
    setPanel(undefined)
    setVisited([])
  }
  const toggleTerminal = () => {
    if (panel() === "terminal") {
      closeRail()
      return
    }
    openPanel("terminal")
  }
  const toggleRail = () => {
    if (panel()) {
      closeRail()
      return
    }
    const next = lastPanel() ?? firstAvailable
    if (next) openPanel(next)
  }
  const rail: SessionRailApi = {
    // Consumer side stays fail-closed even between effect runs: a target whose identity is
    // no longer accepted by the live context reads as absent.
    reviewTarget: () => {
      const target = reviewTarget()
      return target && props.live.accepts(target.identity) ? target : undefined
    },
    jumpToReview: (file) => {
      const identity = props.live.current()?.identity
      if (!identity) return
      setReviewTarget({ identity, file })
      openPanel("review")
    },
    artifactTarget: () => {
      const target = artifactTarget()
      return target && props.live.accepts(target.identity) ? target : undefined
    },
    focusArtifact: (artifactId) => {
      const identity = props.live.current()?.identity
      if (!identity) return
      const active = document.activeElement
      setArtifactTarget({ identity, artifactId, origin: active instanceof HTMLElement ? active : undefined })
      openPanel("artifacts")
    },
  }

  const enabledPanels = () => RAIL_PANELS.filter(available)
  const onTabKey = (event: KeyboardEvent) => {
    const list = enabledPanels()
    const active = panel()
    if (!active || list.length === 0) return
    const index = Math.max(0, list.indexOf(active))
    let next: number | null = null
    if (event.key === "ArrowRight") next = (index + 1) % list.length
    else if (event.key === "ArrowLeft") next = (index + list.length - 1) % list.length
    else if (event.key === "Home") next = 0
    else if (event.key === "End") next = list.length - 1
    if (next === null) return
    event.preventDefault()
    const kind = list[next]!
    openPanel(kind)
    document.getElementById(`alpha-session-rail-tab-${kind}`)?.focus()
  }

  const applyWidth = (kind: SessionRailPanel, value: number) => {
    setWidths((current) => ({ ...current, [kind]: clampRailWidth(value) }))
  }
  const startResize = (event: PointerEvent) => {
    const kind = panel()
    if (!kind) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = railWidth()
    setResizing(true)
    const move = (ev: PointerEvent) => applyWidth(kind, startWidth + (startX - ev.clientX))
    const stop = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", stop)
      setResizing(false)
      rememberRailWidth(kind, clampRailWidth(widths()[kind] ?? startWidth))
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", stop)
  }
  const onGripKey = (event: KeyboardEvent) => {
    const kind = panel()
    if (!kind) return
    const step = event.key === "ArrowLeft" ? 16 : event.key === "ArrowRight" ? -16 : 0
    if (step === 0) return
    event.preventDefault()
    const next = clampRailWidth(railWidth() + step)
    applyWidth(kind, next)
    rememberRailWidth(kind, next)
  }

  const reviewCount = () => props.railMeta?.reviewCount?.()
  const terminalRunning = () => props.railMeta?.terminalRunning?.() === true

  return (
    <div class="a-ui a-swk-root" data-alpha-session-workspace>
      <main class="a-swk-main">
        <WorkspaceTopbar
          live={props.live}
          panel={panel}
          terminalAvailable={available("terminal")}
          toggleRail={toggleRail}
          toggleTerminal={toggleTerminal}
        />
        <section
          class="a-swk-timeline-host"
          data-alpha-session-timeline-host
          aria-label={t("alpha.session.timelineHost")}
        />
        <section
          class="a-swk-composer-dock"
          data-alpha-session-composer-dock
          aria-label={t("alpha.session.composerHost")}
        >
          <div class="a-swk-composer-host" data-alpha-session-composer-host />
        </section>
      </main>
      <Show when={panel()}>
        {(activePanel) => (
          <aside
            id="alpha-session-rail-host"
            class="a-swk-rail-host"
            data-alpha-session-rail-host
            data-alpha-session-rail-panel={activePanel()}
            aria-label={t("alpha.session.railHost")}
            style={{ width: `${railWidth()}px` }}
          >
            <div
              class="a-swk-rail-grip"
              classList={{ "a-swk-rail-grip--active": resizing() }}
              role="separator"
              aria-orientation="vertical"
              aria-label={t("alpha.session.railResize")}
              aria-valuemin={RAIL_MIN_WIDTH}
              aria-valuemax={RAIL_MAX_WIDTH}
              aria-valuenow={railWidth()}
              tabIndex={0}
              onPointerDown={startResize}
              onKeyDown={onGripKey}
            />
            <div class="a-swk-rail-tabs" role="tablist" aria-label={t("alpha.session.railTabs")}>
              <For each={RAIL_PANELS}>
                {(kind) => (
                  <button
                    type="button"
                    role="tab"
                    id={`alpha-session-rail-tab-${kind}`}
                    class="a-swk-rail-tab"
                    classList={{ "a-swk-rail-tab--on": activePanel() === kind }}
                    aria-selected={activePanel() === kind}
                    aria-controls={`alpha-session-rail-panel-${kind}`}
                    data-alpha-session-rail-tab={kind}
                    disabled={!available(kind)}
                    tabIndex={activePanel() === kind ? 0 : -1}
                    onClick={() => openPanel(kind)}
                    onKeyDown={onTabKey}
                  >
                    <Show when={kind === "terminal" && terminalRunning()}>
                      {/* State arrives via railMeta.terminalRunning — the accessor twin of the
                          C550 panel's data-alpha-terminal-any-running root attribute. */}
                      <span class="a-swk-rail-tab-dot" data-alpha-session-terminal-dot aria-hidden="true" />
                    </Show>
                    {railPanelLabel(kind)}
                    <Show when={kind === "review" && (reviewCount() ?? 0) > 0}>
                      <span class="a-swk-rail-tab-badge" data-alpha-session-review-count>
                        {reviewCount()}
                      </span>
                    </Show>
                  </button>
                )}
              </For>
              <button
                type="button"
                class="a-swk-rail-close"
                aria-label={t("alpha.session.closeRail")}
                onClick={closeRail}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </button>
            </div>
            <For each={visited()}>
              {(kind) => {
                const renderPanel = rendererFor(kind)
                if (!renderPanel) return undefined
                return (
                  <div
                    id={`alpha-session-rail-panel-${kind}`}
                    class="a-swk-rail-panel"
                    role="tabpanel"
                    aria-labelledby={`alpha-session-rail-tab-${kind}`}
                    data-alpha-session-rail-panel-host={kind}
                    classList={{ "a-swk-rail-panel--hidden": panel() !== kind }}
                  >
                    {renderPanel(rail)}
                  </div>
                )
              }}
            </For>
          </aside>
        )}
      </Show>
    </div>
  )
}
