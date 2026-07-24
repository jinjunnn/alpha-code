import { createSignal, type Accessor, Show } from "solid-js"
import { t } from "../../i18n"
import { acceptedEngineChannel, type AlphaTerminalEngineChannel } from "../session-rail/terminal/terminal-rail-core"
import { TerminalRailPanel } from "../session-rail/terminal/terminal-rail-panel"
import type { AlphaSessionIdentity, AlphaSessionLiveSnapshot } from "./session-workspace-core"

export interface AlphaSessionLiveContext {
  current: Accessor<AlphaSessionLiveSnapshot | undefined>
  accepts: (identity: AlphaSessionIdentity) => boolean
}

function WorkspaceTopbar(props: {
  live: AlphaSessionLiveContext
  panel: Accessor<"review" | "terminal" | undefined>
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

export function SessionWorkspaceShell(props: {
  live: AlphaSessionLiveContext
  /** 真引擎 channel(#554 适配器投影;缺席 = 面板 fail-closed 空态)。 */
  terminalChannel?: Accessor<AlphaTerminalEngineChannel | undefined>
}) {
  const [panel, setPanel] = createSignal<"review" | "terminal" | undefined>("review")
  const [lastPanel, setLastPanel] = createSignal<"review" | "terminal">("review")
  // #554 焦点交接请求端(上游 terminal.toggle 语义):终端面板从关到开 → 对当前激活实例发
  // 聚焦请求(须先于面板挂载,上游 Terminal 挂载时一次性消费);从开到关 → 撤销未消费的
  // 请求,防陈旧请求日后误触发。经 I8 闸:身份不被当前会话接受的 channel 一律不触碰。
  const switchPanel = (next: "review" | "terminal" | undefined) => {
    const prev = panel()
    if ((prev === "terminal") !== (next === "terminal")) {
      const channel = acceptedEngineChannel(props.terminalChannel?.(), props.live.accepts)
      if (channel) {
        if (next === "terminal") channel.requestFocus(channel.activeID())
        else channel.cancelFocus()
      }
    }
    if (next) setLastPanel(next)
    setPanel(next)
  }
  const toggleTerminal = () => switchPanel(panel() === "terminal" ? undefined : "terminal")
  const toggleRail = () => switchPanel(panel() ? undefined : lastPanel())

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
            <Show when={activePanel() === "terminal"}>
              {/* C3-term:真引擎 channel 经 #554 适配器进入(alpha-session-workspace 接线)。
                  I8:channel 身份必须过 live.accepts,会话切换后旧投影即刻失效。 */}
              <TerminalRailPanel channel={props.terminalChannel?.()} accepts={props.live.accepts} />
            </Show>
          </aside>
        )}
      </Show>
    </div>
  )
}
