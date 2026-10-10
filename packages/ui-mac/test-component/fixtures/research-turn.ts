// REQ-229 / #1473 —— 真实形态的 18 步研究回合夹具(design 2026-10-10-timeline-process-fold §1 的样本,
// 帧 ①② 就是用它画的):思考 6 段,穿插联网搜索 16 次与打开网页 2 次(都失败),最后一段回答。
// 形状对齐引擎真实写入:builtin identity 快照(#878)、ToolStateCompleted / ToolStateError、
// reasoning / text part 的 time。模型测试(timeline-model.test.ts)与真挂载测试
// (session-timeline.cases.ts)共用这一份,两边断言的是同一个回合。
import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk/v2/client"

const SESSION = "ses_research"
export const RESEARCH_USER_ID = "msg_ru"
export const RESEARCH_ASSISTANT_ID = "msg_ra"
/** 用户消息创建时刻;整轮 3 分 27 秒(帧 ① 摘要「3 分 27 秒」)。 */
export const RESEARCH_CREATED_AT = 1_700_000_000_000
export const RESEARCH_COMPLETED_AT = RESEARCH_CREATED_AT + 207_000

function builtin(name: string) {
  return { identity: { source: "builtin", origin: "", name }, technicalId: name, authority: { kind: "not-asserted" } }
}

const searchOutput = (query: string) =>
  JSON.stringify({
    results: [
      { title: `${query} — API reference`, url: "https://docs.typesafe.ai/api" },
      { title: "Choice - TypeSafe AI", url: "https://docs.typesafe.ai/primitives/choice" },
      { title: "typesafe_systemone - Rust", url: "https://docs.rs/typesafe-systemone" },
    ],
  })

let clock = RESEARCH_CREATED_AT + 1_000
let seq = 0
const next = () => {
  seq += 1
  return seq
}

function think(text: string, seconds: number): Part {
  const start = clock
  clock += seconds * 1000
  return {
    id: `prt_rr${next()}`,
    sessionID: SESSION,
    messageID: RESEARCH_ASSISTANT_ID,
    type: "reasoning",
    text,
    time: { start, end: clock },
  }
}

function search(query: string, seconds = 6): Part {
  const start = clock
  clock += seconds * 1000
  return {
    id: `prt_rs${next()}`,
    sessionID: SESSION,
    messageID: RESEARCH_ASSISTANT_ID,
    type: "tool",
    callID: `call_rs${seq}`,
    tool: "websearch",
    display: builtin("websearch"),
    state: {
      status: "completed",
      input: { query },
      output: searchOutput(query),
      title: "websearch",
      metadata: {},
      time: { start, end: clock },
    },
  } as Part
}

function fetchFailed(url: string): Part {
  const start = clock
  clock += 3_000
  return {
    id: `prt_rf${next()}`,
    sessionID: SESSION,
    messageID: RESEARCH_ASSISTANT_ID,
    type: "tool",
    callID: `call_rf${seq}`,
    tool: "webfetch",
    display: builtin("webfetch"),
    state: { status: "error", input: { url }, error: `Transport error (GET ${url})`, time: { start, end: clock } },
  } as Part
}

/** 18 个工具步骤 + 6 段思考 + 1 段回答,按发生顺序(帧 ② 第二层的 12 行就是这串合并后的样子)。 */
export const RESEARCH_PARTS: Part[] = [
  think("Need to find the request schema first.", 2),
  search("docs.typesafe.ai System One API request fields model state questions"),
  search("typesafe jev nested criteria multi-level hierarchy"),
  search("typesafe system_one pydantic nested model BaseModel"),
  search('typesafe jev request body fields "timeout" OR "metadata"'),
  think("The docs site should have the full schema; open it.", 2),
  fetchFailed("https://docs.typesafe.ai/api"),
  fetchFailed("https://docs.typesafe.ai/primitives/choice"),
  search("docs.rs typesafe-systemone Question struct fields"),
  search("typesafe systemone rust crate criteria"),
  think("Rust docs mirror the schema; cross-check concepts page.", 3),
  search("docs.typesafe.ai concepts how to build with system one"),
  search("typesafe system one state questions parallel evaluation"),
  search("typesafe jev score primitive ordered criteria"),
  search("typesafe jev noul primitive"),
  think("Verify whether questions depend on each other.", 5),
  // 帧 ②:这一组里有一步等了 2 分 15 秒 —— 行尾因此出现时长。
  search('"how-to-build-with-system-one" typesafe question', 135),
  search("typesafe system one multiple questions same state"),
  search("typesafe criteria 1-255 labels limit"),
  search("typesafe score 2-10 levels"),
  think("Enough evidence; summarize.", 4),
  search("docs.typesafe.ai concepts how to build with system one request example"),
  search("typesafe jev request body top level keys"),
  think("Write the answer.", 6),
  {
    id: "prt_ranswer",
    sessionID: SESSION,
    messageID: RESEARCH_ASSISTANT_ID,
    type: "text",
    text: "结论先说:**criteria 本身不能嵌套**,Jev 没有多级 / 条件式的 criteria;「多级」要靠把任务拆成多个并列问题、再在代码里组合。",
    time: { start: clock, end: RESEARCH_COMPLETED_AT },
  },
]

export const RESEARCH_USER: UserMessage = {
  id: RESEARCH_USER_ID,
  sessionID: SESSION,
  role: "user",
  time: { created: RESEARCH_CREATED_AT },
  agent: "build",
  model: { providerID: "deepseek", modelID: "deepseek-v4-flash" },
}

export const RESEARCH_ASSISTANT: AssistantMessage = {
  id: RESEARCH_ASSISTANT_ID,
  sessionID: SESSION,
  role: "assistant",
  parentID: RESEARCH_USER_ID,
  time: { created: RESEARCH_CREATED_AT + 400, completed: RESEARCH_COMPLETED_AT },
  modelID: "deepseek-v4-flash",
  providerID: "deepseek",
  mode: "build",
  agent: "build",
  path: { cwd: "/tmp", root: "/tmp" },
  cost: 0,
  tokens: { input: 18_000, output: 6_000, reasoning: 0, cache: { read: 0, write: 0 } },
}

export const RESEARCH_USER_PARTS: Part[] = [
  {
    id: "prt_ru1",
    sessionID: SESSION,
    messageID: RESEARCH_USER_ID,
    type: "text",
    text: "是否支持多级的 criteria,还有请求体都支持哪些字段,我需要完整的。",
  },
]

/** 帧 ② 第二层的 12 行:每项 = [步骤种类, 合并进该行的 part 数]。 */
export const RESEARCH_EXPECTED_STEPS: Array<["reasoning" | "tools", number]> = [
  ["reasoning", 1],
  ["tools", 4],
  ["reasoning", 1],
  ["tools", 2],
  ["tools", 2],
  ["reasoning", 1],
  ["tools", 4],
  ["reasoning", 1],
  ["tools", 4],
  ["reasoning", 1],
  ["tools", 2],
  ["reasoning", 1],
]

export function researchProjectionInput() {
  return {
    messages: [RESEARCH_USER, RESEARCH_ASSISTANT],
    partsOf: (id: string) =>
      id === RESEARCH_USER_ID ? RESEARCH_USER_PARTS : id === RESEARCH_ASSISTANT_ID ? RESEARCH_PARTS : [],
    status: "idle",
  }
}
