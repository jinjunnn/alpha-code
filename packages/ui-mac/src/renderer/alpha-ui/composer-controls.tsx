// composer-controls — the SINGLE source of truth for the alpha composer toolbar chips (权限 · 模型 ·
// effort). Rendered by BOTH the home composer (AlphaHome) and the in-session composer (composer-inject
// Portals these into opencode's toolbar), so the two surfaces are literally one set of components and
// a change is made in ONE place. opencode's heavy in-session composer (textarea/send/slash/attach) is
// kept per ADR-016; only this alpha chrome is shared.
//
// Each chip is self-contained: it owns its popover open-state and a target-aware outside-click close
// (SolidJS delegates events on document, so a chip's stopPropagation can't stop a document listener —
// we ignore clicks that land inside .a-pop-wrap and close on everything else).

import { createEffect, createSignal, For, type JSX, Match, onCleanup, Show, Switch } from "solid-js"
import { Portal } from "solid-js/web"
import { useCommand } from "./providers"
import { setExtHubOpen } from "../extensions/ext-hub-state"

export const EFFORTS = ["低", "中", "高", "超高"] as const
export type Effort = (typeof EFFORTS)[number]
// C28 拍板(2026-07-05,S17 T4):effort 尚未接入引擎 —— 真通道 = model variants(llm/request.ts 的
// options merge),当前 alpha 代理/BYOK 模型均未定义 variants → 任何选择都不影响请求。按用户拍板
// 「改文案保留」:chip 留作预设骨架,popover 明示「暂未生效」、不再宣称影响推理;真接入 → REQ-029。
//
// full = 完全访问 (autoaccept on), ask = 请求审批 (autoaccept off / prompt each time)。
// C28 拍板(2026-07-05,S17 T4):原第三档「只读」已移除 —— 它与 ask 引擎行为完全相同(opencode 无
// 运行时只读命令),宣称「禁止写/执行」不成立;真只读载体 = 引擎 plan agent / config 权限档 → REQ-028。
export type PermMode = "full" | "ask" | "readonly"
const PERM_LABEL: Record<PermMode, string> = { full: "完全访问", ask: "请求审批", readonly: "只读" }

const ico = "0 0 24 24"

/* ── icons ─────────────────────────────────────────────────────────────────── */
export const Plus = () => (
  <svg class="a-ic" viewBox={ico}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)
export const Chevron = () => (
  <svg class="a-ic a-chev" viewBox={ico}>
    <path d="M6 9l6 6 6-6" />
  </svg>
)
// 完全访问 = SOLID filled shield (strong/trusted). 请求审批 = OUTLINE shield + check (cautious).
// The two are intentionally distinct so the active mode reads at a glance.
export const ShieldSolid = () => (
  <svg class="a-ic a-ic-sm" viewBox={ico} style={{ fill: "currentColor", stroke: "none" }}>
    <path d="M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z" />
  </svg>
)
export const ShieldAsk = () => (
  <svg class="a-ic a-ic-sm" viewBox={ico}>
    <path d="M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z" />
    <path d="M9 12l2 2 4-4" />
  </svg>
)
export const ShieldEye = () => (
  <svg class="a-ic a-ic-sm" viewBox={ico}>
    <path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z" />
    <circle cx="12" cy="11" r="2.4" />
  </svg>
)
export const Bolt = () => (
  <svg class="a-ic a-ic-sm" viewBox={ico}>
    <path d="M13 2L4.5 12.5h6L11 22l8.5-10.5h-6z" />
  </svg>
)
export const Check = () => (
  <svg class="a-ic a-ic-sm" viewBox={ico} style={{ color: "var(--a-accent)" }}>
    <path d="M20 6L9 17l-5-5" />
  </svg>
)
export const ArrowUp = () => (
  <svg class="a-ic" viewBox={ico}>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
)

// Single-open registry shared by ALL composer chips (home + in-session). Opening one closes the
// others (#30: 权限 + effort could be open together). Each chip claims a unique id; it is open iff it
// owns the registry, so setting a new owner reactively closes the previous. The document listener
// closes on any click outside a popover/trigger (the popover is Portaled to <body>, so we must also
// ignore clicks inside .a-pop, else clicking a menu item would close it before it acts).
const [openChipId, setOpenChipId] = createSignal<number | null>(null)
let chipSeq = 0
export const closeChips = () => setOpenChipId(null)

