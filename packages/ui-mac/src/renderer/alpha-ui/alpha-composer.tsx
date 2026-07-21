// AlphaComposer — REQ-055:alpha 唯一的 composer 组件(用户拍板 2026-07-07:「一个 CSS 一个完整的
// 组件」「自建,不再集成 opencode」)。首页(mode="home")与会话页(mode="session",经
// composer-takeover 顶替上游 prompt-input)渲染**同一个组件**,样式只来自 alpha-composer.css。
//
// 与旧世界的本质区别:session 的模型/推理档以 typed Session Model.Ref 为真源，composer-state
// 只保留已确认的 UI 投影；agent/权限仍是轻量提交态。不再有 agent.cycle 轮转、variant cycleTo
// 或隐藏上游选择器标签发布 —— 那一类「驱动隐藏上游控件」的机制全部退役。
//
// v1 诚实边界(见 requirements/REQ-055):附件/拖拽/图片粘贴不迁(+ 菜单沿用);上下文 ring 在会话页
// 由 takeover 收养上游活节点(纯只读复用);BYOK 模型无档位数据 → effort 弹层如实说明(始终可点,无死点)。

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
  buildAttachmentParts,
  classifyAttachment,
  mergeAttachments,
  type ComposerAttachment,
} from "./composer-attachments-core"
import { COMPOSER_PLACEHOLDER, COMPOSER_PLACEHOLDER_PLAN } from "../../shared/composer-copy"
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
  composerModelSuspended,
  composerPerm,
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
import { createModelContract } from "./model-contract"
import { composerModelFromRef, modelRefOf, withModelVariant } from "./model-picker-core"
import { ENGINE_FETCH_TIMEOUT_MS } from "./model-picker-logic"
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
      title="装配:引用 · 附加 · 模式(与 @ 同一弹窗)"
      onClick={(e) => (stop(e), props.onOpen())}
    >
      <Plus />
    </button>
  )
}

/* ── 权限 chip:full/ask 驱动引擎 autoaccept 命令;readonly = 提交时 agent 参数 ── */
const PERM_LABEL: Record<PermMode, string> = { full: "完全访问", ask: "请求审批", readonly: "只读" }

