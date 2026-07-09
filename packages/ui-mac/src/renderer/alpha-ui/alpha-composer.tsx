// AlphaComposer — REQ-055:alpha 唯一的 composer 组件(用户拍板 2026-07-07:「一个 CSS 一个完整的
// 组件」「自建,不再集成 opencode」)。首页(mode="home")与会话页(mode="session",经
// composer-takeover 顶替上游 prompt-input)渲染**同一个组件**,样式只来自 alpha-composer.css。
//
// 与旧世界的本质区别:模型/推理档/agent/权限是 **本地状态**(composer-state.ts),提交时作为 SDK
// 显式参数(session.promptAsync 原生收 model/agent/variant)。不再有 agent.cycle 轮转、variant
// cycleTo、MutationObserver 标签发布 —— 那一类「驱动隐藏上游控件」的机制全部退役(REQ-054 根除)。
//
// v1 诚实边界(见 requirements/REQ-055):附件/拖拽/图片粘贴不迁(+ 菜单沿用);上下文 ring 在会话页
// 由 takeover 收养上游活节点(纯只读复用);BYOK 模型无档位数据 → effort 弹层如实说明(始终可点,无死点)。

import { createEffect, createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch, type JSX } from "solid-js"
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
  composerAgent,
  composerEffortSel,
  composerModel,
  composerModelSuspended,
  composerPerm,
  restoreSuspendedModel,
  routeSlash,
  setComposerAgent,
  setComposerEffort,
  setComposerModel,
  setComposerPerm,
  suspendComposerModel,
  type PermMode,
} from "./composer-state"
import { checkPersistedModel, preflightBlockReason, resolveDefaultModel, type EngineModelRef } from "./model-default-core"
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
      <div class="a-ui a-pop a-pop-fixed" style={style} onClick={stop}>
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
    <button class="a-chip a-chip-icon" title="装配:引用 · 附加 · 模式(与 @ 同一弹窗)" onClick={(e) => (stop(e), props.onOpen())}>
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
          <button class="a-pop-item" classList={{ "is-on": composerPerm() === "readonly" }} onClick={() => pick("readonly")}>
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
        title={composerPerm() === "readonly" ? "只读权限档下模式不生效(退出只读后恢复)" : "计划模式开启 — 点击关闭(Shift+Tab 切换)"}
        onClick={(e) => (stop(e), setComposerAgent(null))}
      >
        <span class="a-chip-x" aria-hidden="true">⊗</span>
        {label()}
      </button>
    </Show>
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
        <span class="a-chip-label" title={label()}>{label()}</span>
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

/* ── effort chip:档位真源 = 当前模型的 variants(本地状态,提交时作 variant 参数)。
 *    任何状态都可点(REQ-055 验收⑤「无死点」,用户报障 2026-07-07「为什么不可以点击」):
 *    无模型 → 弹层内嵌模型选择器就地选;有模型无档位 → 弹层如实说明原因。── */
