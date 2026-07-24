import { createEffect, createSignal, For, Show, type Accessor, type JSX } from "solid-js"
import { t } from "../../i18n"
import { sameSessionIdentity, type AlphaSessionIdentity, type AlphaSessionLiveSnapshot } from "./session-workspace-core"

export interface AlphaSessionLiveContext {
  current: Accessor<AlphaSessionLiveSnapshot | undefined>
  accepts: (identity: AlphaSessionIdentity) => boolean
}

// REQ-125 rail state machine. Panels are isomorphic: each is one union member, one tab in the
// rail strip, and (optionally) one injected renderer. C4 adds "artifacts" as a fourth member.
export type SessionRailPanel = "review" | "files" | "terminal"

// I8: a review target carries the session identity it was minted for; it is only ever
// exposed while that identity is still the live one.
export interface SessionRailReviewTarget {
  identity: AlphaSessionIdentity
  file: string
}

// Narrow api handed to injected panels. `jumpToReview` implements the approved linkage contract
// (badged file row → review panel's file card); the review lane consumes `reviewTarget`.
export interface SessionRailApi {
  reviewTarget: Accessor<SessionRailReviewTarget | undefined>
  jumpToReview: (file: string) => void
}

// Panels are injected by the workspace (which owns the app contexts) so the shell itself stays
// context-free and harness-mountable.
export type SessionRailPanelRenderers = Partial<Record<SessionRailPanel, (rail: SessionRailApi) => JSX.Element>>

const RAIL_PANELS: readonly SessionRailPanel[] = ["review", "files", "terminal"]

function railPanelLabel(panel: SessionRailPanel) {
  if (panel === "review") return t("alpha.session.review")
  if (panel === "files") return t("alpha.session.files")
  return t("alpha.session.terminal")
}

function WorkspaceTopbar(props: {
  live: AlphaSessionLiveContext
  panel: Accessor<SessionRailPanel | undefined>
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

export function SessionWorkspaceShell(props: { live: AlphaSessionLiveContext; panels?: SessionRailPanelRenderers }) {
  const [panel, setPanel] = createSignal<SessionRailPanel | undefined>("review")
  const [lastPanel, setLastPanel] = createSignal<SessionRailPanel>("review")
  // Panels visited while the rail is open stay mounted (hidden) so switching tabs does not throw
  // away panel state (tree expansion, scroll…). Closing the rail unmounts everything.
  const [visited, setVisited] = createSignal<readonly SessionRailPanel[]>(["review"])
  const [reviewTarget, setReviewTarget] = createSignal<SessionRailReviewTarget>()
  // I8: any change of the live session identity (including to undefined) invalidates a
  // pending review target — it must never be consumed by another session.
  createEffect((previous: AlphaSessionIdentity | undefined) => {
    const identity = props.live.current()?.identity
    if (previous && !sameSessionIdentity(previous, identity)) setReviewTarget(undefined)
    return identity
  })
  const openPanel = (next: SessionRailPanel) => {
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
    openPanel(lastPanel())
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
  }

  return (
    <div class="a-ui a-swk-root" data-alpha-session-workspace>
      <main class="a-swk-main">
        <WorkspaceTopbar live={props.live} panel={panel} toggleRail={toggleRail} toggleTerminal={toggleTerminal} />
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
          >
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
                    data-alpha-session-rail-tab={kind}
                    onClick={() => openPanel(kind)}
                  >
                    {railPanelLabel(kind)}
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
                const renderPanel = props.panels?.[kind]
                if (!renderPanel) return undefined
                return (
                  <div
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
