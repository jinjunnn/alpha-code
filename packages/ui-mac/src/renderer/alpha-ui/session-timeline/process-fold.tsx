// REQ-229 / #1473 — 工作过程折叠(design ⑧ #process-fold,帧 ①②④)。
//
// 一回合的思考 / 工具调用 / 过渡话收成**一行**(timeline-model 的 process 行),三层:
// ① 收起 = 一行摘要(动作计数 · 不顺的地方 · 整轮用时);② 展开 = 每步一行(图标 + 动作 + 对象 + 行尾);
// ③ 点一步 = 该类卡片的既有正文(cards/tool-cards 的 ToolStepDetail),合并行先展开成每项一行再点一项看正文。
// 安全纪律继承 #879/#587:非我方(metadata-only)工具的步骤只写「来源分类 · 名称」,输入 / 输出 / 错误零字符。
// 进行中的实时标题 / 最近两步窗口 / 自动收起归 #1474;每类步骤的人话动作名与第三方行内来源归 #1475。
import { createMemo, createSignal, For, Show } from "solid-js"
import { t } from "../../i18n"
import { SOURCE_KEYS, ToolStepDetail, toolIcon, toolStepEndOf } from "./cards/tool-cards"
import { cappedItem, toolCardHeadOf } from "./cards/tool-card-model"
import { TimelineMarkdown } from "./timeline-markdown"
import {
  boundedText,
  MARKDOWN_MAX_CHARS,
  type ProcessGroupLabel,
  type ProcessStep,
  REASONING_MAX_CHARS,
  reasoningSummary,
  type TimelineRow,
  toolStepDurationMs,
} from "./timeline-model"

// ── 开合状态 ──────────────────────────────────────────────────────────────────
// 按行 / 步 key 记在模块级(有界),行对象因流式重投影被替换时不丢用户手动开合
// (design ⑦ 总则:你手动开或关过的,本回合内系统不再替你开关;进行中的实时形态归 #1474)。
// 默认收起(design §4:重新打开历史会话全部收起)。
const PROCESS_OPEN_STATE_MAX = 2_000
const processOpenState = new Map<string, ReturnType<typeof createSignal<boolean>>>()

/** 换会话 / 重新打开会话时由视图调用:全部收起(design §4)。 */
export function clearProcessOpenState() {
  processOpenState.clear()
}

function processOpenSignal(key: string) {
  const existing = processOpenState.get(key)
  if (existing) return existing
  if (processOpenState.size >= PROCESS_OPEN_STATE_MAX) {
    const oldest = processOpenState.keys().next().value
    if (oldest !== undefined) processOpenState.delete(oldest)
  }
  const signal = createSignal<boolean>(false)
  processOpenState.set(key, signal)
  return signal
}

/** 步骤行 / 摘要上「只在超过 10 秒时出现」的时长(design §2);分钟 + 秒,整秒向下取整。 */
export const PROCESS_DURATION_SHOW_MS = 10_000

function formatProcessDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes > 0) return t("alpha.timeline.pfMinutesSeconds", { minutes, seconds })
  return t("alpha.timeline.pfSeconds", { seconds })
}

/** 动作名:命中宿主规则的专用卡用动词 i18n;非我方(metadata-only)写「来源分类 · 名称」,永不带输入。 */
function processActionLabel(group: ProcessGroupLabel): string {
  if (group.metadataOnly)
    return t("alpha.timeline.pfToolSource", {
      source: t(
        (SOURCE_KEYS[group.category as keyof typeof SOURCE_KEYS] ?? "alpha.timeline.sourceUnknown") as Parameters<
          typeof t
        >[0],
      ),
      name: group.name,
    })
  if (group.titleKey) return t(group.titleKey as Parameters<typeof t>[0])
  return group.name
}

function processActionText(group: ProcessGroupLabel, count: number): string {
  const action = processActionLabel(group)
  return count > 1 ? t("alpha.timeline.pfTimes", { action, count }) : action
}

function reasoningSeconds(part: { time: { start: number; end?: number } }): number | undefined {
  if (typeof part.time.end !== "number") return undefined
  return Math.max(0, Math.round((part.time.end - part.time.start) / 1000))
}

