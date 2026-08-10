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
  untrack,
  type JSX,
} from "solid-js"
import { Portal } from "solid-js/web"
import { useCommand } from "./providers"
import { setExtHubOpen } from "../extensions/ext-hub-state"
import { createComposerAutocomplete } from "./composer-autocomplete"
import { buildMentionParts, type MentionPart } from "./composer-autocomplete-core"
import {
  ATTACH_ACCEPT,
  ATTACH_MAX_COUNT,
  buildAttachmentParts,
  classifyAttachment,
  IMAGE_MAX_BYTES,
  mergeAttachments,
  PDF_MAX_BYTES,
  type AttachmentReadResult,
  type ComposerAttachment,
  type PendingAttachmentRead,
} from "./composer-attachments-core"
import { pathHitsPopover } from "./popover-hit"
import { pushToast } from "./Toast"
import type { AlphaProjectsApi } from "../sidebar/use-projects"
import type { AuthState } from "../../preload/types"
import {
  adoptComposerAgentScope,
  applyDefaultComposerModel,
  buildPromptRequest,
  clearSuspendedModel,
  composerAgent,
  composerEffortSel,
  composerModel,
  composerModelProjection,
  composerModelSuspended,
  composerPerm,
  failComposerModelProjection,
  invalidateComposerModelProjection,
  releaseComposerAgentScope,
  resetComposerModelProjection,
  resolveComposerModelProjection,
  routeSlash,
  seedComposerAgentScope,
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
import { createModelContract, ModelContractError, type ModelContract } from "./model-contract"
import { byokEngineId, isByokEngineId } from "../../shared/alpha-model-types"
import { composerModelFromRef, modelRefOf, withModelVariant } from "./model-picker-core"
import { ENGINE_FETCH_TIMEOUT_MS } from "./model-picker-logic"
import { accountResultState, createRetryWakeup, loadEngineModelsWithRetry, resolveAccountWithRetry } from "./model-recovery"
import { t } from "../i18n"
import { markStartupTimeline } from "../startup-timeline"
import { subscribeRuntimeRecovery, subscribeSseReconnected } from "../runtime-recovery"
import { reconcileAuthSnapshot, subscribeAuthState } from "../auth-recovery"
import "./alpha-composer.css"

/* ── 单开注册表(全部 chips 共享;开新的自动关旧的)──────────────────────────── */
const [openChipId, setOpenChipId] = createSignal<number | null>(null)
let chipSeq = 0
let homeModelListMarkCount = 0
let homeModelRetryMarkCount = 0
let homeAccountMarkCount = 0
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

/* ── 权限 chip:ask = 引擎默认(命中权限就弹审批);readonly = 提交时强制只读 agent ──
 * REQ-126 AC7(#658):第三档「全自动」已退休。它发的 `permissions.autoaccept.enable/.disable`
 * 两个 id 上游根本没有(上游只有单个 `permissions.autoaccept`,且注册处随 session 叶退役),而
 * 提交层只对 `readonly` 分支 —— 于是「全自动」与「询问」产出完全相同的请求。留着它就是界面上
 * 一个点了不算数的开关。真正的自动放行要接权限引擎,是新能力,另立需求。 */
const permLabel = (mode: PermMode) => (mode === "ask" ? t("alpha.composer.permAsk") : t("alpha.composer.permReadonly"))

type CommandApi = ReturnType<typeof useCommand>

export function PermChip() {
  const { isOpen, toggle, close } = useChip()
  let btn: HTMLButtonElement | undefined
  const pick = (m: PermMode) => {
    setComposerPerm(m)
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
  /** REQ-126:与 `initialText` 同期一次性注入的 mention / 附件(新对话页切目录重挂后的还原)。 */
  initialMentions?: readonly MentionPart[]
  initialAttachments?: readonly ComposerAttachment[]
  /** #663:上一实例交下来的在途读盘工单。挂载即接手 —— settle 后并入本实例的附件列表,本实例
   *  再卸载时把还没 settle 的继续交出去。这样「读盘中的附件」跟着 draft 走,而不是跟着实例死。 */
  initialPendingReads?: readonly PendingAttachmentRead[]
  /** REQ-125 C558:卸载时回报当前草稿(seam dock per-identity 暂存用);门翻转卸载 composer
   *  时据此捕获正在输入的草稿,门翻回时经 `initialText` 注入,使卸载不等于不可恢复的丢失。 */
  onDraftCapture?: (text: string) => void
  /** REQ-126:卸载时回报**完整**草稿(文本 + mention + 附件)。与 `onDraftCapture` 同一时机、
   *  同一份 sending 判据,只是内容更全 —— 新对话页切目录会重挂整叶,只留文本仍然是丢内容。
   *  #663:`pendingReads` = 卸载这一刻还没读完的附件。宿主必须把它连同快照一起存,并在下次挂载
   *  时经 `initialPendingReads` 交回去 —— 只存 `attachments` 就等于丢掉正在读的那些。 */
  onDraftSnapshot?: (draft: {
    text: string
    mentions: readonly MentionPart[]
    attachments: readonly ComposerAttachment[]
    pendingReads: readonly PendingAttachmentRead[]
  }) => void
  /** REQ-126:附件正在被 FileReader 读取。读取未完成时 composer 里还没有这份附件 —— 宿主据此
   *  **拦住**会导致重挂的操作(切目录)并明确提示,而不是让用户对着一个暂时空着的附件区发愣。
   *  (#663 起内容本身不会因重挂而丢:在途工单随草稿快照移交,见 `initialPendingReads`。) */
  onAttachmentReadPending?: (pending: boolean) => void
}

// 附件 id 在**渲染进程内**唯一。#663 起读盘工单可跨实例移交,两个实例各自从 1 开始编号就会撞 id
// (removeAttachment 按 id 过滤,撞了会一次删掉两个)。id 只对内,不进请求。
let attachmentSeq = 0
const nextAttachmentId = () => `att-${++attachmentSeq}`

type ReadState<T> = { status: "ready"; data: T } | { status: "error" }
const readState = <T,>(promise: Promise<T>): Promise<ReadState<T>> =>
  promise.then(
    (data) => ({ status: "ready", data }),
    () => ({ status: "error" }),
  )

/* #652:会话档位的权威实时读(readSessionAgent / SESSION_AGENT_READ_TIMEOUT_MS)随 v2
   durable 发送一起退役 —— v1 promptAsync 每条消息自带 agent,不存在「会话档」这个需要
   先读后 CAS 的中间状态。 */

export function AlphaComposer(props: AlphaComposerProps) {
  return <AlphaComposerRuntime {...props} command={useCommand()} />
}

export type AlphaComposerRuntimeProps = AlphaComposerProps & {
  command: CommandApi
  /** 生产默认走 createModelContract；组件级 contract 驱动测试从同一接缝注入确定性实现。 */
  modelContract?: ModelContract
}

export function AlphaComposerRuntime(props: AlphaComposerRuntimeProps) {
  const command = props.command
  const modelContract = props.modelContract ?? createModelContract(props.projects.sdk)
  // #663:本实例是否已卸载。异步读盘 settle 时据此让位 —— 已卸载的实例不写暂存、不弹 toast。
  let disposed = false
  const [text, setText] = createSignal(props.initialText ?? "")
  const [sending, setSending] = createSignal(false)
  // 提交发起时记录的已提交文本快照:区分「在途未编辑(=正在交付)」与「在途被改成新草稿」。
  let submittedText: string | undefined
  // REQ-125 C558:卸载时把当前草稿交回宿主(seam dock 按身份暂存),避免门翻转卸载丢草稿。
  // 仅当发送在途**且文本仍等于已提交快照**(未编辑,正在交付)才跳过——否则切走再翻回会「复活」
  // 已发送文本、用户再发 = 重复发送。textarea 在途仍可编辑:改成不同内容即新草稿,照常捕获(不丢)。
  // 失败保留走既有失败路径(sending 落回 false 后一律捕获,text 留在 composer 信号供原地重试)。
  // 注:mentions / attachments / inflightReads 在下方声明;cleanup 只在 dispose 时执行,那时三者
  // 早已初始化。
  onCleanup(() => {
    // #663:卸载后本实例**不再动任何东西** —— 读完的工单由接手方处理(见 trackRead)。已死的实例
    // 继续往暂存里写整份快照,会把活着那个实例的快照覆盖掉,那正是「回来得比读完早」时丢附件的路。
    disposed = true
    if (sending() && text() === submittedText) return
    props.onDraftCapture?.(text())
    props.onDraftSnapshot?.({
      text: text(),
      mentions: mentions(),
      attachments: attachments(),
      // #663:还没读完的那些随快照一起移交 —— 读盘结果属于这条 draft,不属于发起读取的实例。
      pendingReads: [...inflightReads],
    })
  })
  const [modelChainState, setModelChainState] = createSignal<"loading" | "recovering" | "ready" | "error">(
    "loading",
  )
  // Token renewal briefly replaces the loopback sidecar without remounting this renderer. Keep
  // the established model projection visible while idle, but gate every engine-backed action
  // until the new generation is healthy. This separates availability from presentation: a
  // routine renewal no longer inserts/removes the "Syncing…" row and shifts the whole composer.
  const [runtimeUnavailable, setRuntimeUnavailable] = createSignal(false)
  const [mentions, setMentions] = createSignal<MentionPart[]>([...(props.initialMentions ?? [])])
  const [composing, setComposing] = createSignal(false)
  let taRef: HTMLTextAreaElement | undefined
  const isImeComposing = (e: KeyboardEvent) => e.isComposing || composing() || e.keyCode === 229
  onMount(() => markStartupTimeline("renderer.composer.mount", { mode: props.mode }))

  /* ── 附件真通道(REQ-078 T2:图片/PDF → dataUrl FilePart;纯核 = composer-attachments-core)──
     入口三通道:弹窗「添加附件」→ 隐藏 <input type=file>;textarea 粘贴;整框拖拽。
     不合规(类型/超限)如实 toast 拒绝,绝不静默丢(C28 —— 旧「文件和文件夹」行正是静默吞)。 */
  const [attachments, setAttachments] = createSignal<ComposerAttachment[]>([...(props.initialAttachments ?? [])])
  const [dragOver, setDragOver] = createSignal(false)
  // REQ-126:有附件正在读盘(FileReader 未 settle)。这段窗口里内容既不在 attachments() 里、
  // 也无处可存 —— 宿主据此拦住会触发重挂的操作(见 onAttachmentReadPending)。
  const [attachmentReads, setAttachmentReads] = createSignal(0)
  createEffect(() => props.onAttachmentReadPending?.(attachmentReads() > 0))
  // #663:本实例名下还没 settle 的读盘工单(自己发起的 + 从上一实例接手的)。卸载时随快照交出去。
  const inflightReads = new Set<PendingAttachmentRead>()
  let fileInputRef: HTMLInputElement | undefined
  // 「粘贴的附件 N」这个**显示名**按本实例计数(用户看到的是这次输入里的第几个)。
  let pasteSeq = 0
  const readAsDataUrl = (f: File) =>
    new Promise<string>((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => (typeof r.result === "string" ? resolve(r.result) : reject(new Error("read")))
      r.onerror = () => reject(r.error ?? new Error("read"))
      // abort 也必须 settle:漏了它,读取计数永不归零,工作区切换从此被永久拦住。
      r.onabort = () => reject(new Error("attachment read aborted"))
      r.readAsDataURL(f)
    })
  // 读一批文件,**不碰任何实例状态** —— 并入谁、由谁报拒绝,交给 trackRead 里那个「settle 时还
  // 活着的实例」决定(#663)。这是工单可以跨实例移交的前提。
  const readFiles = async (list: ArrayLike<File>): Promise<AttachmentReadResult> => {
    const rejected: Array<{ name: string; reason: string }> = []
    const accepted: ComposerAttachment[] = []
    for (const f of Array.from(list)) {
      const name = f.name || t("alpha.composer.pastedAttachment", { count: ++pasteSeq })
      const c = classifyAttachment({ name, type: f.type, size: f.size })
      if (!c.ok) {
        rejected.push({ name, reason: c.reason })
        continue
      }
      try {
        const url = await readAsDataUrl(f)
        accepted.push({ id: nextAttachmentId(), name, mime: f.type, kind: c.kind, size: f.size, url })
      } catch {
        rejected.push({ name, reason: t("alpha.composer.attachmentReadFailed") })
      }
    }
    return { accepted, rejected }
  }
  /** 认领一份读盘工单:挂起计数 +1,settle 时并入**当时活着的这个实例**并如实 toast 拒绝。
   *  已卸载则原地让位 —— 结果已经随工单交给了接手方,这里再写就是覆盖活人的状态。 */
  const trackRead = (read: PendingAttachmentRead) => {
    // 计数(不是布尔):并发的多次粘贴/拖拽各自 settle,最后一个读完才算不再挂起。
    setAttachmentReads((n) => n + 1)
    inflightReads.add(read)
    void read.then((result) => {
      inflightReads.delete(read)
      setAttachmentReads((n) => n - 1)
      if (disposed) return
      const merged = mergeAttachments(attachments(), result.accepted)
      setAttachments(merged.next)
      const bad = [...result.rejected, ...merged.rejected]
      if (bad.length)
        pushToast({
          kind: "error",
          title: t("alpha.composer.attachmentsRejected"),
          detail: bad.map((item) => `${item.name}: ${attachmentReason(item.reason)}`).join("; "),
        })
    })
  }
  const addFiles = (list: ArrayLike<File> | null | undefined) => {
    if (!list || list.length === 0) return
    // 工单**必须** settle:不 settle 则挂起计数永不归零,工作区切换从此被永久拦住。每文件的读失败
    // readFiles 内部已转成 rejected,这里只兜意料外的抛错 —— 兜也如实报出来,不静默吞(C28)。
    const names = Array.from(list).map((f, i) => f.name || t("alpha.composer.pastedAttachment", { count: i + 1 }))
    trackRead(
      readFiles(list).catch(() => ({
        accepted: [],
        rejected: names.map((name) => ({ name, reason: t("alpha.composer.attachmentReadFailed") })),
      })),
    )
  }
  // #663:接手上一实例交下来的在途工单(离开 draft 时随草稿快照移交)。已经 settle 的照接 ——
  // promise 记着结果,接手即并入;「读完时正好没人活着」因此不再是丢失,只是晚一点并进来。
  props.initialPendingReads?.forEach(trackRead)
  const removeAttachment = (id: string) => setAttachments((xs) => xs.filter((a) => a.id !== id))
  const hasDragFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files")

  // REQ-073 拍板③:模式是会话级的 —— home 是新会话入口,挂载即回默认(build)。
  onMount(() => {
    if (props.mode !== "home") return
    setComposerModel(null)
    clearSuspendedModel()
    resetComposerModelProjection()
  })

  /* #570:上一行那句「会话级」此前只写在注释里 —— 档位信号是模块级的,会话页又不重置,于是它
     **跟着人跑**:在会话 A 开「计划」、点侧栏进会话 B,B 的 chip 照样显示「计划」,B 的下一条
     消息也真的以 agent=plan 发出。这里把作用域接上:进一个会话就接管它自己的档位(没开过 =
     默认 build),离开就把当前档位交还给它。home 的作用域是 null(新会话入口,一律回默认)。
     用 createEffect 而不是 onMount:生产的会话 composer 由 SessionComposerMount 按身份 keyed
     重挂,但同一实例内 sessionID 换代(模型链已按此换代)也必须换档位 —— 两种都盖住。 */
  let agentScope: string | null = null
  let agentScopeHeld = false
  createEffect(() => {
    const next = props.mode === "home" ? null : (props.sessionID?.() ?? null)
    untrack(() => {
      if (agentScopeHeld && next === agentScope) return
      if (agentScopeHeld) releaseComposerAgentScope(agentScope)
      agentScope = next
      agentScopeHeld = true
      adoptComposerAgentScope(next)
    })
  })
  onCleanup(() => {
    if (agentScopeHeld) releaseComposerAgentScope(agentScope)
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
  /* #595 谓词 2 的事实源:引擎本次实际注册的模型。撤销豁免(checkSelectedModel)让「选择」活了下来,
     发送门就必须自己拿这份清单挡住不可执行的提交 —— 两个谓词各自执行,谁也不代替谁。 */
  const [engineModelRefs, setEngineModelRefs] = createSignal<EngineModelRef[]>([])
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
  const preflightCtx = () => ({
    loggedIn: lastAuth()?.status === "logged-in" && (lastAuth()?.platformStatus ?? "ready") === "ready",
    platformProviderId: platformId(),
    hasConfiguredByok: hasConfiguredByok(),
    engineModels: engineModelRefs(),
  })
  /** #595:已选的本地 BYOK 在引擎清单里查无对应节点(含引擎成功返回空清单)—— 可选择性照旧
   *  (不撤销),但**不可执行**。判据自己不猜「就绪」:`engineModelRefs` 只在链 ready 之前写入
   *  (:995 早于 :1046),消费方一律先过 `modelChainState() === "ready"`,冷启动窗口不会误杀。 */
  const byokNotRegistered = createMemo(
    () => preflightBlockReason(composerModel(), preflightCtx()) === "byok-not-registered",
  )
  const canSend = createMemo(() => {
    const selected = composerModel()
    const needsPlatform =
      (!!selected && selected.providerID === platformId()) ||
      (!selected && lastAuth()?.status === "logged-in" && !hasConfiguredByok())
    return (
      text().trim().length > 0 &&
      !!props.directory() &&
      !runtimeUnavailable() &&
      modelChainState() === "ready" &&
      (!needsPlatform || platformPermission() === "ready") &&
      // 谓词 2:引擎里没有这个直连节点就发不出去,按钮如实关闭(行内另有告知)。
      !byokNotRegistered() &&
      !sending()
    )
  })

  const selectComposerModel = async (model: NonNullable<ReturnType<typeof composerModel>>) => {
    /* REQ-109 #595:home 的本地 BYOK 直连节点在引擎链恢复中也能写进内存选择 —— 它的可选择性只由
       本地目录 + 本地 KEY 决定(契约 docs/contracts/byok-availability.md),而 home 的“选中”本身
       只是一次内存写(下方 setComposerModel),不需要引擎。执行仍是另一个谓词:canSend 继续要求
       modelChainState() === "ready",绝不在引擎未恢复时假装能发送。
       session 模式不豁免:换模型必须落到服务端 switchModel,引擎不在就不能伪装成已切换。 */
    const homeLocalByok = props.mode === "home" && !props.sessionID?.() && isByokEngineId(model.providerID)
    if (runtimeUnavailable() && !homeLocalByok) throw new Error("runtime is recovering")
    // 未获全链 admission 时不能 supersede 正在完成 auth/KEY/account/list 的 owner，否则无人接管 loading。
    if (modelChainState() !== "ready" && !homeLocalByok) throw new Error("model chain is not ready")
    if (model.providerID === platformId() && platformPermission() !== "ready")
      throw new Error("platform permission is recovering")
    /* home 本地 BYOK 选择在**任何** modelChainState 下都不得 supersede 在跑的链:`++chainSeq` 会让
       list 重试循环(loadEngineModelsWithRetry)与账户恢复循环(resolveAccountWithRetry)双双判
       isStale 而静默退出 —— 前者是 #594 修掉的模型链悬崖,后者是它的孪生形态(链已 ready 而
       account 仍在重试时,supersede 会让 platformPermission 永久留在 recovering,代理节点再也选不了)。
       不递增也不丢语义:home 无 sessionID,`seq` 只被下面的 session switch 分支消费;而链尾的默认
       解析读的是 `composerModel()` 实时值,本次选择照样压过它(applyDefaultComposerModel 空判)。
       安全的 supersede(directory / authEpoch / session 切换 / retryAll)都会建立新的 replacement
       owner,不在此列。 */
    const seq = homeLocalByok ? chainSeq : ++chainSeq
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
    setEngineModelRefs([])
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
          (error) =>
            markStartupTimeline("renderer.home.model_list.end", {
              attempt,
              chain: seq,
              durationMs: performance.now() - started,
              outcome:
                error instanceof ModelContractError && error.reason === "catalog-not-ready"
                  ? "error:catalog-not-ready"
                  : "error:request",
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
    // #604:链自己这次读取与 owner 的视图之间没有顺序保证(两次读取之间 main 可能已完成续期)。
    // 交给 owner 过同一条 freshness 判据并取回它认定的现值,避免用更旧的快照把已恢复的能力判成
    // recovering —— 那正是「消费侧各读各的」把恢复信号丢掉的相位。读取失败仍按既有语义算未登录。
    const authState = auth.status === "ready" ? reconcileAuthSnapshot(auth.data) : null
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
    // #594 R1 第 4 实例:account summary 是被修掉的 list 预算悬崖的同类 —— 旧 20×1s 耗尽后
    // 不再安排任何定时器,唤醒 wake 落空、epoch 重启又只看 model 链 ⇒ 代理节点永久不可用。
    // 改为与 list 同构的无上限封顶退避(resolveAccountWithRetry),直到 ready/failed/supersede。
    const accountResolution = platformAuthReady
      ? (async () => {
          let recovering = false
          const classify = (summary: Awaited<ReturnType<typeof readSummary>>) =>
            summary.status === "error" ? ("recovering" as const) : accountResultState(summary.data)
          function readSummary() {
            return readState(window.api.account.summary())
          }
          const resolved = await resolveAccountWithRetry({
            read: async (attempt) => {
              const markAccount = props.mode === "home" && homeAccountMarkCount < 25
              const started = performance.now()
              if (markAccount) {
                homeAccountMarkCount++
                markStartupTimeline("renderer.home.account_summary.start", { attempt, chain: seq })
              }
              const summary = await readSummary()
              if (markAccount)
                markStartupTimeline("renderer.home.account_summary.end", {
                  attempt,
                  chain: seq,
                  durationMs: performance.now() - started,
                  outcome: classify(summary),
                })
              return summary
            },
            classify,
            wait: (delayMs) => accountRetryWakeup.wait(delayMs),
            isStale: () => chainDisposed || seq !== chainSeq,
            onRecovering: () => {
              recovering = true
              setPlatformPermission("recovering")
            },
          })
          if (resolved.status === "stale") return { status: "superseded" as const }
          if (resolved.status === "failed") {
            setPlatformPermission("failed")
            accountRetryWakeup.clear()
            return { status: "failed" as const }
          }
          // classify 只在 readState 成功时给 ready;这里的收窄是类型层面的防御。
          if (resolved.data.status !== "ready") return { status: "superseded" as const }
          const usable = summaryUsable(resolved.data.data)
          setPlatformPermission(usable ? "ready" : "failed")
          if (recovering && modelChainState() === "recovering") modelRetryWakeup.wake("account-recovered")
          accountRetryWakeup.clear()
          return { status: "ready" as const, usable }
        })()
      : null

    // #594 闩死点二:list 重试不再有 20×1s 预算悬崖(耗尽后不安排任何定时器 = 三个唤醒源
    // 全死时永久闩死)。改为无上限封顶退避(loadEngineModelsWithRetry,1s/2s/4s/8s 封顶),
    // 直到成功或本链被 supersede;唤醒信号(generation/SSE/手动重试)仍可提前打断等待。
    const loaded = await loadEngineModelsWithRetry({
      initial: modelListing,
      read: readModels,
      wait: (delayMs) => modelRetryWakeup.wait(delayMs),
      clearWake: () => modelRetryWakeup.clear(),
      isStale: () => chainDisposed || seq !== chainSeq,
      onAttemptFailed: () => setModelChainState("recovering"),
      onRetryTick: ({ attempt, delayMs, wait }) => {
        if (props.mode === "home" && homeModelRetryMarkCount < 25) {
          homeModelRetryMarkCount++
          markStartupTimeline("renderer.home.model_list.retry_tick", {
            attempt,
            chain: seq,
            count: homeModelRetryMarkCount,
            delayMs: wait === "cancelled" ? 0 : delayMs,
            reason: wait === "cancelled" ? "recovery-signal" : "request-error",
          })
        }
      },
    })
    if (loaded.status === "stale") return
    const engineModels: EngineModelRef[] = loaded.data
      .filter((model) => model.enabled && model.status !== "deprecated")
      .map((model) => ({ providerID: model.providerID, id: model.id }))
    setEngineModelRefs(engineModels)
    setHasConfiguredByok(
      configured.some(
        (id) =>
          id !== pid &&
          engineModels.some((model) => model.providerID === id || model.providerID === `${id}-byok`),
      ),
    )
    // #595:「BYOK 本地可选择」的载体 —— 本地目录 ∩ 本地 KEY 已配置,**不经引擎清单过滤**。
    // 与下面 engine 过滤过的 configuredEngineProviders 分工不同:后者只服务「默认必须真能跑」。
    const localKeyedByokProviders = cat.data.byokProviders
      .filter((provider) => configured.includes(provider.id))
      .map((provider) => byokEngineId(provider.id))
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
        localKeyedByokProviders,
        // #679:`defaultPlatformModel` 必须真的传下去 —— 漏了它,平台自动默认会**静默消失**
        // (解析链已不再有任何兜底挑选,那是本票刻意去掉的)。
        catalog: {
          defaultModel: cat.data.defaultModel,
          defaultPlatformModel: cat.data.defaultPlatformModel,
          platformModels: cat.data.platformModels,
        },
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
    const unsub = subscribeAuthState((state) => {
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
        setRuntimeUnavailable(true)
        runtimeGenerationEpoch++
        const interrupted = running() || sending()
        // An idle token-only renewal changes credentials, not the catalog or selected model.
        // Preserve the ready projection and silently close the execution gate; structural
        // recovery and an interrupted response still rebuild the chain and surface recovery.
        if (state.reason !== "token-only" || interrupted) setModelChainState("recovering")
        // C7:引擎运行态是 typed live 通道的派生值(sessionDock.running),重启后随
        // session_status 自行归位 —— 本地只需复位在途提交并如实播报中断。
        if (interrupted) {
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
      if (state.status === "failed") {
        setRuntimeUnavailable(true)
        setModelChainState("recovering")
        // #577 终态:引擎未通过健康线,不得当成 ready 唤醒(那是在已知失败下伪造恢复信号)。
        // 执行面保持关闭并显式进入恢复态;模型链自身的无上限封顶退避(#594)继续自证:
        // 引擎真实可达时 list 成功,链自然回 ready。
        return
      }
      // ready 与 injection-failed(#613)都证明引擎可达 —— 唤醒停跑的链不是伪造恢复信号;
      // 「配置未生效」的区分呈现归 picker 横幅(alpha-composer-model),不在唤醒面。
      setRuntimeUnavailable(false)
      modelRetryWakeup.wake("generation-ready")
      if (modelChainState() === "recovering") setModelRetryEpoch((value) => value + 1)
      accountRetryWakeup.wake("generation-ready")
    })
    const unsubscribeSse = subscribeSseReconnected(() => {
      // The bounded health/SSE self-probe is the recovery path when a generation-ready IPC event
      // is lost. A proven live transport may reopen the execution gate; otherwise the hidden
      // availability latch would stay closed even after the model chain recovered.
      setRuntimeUnavailable(false)
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
    if (runtimeUnavailable()) {
      pushToast({ kind: "info", title: t("alpha.composer.modelStateReading"), detail: t("alpha.composer.modelStateDetail") })
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
    // #595:Enter 直调 submit(不经 canSend),同一条纯核判据必须在这里也拦住不可执行的 BYOK。
    const block = preflightBlockReason(composerModel(), preflightCtx())
    if (block) {
      pushToast(
        block === "platform-needs-login"
          ? {
              kind: "info",
              title: t("alpha.composer.modelNeedsLogin"),
              detail: t("alpha.composer.modelNeedsLoginDetail"),
            }
          : block === "byok-not-registered"
            ? {
                kind: "info",
                title: t("alpha.composer.modelNotLoaded", { model: composerModel()?.name ?? "" }),
                detail: t("alpha.composer.modelNotLoadedDetail"),
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
        // #570:这条消息用的档位就是新会话的开局档位 —— 不交给它,跳进会话页的瞬间 chip 熄灭、
        // 第二条消息掉回默认档,而用户明明在首页把计划模式开着发出了第一条。
        seedComposerAgentScope(id, composerAgent())
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
      // #652(owner 裁决 2026-07-28):会话内发送回到与首页 startChat 完全同一条 v1 路径
      // (session.promptAsync)。REQ-125 C7 曾把「后续消息」改路由到 v2 durable 队列
      // (c.v2.session.prompt),于是同一个会话里第一条走旧引擎、第二条起走新引擎 ——
      // 而新引擎那条链拿不到 provider 凭证(全库受理 8 次、started 8 次、failed 8 次,零成功),
      // 表现为「只能发第一条」。更根本的是:新引擎(上游 packages/core)**没有 MCP 运行时**,
      // 也**没有 alpha ext 插件的钩子挂载点**(tool.execute.before/after、
      // experimental.chat.system.transform),而 alpha 的整个主权层 —— 云搜索、kill switch、
      // prompt 接管、工厂拒绝、skill 注入 —— 全建在旧引擎的钩子上。「一半迁移」才是半成品;
      // 回到单一代次是干净状态。迁移推迟到上游补齐 MCP 与插件钩子之后,另立需求。
      //
      // 档位随每条消息走(v1 PromptInput.agent,与 startChat 同一个字段):v1 引擎不读会话的
      // agent 列(SessionPrompt.createUserMessage 只认 input.agent,缺省即引擎默认档),
      // 因此 v2 的档位协议(switchAgent 落会话档 + 权威实时读 + CAS 回滚 + 本地推送账本)
      // 随 v2 发送一起退役 —— 留着它只会在每次发送前多两次网络往返,并把「读不到会话档」
      // 变成一个新的发送拦截点。
      const { error } = await c.session.promptAsync({
        sessionID: sid,
        directory: dir,
        parts: req.parts,
        ...(req.agent ? { agent: req.agent } : {}),
      } as any)
      if (interrupted()) return
      if (error) {
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
      {/* #595:发送门因「引擎没有这个直连节点」而关闭时,必须常驻如实说明 ——
          按钮已 disabled,toast 点不出来,不说等于静默失败。选择本身照旧保留。 */}
      <Show when={modelChainState() === "ready" && byokNotRegistered()}>
        <div class="a-comp-model-alert" role="status">
          <span>{t("alpha.composer.modelNotLoaded", { model: composerModel()?.name ?? "" })}</span>
          <span>{t("alpha.composer.modelNotLoadedDetail")}</span>
          <button type="button" onClick={retryCurrentModel}>
            {t("alpha.common.retry")}
          </button>
        </div>
      </Show>
      <div class="a-comp-bar">
        <AddButton expanded={auto.assembleOpen()} onOpen={() => auto.toggleAssemble()} />
        <PermChip />
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
          modelChainReady={() => modelChainState() === "ready" && !runtimeUnavailable()}
          onNeedWorkspace={props.onNeedWorkspace}
          hasWorkspace={hasWorkspace}
        />
        <EffortChip
          contract={modelContract}
          directory={props.directory}
          onSelect={selectComposerModel}
          onRetryCurrent={retryCurrentModel}
          modelChainReady={() => modelChainState() === "ready" && !runtimeUnavailable()}
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
