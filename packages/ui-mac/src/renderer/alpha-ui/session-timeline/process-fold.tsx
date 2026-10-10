// `#1473`(REQ-229 AC1–AC3)— 工作过程:一个回合里回答之前的思考、工具调用与过渡话收成一行。
//
// 形态权威 = docs/design/current/conversation-timeline/design.html ⑧ 节(#process-fold)与
// docs/design/2026-10-10-timeline-process-fold/design.md §2 / §4:
//   · 收起(一行):成功动作计数(最多三类,按次数排)· 有失败步骤且回合成功时的琥珀色人话 · 整轮用时;
//   · 每步一行:图标 + 动作 + 对象 + 行尾(超过 10 秒的用时 / 失败的人话 / 改动增删数);成功不挂状态;
//   · 某一步的详情:复用 cards/tool-cards.tsx 的各类卡片正文(ToolStepDetail),合并行先展开成每项一行。
// 进行中(`#1474`,design §3 / 帧 §③ §⑦):回合开始即出现,实时标题 = 当前动作 + 第 N 步 + 整轮计时;
// 实时区 = 最近 2 个已结束的行 + 所有正在跑的,更早的收成「前面还有 N 步」;一步超过 10 秒写「已等」;
// 正在跑的命令露最后 3 行输出;思考不露原文;回答一开始输出就收成一行摘要(带脉冲点、继续计时);
// 等你批准 / 等你回答 / 自动重试都写进这个标题(原回合脚行与重试卡并入这里)。纯逻辑在 process-live.ts。
// 每类步骤的人话动作名、行尾规则、第三方行内来源(插头 / 拼图 / 问号 + 服务名)与答完的提问(#1475)由
// cards/tool-card-model 的 toolStepLineOf 投影 —— 非我方工具仍不显示输入输出(来源安全规则不变)。
// 两者在行尾汇合:正在跑且回合活跃时「已等 m:ss」优先于行尾的结果信息(ToolEnd)。
//
// 开合状态住在视图级的信号里(按回合 / 步骤键),不住在行对象上:步骤状态翻转会换行对象,
// 用户手动开或关过的不能因此被系统重置(design §3「你手动开或关过的,本回合内系统不再替你开关」)。
import type { ReasoningPart, ToolPart } from "@opencode-ai/sdk/v2/client"
import {
  type Accessor,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  onCleanup,
  Show,
  useContext,
} from "solid-js"
import { t } from "../../i18n"
import { StatBadge, stepSourceIcon, ToolStepDetail, toolIcon } from "./cards/tool-cards"
import {
  cappedItem,
  toolCardDispatchOf,
  toolCardStatusOf,
  toolGroupVerbOf,
  toolStepLineOf,
  type ToolStepEnd,
  type ToolStepLine,
} from "./cards/tool-card-model"
import {
  liveActionOf,
  liveSinceOf,
  liveStepNumberOf,
  liveTerminalTailOf,
  liveWaitedMs,
  liveWindowOf,
  type ProcessLiveAction,
  toolPartLive,
} from "./process-live"
import { TimelineMarkdown } from "./timeline-markdown"
import {
  boundedText,
  formatTurnElapsed,
  PROCESS_STEP_DURATION_MIN_MS,
  processSummaryOf,
  REASONING_MAX_CHARS,
  reasoningStepDurationMs,
  reasoningSummary,
  splitDuration,
  toolStepDurationMs,
  type TimelineProcessStep,
  type TimelineRow,
  type TimelineTurnWait,
} from "./timeline-model"

type I18nKey = Parameters<typeof t>[0]

// ── 开合状态(视图级;缺席 = 组件局部,行为相同) ────────────────────────────
export interface ProcessOpenState {
  get: (key: string) => boolean | undefined
  set: (key: string, open: boolean) => void
}

export function createProcessOpenState(): ProcessOpenState {
  // 用户手动开 / 关过的键才进表;表很小(只随点击增长),整表换值即可。
  const [state, setState] = createSignal<Readonly<Record<string, boolean>>>({})
  return {
    get: (key) => state()[key],
    set: (key, open) => setState((previous) => ({ ...previous, [key]: open })),
  }
}

