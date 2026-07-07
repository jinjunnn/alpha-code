// AlphaComposer — REQ-055:alpha 唯一的 composer 组件(用户拍板 2026-07-07:「一个 CSS 一个完整的
// 组件」「自建,不再集成 opencode」)。首页(mode="home")与会话页(mode="session",经
// composer-takeover 顶替上游 prompt-input)渲染**同一个组件**,样式只来自 alpha-composer.css。
//
// 与旧世界的本质区别:模型/推理档/agent/权限是 **本地状态**(composer-state.ts),提交时作为 SDK
// 显式参数(session.promptAsync 原生收 model/agent/variant)。不再有 agent.cycle 轮转、variant
// cycleTo、MutationObserver 标签发布 —— 那一类「驱动隐藏上游控件」的机制全部退役(REQ-054 根除)。
//
// v1 诚实边界(见 requirements/REQ-055):附件/拖拽/图片粘贴不迁(+ 菜单沿用);上下文 ring 在会话页
// 由 takeover 收养上游活节点(纯只读复用);BYOK 模型无档位数据 → effort 诚实禁用。

import { createEffect, createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { useCommand } from "./providers"
import { setExtHubOpen } from "../extensions/ext-hub-state"
import { createComposerAutocomplete } from "./composer-autocomplete"
import { buildMentionParts, type MentionPart } from "./composer-autocomplete-core"
import { COMPOSER_PLACEHOLDER } from "../../shared/composer-copy"
import { pushToast } from "./Toast"
import type { AlphaProjectsApi } from "../sidebar/use-projects"
import {
  buildPromptRequest,
  composerAgent,
  composerAgents,
  composerEffortSel,
  composerModel,
  composerPerm,
  filterAgents,
  routeSlash,
  setComposerAgent,
  setComposerAgents,
  setComposerEffort,
  setComposerModel,
  setComposerPerm,
  type PermMode,
} from "./composer-state"
import { ModelPickPop } from "./alpha-composer-model"
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
    const t = e.target as Element | null
    if (t && t.closest(".a-pop-wrap, .a-pop")) return
    close()
  }
  document.addEventListener("click", onDoc)
  onCleanup(() => document.removeEventListener("click", onDoc))
  return { isOpen, toggle, close }
}

const stop = (e: Event) => e.stopPropagation()

