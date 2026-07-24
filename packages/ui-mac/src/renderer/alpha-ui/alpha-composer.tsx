// AlphaComposer — REQ-055/REQ-125 C7:alpha 唯一的 composer 组件(用户拍板 2026-07-07:「一个 CSS
// 一个完整的组件」「自建,不再集成 opencode」)。首页(mode="home")、新会话与会话页
// (mode="session",由 seam 会话页的 SessionComposerDock **直挂**,props 传入 —— 零 Portal/
// 零选择器,takeover 时代随 REQ-125 C7 终结)渲染**同一个组件**,样式只来自 alpha-composer.css。
//
// 与旧世界的本质区别:session 的模型/推理档以 typed Session Model.Ref 为真源，composer-state
// 只保留已确认的 UI 投影;agent/权限仍是轻量提交态。不再有 agent.cycle 轮转、variant cycleTo
// 或隐藏上游选择器标签发布 —— 那一类「驱动/收养隐藏上游控件」的机制全部退役。
//
// session 专属数据(live 运行态/上下文用量/审批挂起/斜杠捕获)一律经 sessionDock props 从
// typed 通道注入(基线 I1/I2/I8);2.5s status 轮询与上游 ring DOM 收养已删。

import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
  type JSX,
} from "solid-js"
import { Portal } from "solid-js/web"
import { useCommand } from "./providers"
import { setExtHubOpen } from "../extensions/ext-hub-state"
import { createComposerAutocomplete } from "./composer-autocomplete"
import { buildMentionParts, buildPromptInput, type MentionPart } from "./composer-autocomplete-core"
import {
  ATTACH_ACCEPT,
  ATTACH_MAX_COUNT,
  buildAttachmentParts,
  classifyAttachment,
  IMAGE_MAX_BYTES,
  mergeAttachments,
  PDF_MAX_BYTES,
  type ComposerAttachment,
} from "./composer-attachments-core"
import { pathHitsPopover } from "./popover-hit"
import { pushToast } from "./Toast"
import type { AlphaProjectsApi } from "../sidebar/use-projects"
import type { AuthState } from "../../preload/types"
import {
  applyDefaultComposerModel,
  buildPromptRequest,
  clearSuspendedModel,
  composerAgent,
  composerEffortSel,
  composerModel,
  composerModelProjection,
  composerModelSuspended,
  composerPerm,
  DEFAULT_AGENT,
  failComposerModelProjection,
  invalidateComposerModelProjection,
  pushedAgentFor,
  recordPushedAgent,
  resetComposerModelProjection,
  resolveComposerModelProjection,
  routeSlash,
  setComposerAgent,
  setComposerModel,
  setComposerPerm,
  suspendComposerModel,
  type PermMode,
} from "./composer-state"
import {
  checkSelectedModel,
  preflightBlockReason,
  resolveDefaultModel,
  type EngineModelRef,
} from "./model-default-core"
import { ModelPickPop } from "./alpha-composer-model"
import { createModelContract, type ModelContract } from "./model-contract"
import { composerModelFromRef, modelRefOf, withModelVariant } from "./model-picker-core"
import { ENGINE_FETCH_TIMEOUT_MS } from "./model-picker-logic"
import { accountResultState, createRetryWakeup } from "./model-recovery"
import { t } from "../i18n"
import { markStartupTimeline } from "../startup-timeline"
import { subscribeRuntimeRecovery, subscribeSseReconnected } from "../runtime-recovery"
import "./alpha-composer.css"

/* ── 单开注册表(全部 chips 共享;开新的自动关旧的)──────────────────────────── */
const [openChipId, setOpenChipId] = createSignal<number | null>(null)
let chipSeq = 0
let homeModelListMarkCount = 0
let homeModelRetryMarkCount = 0
export const closeChips = () => setOpenChipId(null)

function useChip() {
  const id = ++chipSeq
  const isOpen = () => openChipId() === id
  const toggle = () => setOpenChipId(isOpen() ? null : id)
  const close = () => {
    if (openChipId() === id) setOpenChipId(null)
  }
  const onDoc = (e: MouseEvent) => {
    // REQ-061:composedPath 在 dispatch 时快照 —— 点击处理器同步重渲染把被点按钮 detach 后,
    // 旧 e.target.closest(".a-pop") 会返回 null 误判外部点击、误关整层(B21 真机 3 次复现:
    // 改键表单入口不可达)。判定细节见 popover-hit.ts。
    if (pathHitsPopover(e.composedPath())) return
    close()
  }
  document.addEventListener("click", onDoc)
  onCleanup(() => document.removeEventListener("click", onDoc))
  return { isOpen, toggle, close }
}

const stop = (e: Event) => e.stopPropagation()

/* 逃出 overflow 裁剪的弹层(Portal 到 body、fixed 定位、朝上开)。 */
export function ChipPopover(props: {
  anchor: HTMLElement | undefined
  align?: "left" | "right"
  minWidth?: number
  role?: "menu"
  onEscape?: () => void
  children: JSX.Element
}) {
  const a = props.anchor
  if (!a) return null
  const r = a.getBoundingClientRect()
  const vw = window.innerWidth
  const minW = props.minWidth ?? 200
  let popover: HTMLDivElement | undefined
  const style: JSX.CSSProperties = {
    position: "fixed",
    bottom: `${Math.round(window.innerHeight - r.top + 8)}px`,
    "z-index": "60",
    "min-width": `${minW}px`,
    "max-width": `${Math.round(vw - 16)}px`,
  }
  if (props.align === "right") style.right = `${Math.round(Math.max(8, vw - r.right))}px`
  else style.left = `${Math.round(Math.min(Math.max(8, r.left), vw - minW - 8))}px`
  onMount(() => {
    queueMicrotask(() =>
      (
        popover?.querySelector<HTMLElement>(
          "button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex='-1'])",
        ) ?? popover
      )?.focus(),
    )
  })
  onCleanup(() => {
    const el = document.activeElement
    if (!popover || popover.contains(el) || el === document.body || el === null)
      queueMicrotask(() => a.isConnected && a.focus())
  })
  return (
    <Portal>
      <div
        ref={popover}
        class="a-ui a-pop a-pop-fixed"
        role={props.role}
        tabindex="-1"
        style={style}
        onClick={stop}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return
          event.preventDefault()
          event.stopPropagation()
          props.onEscape?.()
          a.focus()
        }}
      >
        {props.children}
      </div>
    </Portal>
  )
}

/* ── icons ─────────────────────────────────────────────────────────────────── */
const ico = "0 0 24 24"
const Plus = () => (
  <svg class="a-ic" viewBox={ico}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)
const Chevron = () => (
  <svg class="a-ic a-chev" viewBox={ico}>
    <path d="M6 9l6 6 6-6" />
  </svg>
)
const ShieldSolid = () => (
  <svg class="a-ic a-ic-sm" viewBox={ico} style={{ fill: "currentColor", stroke: "none" }}>
    <path d="M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z" />
  </svg>
)
const ShieldAsk = () => (
  <svg class="a-ic a-ic-sm" viewBox={ico}>
    <path d="M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z" />
    <path d="M9 12l2 2 4-4" />
  </svg>
)
const ShieldEye = () => (
  <svg class="a-ic a-ic-sm" viewBox={ico}>
    <path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z" />
    <circle cx="12" cy="11" r="2.4" />
  </svg>
)
const Bolt = () => (
  <svg class="a-ic a-ic-sm" viewBox={ico}>
    <path d="M13 2L4.5 12.5h6L11 22l8.5-10.5h-6z" />
  </svg>
)
const ArrowUp = () => (
  <svg class="a-ic" viewBox={ico}>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
)
const StopSquare = () => (
  <svg class="a-ic" viewBox={ico} style={{ fill: "currentColor", stroke: "none" }}>
    <rect x="7" y="7" width="10" height="10" rx="2" />
  </svg>
)
const FileGlyph = () => (
  <svg class="a-ic" viewBox={ico}>
    <path d="M14.5 4h-9A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V9.5z" />
    <path d="M14 4v5h6" />
  </svg>
)
const TermGlyph = () => (
  <svg class="a-ic" viewBox={ico}>
    <path d="M4 17l6-5-6-5M12 19h8" />
  </svg>
)