// Shared composer STATE — the single source for BOTH the home composer (AlphaHome) and the in-session
// composer (composer-inject). The chips were already one set of components; lifting their state here too
// means the two surfaces can NEVER drift (pick 高 on home → it's 高 in-session, and vice-versa). effort
// is local intent (opencode's effort context isn't exported); perm mirrors intent and drives opencode's
// real `permissions.autoaccept.*` command from inside PermChip. Module-level so every instance agrees.
const [effort, setEffort] = createSignal<Effort>("高")
const [perm, setPerm] = createSignal<PermMode>("ask")
export const composerEffort = effort
export const composerPerm = perm

// Live model label, sourced from opencode's real model button by composer-inject's observer (which runs
// on the home route too — opencode's new-session composer is mounted behind the alpha overlay). The home
// ModelChip reads this so it shows the SAME model as in-session instead of the "ALPHA" placeholder.
const [modelLabel, setModelLabel] = createSignal<string | undefined>(undefined)
export const composerModelLabel = modelLabel
export const setComposerModelLabel = (v: string | undefined) => {
  if (v && v !== modelLabel()) setModelLabel(v)
}

// REQ-028:当前 agent 名(composer-inject 从上游 [data-action=prompt-agent] 触发器文本发布)。
// 「只读」档真载体 = 切到 alpha-readonly agent(静态权限档 edit/bash deny);chip 状态以此为
// 观察源 —— 引擎实际 agent 与 chip 永远一致(验收④),不靠本地意图假装。
const [agentLabel, setAgentLabel] = createSignal<string | undefined>(undefined)
export const composerAgentLabel = agentLabel
export const setComposerAgentLabel = (v: string | undefined) => {
  if (v !== agentLabel()) setAgentLabel(v)
}
export const READONLY_AGENT = "alpha-readonly"
// 记住进只读前的 agent,退出只读时切回(拿不到就回 build —— 引擎默认主 agent)。
let prevAgentBeforeReadonly = "build"

const readAgentDom = () =>
  (document.querySelector('[data-action="prompt-agent"]') as HTMLElement | null)?.textContent?.trim().toLowerCase()

/** cycle 到目标 agent:逐步 trigger + 读上游触发器文本判停;转满一圈没命中/控件未渲染 → false(诚实失败)。 */
async function switchAgentTo(command: { trigger(id: string): void }, target: string): Promise<boolean> {
  const start = readAgentDom()
  if (!start) return false // agent 控件未渲染(customAgents 可见性关闭等)
  if (start === target) return true
  for (let i = 0; i < 24; i++) {
    try {
      command.trigger("agent.cycle")
    } catch {
      return false
    }
    await new Promise((r) => setTimeout(r, 90))
    const cur = readAgentDom()
    if (cur === target) return true
    if (cur === start) return false // 转满一圈(治理隐藏/禁用后集合仍鲁棒:只认文本命中)
  }
  return false
}

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