export const ProcessOpenContext = createContext<ProcessOpenState>()

// ── 文案 ────────────────────────────────────────────────────────────────────
export function formatProcessDuration(ms: number): string {
  const { minutes, seconds } = splitDuration(ms)
  if (minutes > 0) return t("alpha.timeline.durationMinutes", { minutes, seconds })
  return t("alpha.timeline.reasoningDuration", { seconds })
}

function reasoningVerb(step: Extract<TimelineProcessStep, { kind: "reasoning" }>): string {
  if (step.streaming) return t("alpha.timeline.thinking")
  const ms = reasoningStepDurationMs(step.parts)
  if (ms === undefined) return t("alpha.timeline.reasoning")
  return t("alpha.timeline.stepReasoning", { seconds: Math.max(0, Math.round(ms / 1000)) })
}

/** 我方步骤的动作名(i18n);非我方来源没有动作名(行内写来源,见 StepSource)。 */
function lineVerb(line: ToolStepLine): string {
  return line.verbKey ? t(line.verbKey as I18nKey, line.verbParams) : line.name
}

const SOURCE_FALLBACK_KEYS = {
  mcp: "alpha.timeline.stepSourceMcp",
  plugin: "alpha.timeline.stepSourcePlugin",
  unknown: "alpha.timeline.stepSourceUnknown",
} as const

/** 非我方来源的行内标签:服务名 / 插件名;缺席时用通用文案;来源不明恒为「来源不明」。 */
export function stepSourceLabel(source: NonNullable<ToolStepLine["source"]>): string {
  if (source.kind !== "unknown" && source.label) return source.label
  return t(SOURCE_FALLBACK_KEYS[source.kind])
}

function endText(end: ToolStepEnd): string {
  const params = end.list ? { ...end.params, answer: end.list.join(t("alpha.timeline.listSep")) } : end.params
  return t(end.key as I18nKey, params)
}

/**
 * 步骤行左侧:我方 = 类别图标 + 动作名;非我方 = 来源图标(插头 / 拼图 / 问号)+ 服务名。
 * 防冒充(AC5):data-alpha-step-source 与这三种图标只出现在非我方步骤上。
 */
function StepLead(props: { line: ToolStepLine; kind: string; verb?: string }) {
  return (
    <Show
      when={props.line.source}
      fallback={
        <>
          <span class="a-tl-pf-ico" data-kind={props.kind} aria-hidden="true">
            {toolIcon(props.kind)}
          </span>
          <span class="a-tl-pf-v">{props.verb ?? lineVerb(props.line)}</span>
        </>
      }
    >
      {(source) => (
        <>
          <span class="a-tl-pf-ico" data-alpha-step-source={source().kind} aria-hidden="true">
            {stepSourceIcon(source().kind)}
          </span>
          <span class="a-tl-pf-v" data-alpha-step-origin>
            {stepSourceLabel(source())}
          </span>
        </>
      )}
    </Show>
  )
}

function chev(cls: string) {
  return (
    <svg class={cls} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 6l6 6-6 6" />
    </svg>
  )
}

function thinkIcon() {
  return (
    <svg class="a-tl-pf-i" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9.5 2a4.5 4.5 0 0 0-4.3 5.8A4 4 0 0 0 6 15.5a4 4 0 0 0 7 1 4 4 0 0 0 7-1 4 4 0 0 0 .8-7.7A4.5 4.5 0 0 0 14.5 2 4.5 4.5 0 0 0 12 3.3 4.5 4.5 0 0 0 9.5 2z" />
    </svg>
  )
}