/* ── + 按钮:打开统一装配弹窗(REQ-073)—— 与 @ 同一弹窗,内容/键盘/分节见
 * composer-autocomplete(添加/AGENT/文件/扩展);旧 AddButton 的四条「扩展」占位行
 * (文档/PDF/表格/连接器全是同一个 setExtHubOpen 动作)随之收敛为弹窗单行「扩展市场…」。 */
function AddButton(props: { onOpen: () => void; expanded: boolean }) {
  return (
    <button
      class="a-chip a-chip-icon"
      title={t("alpha.composer.assemble")}
      aria-label={t("alpha.composer.assemble")}
      aria-haspopup="listbox"
      aria-expanded={props.expanded}
      onClick={(e) => (stop(e), props.onOpen())}
    >
      <Plus />
    </button>
  )
}

/* ── 权限 chip:full/ask 驱动引擎 autoaccept 命令;readonly = 提交时 agent 参数 ── */
const permLabel = (mode: PermMode) => mode === "full" ? t("alpha.composer.permFull") : mode === "ask" ? t("alpha.composer.permAsk") : t("alpha.composer.permReadonly")

type CommandApi = ReturnType<typeof useCommand>

export function PermChip(props: { command: CommandApi }) {
  const { isOpen, toggle, close } = useChip()
  let btn: HTMLButtonElement | undefined
  const pick = (m: PermMode) => {
    setComposerPerm(m)
    try {
      props.command.trigger(m === "full" ? "permissions.autoaccept.enable" : "permissions.autoaccept.disable")
    } catch {
      /* command may be unregistered on home — perm 仍是提交参数的真源 */
    }
    close()
  }
  return (
    <div class="a-pop-wrap" data-kind="perm">
      <button
        ref={btn}
        class="a-chip a-chip-perm"
        data-mode={composerPerm()}
        aria-haspopup="menu"
        aria-expanded={isOpen()}
        onClick={(e) => (stop(e), toggle())}
      >
        <Switch fallback={<ShieldAsk />}>
          <Match when={composerPerm() === "full"}>
            <ShieldSolid />
          </Match>
          <Match when={composerPerm() === "readonly"}>
            <ShieldEye />
          </Match>
        </Switch>
        {permLabel(composerPerm())}
        <Chevron />
      </button>
      <Show when={isOpen()}>
        <ChipPopover anchor={btn} align="left" minWidth={230} role="menu" onEscape={close}>
          <div class="a-pop-label" role="presentation">{t("alpha.composer.permissions")}</div>
          <button
            class="a-pop-item"
            classList={{ "is-on": composerPerm() === "full" }}
            role="menuitemradio"
            aria-checked={composerPerm() === "full"}
            onClick={() => pick("full")}
          >
            <ShieldSolid /> {t("alpha.composer.permFull")} <span class="a-pop-desc">{t("alpha.composer.permFullHint")}</span>
          </button>
          <button
            class="a-pop-item"
            classList={{ "is-on": composerPerm() === "ask" }}
            role="menuitemradio"
            aria-checked={composerPerm() === "ask"}
            onClick={() => pick("ask")}
          >
            <ShieldAsk /> {t("alpha.composer.permAsk")} <span class="a-pop-desc">{t("alpha.composer.permAskHint")}</span>
          </button>
          <button
            class="a-pop-item"
            classList={{ "is-on": composerPerm() === "readonly" }}
            role="menuitemradio"
            aria-checked={composerPerm() === "readonly"}
            onClick={() => pick("readonly")}
          >
            <ShieldEye /> {t("alpha.composer.permReadonly")} <span class="a-pop-desc">{t("alpha.composer.permReadonlyHint")}</span>
          </button>
        </ChipPopover>
      </Show>
    </div>
  )
}

/* ── 计划模式 chip(REQ-073,取代 AgentChip)—— composerAgent 即模式载体:null = 引擎默认
 * (build,不出控件);"plan"/第三方主档 = chip 呈现,点击关闭;开关入口在统一装配弹窗,
 * Shift+Tab 快捷切换;perm=readonly 时模式不生效(buildPromptRequest 强制只读档),chip 如实置灰。 */
function PlanChip() {
  const label = () => (composerAgent() === "plan" ? t("alpha.composer.plan") : composerAgent())
  return (
    <Show when={composerAgent()}>
      <button
        class="a-chip a-chip-plan"
        data-disabled={composerPerm() === "readonly" ? "" : undefined}
        title={
          composerPerm() === "readonly"
            ? t("alpha.composer.planReadonly")
            : t("alpha.composer.planEnabled")
        }
        onClick={(e) => (stop(e), setComposerAgent(null))}
      >
        <span class="a-chip-x" aria-hidden="true">
          ⊗
        </span>
        {label()}
      </button>
    </Show>
  )
}

/* ── 模型 chip:打开 canonical alpha picker，选择经 typed model contract 提交。──────────── */
function ModelChip(props: {
  contract: ReturnType<typeof createModelContract>
  directory: () => string | undefined
  onSelect: (model: NonNullable<ReturnType<typeof composerModel>>) => Promise<void>
  onRetryCurrent: () => void
  modelChainReady: () => boolean
  onNeedWorkspace?: () => void
  hasWorkspace: () => boolean
}) {
  const { isOpen, toggle, close } = useChip()
  let btn: HTMLButtonElement | undefined
  const label = () => {
    const projection = composerModelProjection()
    if (projection.status === "loading") return t("alpha.composer.modelReading")
    if (projection.status === "error") return t("alpha.composer.modelFailed")
    return composerModel()?.name ?? t("alpha.model.choose")
  }
  return (
    <div class="a-pop-wrap" data-kind="model">
      <button
        ref={btn}
        class="a-chip a-chip-model"
        title={t("alpha.model.choose")}
        aria-haspopup="dialog"
        aria-expanded={isOpen()}
        onClick={(e) => {
          stop(e)
          if (!props.hasWorkspace()) {
            // 零工作区不留死点(REQ-054①):引导先选工作区,与发送按钮同一分支。
            props.onNeedWorkspace?.()
            return
          }
          toggle()
        }}
      >
        <span class="a-pico" style={{ background: "var(--a-accent)" }}>
          α
        </span>
        <span class="a-chip-label" title={label()}>
          {label()}
        </span>
        <Chevron />
      </button>
      <Show when={isOpen()}>
        <ChipPopover anchor={btn} align="right" minWidth={360} onEscape={close}>
          <ModelPickPop
            contract={props.contract}
            directory={props.directory}
            selected={composerModel}
            onSelect={props.onSelect}
            onPicked={close}
            onRetryCurrent={props.onRetryCurrent}
            modelChainReady={props.modelChainReady}
          />
        </ChipPopover>
      </Show>
    </div>
  )
}