export function ProcessRow(props: { row: Extract<TimelineRow, { kind: "process" }> }) {
  const [open, setOpen] = processOpenSignal(props.row.key)
  const summary = () => props.row.summary
  const summaryItems = createMemo(() => {
    const value = summary()
    const items: { text: string; tone?: "warn" | "num" }[] = value.actions.map((action) => ({
      text: processActionText(action.group, action.count),
    }))
    // 只思考、没用工具:摘要退回「思考 N 秒」(帧 ④ 最后一格)。
    if (items.length === 0 && value.reasoningMs > 0)
      items.push({ text: t("alpha.timeline.pfThink", { seconds: Math.max(0, Math.round(value.reasoningMs / 1000)) }) })
    // 「不顺」只在有失败步骤且回合本身成功时出现(回合失败时错误卡已在外面,不重复写)。
    if (value.failed > 0 && value.turnSucceeded)
      items.push({ text: t("alpha.timeline.pfSummaryFailed", { count: value.failed }), tone: "warn" })
    if (value.durationMs !== undefined) items.push({ text: formatProcessDuration(value.durationMs), tone: "num" })
    return items
  })
  return (
    <section
      class="a-tl-row a-pf"
      data-alpha-timeline-row="process"
      data-alpha-process
      data-open={open() ? "true" : undefined}
      data-steps={props.row.steps.length}
    >
      <button
        type="button"
        class="a-pf-sum"
        aria-expanded={open()}
        title={t("alpha.timeline.pfProcess")}
        onClick={() => setOpen((value) => !value)}
      >
        <svg class="a-pf-chev" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9 6l6 6-6 6" />
        </svg>
        <For each={summaryItems()}>
          {(item, index) => (
            <>
              <Show when={index() > 0}>
                <span class="a-pf-dot" aria-hidden="true" />
              </Show>
              <span
                class="a-pf-sum-item"
                data-tone={item.tone}
                classList={{ "a-pf-warn": item.tone === "warn", "a-pf-num": item.tone === "num" }}
              >
                {item.text}
              </span>
            </>
          )}
        </For>
      </button>
      <Show when={open()}>
        <div class="a-pf-list" data-alpha-process-steps>
          <For each={props.row.steps}>{(step) => <ProcessStepRow step={step} />}</For>
        </div>
      </Show>
    </section>
  )
}

function ProcessStepRow(props: { step: ProcessStep }) {
  const step = props.step
  if (step.kind === "text") return <ProcessSayStep part={step.part} />
  if (step.kind === "reasoning") return <ProcessThinkStep step={step} />
  return <ProcessToolStep step={step} />
}

/** 过渡话:一行灰色正文,没有图标,不参与合并。 */
function ProcessSayStep(props: { part: Extract<ProcessStep, { kind: "text" }>["part"] }) {
  return (
    <div class="a-pf-say" data-alpha-process-step="text">
      <TimelineMarkdown
        text={boundedText(props.part.text ?? "", MARKDOWN_MAX_CHARS).text}
        cacheKey={`say:${props.part.id}`}
        streaming={false}
      />
    </div>
  )
}

/** 思考:只写「思考 N 秒」(+ 显式小标题);点开看原文。进行中不露原文(design §3)。 */
function ProcessThinkStep(props: { step: Extract<ProcessStep, { kind: "reasoning" }> }) {
  const [open, setOpen] = processOpenSignal(props.step.key)
  const seconds = () => reasoningSeconds(props.step.part)
  const body = () => boundedText(props.step.part.text ?? "", REASONING_MAX_CHARS)
  // 流式期不读取不断增长的正文:完成态一次提取,避免折叠头随分片跳变。
  const summary = createMemo(() => (props.step.streaming ? undefined : reasoningSummary(props.step.part.text ?? "")))
  const verb = () => {
    if (props.step.streaming) return t("alpha.timeline.thinking")
    const value = seconds()
    return value === undefined ? t("alpha.timeline.pfThinking") : t("alpha.timeline.pfThink", { seconds: value })
  }
  return (
    <>
      <button
        type="button"
        class="a-pf-step a-pf-think"
        data-alpha-process-step="reasoning"
        data-streaming={props.step.streaming ? "true" : undefined}
        data-open={open() ? "true" : undefined}
        aria-expanded={open()}
        onClick={() => setOpen((value) => !value)}
      >
        <svg class="a-pf-i" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9.5 2a4.5 4.5 0 0 0-4.3 5.8A4 4 0 0 0 6 15.5a4 4 0 0 0 7 1 4 4 0 0 0 7-1 4 4 0 0 0 .8-7.7A4.5 4.5 0 0 0 14.5 2 4.5 4.5 0 0 0 12 3.3 4.5 4.5 0 0 0 9.5 2z" />
        </svg>
        <span class="a-pf-v">{verb()}</span>
        <Show when={summary()}>
          <span class="a-pf-o" title={summary()}>
            {summary()}
          </span>
        </Show>
        <span class="a-pf-end">
          <svg class="a-pf-sc" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9 6l6 6-6 6" />
          </svg>
        </span>
      </button>
      <Show when={open()}>
        <div class="a-pf-detail a-pf-think-body" data-alpha-process-detail="reasoning">
          <div class="a-pf-detail-txt">
            {body().text}
            <Show when={body().truncated}>
              <span class="a-tl-truncated-inline">{t("alpha.timeline.truncated")}</span>
            </Show>
          </div>
        </div>
      </Show>
    </>
  )
}

