// REQ-125 C3-term(#550)—— 右栏终端面板外壳(已批稿 session-workspace §终端)。
// alpha 自持:实例页签条(白卡浮起 + 运行呼吸点 + 新建/关闭)、圆角深底输出区外框
// (双主题恒深底)、脚条(运行状态 · 环境 · 尺寸)。输出区内容由引擎经
// `AlphaTerminalEngineChannel` 渲染;channel 缺席或未就绪 → fail-closed 空态。
import { For, Show, createMemo } from "solid-js"
import { t } from "../../../i18n"
import {
  anyTerminalRunning,
  formatTerminalSize,
  resolveActiveInstance,
  type AlphaTerminalEngineChannel,
} from "./terminal-rail-core"
import "./terminal-rail.css"

const STAGE_ID = "alpha-terminal-stage"

function PlusIcon() {
  return (
    <svg class="a-term-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

export function TerminalRailPanel(props: { channel?: AlphaTerminalEngineChannel }) {
  const engine = () => (props.channel?.ready() ? props.channel : undefined)
  const instances = createMemo(() => engine()?.instances() ?? [])
  const active = createMemo(() => resolveActiveInstance(instances(), engine()?.activeID()))
  const foot = createMemo(() => {
    const current = active()
    const channel = engine()
    if (!current || !channel) return undefined
    return channel.footStatus(current.id)
  })

  return (
    <section
      class="a-term-panel"
      data-alpha-terminal-panel
      data-alpha-terminal-any-running={anyTerminalRunning(instances()) ? "true" : undefined}
      aria-label={t("alpha.session.terminal")}
    >
      <Show
        when={active()}
        fallback={
          <div class="a-term-empty" data-alpha-terminal-empty>
            <span class="a-term-empty-icon" aria-hidden="true">
              <svg class="a-term-icon" viewBox="0 0 24 24">
                <path d="M4 17l6-6-6-6M12 19h8" />
              </svg>
            </span>
            <b>{t("alpha.terminal.emptyTitle")}</b>
            <p>{t("alpha.terminal.emptyBody")}</p>
            <button
              type="button"
              class="a-term-empty-new"
              data-alpha-terminal-new
              disabled={engine() === undefined}
              onClick={() => engine()?.create()}
            >
              <PlusIcon />
              {t("alpha.terminal.new")}
            </button>
          </div>
        }
      >
        {(current) => (
          <>
            <div class="a-term-tabs" role="tablist" aria-label={t("alpha.terminal.tabs")}>
              <For each={instances()}>
                {(instance) => (
                  <span
                    class="a-term-tab"
                    classList={{ "a-term-tab--on": instance.id === current().id }}
                    role="presentation"
                    data-alpha-terminal-tab={instance.id}
                    data-alpha-terminal-running={instance.running ? "true" : undefined}
                  >
                    <button
                      type="button"
                      role="tab"
                      class="a-term-tab-open"
                      aria-selected={instance.id === current().id}
                      aria-controls={STAGE_ID}
                      onClick={() => engine()?.open(instance.id)}
                    >
                      <Show when={instance.running}>
                        <span class="a-term-rundot" aria-hidden="true" />
                      </Show>
                      <span class="a-term-tab-label">{instance.title}</span>
                    </button>
                    <button
                      type="button"
                      class="a-term-tab-close"
                      data-alpha-terminal-close={instance.id}
                      aria-label={t("alpha.terminal.close", { title: instance.title })}
                      onClick={() => engine()?.close(instance.id)}
                    >
                      <svg class="a-term-icon" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  </span>
                )}
              </For>
              <button
                type="button"
                class="a-term-add"
                data-alpha-terminal-new
                aria-label={t("alpha.terminal.new")}
                onClick={() => engine()?.create()}
              >
                <PlusIcon />
              </button>
            </div>
            <div class="a-term-stage" id={STAGE_ID} role="tabpanel" aria-label={t("alpha.session.terminal")}>
              <div class="a-term-output" data-alpha-terminal-output>
                <Show when={engine()} keyed>
                  {(channel) => {
                    const EngineOutput = channel.EngineOutput
                    return (
                      <Show when={current().id} keyed>
                        {(instanceID) => <EngineOutput instanceID={instanceID} />}
                      </Show>
                    )
                  }}
                </Show>
              </div>
              <Show when={foot()}>
                {(status) => (
                  <div class="a-term-foot" data-alpha-terminal-foot>
                    <span
                      class="a-term-foot-state"
                      classList={{ "a-term-foot-state--running": status().running }}
                      data-alpha-terminal-foot-state={status().running ? "running" : "idle"}
                    >
                      <i aria-hidden="true" />
                      {status().running ? t("alpha.terminal.footRunning") : t("alpha.terminal.footIdle")}
                    </span>
                    <Show when={status().shell}>
                      {(shell) => (
                        <>
                          <span class="a-term-foot-sep" aria-hidden="true">
                            ·
                          </span>
                          <span>{shell()}</span>
                        </>
                      )}
                    </Show>
                    <Show when={formatTerminalSize(status().cols, status().rows)}>
                      {(size) => <span class="a-term-foot-size">{size()}</span>}
                    </Show>
                  </div>
                )}
              </Show>
            </div>
          </>
        )}
      </Show>
    </section>
  )
}