/* ── effort chip:档位定义取目录 variants；session 当前值是服务端 Model.Ref 的 UI 投影。
 *    全链 ready 后才允许调档；无模型时弹层内嵌模型选择器就地选，有模型无档位时如实说明原因。── */
function EffortChip(props: {
  contract: ReturnType<typeof createModelContract>
  directory: () => string | undefined
  onSelect: (model: NonNullable<ReturnType<typeof composerModel>>) => Promise<void>
  onRetryCurrent: () => void
  modelChainReady: () => boolean
}) {
  const { isOpen, toggle, close } = useChip()
  let btn: HTMLButtonElement | undefined
  const variants = () => composerModel()?.variants ?? []
  const supported = () => variants().length > 0
  const current = () => composerEffortSel() ?? t("alpha.composer.default")
  const blocked = () => composerModelProjection().status !== "ready" || !props.modelChainReady()
  const selectVariant = (variant: string | null) => {
    const model = composerModel()
    if (!model) return
    void props
      .onSelect(withModelVariant(model, variant))
      .then(close)
      .catch(() => {})
  }
  const title = () => {
    if (composerModelProjection().status === "loading") return t("alpha.composer.effortModelLoading")
    if (composerModelProjection().status === "error") return t("alpha.composer.effortModelFailed")
    if (!props.modelChainReady()) return t("alpha.composer.effortChainPending")
    return !composerModel()
      ? t("alpha.composer.effortNeedsModel")
      : supported()
        ? t("alpha.composer.effortTitle")
        : t("alpha.composer.effortUnsupported")
  }
  return (
    <div class="a-pop-wrap" data-kind="effort">
      <button
        ref={btn}
        class="a-chip"
        data-muted={supported() ? undefined : ""}
        title={title()}
        disabled={blocked()}
        aria-haspopup="dialog"
        aria-expanded={isOpen()}
        onClick={(e) => (stop(e), toggle())}
      >
        <Bolt />
        <span class="a-comp-eff">{supported() ? current() : "—"}</span>
        <Chevron />
      </button>
      <Show when={isOpen()}>
        <ChipPopover
          anchor={btn}
          align="right"
          minWidth={supported() ? 170 : composerModel() ? 260 : 360}
          onEscape={close}
        >
          <Switch>
            <Match when={supported()}>
              <div class="a-pop-label">{t("alpha.composer.effortModel", { model: composerModel()?.name ?? "" })}</div>
              <button
                class="a-pop-item"
                classList={{ "is-on": composerEffortSel() === null }}
                aria-current={composerEffortSel() === null ? "true" : undefined}
                disabled={!props.modelChainReady()}
                onClick={() => selectVariant(null)}
              >
                {t("alpha.composer.default")} <span class="a-pop-desc">{t("alpha.composer.engineDefault")}</span>
              </button>
              <For each={variants()}>
                {(v) => (
                  <button
                    class="a-pop-item"
                    classList={{ "is-on": composerEffortSel() === v }}
                    aria-current={composerEffortSel() === v ? "true" : undefined}
                    disabled={!props.modelChainReady()}
                    onClick={() => selectVariant(v)}
                  >
                    {v}
                  </button>
                )}
              </For>
            </Match>
            <Match when={!composerModel()}>
              <div class="a-pop-label">{t("alpha.composer.effortChooseModel")}</div>
              <div class="a-pop-note">{t("alpha.composer.effortChooseHint")}</div>
              <ModelPickPop
                contract={props.contract}
                directory={props.directory}
                selected={composerModel}
                onSelect={props.onSelect}
                onPicked={() => {}}
                onRetryCurrent={props.onRetryCurrent}
                modelChainReady={props.modelChainReady}
              />
            </Match>
            <Match when={true}>
              <div class="a-pop-label">{t("alpha.composer.effort")}</div>
              <div class="a-pop-note">
                {t("alpha.composer.effortUnavailableHint", { model: composerModel()?.name ?? "" })}
              </div>
            </Match>
          </Switch>
        </ChipPopover>
      </Show>
    </div>
  )
}

/* ── AlphaComposer 主体 ─────────────────────────────────────────────────────── */

/** 斜杠命令发送成功时的来源捕获(REQ-125 C7,供时间线 chip;上游 send 后不保留)。 */
export type ComposerSlashCapture = {
  sessionID: string
  directory: string
  command: string
  arguments: string
  /** 引擎返回的 assistant message id(session.command response.info.id)。 */
  assistantMessageID?: string
}

/**
 * session 模式的 typed 数据面(REQ-125 C7)。由 seam 会话页的 SessionComposerDock 注入;
 * 全部取自 typed 通道(session_status / messages+model catalog / PermissionV2 feed),
 * 缺席(home/newSession 或测试)时组件按「无会话数据」诚实降级:无停止键、无 ring。
 */
export type ComposerSessionDockApi = {
  /** live 运行态(session_status typed 通道;不再轮询)。 */
  running: () => boolean
  /** 上下文用量百分比(0-100);null = 事实不足,ring 不渲染。 */
  contextUsage: () => number | null
  /** 当前会话是否有挂起审批(驱动占位文案与权限 chip 琥珀态)。 */
  approvalPending: () => boolean
  /** 斜杠命令发送成功后的捕获回调。 */
  onSlashCommand?: (capture: ComposerSlashCapture) => void
}

export type AlphaComposerProps = {
  mode: "home" | "session"
  projects: AlphaProjectsApi
  /** 提交目标目录(home = 所选工作区;session = 会话目录)。 */
  directory: () => string | undefined
  /** session 模式必传:目标会话。 */
  sessionID?: () => string | undefined
  /** session 模式:seam dock 注入的 typed 数据面。 */
  sessionDock?: ComposerSessionDockApi
  /** home:零工作区时的引导(打开工作区选择器)。 */
  onNeedWorkspace?: () => void
  /** home:创建+首发成功后的跳转。 */
  onSubmitted?: (sessionID: string) => void
  /** REQ-086:一次性预填文本(deep link `?prompt=`),仅初始化时注入,不覆盖用户后续输入。 */
  initialText?: string
  /** REQ-125 C558:卸载时回报当前草稿(seam dock per-identity 暂存用);门翻转卸载 composer
   *  时据此捕获正在输入的草稿,门翻回时经 `initialText` 注入,使卸载不等于不可恢复的丢失。 */
  onDraftCapture?: (text: string) => void
}

type ReadState<T> = { status: "ready"; data: T } | { status: "error" }
const readState = <T,>(promise: Promise<T>): Promise<ReadState<T>> =>
  promise.then(
    (data) => ({ status: "ready", data }),
    () => ({ status: "error" }),
  )

/** 权威档位读的有界超时(审计第 5 轮 Major:SDK client 关闭默认超时,无界 GET 悬挂会把
 *  sending 永锁 —— 每次发送都暴露在该风险下)。 */
export const SESSION_AGENT_READ_TIMEOUT_MS = 5_000

/** 会话档位的权威实时读(审计第 4 轮 Major):档位决策(needsSwitch / CAS 回滚 / 账本
 *  漂移)一律经 typed SDK GET 直读服务端 —— serverSync 缓存不消费 v2 切档事件、永不更新,
 *  只可作 UI 展示,禁作决策源。
 *  有界(审计第 5 轮 Major):signal 同时交给 SDK(网络层中止)并在本地竞速(即使传输层
 *  忽略 signal,悬挂请求也在超时后按失败 settle)——超时/中止走既有诚实失败路径。 */
