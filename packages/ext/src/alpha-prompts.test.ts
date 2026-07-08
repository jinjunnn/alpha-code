// REQ-062 T3/T6 — alpha 内容层 set-if-absent 接管(优先级:用户治理 > alpha 出厂 > 上游内置)。

import { describe, expect, test } from "bun:test"
import { ALPHA_EXPLORE_PROMPT, ALPHA_GENERAL_PROMPT, ALPHA_INIT_TEMPLATE, ALPHA_REVIEW_TEMPLATE, applyPromptTakeover } from "./alpha-prompts"

describe("alpha 模板内容纪律", () => {
  test("四份 alpha 文本零 opencode 痕迹(内容 100% alpha 承载)", () => {
    for (const t of [ALPHA_INIT_TEMPLATE, ALPHA_REVIEW_TEMPLATE, ALPHA_GENERAL_PROMPT, ALPHA_EXPLORE_PROMPT]) {
      expect(/opencode/i.test(t)).toBe(false)
    }
  })
  test("init/review 模板保留 $ARGUMENTS 占位(引擎 hints 解析依赖)且不含 ${path}(config command 无此替换)", () => {
    for (const t of [ALPHA_INIT_TEMPLATE, ALPHA_REVIEW_TEMPLATE]) {
      expect(t.includes("$ARGUMENTS")).toBe(true)
      expect(t.includes("${path}")).toBe(false)
    }
  })
})

describe("applyPromptTakeover — set-if-absent", () => {
  test("空 config → 接管 init + review + general/explore prompt(用户拍板:两个命令都换)", () => {
    const cfg: Record<string, unknown> = {}
    const r = applyPromptTakeover(cfg)
    expect(r.applied.sort()).toEqual(["agent.explore.prompt", "agent.general.prompt", "command.init", "command.review"])
    expect((cfg.command as any).init.template).toBe(ALPHA_INIT_TEMPLATE)
    expect((cfg.command as any).review.template).toBe(ALPHA_REVIEW_TEMPLATE)
    expect((cfg.command as any).review.subtask).toBe(true) // 与上游内置行为对齐(子任务执行)
    expect((cfg.agent as any).general.prompt).toBe(ALPHA_GENERAL_PROMPT)
    expect((cfg.agent as any).explore.prompt).toBe(ALPHA_EXPLORE_PROMPT)
  })
  test("用户已配同名 command.review → 让位(用户治理 > alpha 出厂)", () => {
    const cfg: Record<string, unknown> = { command: { review: { template: "user's own review" } } }
    const r = applyPromptTakeover(cfg)
    expect(r.applied).not.toContain("command.review")
    expect((cfg.command as any).review.template).toBe("user's own review")
  })
  test("用户已配同名 command.init(治理 override 经 alpha.jsonc 已在 cfg)→ 一概让位", () => {
    const cfg: Record<string, unknown> = { command: { init: { template: "user's own init" } } }
    const r = applyPromptTakeover(cfg)
    expect(r.applied).not.toContain("command.init")
    expect((cfg.command as any).init.template).toBe("user's own init")
  })
  test("用户已覆盖 agent prompt → 让位;只覆盖其它字段(model 等)→ 补 prompt 且保留用户字段", () => {
    const cfg: Record<string, unknown> = {
      agent: { general: { prompt: "user general" }, explore: { model: "anthropic/claude" } },
    }
    const r = applyPromptTakeover(cfg)
    expect((cfg.agent as any).general.prompt).toBe("user general")
    expect((cfg.agent as any).explore.prompt).toBe(ALPHA_EXPLORE_PROMPT)
    expect((cfg.agent as any).explore.model).toBe("anthropic/claude")
    expect(r.applied).toEqual(["command.init", "command.review", "agent.explore.prompt"]) // 无用户配置的照常接管
  })
  test("幂等:第二次调用 no-op", () => {
    const cfg: Record<string, unknown> = {}
    applyPromptTakeover(cfg)
    const r2 = applyPromptTakeover(cfg)
    expect(r2.applied).toEqual([])
  })
})