// Popover that ESCAPES overflow clipping. opencode docks the in-session composer (and renders it near
// the review panel edge), so an `position:absolute` menu gets clipped by an ancestor's overflow — the
// "看不到全部内容" / half-cut popovers. We Portal to <body> and position `fixed` from the trigger's
// rect, opening upward. align="right" anchors the right edge to the trigger (for chips that sit near
// the right edge, e.g. effort beside the review panel) so the menu never runs off-screen.
function ChipPopover(props: {
  anchor: HTMLElement | undefined
  align?: "left" | "right"
  minWidth?: number
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
  if (props.align === "right") {
    style.right = `${Math.round(Math.max(8, vw - r.right))}px`
  } else {
    style.left = `${Math.round(Math.min(Math.max(8, r.left), vw - minW - 8))}px`
  }
  return (
    <Portal>
      <div class="a-pop a-pop-fixed" style={style} onClick={stop}>
        {props.children}
      </div>
    </Portal>
  )
}

/* ── 权限 chip ─────────────────────────────────────────────────────────────── */
// Self-contained: reads/writes the shared `perm` signal and drives opencode's real autoaccept command,
// so home + in-session always show the same mode. No props — render `<PermChip />` on either surface.
export function PermChip() {
  const command = useCommand()
  const { isOpen, toggle, close } = useChip()
  let btn: HTMLButtonElement | undefined
  const [permErr, setPermErr] = createSignal("")
  const pick = (m: PermMode) => {
    void (async () => {
      setPermErr("")
      const before = perm()
      setPerm(m)
      try {
        command.trigger(m === "full" ? "permissions.autoaccept.enable" : "permissions.autoaccept.disable")
      } catch {
        /* command may be unregistered in some states; the chip still reflects intent */
      }
      // 真只读 = 切 alpha-readonly agent;失败(控件未渲染/agent 被治理隐藏/循环未命中)→ 诚实回退,
      // 绝不显示「只读」却仍可写(C28 反 placebo)。
      if (m === "readonly") {
        const cur = readAgentDom()
        if (cur && cur !== READONLY_AGENT) prevAgentBeforeReadonly = cur
        const ok = await switchAgentTo(command, READONLY_AGENT)
        if (!ok) {
          setPerm(before === "readonly" ? "ask" : before)
          setPermErr("无法切换到只读 agent(控件未渲染或档位被隐藏)—— 已回退")
          return
        }
      } else if (readAgentDom() === READONLY_AGENT) {
        const ok = await switchAgentTo(command, prevAgentBeforeReadonly)
        if (!ok) setPermErr(`已退出只读权限,但 agent 未能切回 ${prevAgentBeforeReadonly} —— 请手动切换`)
      }
      close()
    })()
  }
  // 观察源一致性(验收④):引擎 agent 是 alpha-readonly ⟺ chip 显示只读;外部切走(cycle 快捷键等)
  // chip 自动跟随,不留假状态。
  createEffect(() => {
    const label = composerAgentLabel()
    if (label === READONLY_AGENT && perm() !== "readonly") setPerm("readonly")
    else if (label && label !== READONLY_AGENT && perm() === "readonly") setPerm("ask")
  })
  const PermIcon = (p: { mode: PermMode }) => (
    <Switch fallback={<ShieldAsk />}>
      <Match when={p.mode === "full"}>
        <ShieldSolid />
      </Match>
      <Match when={p.mode === "readonly"}>
        <ShieldEye />
      </Match>
    </Switch>
  )
  return (
    <div class="a-pop-wrap a-comp-inject-chip" data-kind="perm">
      <button
        ref={btn}
        class="a-chip a-chip-perm"
        data-mode={perm()}
        onClick={(e) => {
          stop(e)
          toggle()
        }}
      >
        <PermIcon mode={perm()} />
        {PERM_LABEL[perm()]}
        <Chevron />
      </button>
      <Show when={isOpen()}>
        <ChipPopover anchor={btn} align="left" minWidth={230}>
          <div class="a-pop-label">运行权限</div>
          <button class="a-pop-item" classList={{ "is-on": perm() === "full" }} onClick={() => pick("full")}>
            <ShieldSolid /> 完全访问 <span class="a-pop-desc">允许全部</span>
          </button>
          <button class="a-pop-item" classList={{ "is-on": perm() === "ask" }} onClick={() => pick("ask")}>
            <ShieldAsk /> 请求审批 <span class="a-pop-desc">逐次询问</span>
          </button>
          <button class="a-pop-item" classList={{ "is-on": perm() === "readonly" }} onClick={() => pick("readonly")}>
            <ShieldEye /> 只读 <span class="a-pop-desc">不能改文件/执行命令</span>
          </button>
          <Show when={permErr()}>
            <div class="a-pop-label" style={{ color: "var(--a-danger, #d33)" }}>{permErr()}</div>
          </Show>
        </ChipPopover>
      </Show>
    </div>
  )
}

/* ── effort chip ───────────────────────────────────────────────────────────── */
// Self-contained: reads/writes the shared `effort` signal, so home + in-session always agree. No props.
export function EffortChip() {
  const { isOpen, toggle, close } = useChip()
  let btn: HTMLButtonElement | undefined
  return (
    <div class="a-pop-wrap a-comp-inject-chip" data-kind="effort">
      <button
        ref={btn}
        class="a-chip"
        title="推理强度(预设 · 暂未生效)"
        onClick={(e) => {
          stop(e)
          toggle()
        }}
      >
        <Bolt />
        <span class="a-comp-eff">{effort()}</span>
        <Chevron />
      </button>
      <Show when={isOpen()}>
        <ChipPopover anchor={btn} align="right" minWidth={230}>
          <div class="a-pop-label">推理强度 · effort</div>
          <div class="a-pop-note">预设 · 暂未接入模型推理 —— 当前选择不影响请求(接入随 REQ-029)</div>
          <For each={EFFORTS}>
            {(lv) => (
              <button
                class="a-pop-item"
                classList={{ "is-on": effort() === lv }}
                onClick={() => (setEffort(lv), close())}
              >
                <Show when={effort() === lv} fallback={<span style={{ width: "16px" }} />}>
                  <Check />
                </Show>
                {lv}
              </button>
            )}
          </For>
        </ChipPopover>
      </Show>
    </div>
  )
}

/* ── + 添加 menu ───────────────────────────────────────────────────────────────
 * Shared by home (AlphaHome) AND in-session (composer-inject hides opencode's native + and mounts
 * this), so the "+" interaction is identical on both surfaces (#31). Items per mockup §04: file /
 * terminal / goal / plan + a 扩展·定制中心 section that opens the Extension Hub. */
const FileGlyph = () => (
  <svg class="a-ic" viewBox={ico}>
    <path d="M14.5 4h-9A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V9.5z" />
    <path d="M14 4v5h6" />
  </svg>
)
const TermGlyph = () => (
  <svg class="a-ic" viewBox={ico}>
    <path d="M4 5h16v14H4z" />
    <path d="M8 9l3 3-3 3M13 15h4" />
  </svg>
)
const GoalGlyph = () => (
  <svg class="a-ic" viewBox={ico}>
    <circle cx="12" cy="12" r="8" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)
const PlanGlyph = () => (
  <svg class="a-ic" viewBox={ico}>
    <path d="M9 6h11M9 12h11M9 18h11" />
    <path d="M4 6h.01M4 12h.01M4 18h.01" />
  </svg>
)

export function AddButton() {
  const command = useCommand()
  const { isOpen, toggle, close } = useChip()
  let btn: HTMLButtonElement | undefined
  const run = (fn: () => void) => {
    close()
    try {
      fn()
    } catch {
      /* command may be unregistered in some states; menu still reflects intent */
    }
  }
  const cmd = (id: string) => run(() => command.trigger(id))
  const hub = () => run(() => setExtHubOpen(true))
  return (
    <div class="a-pop-wrap a-comp-inject-chip" data-kind="add">
      <button
        ref={btn}
        class="a-chip a-chip-icon"
        title="添加"
        onClick={(e) => {
          stop(e)
          toggle()
        }}
      >
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
          <button class="a-pop-item" onClick={() => run(() => {})}>
            <GoalGlyph /> 设定目标 <span class="a-pop-desc">让 agent 持续推进</span>
          </button>
          <button class="a-pop-item" onClick={() => cmd("agent.cycle")}>
            <PlanGlyph /> 计划模式
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

/* ── 模型 chip ─────────────────────────────────────────────────────────────── */
// Clickable: opens opencode's model picker (the shared three-tier selector) via the `model.choose`
// command, so the home chip behaves the same as the in-session one (was a dead button before).
export function ModelChip(props: { label?: string; onClick: () => void }) {
  return (
    <button
      class="a-chip a-chip-model a-comp-inject-chip"
      data-kind="model"
      title="选择模型"
      onClick={(e) => {
        stop(e)
        closeChips()
        props.onClick()
      }}
    >
      <span class="a-pico" style={{ background: "var(--a-accent)" }}>
        α
      </span>
      {props.label ?? "ALPHA"}
      <Chevron />
    </button>
  )
}
