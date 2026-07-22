// AlphaComposer — REQ-055:alpha 唯一的 composer 组件(用户拍板 2026-07-07:「一个 CSS 一个完整的
// 组件」「自建,不再集成 opencode」)。首页(mode="home")与会话页(mode="session",经
// composer-takeover 顶替上游 prompt-input)渲染**同一个组件**,样式只来自 alpha-composer.css。
//
// 与旧世界的本质区别:session 的模型/推理档以 typed Session Model.Ref 为真源，composer-state
// 只保留已确认的 UI 投影；agent/权限仍是轻量提交态。不再有 agent.cycle 轮转、variant cycleTo
// 或隐藏上游选择器标签发布 —— 那一类「驱动隐藏上游控件」的机制全部退役。
//
// v1 诚实边界(见 requirements/REQ-055):附件/拖拽/图片粘贴不迁(+ 菜单沿用);上下文 ring 在会话页
// 由 takeover 收养上游活节点(纯只读复用);BYOK 模型无档位数据 → 全链 ready 后 effort 弹层如实说明。

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
import { buildMentionParts, type MentionPart } from "./composer-autocomplete-core"
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
  failComposerModelProjection,
  invalidateComposerModelProjection,
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
import { t } from "../i18n"
import "./alpha-composer.css"

/* ── 单开注册表(全部 chips 共享;开新的自动关旧的)──────────────────────────── */
const [openChipId, setOpenChipId] = createSignal<number | null>(null)
let chipSeq = 0
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
function ChipPopover(props: {
  anchor: HTMLElement | undefined
  align?: "left" | "right"
  minWidth?: number
  onEscape?: () => void
  children: JSX.Element
}) {
  const a = props.anchor
  if (!a) return null
  const r = a.getBoundingClientRect()
  const vw = window.innerWidth
  const minW = props.minWidth ?? 200
  const style: JSX.CSSProperties = {
    position: "fixed",
    bottom: `${Math.round(window.innerHeight - r.top + 8)}px`,
    "z-index": "60",
    "min-width": `${minW}px`,
    "max-width": `${Math.round(vw - 16)}px`,
  }
  if (props.align === "right") style.right = `${Math.round(Math.max(8, vw - r.right))}px`
  else style.left = `${Math.round(Math.min(Math.max(8, r.left), vw - minW - 8))}px`
  return (
    <Portal>
      <div
        class="a-ui a-pop a-pop-fixed"
        style={style}
        onClick={stop}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return
          event.preventDefault()
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
function AddButton(props: { onOpen: () => void }) {
  return (
    <button
      class="a-chip a-chip-icon"
      title={t("alpha.composer.assemble")}
      onClick={(e) => (stop(e), props.onOpen())}
    >
      <Plus />
    </button>
  )
}

/* ── 权限 chip:full/ask 驱动引擎 autoaccept 命令;readonly = 提交时 agent 参数 ── */
const permLabel = (mode: PermMode) => mode === "full" ? t("alpha.composer.permFull") : mode === "ask" ? t("alpha.composer.permAsk") : t("alpha.composer.permReadonly")

type CommandApi = ReturnType<typeof useCommand>

function PermChip(props: { command: CommandApi }) {
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
      <button ref={btn} class="a-chip a-chip-perm" data-mode={composerPerm()} onClick={(e) => (stop(e), toggle())}>
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
        <ChipPopover anchor={btn} align="left" minWidth={230}>
          <div class="a-pop-label">{t("alpha.composer.permissions")}</div>
          <button class="a-pop-item" classList={{ "is-on": composerPerm() === "full" }} onClick={() => pick("full")}>
            <ShieldSolid /> {t("alpha.composer.permFull")} <span class="a-pop-desc">{t("alpha.composer.permFullHint")}</span>
          </button>
          <button class="a-pop-item" classList={{ "is-on": composerPerm() === "ask" }} onClick={() => pick("ask")}>
            <ShieldAsk /> {t("alpha.composer.permAsk")} <span class="a-pop-desc">{t("alpha.composer.permAskHint")}</span>
          </button>
          <button
            class="a-pop-item"
            classList={{ "is-on": composerPerm() === "readonly" }}
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

export type AlphaComposerProps = {
  mode: "home" | "session"
  projects: AlphaProjectsApi
  /** 提交目标目录(home = 所选工作区;session = 会话目录)。 */
  directory: () => string | undefined
  /** session 模式必传:目标会话。 */
  sessionID?: () => string | undefined
  /** home:零工作区时的引导(打开工作区选择器)。 */
  onNeedWorkspace?: () => void
  /** home:创建+首发成功后的跳转。 */
  onSubmitted?: (sessionID: string) => void
  /** REQ-086:一次性预填文本(deep link `?prompt=`),仅初始化时注入,不覆盖用户后续输入。 */
  initialText?: string
}

type ReadState<T> = { status: "ready"; data: T } | { status: "error" }
const readState = <T,>(promise: Promise<T>): Promise<ReadState<T>> =>
  promise.then(
    (data) => ({ status: "ready", data }),
    () => ({ status: "error" }),
  )

const isErrorEnvelope = (value: unknown) => !!value && typeof value === "object" && "error" in value

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
  const [text, setText] = createSignal(props.initialText ?? "")
  const [sending, setSending] = createSignal(false)
  const [busy, setBusy] = createSignal(false) // session:引擎侧运行中(status 轮询,见下)
  const [modelChainState, setModelChainState] = createSignal<"loading" | "ready" | "error">("loading")
  const [mentions, setMentions] = createSignal<MentionPart[]>([])
  const [composing, setComposing] = createSignal(false)
  let taRef: HTMLTextAreaElement | undefined
  const isImeComposing = (e: KeyboardEvent) => e.isComposing || composing() || e.keyCode === 229

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

  const canSend = createMemo(
    () => text().trim().length > 0 && !!props.directory() && modelChainState() === "ready" && !sending(),
  )
  const hasWorkspace = () => !!props.directory()

  /* session 模式:忙态轮询(v1;v2 换 SSE)。只在本组件可见 + 已知会话时跑,2.5s 间隔,
     idle 即停 —— 状态未知时**不显示**停止按钮(C28:不装能停)。 */
  let statusTimer: ReturnType<typeof setInterval> | undefined
  const pollStatus = async () => {
    const c = props.projects.sdk()
    const sid = props.sessionID?.()
    if (!c || !sid) return
    try {
      const { data } = await c.session.status({ directory: props.directory() } as any)
      const st = data && (data as Record<string, { type?: string }>)[sid]
      setBusy(!!st && st.type !== "idle")
    } catch {
      setBusy(false)
    }
  }
  const startPolling = () => {
    if (props.mode !== "session" || statusTimer) return
    void pollStatus()
    statusTimer = setInterval(() => void pollStatus(), 2500)
  }
  onMount(startPolling)
  onCleanup(() => statusTimer && clearInterval(statusTimer))

  /* ── 默认模型解析链。session 先从 typed get 收敛真实 Model.Ref；随后 list 负责可用性与默认。
     home 只保留创建会话前的内存选择，创建时把同一 Model.Ref 写进 Session。 */
  const [lastAuth, setLastAuth] = createSignal<AuthState | null>(null)
  const [platformId, setPlatformId] = createSignal<string | null>(null)
  const [hasConfiguredByok, setHasConfiguredByok] = createSignal(false)
  const [authEpoch, setAuthEpoch] = createSignal(0)
  const [modelRetryEpoch, setModelRetryEpoch] = createSignal(0)
  let chainSeq = 0
  let chainDisposed = false

  const selectComposerModel = async (model: NonNullable<ReturnType<typeof composerModel>>) => {
    // 未获全链 admission 时不能 supersede 正在完成 auth/KEY/account/list 的 owner，否则无人接管 loading。
    if (modelChainState() !== "ready") throw new Error("model chain is not ready")
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
    if (sessionID) invalidateComposerModelProjection(sessionID)
    else resetComposerModelProjection()

    const catalogRead = readState(window.api.models.catalog())
    const authRead = readState(window.api.auth.getState())
    const keysRead = readState(window.api.providers.keyStatus())
    const currentRead = sessionID ? await readState(modelContract.current(sessionID)) : undefined
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
    if (auth.status === "error" || keys.status === "error") {
      setModelChainState("error")
      return
    }
    const summary =
      auth.data.status === "logged-in"
        ? await readState(window.api.account.summary())
        : ({ status: "ready", data: null } as const)
    if (chainDisposed || seq !== chainSeq) return
    if (summary.status === "error" || isErrorEnvelope(summary.data)) {
      setModelChainState("error")
      return
    }

    const authState = auth.data
    setLastAuth(authState)
    const pid = cat.data.platformProvider.id
    setPlatformId(pid)
    const configured = Object.entries(keys.data)
      .filter(([, value]) => value.configured)
      .map(([id]) => id)
    setHasConfiguredByok(configured.some((id) => id !== pid))
    const loggedIn = authState.status === "logged-in"
    const baseCtx = {
      loggedIn,
      accountUsable: loggedIn && summaryUsable(summary.data),
      platformProviderId: pid,
      configuredProviders: configured,
      catalog: { defaultModel: cat.data.defaultModel, platformModels: cat.data.platformModels },
    }

    // 只有认证/账户/KEY 都是确定事实时才允许把当前选择挂成业务否定态。
    const current = composerModel()
    if (current && current.providerID === pid) {
      const verdict = checkSelectedModel(current, { ...baseCtx, engineModels: [] })
      if (!verdict.ok) suspendComposerModel(verdict.reason)
    }

    for (let i = 0; i < 20 && !chainDisposed && seq === chainSeq; i++) {
      try {
        const listed = await modelContract.list(directory, AbortSignal.timeout(ENGINE_FETCH_TIMEOUT_MS))
        if (chainDisposed || seq !== chainSeq) return
        const engineModels: EngineModelRef[] = listed
          .filter((model) => model.enabled && model.status !== "deprecated")
          .map((model) => ({ providerID: model.providerID, id: model.id }))
        const cur = composerModel()
        if (cur) {
          const available = engineModels.some((model) => model.providerID === cur.providerID && model.id === cur.id)
          if (available) {
            setModelChainState("ready")
            return
          }
          suspendComposerModel("provider-gone")
        }
        const resolved = resolveDefaultModel({ ...baseCtx, engineModels })
        if (resolved.kind === "model") {
          if (sessionID) {
            const switched = await readState(modelContract.switch(sessionID, modelRefOf(resolved.model)))
            if (chainDisposed || seq !== chainSeq || props.sessionID?.() !== sessionID) return
            if (switched.status === "error") throw new Error("default model switch failed")
          }
          applyDefaultComposerModel(resolved.model)
          setModelChainState("ready")
          return
        }
        if (resolved.kind === "none") {
          setModelChainState("ready")
          return // ④ 空态:占位 + picker 引导 + preflight 兜底
        }
      } catch {
        if (chainDisposed || seq !== chainSeq) return
        setModelChainState("error")
        // 冷启动 / respawn 窗口：保持当前选择，稍后重试；picker 同时呈现真实失败态。
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
      if (chainDisposed || seq !== chainSeq) return
    }
    if (!chainDisposed && seq === chainSeq) setModelChainState("error")
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
    const unsub = window.api.auth.subscribe(() => setAuthEpoch((value) => value + 1))
    onCleanup(() => {
      chainDisposed = true
      unsub?.()
    })
  })

  const abort = async () => {
    const c = props.projects.sdk()
    const sid = props.sessionID?.()
    if (!c || !sid) return
    try {
      await c.session.abort({ sessionID: sid, directory: props.directory() } as any)
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
      loggedIn: lastAuth()?.status === "logged-in",
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
    setSending(true)
    try {
      if (props.mode === "home") {
        const id = await props.projects.startChat(dir, body, req.parts.slice(1), {
          model: req.model,
          agent: req.agent,
        })
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
        if (Array.isArray(cmds) && cmds.some((x: any) => x?.name === slash.name)) {
          const { error } = await c.session.command({
            sessionID: sid,
            directory: dir,
            command: slash.name,
            arguments: slash.args,
          } as any)
          if (error) {
            pushToast({ kind: "error", title: t("alpha.composer.commandFailed") })
            return
          }
          setText("")
          setMentions([])
          setBusy(true)
          return
        }
      }
      const { error } = await c.session.promptAsync({
        sessionID: sid,
        directory: dir,
        parts: req.parts,
        ...(req.agent ? { agent: req.agent } : {}),
      } as any)
      if (error) {
        pushToast({ kind: "error", title: t("alpha.composer.sendFailed") })
        return
      }
      setText("")
      setMentions([])
      setAttachments([])
      setBusy(true) // 立即反映;轮询随后校准
    } finally {
      setSending(false)
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
    // a-ui 作用域类必须随组件走:session 面经 Portal 挂进上游容器,没有 .a-ui 祖先 —— 缺了它,
    // 焦点圈治理(.a-ui .a-chip:focus…)与基础排版全部失效,上游肥橙焦点圈漏进来(用户报障 2026-07-07)。
    <div
      class="a-ui a-comp"
      data-alpha-composer={props.mode}
      data-empty={text().trim() ? undefined : ""}
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
                <button class="a-comp-att-x" title={t("alpha.composer.removeAttachment")} onClick={() => removeAttachment(a.id)}>
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
        placeholder={composerAgent() === "plan" ? t("alpha.composer.placeholderPlan") : t("alpha.composer.placeholder")}
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
      <div class="a-comp-bar">
        <AddButton onOpen={() => auto.toggleAssemble()} />
        <PermChip command={command} />
        <PlanChip />
        <div class="a-comp-grow" />
        {/* 上下文用量 ring 停靠位(session:takeover 把上游活 ring 收养进来;home 无会话无用量,不渲染) */}
        <Show when={props.mode === "session"}>
          <span class="a-comp-usage" data-alpha-usage-host />
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
          when={props.mode === "session" && busy()}
          fallback={
            <button
              class="a-comp-send"
              data-ready={canSend() ? "" : undefined}
              disabled={!canSend()}
              onClick={() => void submit()}
              title={t("alpha.composer.send")}
            >
              <ArrowUp />
            </button>
          }
        >
          <button class="a-comp-send a-comp-stop" data-ready onClick={() => void abort()} title={t("alpha.composer.abort")}>
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
