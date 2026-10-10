// `#1473`(REQ-229 AC1–AC3)— 工作过程:一个回合里回答之前的思考、工具调用与过渡话收成一行。
//
// 形态权威 = docs/design/current/conversation-timeline/design.html ⑧ 节(#process-fold)与
// docs/design/2026-10-10-timeline-process-fold/design.md §2 / §4:
//   · 收起(一行):成功动作计数(最多三类,按次数排)· 有失败步骤且回合成功时的琥珀色人话 · 整轮用时;
//   · 每步一行:图标 + 动作 + 对象 + 行尾(超过 10 秒的用时 / 失败的人话 / 改动增删数);成功不挂状态;
//   · 某一步的详情:复用 cards/tool-cards.tsx 的各类卡片正文(ToolStepDetail),合并行先展开成每项一行。
// 进行中的实时标题 / 最近两步窗口 / 自动收起时机归 #1474;每类步骤的人话动作名、第三方行内来源
// 归 #1475 —— 本组件里非我方工具沿用「来源分类 + 名称」,不显示输入输出(来源安全规则不变)。
//
// 开合状态住在视图级的信号里(按回合 / 步骤键),不住在行对象上:步骤状态翻转会换行对象,
// 用户手动开或关过的不能因此被系统重置(design §3「你手动开或关过的,本回合内系统不再替你开关」)。
import type { ReasoningPart, ToolPart } from "@opencode-ai/sdk/v2/client"
import { createContext, createMemo, createSignal, For, type JSX, Show, useContext } from "solid-js"
import { t } from "../../i18n"
import { sourceCategoryKey, StatBadge, ToolStepDetail, toolIcon } from "./cards/tool-cards"
import {
  cappedItem,
  toolCardDispatchOf,
  toolCardHeadOf,
  toolCardStatusOf,
  toolTitleKeyOf,
} from "./cards/tool-card-model"
import { TimelineMarkdown } from "./timeline-markdown"
import {
  boundedText,
  PROCESS_STEP_DURATION_MIN_MS,
  processSummaryOf,
  REASONING_MAX_CHARS,
  reasoningStepDurationMs,
  reasoningSummary,
  splitDuration,
  toolStepDurationMs,
  type TimelineProcessStep,
  type TimelineRow,
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

/** 步骤 / 摘要的动作名:我方工具 = 动词;metadata-only = 来源分类(规则不变,名称作对象)。 */
function toolVerb(part: ToolPart): string {
  const dispatch = toolCardDispatchOf(part)
  if (dispatch.metadataOnly) return t(sourceCategoryKey(dispatch.category) as I18nKey)
  const key = toolTitleKeyOf(dispatch)
  return key ? t(key as I18nKey) : dispatch.name
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

// ── 工作过程行 ──────────────────────────────────────────────────────────────
export function ProcessRow(props: { row: Extract<TimelineRow, { kind: "process" }> }) {
  const local = createProcessOpenState()
  const state = useContext(ProcessOpenContext) ?? local
  const scope = () => props.row.userMessageID
  const processKey = () => `process:${scope()}`
  // 默认:回合还在跑时展开(实时形态归 #1474),结束 / 重新打开历史会话时收起。
  const open = () => state.get(processKey()) ?? props.row.active
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
    if (segments.length === 0) segments.push({ text: t("alpha.timeline.process") })
    if (props.row.durationMs !== undefined)
      segments.push({ text: formatProcessDuration(props.row.durationMs), tone: "num" })
    return segments
  })
  return (
    <section
      class="a-tl-row a-tl-pf"
      data-alpha-timeline-row="process"
      data-open={open() ? "true" : undefined}
      data-active={props.row.active ? "true" : undefined}
    >
      <button type="button" class="a-tl-pf-sum" aria-expanded={open()} onClick={() => state.set(processKey(), !open())}>
        {chev("a-tl-pf-chev")}
        <For each={parts()}>
          {(segment, index) => (
            <>
              <Show when={index() > 0}>
                <span class="a-tl-pf-dot" aria-hidden="true" />
              </Show>
              <span
                class={segment.tone === "warn" ? "a-tl-pf-warn" : segment.tone === "num" ? "a-tl-pf-num" : undefined}
                data-alpha-process-segment={segment.tone ?? "action"}
              >
                {segment.text}
              </span>
            </>
          )}
        </For>
      </button>
      <Show when={open()}>
        <div class="a-tl-pf-list">
          <For each={props.row.steps}>{(step) => <ProcessStepView step={step} scope={scope()} state={state} />}</For>
        </div>
      </Show>
    </section>
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
        <span class="a-tl-pf-end">{chev("a-tl-pf-sc")}</span>
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

/** 一项工具调用的对象(目标 / 降级名称);脱敏失败 → 确定的「详情已隐藏」(AC5)。 */
function ToolObject(props: { part: ToolPart }) {
  const head = createMemo(() => toolCardHeadOf(props.part))
  return (
    <Show
      when={!head().metadataOnly}
      fallback={
        <span class="a-tl-pf-o">
          {head().toolName}
          <Show when={head().origin}>
            {" · "}
            {head().origin}
          </Show>
        </span>
      }
    >
      <Show when={head().target}>
        <span class="a-tl-pf-o" data-mono="true">
          {head().target}
        </span>
      </Show>
      <Show when={head().targetHidden}>
        <span class="a-tl-pf-o" data-alpha-details-hidden>
          {t("alpha.timeline.detailsHidden")}
        </span>
      </Show>
    </Show>
  )
}

/** 行尾:运行中 / 等待 · 失败的人话 · 超过 10 秒的用时 · 改动增删数。成功不挂状态。 */
function ToolEnd(props: { parts: readonly ToolPart[]; group: boolean }) {
  const failed = () => props.parts.filter((part) => part.state.status === "error").length
  const running = () => props.parts.some((part) => part.state.status === "running")
  const pending = () => !running() && props.parts.some((part) => part.state.status === "pending")
  const head = createMemo(() => (props.parts.length === 1 ? toolCardHeadOf(props.parts[0]!) : undefined))
  const longest = () => {
    let max: number | undefined
    for (const part of props.parts) {
      const ms = toolStepDurationMs(part)
      if (ms !== undefined && (max === undefined || ms > max)) max = ms
    }
    return max !== undefined && max > PROCESS_STEP_DURATION_MIN_MS ? max : undefined
  }
  const failure = () => {
    const count = failed()
    if (count === 0) return undefined
    if (!props.group) return head()?.askTimedOut ? t("alpha.timeline.askTimeout") : t("alpha.timeline.stepFailed")
    if (count === props.parts.length) return t("alpha.timeline.stepAllFailed")
    return t("alpha.timeline.stepSomeFailed", { count })
  }
  return (
    <span class="a-tl-pf-end">
      <Show when={running()}>
        <span class="a-tl-pf-spin" aria-hidden="true" />
        {t("alpha.timeline.toolRunning")}
      </Show>
      <Show when={pending()}>{t("alpha.timeline.toolPending")}</Show>
      <Show when={failure()}>{(text) => <span data-alpha-step-failure>{text()}</span>}</Show>
      <Show when={longest()}>{(ms) => <span>{formatProcessDuration(ms())}</span>}</Show>
      <Show when={head()?.stat}>{(stat) => <StatBadge stat={stat()} />}</Show>
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
  // 默认收起;正在跑的那一步默认展开(终端输出照常实时可见),跑完回到收起 —— 用户手动开关过的优先。
  // 进行中的完整形态(实时标题、最近两步窗口)归 #1474。
  const open = () => props.state.get(props.openKey) ?? props.part.state.status === "running"
  const dispatch = createMemo(() => toolCardDispatchOf(props.part))
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
        data-tone={toneOf([props.part])}
        data-open={open() ? "true" : undefined}
        aria-expanded={open()}
        onClick={() => props.state.set(props.openKey, !open())}
      >
        <Show when={!props.sub}>
          <span class="a-tl-pf-ico" data-kind={dispatch().kind} aria-hidden="true">
            {toolIcon(dispatch().kind)}
          </span>
          <span class="a-tl-pf-v">{toolVerb(props.part)}</span>
        </Show>
        <ToolObject part={props.part} />
        <ToolEnd parts={[props.part]} group={false} />
      </button>
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
        <span class="a-tl-pf-ico" data-kind={dispatch().kind} aria-hidden="true">
          {toolIcon(dispatch().kind)}
        </span>
        <span class="a-tl-pf-v">
          {t("alpha.timeline.processAction", { verb: toolVerb(first()), count: props.step.parts.length })}
        </span>
        <ToolObject part={first()} />
        <ToolEnd parts={props.step.parts} group={true} />
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
