import { mkdtempSync, realpathSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  armCloudMcp,
  assertWebSearchToolAllowed,
  CLOUD_MCP_ARM_ENV,
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

// ─────────────────────────────────────────────────────────────────────────────
// #223 R4:ext 装载握手。上一轮的 fail-closed 判据是 main 侧「ext bundle 路径存不存在」——
// R4 给出三条路径仍在、钩子却不存在的真实情形。下面每一条都真跑一遍:走的是**真实的**
// `AlphaExt`(动态 import 本包源码,与引擎装它的方式同款)与真实的失败模块,不是替身。
// ─────────────────────────────────────────────────────────────────────────────

describe("armCloudMcp 单元判据", () => {
  const disarmed = () => ({ mcp: { cloud: { type: "remote", enabled: false }, other: { type: "local", enabled: false } } })

  test("只开注入面点名的那一个,且只在它确实 disarmed 时开", () => {
    const cfg = disarmed()
    expect(armCloudMcp(cfg, { [CLOUD_MCP_ARM_ENV]: "cloud" })).toBe("cloud")
    expect(cfg.mcp.cloud.enabled).toBe(true)
    // 账本 disabled 覆盖 / XDG 默认拒绝也写 enabled:false —— 那些不归本握手管。
    expect(cfg.mcp.other.enabled).toBe(false)
  })

  test("没有 arm 通道 / 名字对不上 / 本来就是开的 —— 一律不动", () => {
    const none = disarmed()
    expect(armCloudMcp(none, {})).toBeUndefined()
    expect(none.mcp.cloud.enabled).toBe(false)

    const mismatched = disarmed()
    expect(armCloudMcp(mismatched, { [CLOUD_MCP_ARM_ENV]: "nope" })).toBeUndefined()
    expect(mismatched.mcp.cloud.enabled).toBe(false)

    const already = { mcp: { cloud: { type: "remote", enabled: true } } }
    expect(armCloudMcp(already, { [CLOUD_MCP_ARM_ENV]: "cloud" })).toBeUndefined()
  })

  test("配置里根本没有 mcp 段也不抛", () => {
    expect(armCloudMcp({}, { [CLOUD_MCP_ARM_ENV]: "cloud" })).toBeUndefined()
    expect(armCloudMcp(undefined, { [CLOUD_MCP_ARM_ENV]: "cloud" })).toBeUndefined()
  })
})

describe("ext 缺席三态:云 MCP 停在 disarmed(#223 R4 云 kill-switch)", () => {
  let root = ""
  let savedRoot: string | undefined
  let savedArm: string | undefined

  beforeEach(() => {
    savedRoot = process.env.ALPHA_GLOBAL_DIR
    savedArm = process.env[CLOUD_MCP_ARM_ENV]
    root = realpathSync(mkdtempSync(join(tmpdir(), "alpha-ext-arm-")))
    process.env.ALPHA_GLOBAL_DIR = root
    // main 侧 injectAlphaConfig 在 kill-switch 下置位的握手通道。
    process.env[CLOUD_MCP_ARM_ENV] = "cloud"
  })
  afterEach(() => {
    if (savedRoot === undefined) delete process.env.ALPHA_GLOBAL_DIR
    else process.env.ALPHA_GLOBAL_DIR = savedRoot
    if (savedArm === undefined) delete process.env[CLOUD_MCP_ARM_ENV]
    else process.env[CLOUD_MCP_ARM_ENV] = savedArm
  })

  /** 注入面在 kill-switch 下写出的配置:云 server 在册但 disabled。 */
  const injectedConfig = () => ({
    mcp: { cloud: { type: "remote", url: "https://cloud.example/mcp", enabled: false } },
  })

  const pluginInput = () => ({
    client: {} as never,
    directory: root,
    worktree: root,
    project: { id: "prj_arm_test" },
    $: undefined,
  })

  /**
   * 引擎装载外部插件 + 派发 config 钩子的判定形状(`opencode/src/plugin/index.ts`)。
   * 三个前提各由下面 "上游前提(装载路径)" 一组对源码锁住,`pure` 的真实解析由
   * `packages/opencode/test/tool/alpha-websearch-failure.test.ts` 用真 RuntimeFlags 断言。
   */
  async function engineLoadAndConfigure(
    cfg: unknown,
    opts: { pure: boolean; specs: Array<() => Promise<{ default: (input: unknown) => Promise<unknown> }>> },
  ) {
    const hooks: Array<Record<string, unknown>> = []
    // plugin/index.ts: `const plugins = flags.pure ? [] : (cfg.plugin_origins ?? [])`
    for (const load of opts.pure ? [] : opts.specs) {
      let mod: { default: (input: unknown) => Promise<unknown> }
      // PluginLoader.loadExternal:import 失败经 report.error 上报后跳过(log-and-continue)
      try {
        mod = await load()
      } catch {
        continue
      }
      // plugin/index.ts: `Effect.tryPromise({ try: () => plugin(input) })` + `Effect.catch(() => Effect.void)`
      try {
        hooks.push((await mod.default(pluginInput())) as Record<string, unknown>)
      } catch {
        continue
      }
    }
    // plugin/index.ts: "Notify plugins of current config" —— 逐个 hook 调 config
    for (const hook of hooks) await (hook["config"] as ((cfg: unknown) => Promise<void>) | undefined)?.(cfg)
    return hooks
  }

  const realExt = () => import("./plugin") as Promise<{ default: (input: unknown) => Promise<unknown> }>

  test("基线:ext 真的装载 ⇒ 云 server 被 armed(否则下面三条是空的)", async () => {
    const cfg = injectedConfig()
    const hooks = await engineLoadAndConfigure(cfg, { pure: false, specs: [realExt] })

    expect(hooks).toHaveLength(1)
    // armed 的同一个 hooks 对象上,那道不可覆盖的闸确实在。
    expect(typeof hooks[0]!["tool.execute.before"]).toBe("function")
    expect(cfg.mcp.cloud.enabled).toBe(true)
  })

  test("① OPENCODE_PURE:引擎整个跳过外部插件 ⇒ 云 server 仍 disarmed", async () => {
    const cfg = injectedConfig()
    const hooks = await engineLoadAndConfigure(cfg, { pure: true, specs: [realExt] })

    expect(hooks).toEqual([])
    expect(cfg.mcp.cloud.enabled).toBe(false)
  })

  test("② bundle import 失败(log-and-continue)⇒ 云 server 仍 disarmed", async () => {
    const broken = join(root, "broken-bundle.mjs")
    writeFileSync(broken, 'throw new Error("bundle is corrupt")\n')
    const cfg = injectedConfig()

    const hooks = await engineLoadAndConfigure(cfg, {
      pure: false,
      specs: [() => import(broken) as Promise<{ default: (input: unknown) => Promise<unknown> }>],
    })

    expect(hooks).toEqual([])
    expect(cfg.mcp.cloud.enabled).toBe(false)
  })

  test("③ 插件初始化抛错(log-and-continue)⇒ 云 server 仍 disarmed", async () => {
    const failing = join(root, "init-throws.mjs")
    writeFileSync(failing, 'export default async () => { throw new Error("AlphaExt init failed") }\n')
    const cfg = injectedConfig()

    const hooks = await engineLoadAndConfigure(cfg, {
      pure: false,
      specs: [() => import(failing) as Promise<{ default: (input: unknown) => Promise<unknown> }>],
    })

    expect(hooks).toEqual([])
    expect(cfg.mcp.cloud.enabled).toBe(false)
  })

  // 反向:握手通道没置位(= 注入面没走 kill-switch 路径)时,ext 装载也不该乱开别人的 disabled MCP。
  test("没有 arm 通道时 ext 不动任何 disabled MCP", async () => {
    delete process.env[CLOUD_MCP_ARM_ENV]
    const cfg = injectedConfig()
    await engineLoadAndConfigure(cfg, { pure: false, specs: [realExt] })
    expect(cfg.mcp.cloud.enabled).toBe(false)
  })
})

// 上面那个 mini-loader 的三个前提。上游 sync 改掉任何一条,握手的 fail-closed 语义就变了,必须变红。
describe("上游前提(装载路径)", () => {
  const repoRoot = join(import.meta.dir, "..", "..", "..")
  const pluginIndex = () => readFileSync(join(repoRoot, "packages/opencode/src/plugin/index.ts"), "utf8")

  test("pure 时外部插件被整个跳过(R4 绕过链第 3 环)", () => {
    expect(pluginIndex()).toContain("const plugins = flags.pure ? [] : (cfg.plugin_origins ?? [])")
  })

  test("OPENCODE_PURE 就是 pure 这个 flag 的来源(第 2 环)", () => {
    const flags = readFileSync(join(repoRoot, "packages/opencode/src/effect/runtime-flags.ts"), "utf8")
    expect(flags).toContain('pure: bool("OPENCODE_PURE")')
  })

  test("插件装载失败是 log-and-continue,不是 fail-closed(所以判据不能是「路径存在」)", () => {
    const body = pluginIndex()
    const load = body.indexOf('Effect.logError("failed to load plugin"')
    expect(load).toBeGreaterThanOrEqual(0)
    // tapError 之后紧跟 Effect.catch(() => …) —— 装载失败被吞掉,引擎照常启动。
    expect(body.slice(load, load + 300)).toContain("Effect.catch(")
  })

  test("config 钩子确实会被派发到每个已装载插件(握手的载体)", () => {
    const body = pluginIndex()
    const notify = body.indexOf("// Notify plugins of current config")
    expect(notify).toBeGreaterThanOrEqual(0)
    expect(body.slice(notify, notify + 300)).toContain("config?.(cfg)")
  })
})