function PermChip() {
  const command = useCommand()
  const { isOpen, toggle, close } = useChip()
  let btn: HTMLButtonElement | undefined
  const pick = (m: PermMode) => {
    setComposerPerm(m)
    try {
      command.trigger(m === "full" ? "permissions.autoaccept.enable" : "permissions.autoaccept.disable")
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
        {PERM_LABEL[composerPerm()]}
        <Chevron />
      </button>
      <Show when={isOpen()}>
        <ChipPopover anchor={btn} align="left" minWidth={230}>
          <div class="a-pop-label">运行权限</div>
          <button class="a-pop-item" classList={{ "is-on": composerPerm() === "full" }} onClick={() => pick("full")}>
            <ShieldSolid /> 完全访问 <span class="a-pop-desc">允许全部</span>
          </button>
          <button class="a-pop-item" classList={{ "is-on": composerPerm() === "ask" }} onClick={() => pick("ask")}>
            <ShieldAsk /> 请求审批 <span class="a-pop-desc">逐次询问</span>
          </button>
          <button
            class="a-pop-item"
            classList={{ "is-on": composerPerm() === "readonly" }}
            onClick={() => pick("readonly")}
          >
            <ShieldEye /> 只读 <span class="a-pop-desc">不能改文件/执行命令</span>
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
  const label = () => (composerAgent() === "plan" ? "计划" : composerAgent())
  return (
    <Show when={composerAgent()}>
      <button
        class="a-chip a-chip-plan"
        data-disabled={composerPerm() === "readonly" ? "" : undefined}
        title={
          composerPerm() === "readonly"
            ? "只读权限档下模式不生效(退出只读后恢复)"
            : "计划模式开启 — 点击关闭(Shift+Tab 切换)"
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
  onNeedWorkspace?: () => void
  hasWorkspace: () => boolean
}) {
  const { isOpen, toggle, close } = useChip()
  let btn: HTMLButtonElement | undefined
  const label = () => composerModel()?.name ?? "选择模型"
  return (
    <div class="a-pop-wrap" data-kind="model">
      <button
        ref={btn}
        class="a-chip a-chip-model"
        title="选择模型"
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
          />
        </ChipPopover>
      </Show>
    </div>
  )
}

/* ── effort chip:档位定义取目录 variants；session 当前值是服务端 Model.Ref 的 UI 投影。
 *    任何状态都可点(REQ-055 验收⑤「无死点」,用户报障 2026-07-07「为什么不可以点击」):
 *    无模型 → 弹层内嵌模型选择器就地选;有模型无档位 → 弹层如实说明原因。── */
function EffortChip(props: {
  contract: ReturnType<typeof createModelContract>
  directory: () => string | undefined
  onSelect: (model: NonNullable<ReturnType<typeof composerModel>>) => Promise<void>
}) {
  const { isOpen, toggle, close } = useChip()
  let btn: HTMLButtonElement | undefined
  const variants = () => composerModel()?.variants ?? []
  const supported = () => variants().length > 0
  const current = () => composerEffortSel() ?? "默认"
  const title = () =>
    !composerModel() ? "推理强度 — 选择模型后可用" : supported() ? "推理强度(逐模型推理参数档)" : "当前模型不支持推理档"
  return (
    <div class="a-pop-wrap" data-kind="effort">
      <button
        ref={btn}
        class="a-chip"
        data-muted={supported() ? undefined : ""}
        title={title()}
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
              <div class="a-pop-label">推理强度 · {composerModel()?.name}</div>
              <button
                class="a-pop-item"
                classList={{ "is-on": composerEffortSel() === null }}
                onClick={() => {
                  const model = composerModel()
                  if (model)
                    void props
                      .onSelect(withModelVariant(model, null))
                      .then(close)
                      .catch(() => {})
                }}
              >
                默认 <span class="a-pop-desc">引擎默认档</span>
              </button>
              <For each={variants()}>
                {(v) => (
                  <button
                    class="a-pop-item"
                    classList={{ "is-on": composerEffortSel() === v }}
                    onClick={() => {
                      const model = composerModel()
                      if (model)
                        void props
                          .onSelect(withModelVariant(model, v))
                          .then(close)
                          .catch(() => {})
                    }}
                  >
                    {v}
                  </button>
                )}
              </For>
            </Match>
            <Match when={!composerModel()}>
              <div class="a-pop-label">推理强度 · 先选择模型</div>
              <div class="a-pop-note">推理档位随模型而定 —— 选好模型后这里即可调档:</div>
              <ModelPickPop
                contract={props.contract}
                directory={props.directory}
                selected={composerModel}
                onSelect={props.onSelect}
                onPicked={() => {}}
              />
            </Match>
            <Match when={true}>
              <div class="a-pop-label">推理强度</div>
              <div class="a-pop-note">
                「{composerModel()?.name}」未提供推理档位;换用带档位的模型(如代理节点的 α 系列)即可调节。
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

export function AlphaComposer(props: AlphaComposerProps) {
  const command = useCommand()
  const modelContract = createModelContract(props.projects.sdk)
  const [text, setText] = createSignal(props.initialText ?? "")
  const [sending, setSending] = createSignal(false)
  const [busy, setBusy] = createSignal(false) // session:引擎侧运行中(status 轮询,见下)
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
      const name = f.name || `粘贴内容-${attSeq + 1}`
      const c = classifyAttachment({ name, type: f.type, size: f.size })
      if (!c.ok) {
        rejected.push({ name, reason: c.reason })
        continue
      }
      try {
        const url = await readAsDataUrl(f)
        accepted.push({ id: `att-${++attSeq}`, name, mime: f.type, kind: c.kind, size: f.size, url })
      } catch {
        rejected.push({ name, reason: "读取失败" })
      }
    }
    const merged = mergeAttachments(attachments(), accepted)
    setAttachments(merged.next)
    const bad = [...rejected, ...merged.rejected]
    if (bad.length)
      pushToast({ kind: "error", title: "部分附件未添加", detail: bad.map((r) => `${r.name}:${r.reason}`).join("；") })
  }
  const removeAttachment = (id: string) => setAttachments((xs) => xs.filter((a) => a.id !== id))
  const hasDragFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files")

  // REQ-073 拍板③:模式是会话级的 —— home 是新会话入口,挂载即回默认(build);会话页不重置。
  onMount(() => {
    if (props.mode !== "home") return
    setComposerAgent(null)
    setComposerModel(null)
    clearSuspendedModel()
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

  const canSend = createMemo(() => text().trim().length > 0 && !!props.directory() && !sending())
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
  const [authKnown, setAuthKnown] = createSignal(false)
  const [platformId, setPlatformId] = createSignal<string | null>(null)
  const [hasConfiguredByok, setHasConfiguredByok] = createSignal(false)
  const [authEpoch, setAuthEpoch] = createSignal(0)
  let chainSeq = 0
  let chainDisposed = false

  const selectComposerModel = async (model: NonNullable<ReturnType<typeof composerModel>>) => {
    chainSeq++
    const sessionID = props.sessionID?.()
    if (sessionID) {
      try {
        await modelContract.switch(sessionID, modelRefOf(model))
      } catch (error) {
        pushToast({ kind: "error", title: "切换模型失败", detail: "当前选择保持不变，请重试。" })
        throw error
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
    try {
      const [cat, auth, summary, keys] = await Promise.all([
        window.api.models.catalog().catch(() => null),
        window.api.auth.getState().catch(() => null),
        window.api.account.summary().catch(() => null),
        window.api.providers.keyStatus().catch(() => ({}) as Record<string, { configured?: boolean }>),
      ])
      if (chainDisposed || seq !== chainSeq) return
      setLastAuth(auth)
      setAuthKnown(true)
      const pid = cat?.platformProvider.id ?? null
      setPlatformId(pid)
      const configured = Object.entries(keys ?? {})
        .filter(([, v]) => (v as { configured?: boolean } | undefined)?.configured)
        .map(([k]) => k)
      setHasConfiguredByok(configured.some((id) => id !== pid))
      const loggedIn = auth?.status === "logged-in"
      const baseCtx = {
        loggedIn,
        accountUsable: loggedIn && summaryUsable(summary),
        platformProviderId: pid,
        configuredProviders: configured,
        catalog: cat ? { defaultModel: cat.defaultModel, platformModels: cat.platformModels } : null,
      }

      if (sessionID) {
        const upstream = await modelContract.current(sessionID)
        if (chainDisposed || seq !== chainSeq) return
        setComposerModel(upstream ? composerModelFromRef(upstream, cat) : null)
        clearSuspendedModel()
      }

      // 代理模型的 entitlement 可在 model list 之前确定；负面事实先挂起，绝不继续提交。
      const current = composerModel()
      if (current && pid && current.providerID === pid) {
        const verdict = checkSelectedModel(current, { ...baseCtx, engineModels: [] })
        if (!verdict.ok) suspendComposerModel(verdict.reason)
      }

      for (let i = 0; i < 20 && !chainDisposed && seq === chainSeq; i++) {
        try {
          const engineModels: EngineModelRef[] = (
            await modelContract.list(directory, AbortSignal.timeout(ENGINE_FETCH_TIMEOUT_MS))
          )
            .filter((model) => model.enabled && model.status !== "deprecated")
            .map((model) => ({ providerID: model.providerID, id: model.id }))
          const cur = composerModel()
          if (cur) {
            const available = engineModels.some((model) => model.providerID === cur.providerID && model.id === cur.id)
            if (available) return
            suspendComposerModel("provider-gone")
          }
          const r = resolveDefaultModel({ ...baseCtx, engineModels })
          if (r.kind === "model") {
            if (sessionID) await modelContract.switch(sessionID, modelRefOf(r.model))
            if (chainDisposed || seq !== chainSeq) return
            applyDefaultComposerModel(r.model)
            return
          }
          if (r.kind === "none") return // ④ 空态:占位 + picker 引导 + preflight 兜底
        } catch {
          // 冷启动 / respawn 窗口：保持当前选择，稍后重试；picker 同时呈现真实失败态。
        }
        await new Promise((res) => setTimeout(res, 1000))
      }
    } catch {
      /* 默认失败不打扰:保持占位,手选路径完好 */
    }
  }

  createEffect(() => {
    authEpoch()
    const directory = props.directory()
    const sessionID = props.sessionID?.()
    if (!directory) {
      chainSeq++
      return
    }
    void runModelChain(directory, sessionID)
  })

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
      pushToast({ kind: "error", title: "中止失败,请重试" })
    }
  }

  const submit = async () => {
    if (!text().trim() || sending()) return
    const dir = props.directory()
    if (!dir) {
      props.onNeedWorkspace?.()
      return
    }
    const suspended = composerModelSuspended()
    if (suspended && !composerModel()) {
      pushToast({
        kind: "info",
        title: "当前模型不可用",
        detail:
          suspended.reason === "needs-login"
            ? "登录后重新选择该模型，或改用已配置 KEY 的模型。"
            : suspended.reason === "needs-credit"
              ? "充值或恢复会员后重新选择，或改用已配置 KEY 的模型。"
              : "请在模型选择器中改选当前可用的模型。",
      })
      return
    }
    // REQ-069 preflight:未登录 + 代理模型(或全无可用)→ 行内引导替代网关拒绝原文。
    // 网关校验保留为兜底防线;authKnown 未就绪(极早期竞态)不拦,维持旧行为。
    if (authKnown()) {
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
                title: "该模型需登录后使用",
                detail: "登录后零配置直用;或点右下角模型选择器,换用自己 API KEY 的模型。",
              }
            : {
                kind: "info",
                title: "还没有可用的模型",
                detail: "登录即可零配置使用;或在模型选择器里添加自己的 API KEY。",
              },
        )
        return
      }
    }
    const body = text().trim()
    // 斜杠命令走 session.command,不携带 parts —— 附件会被静默丢弃;如实拦下(C28),不装作发出去了。
    if (attachments().length > 0 && body.startsWith("/")) {
      pushToast({ kind: "info", title: "斜杠命令不携带附件", detail: "请先单独发送附件消息,或移除附件后再执行命令。" })
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
          pushToast({ kind: "error", title: "发送失败,请重试" })
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
        pushToast({ kind: "error", title: "会话未就绪,请稍后重试" })
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
            pushToast({ kind: "error", title: "命令执行失败,请重试" })
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
        pushToast({ kind: "error", title: "发送失败,请重试" })
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
                <button class="a-comp-att-x" title="移除附件" onClick={() => removeAttachment(a.id)}>
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
        placeholder={composerAgent() === "plan" ? COMPOSER_PLACEHOLDER_PLAN : COMPOSER_PLACEHOLDER}
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
      <div class="a-comp-bar">
        <AddButton onOpen={() => auto.toggleAssemble()} />
        <PermChip />
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
          onNeedWorkspace={props.onNeedWorkspace}
          hasWorkspace={hasWorkspace}
        />
        <EffortChip contract={modelContract} directory={props.directory} onSelect={selectComposerModel} />
        <Show
          when={props.mode === "session" && busy()}
          fallback={
            <button
              class="a-comp-send"
              data-ready={canSend() ? "" : undefined}
              disabled={!text().trim() || sending()}
              onClick={() => void submit()}
              title="发送"
            >
              <ArrowUp />
            </button>
          }
        >
          <button class="a-comp-send a-comp-stop" data-ready onClick={() => void abort()} title="中止">
            <StopSquare />
          </button>
        </Show>
      </div>
    </div>
  )
}
