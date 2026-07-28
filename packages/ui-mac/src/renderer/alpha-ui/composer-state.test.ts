// REQ-055 — composer-state 纯核单测:提交参数构造 / 斜杠路由 / agent 过滤。
import { describe, expect, test } from "bun:test"
import {
  buildPromptRequest,
  clearSuspendedModel,
  composerModel,
  composerModelSuspended,
  filterAgents,
  routeSlash,
  setComposerModel,
  suspendComposerModel,
  READONLY_AGENT,
  type ComposerModel,
} from "./composer-state"

const sonnet: ComposerModel = {
  providerID: "alpha",
  id: "claude-sonnet-4.6",
  name: "Claude Sonnet 4.6",
  variants: ["低", "中", "高"],
}
const flash: ComposerModel = { providerID: "alpha", id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", variants: [] }

describe("buildPromptRequest", () => {
  test("未显式选择 → 只有 parts(引擎默认,最小干预)", () => {
    const r = buildPromptRequest({ text: "hi", model: null, effort: null, perm: "ask", agent: null })
    expect(r).toEqual({ parts: [{ type: "text", text: "hi" }] })
  })
  test("模型+有效档 → 统一为一个 Model.Ref", () => {
    const r = buildPromptRequest({ text: "hi", model: sonnet, effort: "高", perm: "ask", agent: null })
    expect(r.model).toEqual({ providerID: "alpha", id: "claude-sonnet-4.6", variant: "高" })
    expect(r).not.toHaveProperty("variant")
  })
  test("无档模型 → 绝不携带 variant(C28:不发引擎不认识的档)", () => {
    const r = buildPromptRequest({ text: "hi", model: flash, effort: "高", perm: "ask", agent: null })
    expect(r.model).toEqual({ providerID: "alpha", id: "deepseek-v4-flash" })
  })
  test("档位不属于该模型 → 不携带", () => {
    const r = buildPromptRequest({ text: "hi", model: sonnet, effort: "极限", perm: "ask", agent: null })
    expect(r.model).toEqual({ providerID: "alpha", id: "claude-sonnet-4.6" })
  })
  test("只读权限 → agent 强制 alpha-readonly,压过手选 agent", () => {
    const r = buildPromptRequest({ text: "hi", model: null, effort: null, perm: "readonly", agent: "plan" })
    expect(r.agent).toBe(READONLY_AGENT)
  })
  test("非只读 + 手选 agent → 透传", () => {
    const r = buildPromptRequest({ text: "hi", model: null, effort: null, perm: "ask", agent: "plan" })
    expect(r.agent).toBe("plan")
  })
  test("extraParts(@ 提及)追加在 text part 之后", () => {
    const extra = [{ type: "file", url: "x" }]
    const r = buildPromptRequest({ text: "hi", extraParts: extra, model: null, effort: null, perm: "ask", agent: null })
    expect(r.parts).toHaveLength(2)
    expect(r.parts[1]).toBe(extra[0])
  })
})

describe("routeSlash", () => {
  test("/review pr 12 → {review, 'pr 12'}", () => {
    expect(routeSlash("/review pr 12")).toEqual({ name: "review", args: "pr 12" })
  })
  test("非斜杠/裸斜杠 → null", () => {
    expect(routeSlash("hello /x")).toBeNull()
    expect(routeSlash("/")).toBeNull()
  })
})

describe("filterAgents — 内部档永不可见(用户报障 2026-07-07)", () => {
  const raw = [
    { name: "build", mode: "primary" },
    { name: "plan", mode: "primary" },
    { name: "general", mode: "subagent" },
    { name: "alpha-automation", mode: "primary" },
    { name: "alpha-automation-standard", mode: "primary" },
    { name: "alpha-readonly", mode: "primary" },
    { name: "compaction", mode: "primary", hidden: true },
    { name: "custom-mine", mode: "all", description: "我的" },
  ]
  test("排除 subagent / hidden / alpha 内部三件;保留用户可见项", () => {
    const names = filterAgents(raw).map((a) => a.name)
    expect(names).toEqual(["build", "plan", "custom-mine"])
  })
})

describe("filterAgents — 治理口径守卫(REQ-066 T3)", () => {
  // 治理 hide(REQ-037)物化为引擎 agent.<n>.hidden=true → 列表带 hidden 字段返回;
  // 治理 disable 则引擎直接删除条目(不出现在 list)。选择器必须尊重 hidden,别只看 mode。
  test("治理隐藏的上游 agent(hidden=true)不出现在选择器", () => {
    const raw = [
      { name: "build", mode: "primary" },
      { name: "plan", mode: "primary", hidden: true }, // 治理 hide 物化态
      { name: "custom-mine", mode: "all" },
    ]
    expect(filterAgents(raw).map((a) => a.name)).toEqual(["build", "custom-mine"])
  })
})

describe("suspend — session 选择不可用时只保留说明，不从本地恢复第二真值", () => {
  test("挂起清 UI 投影并记录原因", () => {
    setComposerModel(sonnet)
    expect(composerModel()).toEqual(sonnet)
    suspendComposerModel("needs-login")
    expect(composerModel()).toBeNull()
    expect(composerModelSuspended()).toEqual({ model: sonnet, reason: "needs-login" })
    clearSuspendedModel()
    setComposerModel(null)
  })
  test("无选择时挂起是 no-op", () => {
    setComposerModel(null)
    suspendComposerModel("needs-login")
    expect(composerModelSuspended()).toBeNull()
  })
})