// ── 进行中的共享状态(只在活跃回合里提供;结束态缺席 = 不画任何实时标记) ─────────────
interface ProcessLiveState {
  /** 回合仍在跑。结束态 ⇒ false:不画任何实时标记(「已等」、终端尾巴、等你高亮)。 */
  active: Accessor<boolean>
  /** 每秒走一格的时钟(「已等」与整轮计时共用)。 */
  now: Accessor<number>
  /** 等你批准时,被等的那一次工具调用(同色高亮、行尾写「等你批准」)。 */
  waitingPartID: Accessor<string | undefined>
}

const ProcessLiveContext = createContext<ProcessLiveState>()

const PROCESS_LIVE_TICK_MS = 1000

/** 活跃期间每秒走一格;回合结束即停表(结束态不需要时钟)。 */
function createLiveClock(active: Accessor<boolean>): Accessor<number> {
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    if (!active()) return
    setNow(Date.now())
    const tick = setInterval(() => setNow(Date.now()), PROCESS_LIVE_TICK_MS)
    onCleanup(() => clearInterval(tick))
  })
  return now
}

function liveActionText(action: ProcessLiveAction): string {
  if (action.type === "thinking") return t("alpha.timeline.liveThinking")
  const many = action.count > 1
  switch (action.family) {
    case "search":
      return many ? t("alpha.timeline.liveSearchMany", { count: action.count }) : t("alpha.timeline.liveSearch")
    case "bash":
      return many ? t("alpha.timeline.liveBashMany", { count: action.count }) : t("alpha.timeline.liveBash")
    case "fetch":
      return many ? t("alpha.timeline.liveFetchMany", { count: action.count }) : t("alpha.timeline.liveFetch")
    case "verb": {
      const verb = t(action.verbKey as I18nKey)
      return many ? t("alpha.timeline.liveVerbMany", { verb, count: action.count }) : t("alpha.timeline.liveVerb", { verb })
    }
    default: {
      const name = action.name ?? ""
      return many
        ? t("alpha.timeline.liveNamedMany", { name, count: action.count })
        : t("alpha.timeline.liveNamed", { name })
    }
  }
}

function pauseIcon() {
  return (
    <svg class="a-tl-pf-pause" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 5v14M15 5v14" />
    </svg>
  )
}