async function readSessionAgent(
  client: NonNullable<ReturnType<AlphaProjectsApi["sdk"]>>,
  sessionID: string,
  timeoutMs = SESSION_AGENT_READ_TIMEOUT_MS,
): Promise<{ ok: true; agent: string | undefined } | { ok: false }> {
  try {
    const signal = AbortSignal.timeout(timeoutMs)
    const call = client.v2.session.get({ sessionID }, { signal })
    const result = await new Promise<Awaited<typeof call>>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("session agent read timed out")), { once: true })
      call.then(resolve, reject)
    })
    if (result.error !== undefined || !result.data) return { ok: false }
    return { ok: true, agent: result.data.data.agent }
  } catch {
    return { ok: false }
  }
}

export function AlphaComposer(props: AlphaComposerProps) {
  return <AlphaComposerRuntime {...props} command={useCommand()} />
}

export type AlphaComposerRuntimeProps = AlphaComposerProps & {
  command: CommandApi
  /** 生产默认走 createModelContract；组件级 contract 驱动测试从同一接缝注入确定性实现。 */
  modelContract?: ModelContract
  /** 权威档位读的超时上界(测试接缝;生产默认 SESSION_AGENT_READ_TIMEOUT_MS)。 */
  agentReadTimeoutMs?: number
}

