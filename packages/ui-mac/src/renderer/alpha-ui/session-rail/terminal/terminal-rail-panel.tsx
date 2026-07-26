// REQ-125 C3-term(#550)—— 右栏终端面板外壳(已批稿 session-workspace §终端)。
// alpha 自持:实例页签条(白卡浮起 + 运行呼吸点 + 新建/关闭)、圆角深底输出区外框
// (双主题恒深底)、脚条(运行状态 · 环境 · 尺寸)。输出区内容由引擎经
// `AlphaTerminalEngineChannel` 渲染;channel 缺席或未就绪 → fail-closed 空态。
import { For, Show, createEffect, createMemo, onCleanup } from "solid-js"
import { t } from "../../../i18n"
import { rovingKey, rovingTabIndex } from "../../roving-focus"
import type { AlphaSessionIdentity } from "../../session-workspace/session-workspace-core"
import {
  acceptedEngineChannel,
  anyTerminalRunning,
  formatTerminalSize,
  resolveActiveInstance,
  type AlphaTerminalEngineChannel,
} from "./terminal-rail-core"
import { registerTerminalRunningPublisher } from "./terminal-rail-state"
import "./terminal-rail.css"

const STAGE_ID = "alpha-terminal-stage"
const tabID = (instanceID: string) => `alpha-terminal-tab-${instanceID}`

function PlusIcon() {
  return (
    <svg class="a-term-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

export function TerminalRailPanel(props: {
  channel?: AlphaTerminalEngineChannel
  /** C1 live 上下文的身份校验(`live.accepts`);缺席 = fail-closed,channel 视为不存在。 */
  accepts?: (identity: AlphaSessionIdentity) => boolean
}) {
  // I8:channel 必须携带被当前会话接受的三元身份,且 ready;任一不满足即落空态。
  const engine = () => {
    const channel = acceptedEngineChannel(props.channel, props.accepts)
    return channel?.ready() ? channel : undefined
  }
  const instances = createMemo(() => engine()?.instances() ?? [])
  // Any-running projection for the rr-tabs breathing dot (integration audit Major-2):
  // this mount registers its own publisher entry — instances are already identity-gated
  // above, and unmount removes only this entry, so concurrent panels/remounts never
  // clobber each other's published state.
  const runningPublisher = registerTerminalRunningPublisher()
  createEffect(() => runningPublisher.publish(anyTerminalRunning(instances())))
  onCleanup(() => runningPublisher.unregister())
  const active = createMemo(() => resolveActiveInstance(instances(), engine()?.activeID()))
  const foot = createMemo(() => {
    const current = active()
    const channel = engine()
    if (!current || !channel) return undefined
    return channel.footStatus(current.id)
  })
  // C21 AC2:role="tablist" 欠下的键盘契约 —— ←→/Home/End 在实例页签间移动即切换,
  // 整条页签条在 Tab 序列里只占一个落点(横排 tablist 不吃 ↑↓,那是页面滚动)。
  //
  // 关闭按钮随之退出 Tab 序列(否则 N 个实例 = N+1 个落点),键盘关闭改由页签上的
  // Delete/Backspace 承担;鼠标点 × 与读屏直接激活该按钮的路径都不变。
  //
  // 关闭后必须交接焦点:被删的元素带着焦点消失,焦点会掉回 <body>,键盘用户得从头 Tab
  // 回来。目标在关闭前就算好(后一个,没有则前一个),关闭后再交接 —— 全关光时落到空态
  // 的「新建」按钮。
  const neighbourOf = (instanceID: string) => {
    const list = instances()
    const index = list.findIndex((instance) => instance.id === instanceID)
    if (index < 0) return undefined
    return list[index + 1] ?? list[index - 1]
  }
  // 空态「新建」按钮的 ref(I1:不用选择器找元素)。isConnected 挡住卸载后的陈旧引用。
  let emptyNewButton: HTMLButtonElement | undefined
  const closeInstance = (instanceID: string) => {
    const neighbour = neighbourOf(instanceID)
    engine()?.close(instanceID)
    // 重渲染排在信号更新之后;微任务里再取元素,拿到的才是关闭后的树。
    queueMicrotask(() => {
      const survivor = neighbour ? document.getElementById(tabID(neighbour.id)) : undefined
      if (survivor) return survivor.focus()
      if (emptyNewButton?.isConnected) emptyNewButton.focus()
    })
  }
  const onTabKey = (event: KeyboardEvent, instanceID: string) => {
    if (event.key === "Delete" || event.key === "Backspace") {
      if (event.isComposing || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return
      event.preventDefault()
      closeInstance(instanceID)
      return
    }
    rovingKey(event, "horizontal-tabs", instances(), active(), (instance) => {
      engine()?.open(instance.id)
      document.getElementById(tabID(instance.id))?.focus()
    })
  }
  // 页签条外框 .a-term-tabbar 只为把新建按钮挪出 role="tablist" —— tablist 只拥有 tab。

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
              ref={(element) => (emptyNewButton = element)}
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
            <div class="a-term-tabbar">
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
                        id={tabID(instance.id)}
                        class="a-term-tab-open"
                        aria-selected={instance.id === current().id}
                        aria-controls={STAGE_ID}
                        aria-keyshortcuts="Delete"
                        tabIndex={rovingTabIndex(instance.id === current().id)}
                        onClick={() => engine()?.open(instance.id)}
                        onKeyDown={(event) => onTabKey(event, instance.id)}
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
                        tabIndex={-1}
                        onClick={() => closeInstance(instance.id)}
                      >
                        <svg class="a-term-icon" viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M6 6l12 12M18 6L6 18" />
                        </svg>
                      </button>
                    </span>
                  )}
                </For>
              </div>
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