// ── 工作过程行 ──────────────────────────────────────────────────────────────
//
// 无障碍(继承 `#1399` 回合脚行的播报预算):活跃回合挂一个视觉隐藏的 role="status",整轮只在
// 出现 / 转成等你 / 转成重试 / 回到运行这几个时刻改字;实时标题里每次换动作、每秒跳的计时都不进 live 区。
// 结束不由本行播报(由接管者 —— 中断行 / 错误卡 / 顶栏胶囊 —— 说)。
export function ProcessRow(props: { row: Extract<TimelineRow, { kind: "process" }>; wait?: TimelineTurnWait }) {
  const local = createProcessOpenState()
  const state = useContext(ProcessOpenContext) ?? local
  const scope = () => props.row.userMessageID
  const processKey = () => `process:${scope()}`
  // 默认:回合在跑且回答还没开始 ⇒ 展开(实时区);回答一开始输出 ⇒ 收成一行;回合结束 / 重新打开
  // 历史会话 ⇒ 收起。用户在本回合手动开或关过(键在表里)⇒ 系统不再替他开关。
  const open = () => state.get(processKey()) ?? (props.row.active && !props.row.answering)
  const active = () => props.row.active
  const wait = () => (active() ? props.wait : undefined)
  const retry = () => (active() ? props.row.retry : undefined)
  const face = () => (!active() ? undefined : wait() ? "waiting" : retry() ? "retry" : "running")
  const now = createLiveClock(active)
  const elapsed = () => formatTurnElapsed(now() - props.row.startedAt)
  const action = createMemo(() => liveActionOf(props.row.steps))
  const stepNumber = createMemo(() => liveStepNumberOf(props.row.steps))
  const waitingPartID = createMemo(() => {
    if (wait() !== "approval") return undefined
    let id: string | undefined
    for (const step of props.row.steps)
      if (step.kind === "tool") for (const part of step.parts) if (toolPartLive(part)) id = part.id
    return id
  })
  // 实时标题出现在:展开的活跃回合,以及任何「等你 / 重试」时刻(即使收起,也不能把它们藏起来)。
  const headLive = () => active() && (open() || !!wait() || !!retry())
  const statusText = () => {
    const waiting = wait()
    if (waiting === "approval") return `${t("alpha.timeline.turnWaitApproval")} ${t("alpha.timeline.turnWaitApprovalHint")}`
    if (waiting === "question") return `${t("alpha.timeline.turnWaitQuestion")} ${t("alpha.timeline.turnWaitQuestionHint")}`
    const current = retry()
    if (current) return t("alpha.timeline.liveRetrying", { attempt: current.attempt })
    return t("alpha.timeline.turnRunning")
  }
  const summary = createMemo(() => processSummaryOf(props.row.steps))
  const parts = createMemo(() => {
    const value = summary()
    const segments: { text: string; tone?: "warn" | "num" }[] = value.actions.map((action) => ({
      text: t("alpha.timeline.processAction", {
        verb: action.titleKey ? t(action.titleKey as I18nKey) : action.name,
        count: action.count,
      }),
    }))
    if (segments.length === 0 && value.reasoningCount > 0 && value.failed === 0) {
      segments.push({
        text:
          value.reasoningMs !== undefined
            ? t("alpha.timeline.stepReasoning", { seconds: Math.max(0, Math.round(value.reasoningMs / 1000)) })
            : t("alpha.timeline.reasoning"),
      })
    }
    // 「不顺」只在有失败步骤且回合本身成功时出现;回合失败时错误卡已在外面,不重复。
    if (value.failed > 0 && !props.row.turnFailed)
      segments.push({ text: t("alpha.timeline.processFailed", { count: value.failed }), tone: "warn" })
    // 回答已开始、过程里还一步都没有(纯文字回答):收起行写「正在生成」,不写空洞的「工作过程」。
    if (segments.length === 0)
      segments.push({ text: props.row.active ? t("alpha.timeline.turnRunning") : t("alpha.timeline.process") })
    if (props.row.durationMs !== undefined)
      segments.push({ text: formatProcessDuration(props.row.durationMs), tone: "num" })
    return segments
  })
  const liveWindow = createMemo(() => liveWindowOf(props.row.steps))
  const allKey = () => `${processKey()}/all`
  const showAll = () => !active() || (state.get(allKey()) ?? false)
  const listed = () => (showAll() ? props.row.steps : liveWindow().visible)
  const live: ProcessLiveState = { active, now, waitingPartID }
  return (
    <section
      class="a-tl-row a-tl-pf"
      data-alpha-timeline-row="process"
      data-open={open() ? "true" : undefined}
      data-active={props.row.active ? "true" : undefined}
      data-face={face()}
      data-wait={wait()}
    >
      <button
        type="button"
        class="a-tl-pf-sum"
        data-live={headLive() ? "true" : undefined}
        aria-expanded={open()}
        onClick={() => state.set(processKey(), !open())}
      >
        {chev("a-tl-pf-chev")}
        <Show
          when={headLive()}
          fallback={
            <>
              <For each={parts()}>
                {(segment, index) => (
                  <>
                    <Show when={index() > 0}>
                      <span class="a-tl-pf-dot" aria-hidden="true" />
                    </Show>
                    <span
                      class={
                        segment.tone === "warn" ? "a-tl-pf-warn" : segment.tone === "num" ? "a-tl-pf-num" : undefined
                      }
                      data-alpha-process-segment={segment.tone ?? "action"}
                    >
                      {segment.text}
                    </span>
                  </>
                )}
              </For>
              {/* 收起但回合仍在跑(回答正在输出):继续计时 + 脉冲点,直到回合结束才定格。 */}
              <Show when={active()}>
                <span class="a-tl-pf-dot" aria-hidden="true" />
                <span class="a-tl-pf-num" data-alpha-process-segment="elapsed" aria-hidden="true">
                  {elapsed()}
                </span>
                <span class="a-tl-pf-pulse" aria-hidden="true" />
              </Show>
            </>
          }
        >
          <LiveHead
            wait={wait()}
            retry={retry()}
            action={action()}
            stepNumber={stepNumber()}
            elapsed={elapsed()}
          />
        </Show>
      </button>
      <Show when={active()}>
        <span class="a-tl-pf-sr" role="status">
          {statusText()}
        </span>
      </Show>
      <Show when={open()}>
        <ProcessLiveContext.Provider value={live}>
          <div class="a-tl-pf-list" data-live={active() ? "true" : undefined}>
            <Show when={!showAll() && liveWindow().hidden > 0}>
              <button
                type="button"
                class="a-tl-pf-more"
                data-alpha-process-more
                aria-expanded="false"
                onClick={() => state.set(allKey(), true)}
              >
                {chev("a-tl-pf-sc")}
                {t("alpha.timeline.liveMore", { count: liveWindow().hidden })}
              </button>
            </Show>
            <For each={listed()}>{(step) => <ProcessStepView step={step} scope={scope()} state={state} />}</For>
          </div>
        </ProcessLiveContext.Provider>
      </Show>
    </section>
  )
}