export function AlphaComposerRuntime(props: AlphaComposerRuntimeProps) {
  const command = props.command
  const modelContract = props.modelContract ?? createModelContract(props.projects.sdk)
  const [text, setText] = createSignal(props.initialText ?? "")
  const [sending, setSending] = createSignal(false)
  // 提交发起时记录的已提交文本快照:区分「在途未编辑(=正在交付)」与「在途被改成新草稿」。
  let submittedText: string | undefined
  // REQ-125 C558:卸载时把当前草稿交回宿主(seam dock 按身份暂存),避免门翻转卸载丢草稿。
  // 仅当发送在途**且文本仍等于已提交快照**(未编辑,正在交付)才跳过——否则切走再翻回会「复活」
  // 已发送文本、用户再发 = 重复发送。textarea 在途仍可编辑:改成不同内容即新草稿,照常捕获(不丢)。
  // 失败保留走既有失败路径(sending 落回 false 后一律捕获,text 留在 composer 信号供原地重试)。
  onCleanup(() => {
    if (sending() && text() === submittedText) return
    props.onDraftCapture?.(text())
  })
  const [modelChainState, setModelChainState] = createSignal<"loading" | "recovering" | "ready" | "error">(
    "loading",
  )
  const [mentions, setMentions] = createSignal<MentionPart[]>([])
  const [composing, setComposing] = createSignal(false)
  let taRef: HTMLTextAreaElement | undefined
  const isImeComposing = (e: KeyboardEvent) => e.isComposing || composing() || e.keyCode === 229
  onMount(() => markStartupTimeline("renderer.composer.mount", { mode: props.mode }))

  /* ── 附件真通道(REQ-078 T2:图片/PDF → dataUrl FilePart;纯核 = composer-attachments-core)──
     入口三通道:弹窗「添加附件」→ 隐藏 <input type=file>;textarea 粘贴;整框拖拽。
     不合规(类型/超限)如实 toast 拒绝,绝不静默丢(C28 —— 旧「文件和文件夹」行正是静默吞)。 */
  const [attachments, setAttachments] = createSignal<ComposerAttachment[]>([])
  const [dragOver, setDragOver] = createSignal(false)
  let fileInputRef: HTMLInputElement | undefined
  let attSeq = 0
  const readAsDataUrl = (f: File) =>
    new Promise<string>((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => (typeof r.result === "string" ? resolve(r.result) : reject(new Error("read")))
      r.onerror = () => reject(r.error ?? new Error("read"))
      r.readAsDataURL(f)
    })
  const addFiles = async (list: ArrayLike<File> | null | undefined) => {
    if (!list || list.length === 0) return
    const rejected: Array<{ name: string; reason: string }> = []
    const accepted: ComposerAttachment[] = []
    for (const f of Array.from(list)) {
      const name = f.name || t("alpha.composer.pastedAttachment", { count: attSeq + 1 })
      const c = classifyAttachment({ name, type: f.type, size: f.size })
      if (!c.ok) {
        rejected.push({ name, reason: c.reason })
        continue
      }
      try {
        const url = await readAsDataUrl(f)
        accepted.push({ id: `att-${++attSeq}`, name, mime: f.type, kind: c.kind, size: f.size, url })
      } catch {
        rejected.push({ name, reason: t("alpha.composer.attachmentReadFailed") })
      }
    }
    const merged = mergeAttachments(attachments(), accepted)
    setAttachments(merged.next)
    const bad = [...rejected, ...merged.rejected]
    if (bad.length)
      pushToast({
        kind: "error",
        title: t("alpha.composer.attachmentsRejected"),
        detail: bad.map((item) => `${item.name}: ${attachmentReason(item.reason)}`).join("; "),
      })
  }
  const removeAttachment = (id: string) => setAttachments((xs) => xs.filter((a) => a.id !== id))
  const hasDragFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files")

  // REQ-073 拍板③:模式是会话级的 —— home 是新会话入口,挂载即回默认(build);会话页不重置。
  onMount(() => {
    if (props.mode !== "home") return
    setComposerAgent(null)
    setComposerModel(null)
    clearSuspendedModel()
    resetComposerModelProjection()
  })

  const auto = createComposerAutocomplete({
    text,
    setText,
    textarea: () => taRef,
    directory: props.directory,
    command,
    sdk: props.projects.sdk,
    onMention: (m) => setMentions((xs) => [...xs.filter((x) => x.content !== m.content), m]),
    isComposing: isImeComposing,
    surface: props.mode,
    onAttach: () => fileInputRef?.click(),
  })

  const hasWorkspace = () => !!props.directory()

  /* session 模式:运行态来自 sessionDock 注入的 live status typed 通道(REQ-125 C7,取代
     2.5s 轮询)。状态未知(dock 缺席)= false —— 不显示停止按钮(C28:不装能停)。 */
  const running = () => (props.mode === "session" && props.sessionDock?.running()) || false
  const approvalPending = () => (props.mode === "session" && props.sessionDock?.approvalPending()) || false
  const contextUsage = createMemo(() =>
    props.mode === "session" ? (props.sessionDock?.contextUsage() ?? null) : null,
  )
  const placeholder = () => {
    if (approvalPending()) return t("alpha.composer.placeholderDecision")
    if (running()) return t("alpha.composer.placeholderQueue")
    return composerAgent() === "plan" ? t("alpha.composer.placeholderPlan") : t("alpha.composer.placeholder")
  }

  /* ── 默认模型解析链。session 先从 typed get 收敛真实 Model.Ref；随后 list 负责可用性与默认。
     home 只保留创建会话前的内存选择，创建时把同一 Model.Ref 写进 Session。 */
  const [lastAuth, setLastAuth] = createSignal<AuthState | null>(null)
  const [platformId, setPlatformId] = createSignal<string | null>(null)
  const [hasConfiguredByok, setHasConfiguredByok] = createSignal(false)
  const [platformPermission, setPlatformPermission] = createSignal<"out" | "recovering" | "ready" | "failed">(
    "recovering",
  )
  const [authEpoch, setAuthEpoch] = createSignal(0)
  const [modelRetryEpoch, setModelRetryEpoch] = createSignal(0)
  let chainSeq = 0
  let chainDisposed = false
  let runtimeGenerationEpoch = 0
  let lastAuthSignature: string | undefined
  const modelRetryWakeup = createRetryWakeup({
    onCancel: (reason, outcome) =>
      markStartupTimeline("renderer.retry_backoff.cancel", {
        reason,
        outcome,
        surface: "home",
      }),
  })
  const accountRetryWakeup = createRetryWakeup()
  const authSignature = (state: AuthState) =>
    `${state.status}\u0000${state.mode}\u0000${state.platformStatus ?? "ready"}\u0000${state.account?.email ?? ""}`
  const canSend = createMemo(() => {
    const selected = composerModel()
    const needsPlatform =
      (!!selected && selected.providerID === platformId()) ||
      (!selected && lastAuth()?.status === "logged-in" && !hasConfiguredByok())
    return (
      text().trim().length > 0 &&
      !!props.directory() &&
      modelChainState() === "ready" &&
      (!needsPlatform || platformPermission() === "ready") &&
      !sending()
    )
  })

  const selectComposerModel = async (model: NonNullable<ReturnType<typeof composerModel>>) => {
    // 未获全链 admission 时不能 supersede 正在完成 auth/KEY/account/list 的 owner，否则无人接管 loading。
    if (modelChainState() !== "ready") throw new Error("model chain is not ready")
    if (model.providerID === platformId() && platformPermission() !== "ready")
      throw new Error("platform permission is recovering")
    const seq = ++chainSeq
    const sessionID = props.sessionID?.()
    if (sessionID) {
      const projection = composerModelProjection()
      if (projection.status !== "ready" || projection.sessionID !== sessionID) {
        pushToast({ kind: "info", title: t("alpha.composer.currentModelPending"), detail: t("alpha.composer.currentModelPendingDetail") })
        throw new Error("session model projection is not ready")
      }
      const switched = await readState(modelContract.switch(sessionID, modelRefOf(model)))
      if (chainDisposed || seq !== chainSeq || props.sessionID?.() !== sessionID) {
        throw new Error("session changed while switching model")
      }
      if (switched.status === "error") {
        pushToast({ kind: "error", title: t("alpha.model.switchFailed"), detail: t("alpha.model.switchFailedDetail") })
        throw new Error("model switch failed")
      }
    }
    setComposerModel(model)
    clearSuspendedModel()
  }

  // 账户状态无法确认时 fail-closed；只有明确会员或有余额才允许代理模型。
  const summaryUsable = (r: unknown): boolean => {
    if (!r || typeof r !== "object" || "error" in (r as Record<string, unknown>)) return false
    const s = r as { plan?: { status?: string }; balanceFen?: number }
    return s.plan?.status === "active" || (s.balanceFen ?? 0) > 0
  }

  const runModelChain = async (directory: string, sessionID: string | undefined) => {
    const seq = ++chainSeq
    setModelChainState("loading")
    setLastAuth(null)
    setPlatformId(null)
    setHasConfiguredByok(false)
    setPlatformPermission("recovering")
    if (sessionID) invalidateComposerModelProjection(sessionID)
    else resetComposerModelProjection()

    const catalogRead = readState(window.api.models.catalog())
    const authRead = readState(window.api.auth.getState())
    const keysRead = readState(window.api.providers.keyStatus())
    const currentPromise = sessionID ? readState(modelContract.current(sessionID)) : undefined
    let modelAttempt = 0
    const readModels = () => {
      const attempt = ++modelAttempt
      const markModelList = props.mode === "home" && homeModelListMarkCount < 25
      const started = markModelList ? performance.now() : 0
      if (markModelList) {
        homeModelListMarkCount++
        markStartupTimeline("renderer.home.model_list.start", { attempt, chain: seq })
      }
      const listing = modelContract.list(directory, AbortSignal.timeout(ENGINE_FETCH_TIMEOUT_MS))
      if (markModelList)
        void listing.then(
          (listed) =>
            markStartupTimeline("renderer.home.model_list.end", {
              attempt,
              chain: seq,
              count: listed.length,
              durationMs: performance.now() - started,
              outcome: "ok",
            }),
          () =>
            markStartupTimeline("renderer.home.model_list.end", {
              attempt,
              chain: seq,
              durationMs: performance.now() - started,
              outcome: "error:request",
            }),
        )
      return listing
    }
    // T3:directory SDK 可用就立刻发 model.list；账户读取在下面独立推进，不能成为目录前置门。
    let modelListing = readModels()
    const currentRead = currentPromise ? await currentPromise : undefined
    if (chainDisposed || seq !== chainSeq) return
    if (sessionID && currentRead?.status === "error") {
      failComposerModelProjection(sessionID)
      setModelChainState("error")
      return
    }
    if (sessionID && currentRead?.status === "ready") {
      resolveComposerModelProjection(
        sessionID,
        currentRead.data ? composerModelFromRef(currentRead.data, null) : null,
      )
    }

    const cat = await catalogRead
    if (chainDisposed || seq !== chainSeq) return
    if (cat.status === "error") {
      setModelChainState("error")
      return
    }
    if (sessionID && currentRead?.status === "ready") {
      resolveComposerModelProjection(
        sessionID,
        currentRead.data ? composerModelFromRef(currentRead.data, cat.data) : null,
      )
    }

    const [auth, keys] = await Promise.all([authRead, keysRead])
    if (chainDisposed || seq !== chainSeq) return
    if (keys.status === "error") {
      setModelChainState("error")
      return
    }
    const authState = auth.status === "ready" ? auth.data : null
    if (authState) {
      lastAuthSignature = authSignature(authState)
      setLastAuth(authState)
    }
    const pid = cat.data.platformProvider.id
    setPlatformId(pid)
    const configured = Object.entries(keys.data)
      .filter(([, value]) => value.configured)
      .map(([id]) => id)
    setHasConfiguredByok(configured.some((id) => id !== pid))
    const loggedIn = authState?.status === "logged-in"
    const platformAuthReady = loggedIn && (authState.platformStatus ?? "ready") === "ready"
    if (!loggedIn) setPlatformPermission("out")
    else if (!platformAuthReady) setPlatformPermission("recovering")
    const accountResolution = platformAuthReady
      ? (async () => {
          let recovering = false
          for (let attempt = 1; attempt <= 20 && !chainDisposed && seq === chainSeq; attempt++) {
            const started = performance.now()
            if (props.mode === "home")
              markStartupTimeline("renderer.home.account_summary.start", { attempt, chain: seq })
            const summary = await readState(window.api.account.summary())
            const state = summary.status === "error" ? "recovering" : accountResultState(summary.data)
            if (props.mode === "home")
              markStartupTimeline("renderer.home.account_summary.end", {
                attempt,
                chain: seq,
                durationMs: performance.now() - started,
                outcome: state,
              })
            if (chainDisposed || seq !== chainSeq) return { status: "superseded" as const }
            if (state === "ready" && summary.status === "ready") {
              const usable = summaryUsable(summary.data)
              setPlatformPermission(usable ? "ready" : "failed")
              if (recovering && modelChainState() === "recovering")
                modelRetryWakeup.wake("account-recovered")
              accountRetryWakeup.clear()
              return { status: "ready" as const, usable }
            }
            if (state === "failed") {
              setPlatformPermission("failed")
              accountRetryWakeup.clear()
              return { status: "failed" as const }
            }
            recovering = true
            setPlatformPermission("recovering")
            await accountRetryWakeup.wait(1000)
          }
          // Transport retry budget exhaustion is still not a verified entitlement denial.
          // Remain recovering until auth/generation/SSE or a manual retry starts a fresh chain.
          return { status: "recovering" as const }
        })()
      : null

    let engineModels: EngineModelRef[] = []
    let modelsLoaded = false
    for (let i = 0; i < 20 && !chainDisposed && seq === chainSeq; i++) {
      try {
        const listed = await modelListing
        if (chainDisposed || seq !== chainSeq) return
        engineModels = listed
          .filter((model) => model.enabled && model.status !== "deprecated")
          .map((model) => ({ providerID: model.providerID, id: model.id }))
        modelsLoaded = true
        modelRetryWakeup.clear()
        break
      } catch {
        if (chainDisposed || seq !== chainSeq) return
        setModelChainState("recovering")
      }
      const wait = await modelRetryWakeup.wait(1000)
      if (chainDisposed || seq !== chainSeq) return
      if (props.mode === "home" && i + 1 < 20 && homeModelRetryMarkCount < 25) {
        homeModelRetryMarkCount++
        markStartupTimeline("renderer.home.model_list.retry_tick", {
          attempt: i + 2,
          chain: seq,
          count: homeModelRetryMarkCount,
          delayMs: wait === "cancelled" ? 0 : 1000,
          reason: wait === "cancelled" ? "recovery-signal" : "request-error",
        })
      }
      modelListing = readModels()
    }
    if (chainDisposed || seq !== chainSeq) return
    if (!modelsLoaded) {
      // An exhausted transport retry budget is not a hard catalog failure.
      setModelChainState("recovering")
      return
    }
    setHasConfiguredByok(
      configured.some(
        (id) =>
          id !== pid &&
          engineModels.some((model) => model.providerID === id || model.providerID === `${id}-byok`),
      ),
    )
    const configuredEngineProviders = configured.flatMap((id) => {
      if (engineModels.some((model) => model.providerID === id)) return [id]
      const byokID = `${id}-byok`
      return engineModels.some((model) => model.providerID === byokID) ? [byokID] : []
    })

    const resolveSelection = async (accountUsable: boolean, accountVerified: boolean) => {
      if (chainDisposed || seq !== chainSeq) return
      const current = composerModel()
      const baseCtx = {
        loggedIn: Boolean(platformAuthReady),
        accountUsable,
        platformProviderId: pid,
        configuredProviders: configuredEngineProviders,
        catalog: { defaultModel: cat.data.defaultModel, platformModels: cat.data.platformModels },
        engineModels,
      }
      // 平台当前选择只有在账户事实已验证后才可挂起；恢复窗口不把未知误写成业务否定。
      if (current) {
        if (current.providerID === pid && !accountVerified) return
        const verdict = checkSelectedModel(current, baseCtx)
        if (!verdict.ok) suspendComposerModel(verdict.reason)
        return
      }
      const resolved = resolveDefaultModel(baseCtx)
      if (resolved.kind !== "model") return
      if (sessionID) {
        const switched = await readState(modelContract.switch(sessionID, modelRefOf(resolved.model)))
        if (chainDisposed || seq !== chainSeq || props.sessionID?.() !== sessionID) return
        if (switched.status === "error") {
          setModelChainState("error")
          return
        }
      }
      applyDefaultComposerModel(resolved.model)
    }

    setModelChainState("ready")
    if (!platformAuthReady) await resolveSelection(false, !loggedIn)
    if (!platformAuthReady || chainDisposed || seq !== chainSeq) return
    await resolveSelection(false, false)
    if (chainDisposed || seq !== chainSeq) return

    void accountResolution?.then(async (resolution) => {
      if (chainDisposed || seq !== chainSeq || resolution.status !== "ready") return
      await resolveSelection(resolution.usable, true)
    })
  }

  createEffect(() => {
    authEpoch()
    modelRetryEpoch()
    const directory = props.directory()
    const sessionID = props.sessionID?.()
    if (!directory) {
      chainSeq++
      setModelChainState("loading")
      return
    }
    void runModelChain(directory, sessionID)
  })

  const retryCurrentModel = () => {
    setModelChainState("loading")
    setModelRetryEpoch((value) => value + 1)
  }

  onMount(() => {
    // 登录态变化递增 epoch；路由 directory/sessionID 由上面的 effect 直接跟踪。
    let receivedInitialAuth = false
    const unsub = window.api.auth.subscribe((state) => {
      const signature = authSignature(state)
      if (!receivedInitialAuth) {
        receivedInitialAuth = true
        lastAuthSignature = signature
        return
      }
      if (signature === lastAuthSignature) return
      lastAuthSignature = signature
      setAuthEpoch((value) => {
        markStartupTimeline("renderer.composer.auth_epoch.increment", {
          candidate: "B",
          epoch: value + 1,
          trigger: "auth-change",
        })
        return value + 1
      })
    })
    let receivedRuntimeState = false
    const unsubscribeRuntime = subscribeRuntimeRecovery((state) => {
      if (!receivedRuntimeState) {
        receivedRuntimeState = true
        if (state.status === "ready") return
      }
      if (state.status === "recovering") {
        runtimeGenerationEpoch++
        setModelChainState("recovering")
        // C7:引擎运行态是 typed live 通道的派生值(sessionDock.running),重启后随
        // session_status 自行归位 —— 本地只需复位在途提交并如实播报中断。
        if (running() || sending()) {
          markStartupTimeline("renderer.generation.interruption", {
            generation: state.generation,
            reason: state.reason,
          })
          setSending(false)
          pushToast({
            kind: "info",
            title: t("alpha.composer.generationInterrupted"),
            detail: t("alpha.composer.generationInterruptedDetail"),
          })
        }
        return
      }
      modelRetryWakeup.wake("generation-ready")
      if (modelChainState() === "recovering") setModelRetryEpoch((value) => value + 1)
      accountRetryWakeup.wake("generation-ready")
    })
    const unsubscribeSse = subscribeSseReconnected(() => {
      modelRetryWakeup.wake("sse-reconnected")
      if (modelChainState() === "recovering") setModelRetryEpoch((value) => value + 1)
      accountRetryWakeup.wake("sse-reconnected")
    })
    onCleanup(() => {
      chainDisposed = true
      unsub?.()
      unsubscribeRuntime()
      unsubscribeSse()
      modelRetryWakeup.dispose()
      accountRetryWakeup.dispose()
    })
  })

  const abort = async () => {
    const c = props.projects.sdk()
    const sid = props.sessionID?.()
    if (!c || !sid) return
    try {
      const result = await c.session.abort({ sessionID: sid, directory: props.directory() } as any)
      // throwOnError:false 档位的 { error } 信封同样是失败(审计 minor:4xx 不装停止成功)。
      if ((result as { error?: unknown } | undefined)?.error !== undefined) throw new Error("abort rejected")
    } catch {
      pushToast({ kind: "error", title: t("alpha.composer.abortFailed") })
    }
  }

  const submit = async () => {
    if (!text().trim() || sending()) return
    const dir = props.directory()
    if (!dir) {
      props.onNeedWorkspace?.()
      return
    }
    if (modelChainState() !== "ready") {
      pushToast({
        kind: modelChainState() === "error" ? "error" : "info",
        title: modelChainState() === "error" ? t("alpha.composer.modelStateFailed") : t("alpha.composer.modelStateReading"),
        detail: t("alpha.composer.modelStateDetail"),
      })
      return
    }
    const suspended = composerModelSuspended()
    if (suspended && !composerModel()) {
      pushToast({
        kind: "info",
        title: t("alpha.composer.currentModelUnavailable"),
        detail:
          suspended.reason === "needs-login"
            ? t("alpha.composer.currentModelLogin")
            : suspended.reason === "needs-credit"
              ? t("alpha.composer.currentModelCredit")
              : t("alpha.composer.currentModelChoose"),
      })
      return
    }
    // REQ-069 preflight:未登录 + 代理模型(或全无可用)→ 行内引导替代网关拒绝原文。
    const block = preflightBlockReason(composerModel(), {
      loggedIn:
        lastAuth()?.status === "logged-in" && (lastAuth()?.platformStatus ?? "ready") === "ready",
      platformProviderId: platformId(),
      hasConfiguredByok: hasConfiguredByok(),
    })
    if (block) {
      pushToast(
        block === "platform-needs-login"
          ? {
              kind: "info",
              title: t("alpha.composer.modelNeedsLogin"),
              detail: t("alpha.composer.modelNeedsLoginDetail"),
            }
          : {
              kind: "info",
              title: t("alpha.composer.noModel"),
              detail: t("alpha.composer.noModelDetail"),
            },
      )
      return
    }
    const body = text().trim()
    // 斜杠命令走 session.command,不携带 parts —— 附件会被静默丢弃;如实拦下(C28),不装作发出去了。
    if (attachments().length > 0 && body.startsWith("/")) {
      pushToast({ kind: "info", title: t("alpha.composer.commandNoAttachments"), detail: t("alpha.composer.commandNoAttachmentsDetail") })
      return
    }
    const req = buildPromptRequest({
      text: body,
      extraParts: [...buildMentionParts(body, dir, mentions()), ...buildAttachmentParts(attachments())],
      model: composerModel(),
      effort: composerEffortSel(),
      perm: composerPerm(),
      agent: composerAgent(),
    })
    const submissionGeneration = runtimeGenerationEpoch
    const interrupted = () => submissionGeneration !== runtimeGenerationEpoch
    submittedText = text() // 已提交文本快照(在途未编辑判据)
    setSending(true)
    try {
      if (props.mode === "home") {
        const id = await props.projects.startChat(dir, body, req.parts.slice(1), {
          model: req.model,
          agent: req.agent,
        })
        if (interrupted()) return
        if (!id) {
          pushToast({ kind: "error", title: t("alpha.composer.sendFailed") })
          return
        }
        setText("")
        setMentions([])
        setAttachments([])
        props.onSubmitted?.(id)
        return
      }
      // session 模式
      const c = props.projects.sdk()
      const sid = props.sessionID?.()
      if (!c || !sid) {
        pushToast({ kind: "error", title: t("alpha.composer.sessionPending") })
        return
      }
      const slash = routeSlash(body)
      if (slash) {
        const { data: cmds } = await c.command
          .list({ directory: dir } as any)
          .catch(() => ({ data: undefined }) as const)
        if (interrupted()) return
        if (Array.isArray(cmds) && cmds.some((x: any) => x?.name === slash.name)) {
          const { data: commanded, error } = await c.session.command({
            sessionID: sid,
            directory: dir,
            command: slash.name,
            arguments: slash.args,
          } as any)
          if (interrupted()) return
          if (error) {
            pushToast({ kind: "error", title: t("alpha.composer.commandFailed") })
            return
          }
          // REQ-125 C7:send 当下捕获命令来源(上游不保留);assistant messageID 用于时间线对齐。
          const assistantMessageID = (commanded as { info?: { id?: string } } | undefined)?.info?.id
          props.sessionDock?.onSlashCommand?.({
            sessionID: sid,
            directory: dir,
            command: slash.name,
            arguments: slash.args,
            ...(typeof assistantMessageID === "string" && assistantMessageID ? { assistantMessageID } : {}),
          })
          setText("")
          setMentions([])
          return
        }
      }
      // REQ-125 C7:会话发送走 v2 durable 输入队列(session.prompt + delivery),直连
      // promptAsync 退役。运行中 = "queue"(与占位文案「发送后排队」一致,含 Enter 路径);
      // 空闲省略 delivery(引擎默认 steer,行为等价即时执行)。
      //
      // 档位协议(审计第 2-5 轮:可逆、原子、不污染 durable 队列,决策源=权威实时读):
      // ① 空闲:发送前把会话档切到本次期望档;prompt 提交失败经 CAS 权威核验后回滚,
      //   不留下已改档的会话。
      // ② 运行中:切档会立刻作用于正在 drain 的回合 —— 需要改档的排队发送如实拒绝
      //   (提示等当前任务结束);无档位变化的发送正常排队。
      // ③ 退出 plan/readonly:期望档回空时,若会话档仍是本 composer 推送的档,切回引擎
      //   默认档(账本只回滚自己写过的,不碰用户在别处设置的档)。
      // 发送前:权威实时读当前会话档(决策源;serverSync 缓存禁用于决策 —— 见 readSessionAgent)。
      // 读不到 = 无法安全决策档位,按发送失败如实拦下(正文保留)。
      const agentRead = await readSessionAgent(c, sid, props.agentReadTimeoutMs)
      if (interrupted()) return
      if (!agentRead.ok) {
        pushToast({ kind: "error", title: t("alpha.composer.sendFailed") })
        return
      }
      const agentNow = agentRead.agent
      let entryBefore = pushedAgentFor(sid)
      if (entryBefore !== undefined && agentNow !== entryBefore) {
        // 权威漂移判定:会话档已被他处改写 → 弃权,不重新认领(含用户改回默认的情形)。
        recordPushedAgent(sid, null)
        entryBefore = undefined
      }
      const desiredAgent = req.agent ?? (entryBefore !== undefined ? DEFAULT_AGENT : undefined)
      const needsAgentSwitch = desiredAgent !== undefined && desiredAgent !== (agentNow ?? DEFAULT_AGENT)
      if (needsAgentSwitch && running()) {
        pushToast({
          kind: "info",
          title: t("alpha.composer.agentQueueBlocked"),
          detail: t("alpha.composer.agentQueueBlockedDetail"),
        })
        return
      }
      let rollbackAgent: string | undefined
      if (needsAgentSwitch) {
        const switched = await c.v2.session
          .switchAgent({ sessionID: sid, agent: desiredAgent })
          .catch(() => ({ error: new Error("switch agent failed") }))
        if (interrupted()) return
        if ((switched as { error?: unknown } | undefined)?.error !== undefined) {
          pushToast({ kind: "error", title: t("alpha.composer.sendFailed") })
          return
        }
        rollbackAgent = agentNow ?? DEFAULT_AGENT
        recordPushedAgent(sid, desiredAgent === DEFAULT_AGENT ? null : desiredAgent)
      }
      const admitted = await c.v2.session
        .prompt({
          sessionID: sid,
          prompt: buildPromptInput({ text: body, mentions: mentions(), attachments: attachments() }),
          ...(running() ? { delivery: "queue" as const } : {}),
        })
        .catch(() => undefined)
      if (interrupted()) return
      if (admitted === undefined || admitted.error !== undefined || !admitted.data) {
        if (rollbackAgent !== undefined) {
          // CAS 回滚(审计第 3-5 轮 Major):回滚决策前经 typed SDK **权威实时读**当前会话档
          // (不经 serverSync 缓存)——仍等于 composer 刚设的 desired 才回滚;读到其它值 =
          // 用户并发改档,不覆盖用户选择,只放弃自己的账本;权威读不可得时不盲写回滚
          // (宁可留下 desired 也不冒覆盖用户并发选择的险),账本保持与引擎最后受理状态一致,
          // 后续发送经权威读自愈。发送失败本身已如实提示。
          const verify = await readSessionAgent(c, sid, props.agentReadTimeoutMs)
          if (interrupted()) return
          if (verify.ok && verify.agent === desiredAgent) {
            const rolled = await c.v2.session
              .switchAgent({ sessionID: sid, agent: rollbackAgent })
              .catch(() => ({ error: new Error("switch agent rollback failed") }))
            if ((rolled as { error?: unknown } | undefined)?.error === undefined) {
              recordPushedAgent(sid, entryBefore ?? null)
            }
          } else if (verify.ok) {
            recordPushedAgent(sid, null)
          }
        }
        pushToast({ kind: "error", title: t("alpha.composer.sendFailed") })
        return
      }
      setText("")
      setMentions([])
      setAttachments([])
      // 忙态由 live status typed 通道驱动,这里不再乐观置位。
    } catch {
      if (!interrupted()) pushToast({ kind: "error", title: t("alpha.composer.sendFailed") })
    } finally {
      setSending(false)
      submittedText = undefined // 落定后复位:成功已清空、失败保留,此后一律按草稿捕获
    }
  }

  const onKey = (e: KeyboardEvent) => {
    if (auto.onKeyDown(e)) return
    // REQ-073:Shift+Tab 切换计划模式(Codex 同款;readonly 档下不切换 —— 模式本就不生效)
    if (e.key === "Tab" && e.shiftKey && !isImeComposing(e)) {
      e.preventDefault()
      if (composerPerm() !== "readonly") setComposerAgent(composerAgent() === "plan" ? null : "plan")
      return
    }
    if (e.key === "Enter" && !e.shiftKey && !isImeComposing(e)) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    // a-ui 作用域类保持随组件走:home 与 session 宿主布局各异,自带作用域才能保证焦点圈治理
    // (.a-ui .a-chip:focus…)与基础排版在任何挂点一致(用户报障 2026-07-07 的固化教训)。
    <div
      class="a-ui a-comp"
      data-alpha-composer={props.mode}
      data-empty={text().trim() ? undefined : ""}
      data-approval={approvalPending() ? "" : undefined}
      data-drag={dragOver() ? "" : undefined}
      onClick={stop}
      onDragOver={(e) => {
        if (!hasDragFiles(e)) return
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={(e) => {
        // 只在真正离开 composer 树时熄灭(进入子元素也会触发 dragleave)
        if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) setDragOver(false)
      }}
      onDrop={(e) => {
        if (!hasDragFiles(e)) return
        e.preventDefault()
        setDragOver(false)
        void addFiles(e.dataTransfer?.files)
      }}
    >
      <auto.Menu />
      <input
        ref={fileInputRef}
        type="file"
        accept={ATTACH_ACCEPT}
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          void addFiles(e.currentTarget.files)
          e.currentTarget.value = "" // 允许再次选择同一文件
        }}
      />
      <Show when={attachments().length > 0}>
        <div class="a-comp-atts">
          <For each={attachments()}>
            {(a) => (
              <span class="a-comp-att" data-kind={a.kind}>
                <Show when={a.kind === "image"} fallback={<FileGlyph />}>
                  <img src={a.url} alt="" />
                </Show>
                <span class="a-comp-att-name" title={`${a.name} · ${(a.size / 1024 / 1024).toFixed(1)}MB`}>
                  {a.name}
                </span>
                <button
                  class="a-comp-att-x"
                  title={t("alpha.composer.removeAttachment")}
                  aria-label={t("alpha.composer.removeAttachment")}
                  onClick={() => removeAttachment(a.id)}
                >
                  ×
                </button>
              </span>
            )}
          </For>
        </div>
      </Show>
      <textarea
        ref={taRef}
        class="a-comp-input"
        rows="1"
        placeholder={placeholder()}
        aria-label={placeholder()}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={auto.open()}
        aria-controls={auto.listboxId}
        aria-activedescendant={auto.activeDescendant()}
        value={text()}
        onInput={(e) => {
          setText(e.currentTarget.value)
          auto.onInput()
        }}
        onKeyDown={onKey}
        onPaste={(e) => {
          const files = e.clipboardData?.files
          if (files && files.length > 0) {
            e.preventDefault() // 图片/PDF 粘贴进附件通道;纯文本粘贴不受影响
            void addFiles(files)
          }
        }}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
      />
      <Show when={modelChainState() === "error"}>
        <div class="a-comp-model-alert" role="alert">
          <span>{t("alpha.composer.modelChainFailed")}</span>
          <button type="button" onClick={retryCurrentModel}>
            {t("alpha.common.retry")}
          </button>
        </div>
      </Show>
      <Show when={modelChainState() === "recovering"}>
        <div class="a-comp-model-alert" role="status">
          <span>{t("alpha.model.syncing")}</span>
        </div>
      </Show>
      <div class="a-comp-bar">
        <AddButton expanded={auto.assembleOpen()} onOpen={() => auto.toggleAssemble()} />
        <PermChip command={command} />
        <PlanChip />
        <div class="a-comp-grow" />
        {/* 上下文用量 ring(session:sessionDock 从 typed 通道计算注入;事实不足 = null 不渲染;
            home 无会话无用量,不渲染 —— 收养上游 DOM 节点的 takeover 机制已随 REQ-125 C7 终结) */}
        <Show when={contextUsage() !== null}>
          <span
            class="a-comp-usage"
            title={t("alpha.composer.contextUsage", { percent: contextUsage()! })}
            aria-label={t("alpha.composer.contextUsage", { percent: contextUsage()! })}
          >
            <span class="a-comp-usage-ring" style={{ "--a-comp-usage-fill": `${contextUsage()}%` }} aria-hidden="true" />
            <span class="a-comp-usage-num">{contextUsage()}%</span>
          </span>
        </Show>
        <ModelChip
          contract={modelContract}
          directory={props.directory}
          onSelect={selectComposerModel}
          onRetryCurrent={retryCurrentModel}
          modelChainReady={() => modelChainState() === "ready"}
          onNeedWorkspace={props.onNeedWorkspace}
          hasWorkspace={hasWorkspace}
        />
        <EffortChip
          contract={modelContract}
          directory={props.directory}
          onSelect={selectComposerModel}
          onRetryCurrent={retryCurrentModel}
          modelChainReady={() => modelChainState() === "ready"}
        />
        <Show
          when={running()}
          fallback={
            <button
              class="a-comp-send"
              data-ready={canSend() ? "" : undefined}
              disabled={!canSend()}
              onClick={() => void submit()}
              title={t("alpha.composer.send")}
              aria-label={t("alpha.composer.send")}
            >
              <ArrowUp />
            </button>
          }
        >
          <button
            class="a-comp-send a-comp-stop"
            data-ready
            onClick={() => void abort()}
            title={t("alpha.composer.stopGenerating")}
            aria-label={t("alpha.composer.stopGenerating")}
          >
            <StopSquare />
          </button>
        </Show>
      </div>
    </div>
  )
}

function attachmentReason(reason: string) {
  if (reason.startsWith("仅支持")) return t("alpha.composer.attachmentTypeUnsupported")
  if (reason.startsWith("超过图片"))
    return t("alpha.composer.attachmentImageTooLarge", { size: IMAGE_MAX_BYTES / 1024 / 1024 })
  if (reason.startsWith("超过PDF"))
    return t("alpha.composer.attachmentPdfTooLarge", { size: PDF_MAX_BYTES / 1024 / 1024 })
  if (reason.startsWith("最多")) return t("alpha.composer.attachmentCountExceeded", { count: ATTACH_MAX_COUNT })
  return reason
}