/* 逃出 overflow 裁剪的弹层(Portal 到 body、fixed 定位、朝上开)。 */
function ChipPopover(props: { anchor: HTMLElement | undefined; align?: "left" | "right"; minWidth?: number; children: JSX.Element }) {
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
      <div class="a-pop a-pop-fixed" style={style} onClick={stop}>
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
const AgentGlyph = () => (
  <svg class="a-ic a-ic-sm" viewBox={ico}>
    <path d="M4 8h16M4 16h16" />
    <circle cx="9" cy="8" r="2" style={{ fill: "var(--a-surface)" }} />
    <circle cx="15" cy="16" r="2" style={{ fill: "var(--a-surface)" }} />
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

/* ── + 添加菜单(与旧 AddButton 同内容;注册表换用本文件的单开注册表)──────────── */
function AddButton() {
  const command = useCommand()
  const { isOpen, toggle, close } = useChip()
  let btn: HTMLButtonElement | undefined
  const run = (fn: () => void) => {
    close()
    try {
      fn()
    } catch {
      /* command may be unregistered in some states */
    }
  }
  const cmd = (id: string) => run(() => command.trigger(id))
  const hub = () => run(() => setExtHubOpen(true))
  return (
    <div class="a-pop-wrap" data-kind="add">
      <button ref={btn} class="a-chip a-chip-icon" title="添加" onClick={(e) => (stop(e), toggle())}>
        <Plus />
      </button>
      <Show when={isOpen()}>
        <ChipPopover anchor={btn} align="left" minWidth={244}>
          <div class="a-pop-label">添加</div>
          <button class="a-pop-item" onClick={() => cmd("file.attach")}>
            <FileGlyph /> 文件与文件夹 <span class="a-pop-kbd">↵</span>
          </button>
          <button class="a-pop-item" onClick={() => cmd("terminal.new")}>
            <TermGlyph /> 附加终端
          </button>
          <div class="a-pop-sep" />
          <div class="a-pop-label">扩展 · 定制中心</div>
          <button class="a-pop-item" onClick={hub}>
            <span class="a-pico" style={{ background: "#2563eb" }}>文</span> 文档 <span class="a-pop-desc">Documents</span>
          </button>
          <button class="a-pop-item" onClick={hub}>
            <span class="a-pico" style={{ background: "#dc2626" }}>PDF</span> PDF
          </button>
          <button class="a-pop-item" onClick={hub}>
            <span class="a-pico" style={{ background: "#16a34a" }}>表</span> 表格 <span class="a-pop-desc">Spreadsheets</span>
          </button>
          <button class="a-pop-item" onClick={hub}>
            <span class="a-pico" style={{ background: "#7c3aed" }}>MCP</span> 连接器… <span class="a-pop-desc">浏览市场</span>
          </button>
        </ChipPopover>
      </Show>
    </div>
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
          <button class="a-pop-item" classList={{ "is-on": composerPerm() === "readonly" }} onClick={() => pick("readonly")}>
            <ShieldEye /> 只读 <span class="a-pop-desc">不能改文件/执行命令</span>
          </button>
        </ChipPopover>
      </Show>
    </div>
  )
}

/* ── agent chip:SDK /agent 列表(过滤内部档)→ 本地选择,提交时作参数 ─────────── */
function AgentChip(props: { sdk: AlphaProjectsApi["sdk"]; directory: () => string | undefined }) {
  const { isOpen, toggle, close } = useChip()
  let btn: HTMLButtonElement | undefined
  const label = () => (composerPerm() === "readonly" ? "只读档" : (composerAgent() ?? "build"))
  const load = async () => {
    const c = props.sdk()
    if (!c) return
    try {
      const { data } = await c.v2.agent.list({ location: { directory: props.directory() } } as any)
      if (Array.isArray(data)) setComposerAgents(filterAgents(data as any))
    } catch {
      /* 列表加载失败 → 保留上次;chip 仍可用(引擎默认) */
    }
  }
  onMount(() => void load())
  createEffect(() => {
    if (isOpen()) void load() // 打开时刷新(装了新 agent 免重启可见)
  })
  return (
    <div class="a-pop-wrap" data-kind="agent">
      <button
        ref={btn}
        class="a-chip"
        data-disabled={composerPerm() === "readonly" ? "" : undefined}
        title={composerPerm() === "readonly" ? "只读权限档固定使用只读 agent" : "选择 agent"}
        onClick={(e) => {
          stop(e)
          if (composerPerm() !== "readonly") toggle()
        }}
      >
        <AgentGlyph />
        {label()}
        <Chevron />
      </button>
      <Show when={isOpen()}>
        <ChipPopover anchor={btn} align="left" minWidth={220}>
          <div class="a-pop-label">Agent</div>
          <button class="a-pop-item" classList={{ "is-on": composerAgent() === null }} onClick={() => (setComposerAgent(null), close())}>
            build <span class="a-pop-desc">默认</span>
          </button>
          <For each={composerAgents().filter((a) => a.name !== "build")}>
            {(a) => (
              <button class="a-pop-item" classList={{ "is-on": composerAgent() === a.name }} onClick={() => (setComposerAgent(a.name), close())}>
                {a.name}
                <Show when={a.description}>
                  <span class="a-pop-desc">{(a.description ?? "").slice(0, 18)}</span>
                </Show>
              </button>
            )}
          </For>
        </ChipPopover>
      </Show>
    </div>
  )
}

/* ── 模型 chip:打开 alpha 自建 picker(本地选择;不再点上游隐藏按钮)──────────── */
function ModelChip(props: { sdk: AlphaProjectsApi["sdk"]; onNeedWorkspace?: () => void; hasWorkspace: () => boolean }) {
  const { isOpen, toggle, close } = useChip()
  let btn: HTMLButtonElement | undefined
  const label = () => composerModel()?.name ?? "选择模型"
  return (
    <div class="a-pop-wrap" data-kind="model">
      <button
        ref={btn}
        class="a-chip a-chip-model"
        title="选择模型"
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
        <span class="a-pico" style={{ background: "var(--a-accent)" }}>α</span>
        {label()}
        <Chevron />
      </button>
      <Show when={isOpen()}>
        <ChipPopover anchor={btn} align="right" minWidth={360}>
          <ModelPickPop sdk={props.sdk} onPicked={close} />
        </ChipPopover>
      </Show>
    </div>
  )
}

/* ── effort chip:档位真源 = 当前模型的 variants(本地状态,提交时作 variant 参数)── */
function EffortChip() {
  const { isOpen, toggle, close } = useChip()
  let btn: HTMLButtonElement | undefined
  const variants = () => composerModel()?.variants ?? []
  const supported = () => variants().length > 0
  const current = () => composerEffortSel() ?? "默认"
  const title = () =>
    !composerModel()
      ? "选择模型后可用"
      : supported()
        ? "推理强度(逐模型推理参数档)"
        : "当前模型不支持推理档"
  return (
    <div class="a-pop-wrap" data-kind="effort">
      <button
        ref={btn}
        class="a-chip"
        data-disabled={supported() ? undefined : ""}
        title={title()}
        onClick={(e) => {
          stop(e)
          if (supported()) toggle()
        }}
      >
        <Bolt />
        <span class="a-comp-eff">{supported() ? current() : "—"}</span>
        <Chevron />
      </button>
      <Show when={isOpen()}>
        <ChipPopover anchor={btn} align="right" minWidth={170}>
          <div class="a-pop-label">推理强度 · {composerModel()?.name}</div>
          <button class="a-pop-item" classList={{ "is-on": composerEffortSel() === null }} onClick={() => (setComposerEffort(null), close())}>
            默认 <span class="a-pop-desc">引擎默认档</span>
          </button>
          <For each={variants()}>
            {(v) => (
              <button class="a-pop-item" classList={{ "is-on": composerEffortSel() === v }} onClick={() => (setComposerEffort(v), close())}>
                {v}
              </button>
            )}
          </For>
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
}

export function AlphaComposer(props: AlphaComposerProps) {
  const command = useCommand()
  const [text, setText] = createSignal("")
  const [sending, setSending] = createSignal(false)
  const [busy, setBusy] = createSignal(false) // session:引擎侧运行中(status 轮询,见下)
  const [mentions, setMentions] = createSignal<MentionPart[]>([])
  const [composing, setComposing] = createSignal(false)
  let taRef: HTMLTextAreaElement | undefined
  const isImeComposing = (e: KeyboardEvent) => e.isComposing || composing() || e.keyCode === 229

  const auto = createComposerAutocomplete({
    text,
    setText,
    textarea: () => taRef,
    directory: props.directory,
    command,
    sdk: props.projects.sdk,
    onMention: (m) => setMentions((xs) => [...xs.filter((x) => x.content !== m.content), m]),
    isComposing: isImeComposing,
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
    const body = text().trim()
    const req = buildPromptRequest({
      text: body,
      extraParts: buildMentionParts(body, dir, mentions()),
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
          variant: req.variant,
        })
        if (!id) {
          pushToast({ kind: "error", title: "发送失败,请重试" })
          return
        }
        setText("")
        setMentions([])
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
        const { data: cmds } = await c.command.list({ directory: dir } as any).catch(() => ({ data: undefined }) as const)
        if (Array.isArray(cmds) && cmds.some((x: any) => x?.name === slash.name)) {
          const { error } = await c.session.command({ sessionID: sid, directory: dir, command: slash.name, arguments: slash.args } as any)
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
      const { error } = await c.session.promptAsync({ sessionID: sid, directory: dir, ...req } as any)
      if (error) {
        pushToast({ kind: "error", title: "发送失败,请重试" })
        return
      }
      setText("")
      setMentions([])
      setBusy(true) // 立即反映;轮询随后校准
    } finally {
      setSending(false)
    }
  }

  const onKey = (e: KeyboardEvent) => {
    if (auto.onKeyDown(e)) return
    if (e.key === "Enter" && !e.shiftKey && !isImeComposing(e)) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <div class="a-comp" data-alpha-composer={props.mode} data-empty={text().trim() ? undefined : ""} onClick={stop}>
      <auto.Menu />
      <textarea
        ref={taRef}
        class="a-comp-input"
        rows="1"
        placeholder={COMPOSER_PLACEHOLDER}
        value={text()}
        onInput={(e) => {
          setText(e.currentTarget.value)
          auto.onInput()
        }}
        onKeyDown={onKey}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
      />
      <div class="a-comp-bar">
        <AddButton />
        <PermChip />
        <AgentChip sdk={props.projects.sdk} directory={props.directory} />
        <div class="a-comp-grow" />
        {/* 上下文用量 ring 停靠位(session:takeover 把上游活 ring 收养进来;home 无会话无用量,不渲染) */}
        <Show when={props.mode === "session"}>
          <span class="a-comp-usage" data-alpha-usage-host />
        </Show>
        <ModelChip sdk={props.projects.sdk} onNeedWorkspace={props.onNeedWorkspace} hasWorkspace={hasWorkspace} />
        <EffortChip />
        <Show
          when={props.mode === "session" && busy()}
          fallback={
            <button class="a-comp-send" data-ready={canSend() ? "" : undefined} disabled={!text().trim() || sending()} onClick={() => void submit()} title="发送">
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