/** 实时标题:运行(当前动作 + 第 N 步 + 计时)/ 等你(琥珀,今天回合脚行的文案)/ 自动重试。 */
function LiveHead(props: {
  wait?: TimelineTurnWait
  retry?: { attempt: number; message: string }
  action: ProcessLiveAction
  stepNumber: number
  elapsed: string
}) {
  return (
    <Show
      when={props.wait}
      fallback={
        <Show
          when={props.retry}
          fallback={
            <>
              <span class="a-tl-pf-pulse" aria-hidden="true" />
              <span class="a-tl-pf-title" data-alpha-process-title>
                {liveActionText(props.action)}
              </span>
              <Show when={props.action.type === "thinking" ? props.action.title : undefined}>
                {(title) => (
                  <span class="a-tl-pf-o" data-alpha-process-reasoning-title>
                    {title()}
                  </span>
                )}
              </Show>
              <span class="a-tl-pf-dot" aria-hidden="true" />
              <span class="a-tl-pf-num" data-alpha-process-segment="elapsed" aria-hidden="true">
                {props.stepNumber > 0
                  ? `${t("alpha.timeline.liveStep", { step: props.stepNumber })} · ${props.elapsed}`
                  : props.elapsed}
              </span>
            </>
          }
        >
          {(retry) => (
            <>
              <span class="a-tl-pf-spin" aria-hidden="true" />
              <span class="a-tl-pf-title" data-alpha-process-title>
                {t("alpha.timeline.liveRetrying", { attempt: retry().attempt })}
              </span>
              <Show when={retry().message}>
                <span class="a-tl-pf-dot" aria-hidden="true" />
                <span class="a-tl-pf-o" data-alpha-process-retry-reason>
                  {retry().message}
                </span>
              </Show>
              <span class="a-tl-pf-dot" aria-hidden="true" />
              <span class="a-tl-pf-num" data-alpha-process-segment="elapsed" aria-hidden="true">
                {props.elapsed}
              </span>
            </>
          )}
        </Show>
      }
    >
      {(wait) => (
        <>
          {pauseIcon()}
          <span class="a-tl-pf-title" data-alpha-process-title>
            {wait() === "approval" ? t("alpha.timeline.turnWaitApproval") : t("alpha.timeline.turnWaitQuestion")}
          </span>
          <span class="a-tl-pf-dot" aria-hidden="true" />
          <span class="a-tl-pf-hint">
            {wait() === "approval"
              ? t("alpha.timeline.turnWaitApprovalHint")
              : t("alpha.timeline.turnWaitQuestionHint")}
          </span>
        </>
      )}
    </Show>
  )
}

