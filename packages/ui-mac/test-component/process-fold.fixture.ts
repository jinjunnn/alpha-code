// `#1473` 夹具:一次真实形态的 18 步研究回合(design 2026-10-10-timeline-process-fold §1 的样本)。
//
// 形态对照本机会话库里那次回合:一轮用户提问 → 6 条助手消息(引擎每一次 LLM 调用一条),
// 每条带 step-start / step-finish part;思考 6 段,云端网页搜索 16 次(第一方 Alpha Cloud identity
// + 持久化 alpha-cloud authority),打开网页 2 次都失败(本机 webfetch,Transport error),
// 最后一条消息写回答。工具之间没有过渡话。
//
// 期望(design ① ②):回答之前恰好一行工作过程;摘要「搜索 16 次 · 2 步没成功 · 3 分 27 秒」;
// 展开后 12 行 = 思考 6 + 搜索 4/2/4/4/2 + 打开网页 2(合成一行)。
import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk/v2/client"

export const RESEARCH_SESSION = "ses_research"
export const RESEARCH_USER = "msg_research_u"
const T0 = 1_760_000_000_000
/** 用户发出 → 最后一条助手消息完成 = 3 分 27 秒。 */
export const RESEARCH_TURN_MS = 207_000

const cloudSearch = {
  identity: { source: "mcp", origin: "cloud", name: "cloud_web_search" },
  technicalId: "cloud_cloud_web_search",
  authority: { kind: "alpha-cloud", bindingId: "mcp:cloud", evidenceDigest: `sha256:${"d".repeat(64)}` },
}
const webfetch = {
  identity: { source: "builtin", origin: "", name: "webfetch" },
  technicalId: "webfetch",
  authority: { kind: "not-asserted" },
}

type Script = { reason: string; ms: number } | { search: string; ms?: number } | { fetch: string } | { answer: string }

/** 6 条助手消息的脚本(顺序即时间线顺序)。 */
const SCRIPT: Script[][] = [
  [
    { reason: "**Planning the lookup**\n\nThe user wants nested criteria and the full request body.", ms: 2000 },
    { search: "docs.typesafe.ai System One API request fields model state questions" },
    { search: "typesafe jev nested criteria multi-level hierarchy" },
    { search: "typesafe system_one pydantic nested model BaseModel" },
    { search: 'typesafe jev request body fields "timeout" OR "metadata"' },
  ],
  [
    { reason: "Let me open the API reference directly.", ms: 2000 },
    { fetch: "https://docs.typesafe.ai/api" },
    { fetch: "https://docs.typesafe.ai/primitives/choice" },
    { search: "docs.rs typesafe-systemone Question struct fields" },
    { search: "typesafe-systemone crate Criteria enum" },
  ],
  [
    { reason: "The fetches failed; search the concept pages instead.", ms: 3000 },
    { search: "docs.typesafe.ai concepts how to build with system one" },
    { search: "typesafe choice criteria labels description" },
    { search: "typesafe score criteria ordered array" },
    { search: "typesafe noul criteria optional true false" },
  ],
  [
    { reason: "Need the how-to page for parallel evaluation semantics.", ms: 5000 },
    { search: '"how-to-build-with-system-one" typesafe question', ms: 135_000 },
    { search: "typesafe questions evaluated in parallel same state", ms: 130_000 },
    { search: "typesafe jev conditional criteria", ms: 128_000 },
    { search: "typesafe jev request schema top level keys", ms: 131_000 },
  ],
  [
    { reason: "Confirm the closed field set.", ms: 4000 },
    { search: "docs.typesafe.ai concepts how to build with system one request body" },
    { search: "typesafe system one model field values" },
  ],
  [
    { reason: "I have enough to answer.", ms: 6000 },
    {
      answer:
        "结论先说:**criteria 本身不能嵌套,Jev 没有多级 / 条件式的 criteria;「多级」要靠把任务拆成多个并列问题、再在代码里组合。**完整的请求体只有三层结构,字段是封闭的一小组。",
    },
  ],
]

const searchOutput = JSON.stringify({
  results: [
    { title: "API reference - TypeSafe AI", url: "https://docs.typesafe.ai/api" },
    { title: "Choice - TypeSafe AI", url: "https://docs.typesafe.ai/primitives/choice" },
  ],
})

export function researchTurn(): {
  messages: (UserMessage | AssistantMessage)[]
  parts: Record<string, Part[]>
} {
  const user: UserMessage = {
    id: RESEARCH_USER,
    sessionID: RESEARCH_SESSION,
    role: "user",
    time: { created: T0 },
    agent: "build",
    model: { providerID: "deepseek", modelID: "deepseek-flash" },
  }
  const messages: (UserMessage | AssistantMessage)[] = [user]
  const parts: Record<string, Part[]> = {
    [RESEARCH_USER]: [
      {
        id: "prt_research_u",
        sessionID: RESEARCH_SESSION,
        messageID: RESEARCH_USER,
        type: "text",
        text: "是否支持多级的 criteria,还有请求体都支持哪些字段,我需要完整的。",
      },
    ],
  }
  let clock = T0 + 500
  SCRIPT.forEach((steps, index) => {
    const id = `msg_research_a${index + 1}`
    const created = clock
    const list: Part[] = [
      { id: `prt_${id}_start`, sessionID: RESEARCH_SESSION, messageID: id, type: "step-start" } as Part,
    ]
    steps.forEach((step, at) => {
      const partID = `prt_${id}_${at}`
      if ("reason" in step) {
        list.push({
          id: partID,
          sessionID: RESEARCH_SESSION,
          messageID: id,
          type: "reasoning",
          text: step.reason,
          time: { start: clock, end: clock + step.ms },
        })
        clock += step.ms
        return
      }
      if ("answer" in step) {
        list.push({ id: partID, sessionID: RESEARCH_SESSION, messageID: id, type: "text", text: step.answer })
        return
      }
      if ("search" in step) {
        const ms = step.ms ?? 6000
        list.push({
          id: partID,
          sessionID: RESEARCH_SESSION,
          messageID: id,
          type: "tool",
          callID: `call_${partID}`,
          tool: "cloud_cloud_web_search",
          display: cloudSearch,
          state: {
            status: "completed",
            input: { query: step.search },
            output: searchOutput,
            title: step.search,
            metadata: {},
            time: { start: clock, end: clock + ms },
          },
        } as Part)
        clock += 1000
        return
      }
      list.push({
        id: partID,
        sessionID: RESEARCH_SESSION,
        messageID: id,
        type: "tool",
        callID: `call_${partID}`,
        tool: "webfetch",
        display: webfetch,
        state: {
          status: "error",
          input: { url: step.fetch, format: "markdown" },
          error: `Transport error (GET ${step.fetch})`,
          time: { start: clock, end: clock + 800 },
        },
      } as Part)
      clock += 800
    })
    list.push({ id: `prt_${id}_finish`, sessionID: RESEARCH_SESSION, messageID: id, type: "step-finish" } as Part)
    const last = index === SCRIPT.length - 1
    // 第 4 条里那组慢搜索各等了两分多钟(并行);消息完成时刻跟着它走。
    clock = last ? T0 + RESEARCH_TURN_MS : clock + (index === 3 ? 135_000 : 4000)
    messages.push({
      id,
      sessionID: RESEARCH_SESSION,
      role: "assistant",
      time: { created, completed: clock },
      parentID: RESEARCH_USER,
      modelID: "deepseek-flash",
      providerID: "deepseek",
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 18_000, output: 6_000, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: last ? "stop" : "tool-calls",
    } as AssistantMessage)
    parts[id] = list
  })
  return { messages, parts }
}
