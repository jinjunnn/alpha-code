import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import {
  assertWebSearchToolAllowed,
  CLOUD_WEBSEARCH_DENY_ENV,
  cloudWebSearchDenied,
  isWebSearchToolId,
  WebSearchKillSwitchError,
} from "./cloud-websearch-kill"

const ON = { [CLOUD_WEBSEARCH_DENY_ENV]: "1" }
const OFF = {}

const siblingCloudTools = [
  "cloud_dispatch",
  "cloud_status",
  "cloud_await",
  "cloud_artifacts",
  "cloud_schedule_create",
  "cloud_schedule_list",
  "cloud_schedule_delete",
]

describe("cloud web search kill switch", () => {
  test("fail-closed:只有缺省/空串/\"0\" 放行", () => {
    expect(cloudWebSearchDenied(OFF)).toBe(false)
    expect(cloudWebSearchDenied({ [CLOUD_WEBSEARCH_DENY_ENV]: "" })).toBe(false)
    expect(cloudWebSearchDenied({ [CLOUD_WEBSEARCH_DENY_ENV]: "0" })).toBe(false)
    for (const value of ["1", "true", "yes", "no", "off", "false", " "])
      expect(cloudWebSearchDenied({ [CLOUD_WEBSEARCH_DENY_ENV]: value })).toBe(true)
  })

  test("命中云 web search,放过全部兄弟云工具(AC4:不误杀)", () => {
    expect(isWebSearchToolId("cloud_web_search")).toBe(true)
    // 平台改名也得继续命中 —— 闸不许写死单个字面量。
    expect(isWebSearchToolId("cloud_web_search_v2")).toBe(true)
    expect(isWebSearchToolId("websearch")).toBe(true)
    for (const tool of siblingCloudTools) expect(isWebSearchToolId(tool)).toBe(false)
    for (const tool of ["read", "bash", "alpha_ping", "cloud_search_jobs", "webfetch"])
      expect(isWebSearchToolId(tool)).toBe(false)
  })

  test("闸开时抛,闸关时全放行", () => {
    expect(() => assertWebSearchToolAllowed("cloud_web_search", ON)).toThrow(WebSearchKillSwitchError)
    expect(() => assertWebSearchToolAllowed("cloud_web_search", ON)).toThrow(/do not retry/)
    expect(() => assertWebSearchToolAllowed("cloud_web_search", OFF)).not.toThrow()
    for (const tool of siblingCloudTools) {
      expect(() => assertWebSearchToolAllowed(tool, ON)).not.toThrow()
      expect(() => assertWebSearchToolAllowed(tool, OFF)).not.toThrow()
    }
  })
})