function ProcessStepView(props: { step: TimelineProcessStep; scope: string; state: ProcessOpenState }): JSX.Element {
  const step = props.step
  if (step.kind === "say") return <SayStep step={step} />
  if (step.kind === "reasoning") return <ReasoningStep step={step} scope={props.scope} state={props.state} />
  if (step.parts.length === 1)
    return <ToolItem part={step.parts[0]!} openKey={`${props.scope}/${step.key}`} state={props.state} />
  return <ToolGroupStep step={step} scope={props.scope} state={props.state} />
}

/** 过渡话:一行灰色正文,没有图标,不参与合并。 */
function SayStep(props: { step: Extract<TimelineProcessStep, { kind: "say" }> }) {
  return (
    <div class="a-tl-pf-say" data-alpha-process-step="say">
      <TimelineMarkdown text={props.step.part.text ?? ""} cacheKey={`say:${props.step.part.id}`} streaming={false} />
    </div>
  )
}

function ReasoningStep(props: {
  step: Extract<TimelineProcessStep, { kind: "reasoning" }>
  scope: string
  state: ProcessOpenState
}) {
  const key = () => `${props.scope}/${props.step.key}`
  const open = () => props.state.get(key()) ?? false
  const live = useContext(ProcessLiveContext)
  const waited = () => (live?.active() ? liveWaitedMs(liveSinceOf(props.step), live.now()) : undefined)
  // 流式期不读不断增长的正文:完成态一次提取,行标题不随分片跳变;只认显式小标题(不猜首句)。
  const title = createMemo(() => (props.step.streaming ? undefined : reasoningSummary(props.step.parts[0]?.text ?? "")))
  const body = () =>
    boundedText(
      props.step.parts
        .map((part: ReasoningPart) => part.text ?? "")
        .filter(Boolean)
        .join("\n\n"),
      REASONING_MAX_CHARS,
    )
  return (
    <>
      <button
        type="button"
        class="a-tl-pf-step"
        data-alpha-process-step="reasoning"
        data-think="true"
        data-streaming={props.step.streaming ? "true" : undefined}
        data-open={open() ? "true" : undefined}
        aria-expanded={open()}
        onClick={() => props.state.set(key(), !open())}
      >
        {thinkIcon()}
        <span class="a-tl-pf-v">{reasoningVerb(props.step)}</span>
        <Show when={title()}>
          <span class="a-tl-pf-o">
            {title()}
          </span>
        </Show>
        <span class="a-tl-pf-end">
          <Show when={waited()}>{(ms) => <span data-alpha-step-waited>{waitedText(ms())}</span>}</Show>
          {chev("a-tl-pf-sc")}
        </span>
      </button>
      <Show when={open()}>
        <div class="a-tl-pf-detail a-tl-pf-think">
          {body().text}
          <Show when={body().truncated}>
            <span class="a-tl-truncated-inline">{t("alpha.timeline.truncated")}</span>
          </Show>
        </div>
      </Show>
    </>
  )
}

/** 一项工具调用的对象(目标 / 名称);脱敏失败 → 确定的「详情已隐藏」(AC5)。 */
function ToolObject(props: { line: ToolStepLine; text?: string }) {
  return (
    <>
      <Show when={props.text ?? props.line.object}>
        {(text) => (
          <span class="a-tl-pf-o" data-mono={props.line.objectMono ? "true" : undefined}>
            {text()}
          </span>
        )}
      </Show>
      <Show when={props.line.objectHidden}>
        <span class="a-tl-pf-o" data-alpha-details-hidden>
          {t("alpha.timeline.detailsHidden")}
        </span>
      </Show>
    </>
  )
}

/** 行尾:运行中 / 等待 · 失败的人话 · 超过 10 秒的用时 · 改动增删数。成功不挂状态。 */
function waitedText(ms: number): string {
  return t("alpha.timeline.liveWaited", { time: formatTurnElapsed(ms) })
}