function EffortChip(props: { sdk: AlphaProjectsApi["sdk"] }) {
  const { isOpen, toggle, close } = useChip()
  let btn: HTMLButtonElement | undefined
  const variants = () => composerModel()?.variants ?? []
  const supported = () => variants().length > 0
  const current = () => composerEffortSel() ?? "默认"
  const title = () =>
    !composerModel()
      ? "推理强度 — 选择模型后可用"
      : supported()
        ? "推理强度(逐模型推理参数档)"
        : "当前模型不支持推理档"
  return (
    <div class="a-pop-wrap" data-kind="effort">
      <button
        ref={btn}
        class="a-chip"
        data-muted={supported() ? undefined : ""}
        title={title()}
        onClick={(e) => (stop(e), toggle())}
      >
        <Bolt />
        <span class="a-comp-eff">{supported() ? current() : "—"}</span>
        <Chevron />
      </button>
      <Show when={isOpen()}>
        <ChipPopover anchor={btn} align="right" minWidth={supported() ? 170 : composerModel() ? 260 : 360}>
          <Switch>
            <Match when={supported()}>
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
            </Match>
            <Match when={!composerModel()}>
              <div class="a-pop-label">推理强度 · 先选择模型</div>
              <div class="a-pop-note">推理档位随模型而定 —— 选好模型后这里即可调档:</div>
              <ModelPickPop sdk={props.sdk} onPicked={() => {}} />
            </Match>
            <Match when={true}>
              <div class="a-pop-label">推理强度</div>
              <div class="a-pop-note">「{composerModel()?.name}」未提供推理档位;换用带档位的模型(如代理节点的 α 系列)即可调节。</div>
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
    if (bad.length) pushToast({ kind: "error", title: "部分附件未添加", detail: bad.map((r) => `${r.name}:${r.reason}`).join("；") })
  }
  const removeAttachment = (id: string) => setAttachments((xs) => xs.filter((a) => a.id !== id))
  const hasDragFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files")

  // REQ-073 拍板③:模式是会话级的 —— home 是新会话入口,挂载即回默认(build);会话页不重置。
  onMount(() => {
    if (props.mode === "home") setComposerAgent(null)
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

  /* ── 默认模型解析链(REQ-069;纯核 = model-default-core.ts,REQ-056「登录+代理活自动默认」
     收编为第②级,语义原样保留)──
       ① 持久化上次选择:可用性校验;不可用 → 挂起(不删 localStorage,登录回来自动还原,
          picker 如实展示原因)—— 堵住「登出后残留代理模型 → 发消息撞网关拒绝」(用户报障 2026-07-08);
       ② 登录 + 账户可用(会员/有余额)+ 代理已注册 → catalog 默认档(非持久);
       ③ 已配 KEY 的 BYOK provider → 其引擎注册的第一个模型(非持久);
       ④ 全无 → 保持占位:picker 内登录/配 KEY 双出口,发送前 preflight 拦截。
     显式选择才落盘;自动默认一律非持久(C28:不选锁定模型装可用)。 */
  const [lastAuth, setLastAuth] = createSignal<AuthState | null>(null)
  const [authKnown, setAuthKnown] = createSignal(false)
  const [platformId, setPlatformId] = createSignal<string | null>(null)
  const [hasConfiguredByok, setHasConfiguredByok] = createSignal(false)
  let chainSeq = 0
  let chainDisposed = false

  // summary 拿不到/网络错 → 疑罪从无(维持 REQ-056 行为,网关是最终裁决);明确空账户才 false。
  const summaryUsable = (r: unknown): boolean => {
    if (!r || typeof r !== "object" || "error" in (r as Record<string, unknown>)) return true
    const s = r as { plan?: { status?: string }; balanceFen?: number }
    return s.plan?.status === "active" || (s.balanceFen ?? 0) > 0
  }

  const runModelChain = async () => {
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

      // ① 代理模型的可用性只依赖 auth 侧事实,即刻可判(BYOK 的 provider-gone 需引擎表,在下方循环里判)
      const current = composerModel()
      if (current && pid && current.providerID === pid) {
        const verdict = checkPersistedModel(current, { ...baseCtx, engineModels: [] })
        if (verdict.ok) return
        suspendComposerModel(verdict.reason) // 挂起后继续走②③给出替代默认
      } else if (!current && loggedIn && composerModelSuspended()?.reason === "needs-login") {
        if (restoreSuspendedModel()) return // 登录回来:还原挂起的上次选择(entitlement 型不自动还原)
      }

      // ②③ 需要引擎模型表:冷启动引擎/sdk 未就绪是常态,有界重试(≤20s),别一枪打空。
      for (let i = 0; i < 20 && !chainDisposed && seq === chainSeq; i++) {
        const c = props.projects.sdk()
        if (c) {
          const { data } = await c.config.providers({} as any).catch(() => ({ data: undefined }) as const)
          const provs = Array.isArray((data as any)?.providers) ? (data as any).providers : Array.isArray(data) ? (data as any) : []
          const engineModels: EngineModelRef[] = []
          for (const p of provs) {
            const ppid = p?.id ?? p?.providerID
            const models = p?.models && typeof p.models === "object" ? Object.keys(p.models) : []
            for (const mid of models) engineModels.push({ providerID: ppid, modelID: mid })
          }
          const cur = composerModel()
          if (cur) {
            // ① 的 BYOK 半边:引擎表非空才可判 provider-gone(空表 = 未就绪,不误杀)
            if (engineModels.length) {
              const v = checkPersistedModel(cur, { ...baseCtx, engineModels })
              if (v.ok) return
              suspendComposerModel(v.reason)
            } else {
              return // 有选择且引擎未就绪:等引擎自己收敛,不抢跑
            }
          }
          const r = resolveDefaultModel({ ...baseCtx, engineModels })
          if (r.kind === "model") {
            applyDefaultComposerModel(r.model)
            return
          }
          if (r.kind === "none") return // ④ 空态:占位 + picker 引导 + preflight 兜底
        }
        await new Promise((res) => setTimeout(res, 1000))
      }
    } catch {
      /* 默认失败不打扰:保持占位,手选路径完好 */
    }
  }

  onMount(() => {
    void runModelChain()
    // 登录态变化即重跑链:登出 → 挂起代理选择;登录 → 还原/自动默认(REQ-069)
    const unsub = window.api.auth.subscribe(() => void runModelChain())
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
            ? { kind: "info", title: "该模型需登录后使用", detail: "登录后零配置直用;或点右下角模型选择器,换用自己 API KEY 的模型。" }
            : { kind: "info", title: "还没有可用的模型", detail: "登录即可零配置使用;或在模型选择器里添加自己的 API KEY。" },
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
          variant: req.variant,
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
        <ModelChip sdk={props.projects.sdk} onNeedWorkspace={props.onNeedWorkspace} hasWorkspace={hasWorkspace} />
        <EffortChip sdk={props.projects.sdk} />
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