// 反向测试:R2/R3 的判据是「可覆盖的 permission 不能证明 kill-switch 真能关」。这里复刻引擎两条
// 云工具执行链的**次序**(hook → ask → callTool),把 ask 配成「后置 agent/session allow +
// approved 全开」的最有利于绕过的状态,断言 callTool 一次都没被打到。
describe("后置 allow / approved 覆盖不了 kill-switch", () => {
  type Chain = { calls: string[]; run: (tool: string) => void }

  /** `session/tools.ts` 与 `tool/code-mode.ts` 的共同骨架:先 trigger 钩子,再 ask,再 callTool。 */
  const engineChain = (env: Record<string, string | undefined>): Chain => {
    const calls: string[] = []
    return {
      calls,
      run(tool) {
        assertWebSearchToolAllowed(tool, env) // = plugin.trigger("tool.execute.before", ...)
        // 最有利于绕过的 permission 状态:全局 deny 之后还有 agent wildcard allow、持久化到
        // session 的 allow、以及排在整个 ruleset 之后的 approved —— 三条都放行。
        const ruleset = [
          { action: tool, effect: "deny" },
          { action: "*", effect: "allow" }, // 后加载的 agent wildcard
          { action: tool, effect: "allow" }, // 持久化进 session 的 permission
        ]
        const approved = true
        const decision = approved ? "allow" : ruleset.findLast((rule) => rule.action === tool || rule.action === "*")!.effect
        calls.push(`ask:${decision}`)
        if (decision !== "allow") return
        calls.push(`callTool:${tool}`)
      },
    }
  }

  test("kill-switch 下 cloud_web_search 到不了 callTool(两条链同一个骨架)", () => {
    const chain = engineChain(ON)
    expect(() => chain.run("cloud_web_search")).toThrow(WebSearchKillSwitchError)
    expect(chain.calls).toEqual([]) // 连 ask 都没走到,approved 无从生效
  })

  test("同一条链上,兄弟云工具照常执行", () => {
    const chain = engineChain(ON)
    for (const tool of siblingCloudTools) chain.run(tool)
    expect(chain.calls.filter((c) => c.startsWith("callTool:"))).toEqual(
      siblingCloudTools.map((tool) => `callTool:${tool}`),
    )
  })

  test("闸关时 cloud_web_search 照常执行(不是永久禁用)", () => {
    const chain = engineChain(OFF)
    chain.run("cloud_web_search")
    expect(chain.calls).toEqual(["ask:allow", "callTool:cloud_web_search"])
  })
})

// 上面那个骨架的前提是引擎**真的**先触发钩子再 ask。这条锁把该前提机械化:上游 sync 一旦把
// trigger 挪到 ask 之后(或删掉),云侧最终闸就退化成可覆盖的 permission,必须立刻变红。
describe("上游次序前提(trigger 早于 ask)", () => {
  const repoRoot = join(import.meta.dir, "..", "..", "..")
  const between = (body: string, from: number) => {
    const trigger = body.indexOf('"tool.execute.before"', from)
    const ask = body.indexOf("ctx.ask(", trigger)
    return { trigger, ask }
  }

  test("普通 MCP 链:session/tools.ts 的 MCP 循环里 trigger 在 ask 之前", () => {
    const body = readFileSync(join(repoRoot, "packages/opencode/src/session/tools.ts"), "utf8")
    const loop = body.indexOf("McpCatalog.convertTool(")
    expect(loop).toBeGreaterThanOrEqual(0)
    const { trigger, ask } = between(body, loop)
    expect(trigger).toBeGreaterThan(loop)
    expect(ask).toBeGreaterThan(trigger)
  })

  test("code-mode 链:invokeChildTool 里 trigger 在 ask 与 callTool 之前", () => {
    const body = readFileSync(join(repoRoot, "packages/opencode/src/tool/code-mode.ts"), "utf8")
    const fn = body.indexOf("invokeChildTool = Effect.fn")
    expect(fn).toBeGreaterThanOrEqual(0)
    const { trigger, ask } = between(body, fn)
    const callTool = body.indexOf(".callTool(", fn)
    expect(trigger).toBeGreaterThan(fn)
    expect(ask).toBeGreaterThan(trigger)
    expect(callTool).toBeGreaterThan(ask)
  })

  test("Plugin.trigger 不吞钩子抛出的错(Effect.promise = 抛即 defect)", () => {
    const body = readFileSync(join(repoRoot, "packages/opencode/src/plugin/index.ts"), "utf8")
    const trigger = body.indexOf('Effect.fn("Plugin.trigger")')
    expect(trigger).toBeGreaterThanOrEqual(0)
    const invoke = body.indexOf("Effect.promise(async () => fn(input, output))", trigger)
    expect(invoke).toBeGreaterThan(trigger)
    // trigger 体内不得出现任何吞错(否则钩子抛出会被静默降级成「照常执行」)
    const tail = body.slice(trigger, invoke + 400)
    for (const swallow of ["Effect.ignore", "catchAll", "Effect.orElse", "Effect.either"])
      expect(tail).not.toContain(swallow)
  })
})