function ToolEnd(props: {
  parts: readonly ToolPart[]
  group: boolean
  line?: ToolStepLine
  stat?: { additions: number; deletions: number }
  waiting?: boolean
}) {
  const live = useContext(ProcessLiveContext)
  // 一步超过 10 秒:「运行中」换成「已等 m:ss」(只在活跃回合里、只对正在跑的单项步骤;并行的各自一行各自计)。
  const waited = () => {
    if (!live?.active() || props.parts.length !== 1) return undefined
    const part = props.parts[0]!
    return liveWaitedMs(liveSinceOf({ kind: "tool", key: "", parts: [part] }, part), live.now())
  }
  const failed = () => props.parts.filter((part) => part.state.status === "error").length
  const running = () => props.parts.some((part) => part.state.status === "running")
  const pending = () => !running() && props.parts.some((part) => part.state.status === "pending")
  const longest = () => {
    let max: number | undefined
    for (const part of props.parts) {
      const ms = toolStepDurationMs(part)
      if (ms !== undefined && (max === undefined || ms > max)) max = ms
    }
    return max !== undefined && max > PROCESS_STEP_DURATION_MIN_MS ? max : undefined
  }
  // 单项:失败 / 审批超时的人话来自步骤行投影(同一句话覆盖所有 kind 与来源);合并行按次数说。
  const failure = () => {
    if (!props.group) return props.line?.end?.failure ? endText(props.line.end) : undefined
    const count = failed()
    if (count === 0) return undefined
    if (count === props.parts.length) return t("alpha.timeline.stepAllFailed")
    return t("alpha.timeline.stepSomeFailed", { count })
  }
  // 成功时行尾只放有用的信息:「没找到」「退出 1」「2 个报错」「你选了 …」。
  const note = () => (!props.group && props.line?.end && !props.line.end.failure ? endText(props.line.end) : undefined)
  // 「已等」只在正在跑、回合活跃时出现;此时它占住行尾,结果信息(人话 / 用时 / 增删数)让位。
  const settled = () => waited() === undefined
  return (
    <span class="a-tl-pf-end">
      <Show
        when={props.waiting}
        fallback={
          <>
            <Show when={running()}>
              <span class="a-tl-pf-spin" aria-hidden="true" />
              <Show when={waited()} fallback={t("alpha.timeline.toolRunning")}>
                {(ms) => <span data-alpha-step-waited>{waitedText(ms())}</span>}
              </Show>
            </Show>
            <Show when={pending()}>{t("alpha.timeline.toolPending")}</Show>
          </>
        }
      >
        <span data-alpha-step-waiting>{t("alpha.timeline.liveWaitApproval")}</span>
      </Show>
      <Show when={failure()}>{(text) => <span data-alpha-step-failure>{text()}</span>}</Show>
      <Show when={settled() && note()}>{(text) => <span data-alpha-step-note>{text()}</span>}</Show>
      <Show when={settled() && longest()}>{(ms) => <span>{formatProcessDuration(ms())}</span>}</Show>
      <Show when={settled() && props.stat}>{(stat) => <StatBadge stat={stat()} />}</Show>
      {chev("a-tl-pf-sc")}
    </span>
  )
}

function toneOf(parts: readonly ToolPart[]): string | undefined {
  if (parts.some((part) => part.state.status === "error")) return "warn"
  if (parts.some((part) => part.state.status === "running" || part.state.status === "pending")) return "run"
  return undefined
}

/**
 * 一次工具调用 = 一个条目(步骤行 + 点开后的详情)。条目带着工具卡原有的身份属性
 * (data-alpha-tool-card / kind / category / status),来源安全的 DOM 合同跟着条目走。
 */
