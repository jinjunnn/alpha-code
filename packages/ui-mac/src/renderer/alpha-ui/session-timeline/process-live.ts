// `#1474`(REQ-229 AC4)— 进行中的工作过程:实时标题、最近两步窗口、超时提示与终端尾巴(纯函数)。
//
// 形态权威 = docs/design/2026-10-10-timeline-process-fold/design.md §3 与 frame.html §③ / §⑦:
//   · 实时标题 = 当前动作(并行时「正在搜索 N 个问题」)+ 第 N 步 + 整轮计时;
//   · 实时区 = 最近 2 个已结束的行 + 所有正在跑的(各自一行、不合并),更早的收成「前面还有 N 步」;
//   · 一步超过 10 秒,行尾写「已等 m:ss」;
//   · 思考进行中不露原文,只在开头给了明确小标题(且标题那一行已经写完)时附在「正在思考」后;
//   · 正在跑的命令在其下方露最后 3 行输出,结束即收起。
// 视图(process-fold.tsx)只负责把这里的结论变成 DOM;每条结论在 process-live.test.ts 里单测。
import type { ToolPart } from "@opencode-ai/sdk/v2/client"
import { toolCardBodyOf, toolCardDispatchOf, toolTitleKeyOf } from "./cards/tool-card-model"
import {
  PROCESS_STEP_DURATION_MIN_MS,
  reasoningSummary,
  toolStepMergeKeyOf,
  type TimelineProcessStep,
} from "./timeline-model"

/** 实时区保留几个最近已结束的行(design §8:「改一个数」)。 */
export const PROCESS_LIVE_RECENT = 2
/** 一步等了多久才写「已等」(与结束态写用时的门槛同一个数)。 */
export const PROCESS_LIVE_WAITED_MIN_MS = PROCESS_STEP_DURATION_MIN_MS
/** 正在跑的命令露出几行输出。 */
export const PROCESS_LIVE_TAIL_LINES = 3

/** 工具调用还没结束(等待运行 / 运行中)。 */
export function toolPartLive(part: ToolPart): boolean {
  return part.state.status === "running" || part.state.status === "pending"
}

/** 一步还在跑:工具有未结束的调用,或思考仍在流式。过渡话永远是已结束的行。 */
export function processStepLive(step: TimelineProcessStep): boolean {
  if (step.kind === "say") return false
  if (step.kind === "reasoning") return step.streaming
  return step.parts.some(toolPartLive)
}

/** 实时区:最近 PROCESS_LIVE_RECENT 个已结束的行 + 全部正在跑的(保序);其余计入 hidden。 */
export function liveWindowOf(steps: readonly TimelineProcessStep[]): {
  hidden: number
  visible: TimelineProcessStep[]
} {
  const keep = new Set<number>()
  let recent = 0
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (processStepLive(steps[index]!)) keep.add(index)
    else if (recent < PROCESS_LIVE_RECENT) {
      keep.add(index)
      recent += 1
    }
  }
  return { hidden: steps.length - keep.size, visible: steps.filter((_, index) => keep.has(index)) }
}

/**
 * 「第 N 步」:已结束的思考 / 工具步骤数,加上正在进行的这一步(并行跑的多个调用算同一步)。
 * 过渡话不是一步。一步都还没有 → 0(标题不写步数)。
 */
export function liveStepNumberOf(steps: readonly TimelineProcessStep[]): number {
  let done = 0
  let live = false
  for (const step of steps) {
    if (step.kind === "say") continue
    if (processStepLive(step)) live = true
    else done += 1
  }
  return done + (live ? 1 : 0)
}

/** 实时标题的当前动作。 */
export type ProcessLiveAction =
  | { type: "thinking"; title?: string }
  | {
      type: "tool"
      /** 用哪一组文案:搜索 / 运行命令 / 打开网页 / 我方工具通用(动词)/ 非我方工具(名称)。 */
      family: "search" | "bash" | "fetch" | "verb" | "named"
      /** family=verb 时的动词 i18n key。 */
      verbKey?: string
      /** family=named 时的被动净化名称(与步骤行对象同源,不读输入输出)。 */
      name?: string
      /** 同一类正在并行跑的调用数。 */
      count: number
    }