/** 一次工具调用在步骤行 / 子行上的「对象」与行尾(复用 tool-card-model 的头部投影;metadata-only 零对象)。 */
function toolStepFacts(part: Extract<ProcessStep, { kind: "tools" }>["parts"][number]) {
  const head = toolCardHeadOf(part)
  const object = head.metadataOnly ? undefined : head.target
  const detail = head.metadataOnly ? undefined : head.detail
  const objectHidden = !head.metadataOnly && (head.targetHidden || head.detailHidden)
  return { head, object, detail, objectHidden, stat: head.stat, end: toolStepEndOf(head) }
}

/** 行尾的改动增删数(design §6:它是内容不是状态);合并行取各项之和,全零即缺席。 */
function stepStatOf(parts: Extract<ProcessStep, { kind: "tools" }>["parts"]) {
  let additions = 0
  let deletions = 0
  let present = false
  for (const part of parts) {
    const stat = toolCardHeadOf(part).stat
    if (!stat) continue
    present = true
    additions += stat.additions
    deletions += stat.deletions
  }
  return present && additions + deletions > 0 ? { additions, deletions } : undefined
}

function StepStat(props: { stat: { additions: number; deletions: number } }) {
  return (
    <span class="a-pf-stat">
      <Show when={props.stat.additions > 0}>
        <span class="a-pf-add">+{props.stat.additions}</span>
      </Show>
      <Show when={props.stat.deletions > 0}>
        <span class="a-pf-del">−{props.stat.deletions}</span>
      </Show>
    </span>
  )
}

