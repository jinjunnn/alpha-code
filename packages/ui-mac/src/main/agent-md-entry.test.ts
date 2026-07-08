import { describe, expect, test } from "bun:test"
import { agentMdToEntry } from "./agent-md-entry"

const CODE_REVIEWER = `---
description: 只读代码审查 Agent(REQ-023 官方示例)
mode: subagent
permission:
  edit: deny
  bash: ask
  webfetch: allow
---

你是一名严格的代码审查者。只读审查,输出问题清单。
`

describe("agentMdToEntry — md → config agent 条目(REQ-059 T3b)", () => {
  test("打包资产形状(code-reviewer):平铺键 + permission 一层", () => {
    const r = agentMdToEntry(CODE_REVIEWER)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.entry.mode).toBe("subagent")
      expect(r.entry.permission).toEqual({ edit: "deny", bash: "ask", webfetch: "allow" })
      expect(String(r.entry.prompt)).toContain("代码审查者")
      expect("name" in r.entry).toBe(false)
    }
  })

  test("permission 两层(pattern map,agent-creator 模板形状)", () => {
    const md = `---
description: d
mode: subagent
permission:
  read:
    "*": allow
    "*.env*": deny
  edit: deny
---

body
`
    const r = agentMdToEntry(md)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.entry.permission).toEqual({ read: { "*": "allow", "*.env*": "deny" }, edit: "deny" })
  })

  test("数值/布尔转型(temperature/steps/hidden)", () => {
    const md = `---
description: d
temperature: 0.2
steps: 30
hidden: true
---

body
`
    const r = agentMdToEntry(md)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.entry.temperature).toBe(0.2)
      expect(r.entry.steps).toBe(30)
      expect(r.entry.hidden).toBe(true)
    }
  })

  test("fail-closed:未知顶层键 / 三层嵌套 / 非法 action / 空 body 全拒", () => {
    expect(agentMdToEntry(`---\ndescription: d\nevil_key: x\n---\n\nbody\n`).ok).toBe(false)
    expect(agentMdToEntry(`---\ndescription: d\npermission:\n  read:\n    deep:\n      more: allow\n---\n\nbody\n`).ok).toBe(false)
    expect(agentMdToEntry(`---\ndescription: d\npermission:\n  edit: maybe\n---\n\nbody\n`).ok).toBe(false)
    expect(agentMdToEntry(`---\ndescription: d\n---\n\n`).ok).toBe(false)
    expect(agentMdToEntry(`no frontmatter`).ok).toBe(false)
  })

  test("description 必填;注释与空行被忽略;引号剥除", () => {
    expect(agentMdToEntry(`---\nmode: subagent\n---\n\nbody\n`).ok).toBe(false)
    const r = agentMdToEntry(`---\n# comment\ndescription: "quoted"\n\nmode: subagent\n---\n\nbody\n`)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.entry.description).toBe("quoted")
  })
})