/**
 * 思考的明确小标题 —— 只看已经写完的第一行(流式期标题本身还在长,不能半截露出来);
 * 判定规则与结束态相同(reasoningSummary:只认 Markdown/HTML 标题与整行加粗,不猜首句)。
 */
export function liveReasoningTitle(text: string): string | undefined {
  const head = text.trimStart()
  const newline = head.indexOf("\n")
  if (newline <= 0) return undefined
  return reasoningSummary(head.slice(0, newline + 1))
}

function familyOf(part: ToolPart): Omit<Extract<ProcessLiveAction, { type: "tool" }>, "type" | "count"> {
  const dispatch = toolCardDispatchOf(part)
  if (dispatch.metadataOnly) return { family: "named", name: dispatch.name }
  const verbKey = toolTitleKeyOf(dispatch)
  if (dispatch.kind === "websearch" || verbKey === "alpha.timeline.cloud.webSearch") return { family: "search" }
  if (dispatch.kind === "bash") return { family: "bash" }
  if (dispatch.kind === "webfetch") return { family: "fetch" }
  if (verbKey) return { family: "verb", verbKey }
  return { family: "named", name: dispatch.name }
}

/**
 * 当前动作:有正在跑的工具调用 ⇒ 以最后一个为准,计同类(同合并键)并行的个数;
 * 否则 ⇒ 正在思考(最后一步是流式思考时带它的明确小标题)。
 */
export function liveActionOf(steps: readonly TimelineProcessStep[]): ProcessLiveAction {
  const running: ToolPart[] = []
  for (const step of steps)
    if (step.kind === "tool") for (const part of step.parts) if (toolPartLive(part)) running.push(part)
  const last = running.at(-1)
  if (last) {
    const key = toolStepMergeKeyOf(last)
    const count = running.filter((part) => toolStepMergeKeyOf(part) === key).length
    return { type: "tool", count, ...familyOf(last) }
  }
  const tail = steps.at(-1)
  if (tail?.kind === "reasoning" && tail.streaming) {
    const title = liveReasoningTitle(tail.parts.at(-1)?.text ?? "")
    return title ? { type: "thinking", title } : { type: "thinking" }
  }
  return { type: "thinking" }
}

/** 这一步从什么时候开始等(只对还在跑的工具 / 流式思考有意义);时间非法 → 缺席。 */
export function liveSinceOf(step: TimelineProcessStep, part?: ToolPart): number | undefined {
  if (step.kind === "say") return undefined
  if (step.kind === "reasoning") {
    if (!step.streaming) return undefined
    const start = step.parts.at(-1)?.time?.start
    return typeof start === "number" && Number.isFinite(start) ? start : undefined
  }
  const target = part ?? step.parts[0]
  if (!target || target.state.status !== "running") return undefined
  const start = (target.state.time as { start?: unknown } | undefined)?.start
  return typeof start === "number" && Number.isFinite(start) ? start : undefined
}

/** 「已等 m:ss」该不该出现:等了超过门槛才出;起点缺席 / 时钟倒退 → 不出。 */
export function liveWaitedMs(since: number | undefined, now: number): number | undefined {
  if (since === undefined) return undefined
  const waited = now - since
  return waited > PROCESS_LIVE_WAITED_MIN_MS ? waited : undefined
}

/**
 * 正在跑的命令的最后 N 行输出。只取 toolCardBodyOf 已经脱敏、有界、且过了来源闸的终端正文
 * (metadata-only 降级 / 非 bash / 已结束 ⇒ 缺席),不自己读 metadata。
 */
export function liveTerminalTailOf(part: ToolPart): string[] | undefined {
  if (part.state.status !== "running") return undefined
  const body = toolCardBodyOf(part)
  if (body.type !== "term" || !body.streaming) return undefined
  const lines = body.output
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => line.trim().length > 0)
  if (lines.length === 0) return undefined
  return lines.slice(-PROCESS_LIVE_TAIL_LINES)
}