function ProcessToolStep(props: { step: Extract<ProcessStep, { kind: "tools" }> }) {
  const [open, setOpen] = processOpenSignal(props.step.key)
  const first = () => toolStepFacts(props.step.parts[0]!)
  const count = () => props.step.parts.length
  const failed = createMemo(() => props.step.parts.filter((part) => part.state.status === "error").length)
  // 行尾:一步(或合并组里最长的一步)超过 10 秒写时长;失败写人话原因;运行中 / 待运行写状态。
  const longestMs = createMemo(() =>
    props.step.parts.reduce((max, part) => Math.max(max, toolStepDurationMs(part) ?? 0), 0),
  )
  const endLabel = () => {
    if (count() === 1) {
      const end = first().end
      if (end) return end
      return longestMs() >= PROCESS_DURATION_SHOW_MS
        ? { label: formatProcessDuration(longestMs()), tone: "muted" as const }
        : undefined
    }
    if (failed() > 0)
      return {
        label:
          failed() === count() ? t("alpha.timeline.pfFailed") : t("alpha.timeline.pfFailedSome", { count: failed() }),
        tone: "error" as const,
      }
    return longestMs() >= PROCESS_DURATION_SHOW_MS
      ? { label: formatProcessDuration(longestMs()), tone: "muted" as const }
      : undefined
  }
  // 色调:失败 = 琥珀(design 帧 ②「失败用琥珀色写成人话,不写出错」;红色留给回合外的错误卡),运行中 = 强调色。
  const tone = () => {
    const end = endLabel()
    if (!end) return undefined
    if (end.tone === "error") return "warn"
    if (end.tone === "running") return "run"
    return undefined
  }
  return (
    <>
      <button
        type="button"
        class="a-pf-step"
        data-alpha-process-step="tools"
        data-kind={props.step.group.kind}
        data-category={props.step.group.category}
        data-tool={cappedItem(props.step.parts[0]!.tool)}
        data-count={count()}
        data-status={first().head.status}
        data-tone={tone()}
        data-open={open() ? "true" : undefined}
        aria-expanded={open()}
        onClick={() => setOpen((value) => !value)}
      >
        <span class="a-pf-i" data-kind={props.step.group.kind} aria-hidden="true">
          {toolIcon(props.step.group.kind)}
        </span>
        <span class="a-pf-v">{processActionText(props.step.group, count())}</span>
        <Show when={first().object}>
          <span class="a-pf-o a-pf-mono">{first().object}</span>
        </Show>
        <Show when={first().detail}>
          <span class="a-pf-o2 a-pf-mono">{first().detail}</span>
        </Show>
        {/* AC5:目标存在但 redactor 失败 → 确定的「详情已隐藏」,无 raw 旁路。 */}
        <Show when={first().objectHidden}>
          <span class="a-pf-o" data-alpha-details-hidden>
            {t("alpha.timeline.detailsHidden")}
          </span>
        </Show>
        <span class="a-pf-end">
          <Show when={stepStatOf(props.step.parts)}>{(stat) => <StepStat stat={stat()} />}</Show>
          <Show when={endLabel()}>
            {(end) => (
              <span class="a-pf-end-label" data-tone={end().tone}>
                <Show when={end().tone === "running"}>
                  <span class="a-tl-spinner" aria-hidden="true" />
                </Show>
                {end().label}
              </span>
            )}
          </Show>
          <svg class="a-pf-sc" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9 6l6 6-6 6" />
          </svg>
        </span>
      </button>
      <Show when={open()}>
        <Show when={count() > 1} fallback={<ToolStepDetail part={props.step.parts[0]!} />}>
          <div class="a-pf-sub-list" data-alpha-process-sublist>
            <For each={props.step.parts}>{(part) => <ProcessToolItem part={part} stepKey={props.step.key} />}</For>
          </div>
        </Show>
      </Show>
    </>
  )
}

/** 合并行展开后的每一项:对象 + 行尾;再点一项看该类卡片正文。 */
function ProcessToolItem(props: { part: Extract<ProcessStep, { kind: "tools" }>["parts"][number]; stepKey: string }) {
  const [open, setOpen] = processOpenSignal(`${props.stepKey}/${props.part.id}`)
  const facts = () => toolStepFacts(props.part)
  const durationMs = () => toolStepDurationMs(props.part) ?? 0
  const endLabel = () => {
    const end = facts().end
    if (end) return end
    return durationMs() >= PROCESS_DURATION_SHOW_MS
      ? { label: formatProcessDuration(durationMs()), tone: "muted" as const }
      : undefined
  }
  return (
    <>
      <button
        type="button"
        class="a-pf-step a-pf-item"
        data-alpha-process-item
        data-status={facts().head.status}
        data-tone={endLabel()?.tone === "error" ? "warn" : undefined}
        data-open={open() ? "true" : undefined}
        aria-expanded={open()}
        onClick={() => setOpen((value) => !value)}
      >
        <Show when={facts().object} fallback={<span class="a-pf-o">{facts().head.toolName}</span>}>
          <span class="a-pf-o a-pf-mono">{facts().object}</span>
        </Show>
        <Show when={facts().detail}>
          <span class="a-pf-o2 a-pf-mono">{facts().detail}</span>
        </Show>
        <Show when={facts().objectHidden}>
          <span class="a-pf-o" data-alpha-details-hidden>
            {t("alpha.timeline.detailsHidden")}
          </span>
        </Show>
        <span class="a-pf-end">
          <Show when={facts().stat && facts().stat!.additions + facts().stat!.deletions > 0}>
            <StepStat stat={facts().stat!} />
          </Show>
          <Show when={endLabel()}>
            {(end) => (
              <span class="a-pf-end-label" data-tone={end().tone}>
                {end().label}
              </span>
            )}
          </Show>
          <svg class="a-pf-sc" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9 6l6 6-6 6" />
          </svg>
        </span>
      </button>
      <Show when={open()}>
        <ToolStepDetail part={props.part} />
      </Show>
    </>
  )
}