function ToolItem(props: { part: ToolPart; openKey: string; state: ProcessOpenState; sub?: boolean }) {
  // 默认收起 —— 用户手动开关过的优先。正在跑的命令不整张展开,只在行下露最后 3 行输出(结束即收起)。
  const open = () => props.state.get(props.openKey) ?? false
  const dispatch = createMemo(() => toolCardDispatchOf(props.part))
  const line = createMemo(() => toolStepLineOf(props.part))
  const live = useContext(ProcessLiveContext)
  const waiting = () => live?.active() === true && live.waitingPartID() === props.part.id
  const tail = createMemo(() => (live?.active() && !open() ? liveTerminalTailOf(props.part) : undefined))
  return (
    <div
      class="a-tl-pf-item"
      data-alpha-tool-card
      data-kind={dispatch().kind}
      data-category={dispatch().category}
      data-tool={cappedItem(props.part.tool)}
      data-status={toolCardStatusOf(props.part.state)}
      data-open={open() ? "true" : undefined}
    >
      <button
        type="button"
        class="a-tl-pf-step"
        data-alpha-process-step={props.sub ? "tool-item" : "tool"}
        data-tone={waiting() ? "wait" : toneOf([props.part])}
        data-open={open() ? "true" : undefined}
        aria-expanded={open()}
        onClick={() => props.state.set(props.openKey, !open())}
      >
        <Show when={!props.sub}>
          <StepLead line={line()} kind={dispatch().kind} />
        </Show>
        <ToolObject line={line()} />
        <ToolEnd parts={[props.part]} group={false} line={line()} stat={line().stat} waiting={waiting()} />
      </button>
      <Show when={tail()}>
        {(lines) => (
          <div class="a-tl-pf-tail" data-alpha-process-tail aria-hidden="true">
            <For each={lines()}>{(line) => <div class="a-tl-pf-tail-line">{line}</div>}</For>
          </div>
        )}
      </Show>
      <Show when={open()}>
        <ToolStepDetail part={props.part} />
      </Show>
    </div>
  )
}

function ToolGroupStep(props: {
  step: Extract<TimelineProcessStep, { kind: "tool" }>
  scope: string
  state: ProcessOpenState
}) {
  const key = () => `${props.scope}/${props.step.key}`
  const open = () => props.state.get(key()) ?? false
  const first = () => props.step.parts[0]!
  const dispatch = createMemo(() => toolCardDispatchOf(first()))
  const line = createMemo(() => toolStepLineOf(first()))
  const count = () => props.step.parts.length
  // 合并后的动作名:读取 / 编辑 / 写入按文件数(「读取 5 个文件」),其余「X N 次」;
  // 非我方来源:来源标签在前,「工具名 N 次」作对象(仍不显示任何参数)。
  const verb = () => {
    const grouped = toolGroupVerbOf(first(), count())
    if (grouped) return t(grouped.key as I18nKey, grouped.params)
    return t("alpha.timeline.processAction", { verb: lineVerb(line()), count: count() })
  }
  // 改动增删数是内容不是状态:合并行写全组之和(任一项有数才写)。
  const stat = createMemo(() => {
    let sum: { additions: number; deletions: number } | undefined
    for (const part of props.step.parts) {
      const value = toolStepLineOf(part).stat
      if (value) sum = { additions: (sum?.additions ?? 0) + value.additions, deletions: (sum?.deletions ?? 0) + value.deletions }
    }
    return sum
  })
  const object = () =>
    line().source ? t("alpha.timeline.processAction", { verb: line().name, count: count() }) : undefined
  return (
    <div
      class="a-tl-pf-group"
      data-alpha-process-group
      data-kind={dispatch().kind}
      data-open={open() ? "true" : undefined}
    >
      <button
        type="button"
        class="a-tl-pf-step"
        data-alpha-process-step="toolgroup"
        data-kind={dispatch().kind}
        data-category={dispatch().category}
        data-count={props.step.parts.length}
        data-tone={toneOf(props.step.parts)}
        data-open={open() ? "true" : undefined}
        aria-expanded={open()}
        onClick={() => props.state.set(key(), !open())}
      >
        <StepLead line={line()} kind={dispatch().kind} verb={verb()} />
        <ToolObject line={line()} text={object()} />
        <ToolEnd parts={props.step.parts} group={true} line={line()} stat={stat()} />
      </button>
      <Show when={open()}>
        <div class="a-tl-pf-sublist">
          <For each={props.step.parts}>
            {(part) => <ToolItem part={part} openKey={`${key()}/${part.id}`} state={props.state} sub />}
          </For>
        </div>
      </Show>
    </div>
  )
}
