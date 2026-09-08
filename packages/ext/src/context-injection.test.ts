// REQ-157 `#1284` —— Alpha 注入模型上下文的咽喉(AC1)、上限响亮失败(AC2)、库存快照(AC3)。
//
// 咽喉的完备性不靠「我列了四个注入点」这种散文,靠一条派生链,每一环都是可执行断言:
//   ① `packages/plugin/src/index.ts` 的 `Hooks` 接口 = 插件能碰引擎的**全部**方式(单一权威)。
//      从源码解析它的键集,与登记簿的 HOOK_CONTEXT_CLASS 键集比对 —— 上游加钩子、我们漏分类,即红。
//   ② 真 AlphaExt 实现了的钩子里,分类为「载上下文」的那几个,集合必须逐字等于本文件设了咽喉的
//      那几个 —— alpha 明天多实现一个 messages.transform 而没写咽喉,即红。
//   ③ 每个咽喉:跑**真钩子**,把它送出去的每一个字符串与登记簿比对;并在同一测试里用一个
//      **已知的坏**(包一层真钩子再多塞一段)证明判官看得见 —— 「先证明手段能测出已知的坏」。
//
// ui-mac 经 cfg.instructions 写的两份 .md(`#1296`)与经 cfg.agent.* 写的三个 agent 的字(`#1299`)也在同一份登记簿里;
// ui-mac 侧的咽喉(跑真 injectAlphaConfig、罩整份 config)在 packages/ui-mac/src/main/config-injection-throat.test.ts(`#1305`),
// 本文件只钉登记形状、判官与跨包前提(③e / ③f)。
// 已知不覆盖:项目自己的 plugins / alpha.jsonc(用户的字);skills 正文与 MCP 工具表(别人的字)。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  applyRegisteredRebrands,
  BEHAVIOR_FRAGMENT_ID,
  CONTEXT_INJECTIONS,
  ContextBudgetError,
  contextBytes,
  contextText,
  defineRebrand,
  defineTemplate,
  defineText,
  explainAgentText,
  explainConfigReference,
  explainConfigString,
  explainInstructionBody,
  HOOK_CONTEXT_CLASS,
  IDENTITY_FRAGMENT_ID,
  identityCapsFromId,
  inventory,
  renderInventory,
  renderTemplate,
  TOOL_TEXT,
  UI_MAC_AGENT_NAMES,
  uiMacAgentFragmentId,
} from "./context-injection"
import { REBRAND_RULES } from "./prompt-rebrand"
import { ALPHA_AGENT_TEXT } from "../../ui-mac/src/main/alpha-agents"
import { ALPHA_BEHAVIOR_MD } from "../../ui-mac/src/main/alpha-behavior"
import { buildAlphaIdentity } from "../../ui-mac/src/main/alpha-identity"
import { CLOUD_MCP_ARM_ENV, CLOUD_MCP_DEF_ENV } from "./cloud-websearch-kill"

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..")
const HOOKS_SOURCE = join(REPO_ROOT, "packages", "plugin", "src", "index.ts")
const PROMPT_DIR = join(REPO_ROOT, "packages", "opencode", "src", "session", "prompt")
const SNAPSHOT = join(import.meta.dir, "context-injection-inventory.snapshot.txt")

// ── ① 单一权威:Hooks 接口的键集 ─────────────────────────────────────────────────

function hooksInterfaceKeys(): string[] {
  const src = readFileSync(HOOKS_SOURCE, "utf8")
  const start = src.indexOf("export interface Hooks {")
  if (start < 0) throw new Error(`Hooks 接口没找到:${HOOKS_SOURCE}`)
  const endMatch = /\n\}(\n|$)/.exec(src.slice(start))
  if (!endMatch) throw new Error("Hooks 接口没有闭合")
  const body = src.slice(start, start + endMatch.index)
  const keys: string[] = []
  for (const line of body.split("\n")) {
    // 接口顶层成员 = 两格缩进 + 可选引号包住的键 + `?: `;嵌套成员缩进更深,注释不以标识符起头。
    const m = /^ {2}"?([A-Za-z_][\w.]*)"?\?: /.exec(line)
    if (m) keys.push(m[1])
  }
  return keys
}

describe("① 通路枚举派生自 packages/plugin 的 Hooks 接口", () => {
  test("解析手段先测出已知的形状:≥15 个键、含三个已知钩子、无重复", () => {
    const keys = hooksInterfaceKeys()
    expect(keys.length).toBeGreaterThanOrEqual(15)
    for (const k of ["config", "tool", "experimental.chat.system.transform", "chat.params"]) expect(keys).toContain(k)
    expect(new Set(keys).size).toBe(keys.length)
  })
  test("HOOK_CONTEXT_CLASS 的键集与接口 1:1 —— 上游新增钩子而这里没分类,即红", () => {
    expect([...hooksInterfaceKeys()].sort()).toEqual(Object.keys(HOOK_CONTEXT_CLASS).sort())
  })
})

// ── 真 AlphaExt 的装载夹具(与 platform-output-cap.test.ts 同形)────────────────────────

const SANITIZE = [
  "ALPHA_FACTORY_SKILL_DIRS",
  "ALPHA_FACTORY_DENY_SKILLS",
  "ALPHA_PROMPT_REBRAND_DISABLE",
  "ALPHA_EXT_VERBOSE",
  "ALPHA_GLOBAL_DIR",
  "ALPHA_REAL_SHELL",
  "ALPHA_SB_PROFILE",
  CLOUD_MCP_ARM_ENV,
  CLOUD_MCP_DEF_ENV,
] as const

type Hooks = Record<string, unknown>
let root = ""
const saved = new Map<string, string | undefined>()

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "alpha-ext-ctxinj-")))
  const global = join(root, "global", "env", "dev")
  mkdirSync(global, { recursive: true })
  mkdirSync(join(root, "project"), { recursive: true })
  for (const k of SANITIZE) {
    saved.set(k, process.env[k])
    delete process.env[k]
  }
  process.env.ALPHA_GLOBAL_DIR = global
})
afterEach(() => {
  for (const k of SANITIZE) {
    const v = saved.get(k)
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(root, { recursive: true, force: true })
})

async function loadHooks(): Promise<Hooks> {
  const { AlphaExt } = await import("./plugin")
  return (await AlphaExt({
    directory: join(root, "project"),
    worktree: join(root, "project"),
    client: { instance: { dispose: async () => {} } },
  } as unknown as Parameters<typeof AlphaExt>[0])) as unknown as Hooks
}

/** 本文件为之设了咽喉的钩子。② 要求它与「真 AlphaExt 实现且分类为 context」的集合逐字相等。 */
const THROATED = ["config", "experimental.chat.system.transform", "tool", "tool.execute.after"].sort()

describe("② alpha 实现的每个载上下文钩子都有咽喉", () => {
  test("实现集 ∩ context 分类 == 本文件设咽喉的集合;实现的每个钩子都在分类表里", async () => {
    const hooks = await loadHooks()
    const implemented = Object.keys(hooks)
    for (const k of implemented) expect(Object.keys(HOOK_CONTEXT_CLASS), `钩子 ${k} 不在 HOOK_CONTEXT_CLASS 里`).toContain(k)
    const ctx = implemented.filter((k) => HOOK_CONTEXT_CLASS[k as keyof typeof HOOK_CONTEXT_CLASS] === "context").sort()
    expect(ctx).toEqual(THROATED)
  })
})

// ── ③a config 咽喉 ───────────────────────────────────────────────────────────────

type Leaf = { pointer: string; value: string }
function stringLeaves(v: unknown, pointer = ""): Leaf[] {
  if (typeof v === "string") return [{ pointer, value: v }]
  if (Array.isArray(v)) return v.flatMap((x, i) => stringLeaves(x, `${pointer}/${i}`))
  if (v && typeof v === "object")
    return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) =>
      stringLeaves(x, `${pointer}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`),
    )
  return []
}
/** 判官:hook 跑完后**新出现**的字符串叶子里,登记簿解释不了的那些。 */
function unexplainedDelta(before: unknown, after: unknown): Leaf[] {
  const had = new Set(stringLeaves(before).map((l) => `${l.pointer.length}:${l.pointer}${l.value}`))
  return stringLeaves(after)
    .filter((l) => !had.has(`${l.pointer.length}:${l.pointer}${l.value}`))
    .filter((l) => !explainConfigString(l.pointer, l.value).ok)
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

async function runConfig(cfg: Record<string, unknown>): Promise<{ before: unknown; after: Record<string, unknown> }> {
  const hooks = await loadHooks()
  const before = clone(cfg)
  await (hooks.config as (c: unknown) => Promise<void>)(cfg)
  return { before, after: cfg }
}

describe("③a config 咽喉:hook 写进 cfg 的每个字符串都必须由登记簿解释", () => {
  test("空 cfg:真 hook 注入之后零无解释叶子;且确实注入了(不是空跑)", async () => {
    const { before, after } = await runConfig({})
    const leaves = stringLeaves(after)
    expect(leaves.length).toBeGreaterThanOrEqual(8)
    for (const p of ["/command/init/template", "/command/review/template", "/agent/general/prompt", "/agent/docs/prompt", "/agent/docs/description"])
      expect(leaves.map((l) => l.pointer)).toContain(p)
    expect(unexplainedDelta(before, after)).toEqual([])
  })
  test("出厂禁项(模板渲染)+ 出厂技能目录(引用):都能解释", async () => {
    const dir = join(root, "factory-skills")
    mkdirSync(dir, { recursive: true })
    process.env.ALPHA_FACTORY_DENY_SKILLS = JSON.stringify(["customize-opencode"])
    process.env.ALPHA_FACTORY_SKILL_DIRS = JSON.stringify([dir])
    const { before, after } = await runConfig({})
    const pointers = stringLeaves(after).map((l) => l.pointer)
    expect(pointers).toContain("/command/customize-opencode/template")
    expect(pointers).toContain("/command/customize-opencode/description")
    expect(pointers).toContain("/permission/skill/customize-opencode")
    expect(pointers).toContain("/skills/paths/0")
    expect(explainConfigString("/command/customize-opencode/template", (after.command as any)["customize-opencode"].template)).toEqual({
      ok: true,
      id: "command.factory-denied.template",
      kind: "template",
    })
    expect(unexplainedDelta(before, after)).toEqual([])
  })
  test("用户已有的字不是 alpha 的注入:判官只看 hook 新写入的叶子", async () => {
    const { before, after } = await runConfig({
      command: { init: { template: "user's own init", description: "mine" } },
      agent: { general: { prompt: "user general" } },
      instructions: ["/Users/someone/AGENTS.md"],
    })
    expect(unexplainedDelta(before, after)).toEqual([])
    expect((after.command as any).init.template).toBe("user's own init")
  })
  test("已知的坏 ①:绕过登记簿写一个 agent prompt —— 判官点名那一条", async () => {
    const { before, after } = await runConfig({})
    ;(after.agent as Record<string, unknown>).rogue = { prompt: "rogue prompt written straight into cfg" }
    expect(unexplainedDelta(before, after)).toEqual([{ pointer: "/agent/rogue/prompt", value: "rogue prompt written straight into cfg" }])
  })
  test("已知的坏 ②:往一个登记簿从没声明过的键(instructions)塞东西 —— 不是白名单,新 pointer 照样红", async () => {
    const { before, after } = await runConfig({})
    after.instructions = ["/tmp/sneaky.md"]
    expect(unexplainedDelta(before, after).map((l) => l.pointer)).toEqual(["/instructions/0"])
  })
  test("已知的坏 ③:登记过的文字被改动一个字节 —— 逐字比对,不是「像」", async () => {
    const { before, after } = await runConfig({})
    ;(after.command as any).init.template += "!"
    expect(unexplainedDelta(before, after).map((l) => l.pointer)).toEqual(["/command/init/template"])
  })
  test("已知的坏 ④:模板实例前后缀之外多了字 —— 模板识别是前后缀逐字,不是包含", () => {
    const good = renderTemplate("command.factory-denied.template", { name: "x" })
    expect(explainConfigString("/command/x/template", good).ok).toBe(true)
    expect(explainConfigString("/command/x/template", good + " and more").ok).toBe(false)
    expect(explainConfigString("/command/x/template", "prefix " + good).ok).toBe(false)
  })
  test("已知的坏 ⑤(`#1305`):explainConfigReference 只认引用 —— ui-mac 六条引用子树解释得通;登记过的文字放在没登记 sink 的位置不由它放行;/instructions 仍不是引用;段边界精确", () => {
    for (const p of ["/$schema", "/plugin/0", "/enabled_providers/1", "/model", "/provider/alpha/models/x/variants/高/reasoning/effort", "/mcp/cloud/headers/Authorization"])
      expect(explainConfigReference(p).ok, p).toBe(true)
    expect(explainConfigReference("/provider")).toEqual({ ok: true, id: "ref.provider", kind: "reference" })
    for (const p of ["/command/x/template", "/instructions/0", "/agent/x/prompt", "/providers/x", "/provider_extra", "/models", "/permission/websearch", ""])
      expect(explainConfigReference(p).ok, p).toBe(false)
    // 与 explainConfigString 的分工:后者还认文字与模板,前者只认引用 —— 同一段登记文字放在 /command/x/template 上,两者结论不同
    expect(explainConfigString("/command/x/template", contextText("command.init.template")).ok).toBe(true)
    expect(explainConfigReference("/command/x/template").ok).toBe(false)
  })
})

// ── ③b system.transform 咽喉 ────────────────────────────────────────────────────

type SystemHook = (input: { sessionID?: string; model: unknown }, output: { system: string[] }) => Promise<void>
/** 判官:输出必须逐段等于「输入 + 登记过的替换」;段数变了、或某段多了字,都点名。 */
function unexplainedSystem(input: readonly string[], output: readonly string[]): string[] {
  const bad: string[] = []
  if (input.length !== output.length) bad.push(`segment count ${input.length} → ${output.length}`)
  for (let i = 0; i < Math.min(input.length, output.length); i++)
    if (output[i] !== applyRegisteredRebrands(input[i])) bad.push(`segment ${i} differs from registered substitutions`)
  return bad
}
async function runSystem(system: string[]): Promise<string[]> {
  const hooks = await loadHooks()
  const out = { system: [...system] }
  await (hooks["experimental.chat.system.transform"] as SystemHook)({ model: {} }, out)
  return out.system
}

describe("③b system.transform 咽喉:输出 == 输入 + 登记过的替换,一个字不多", () => {
  test("登记簿的 rebrand 集合与 REBRAND_RULES 1:1(id 与 to 逐字)", () => {
    const registered = CONTEXT_INJECTIONS.filter((f) => f.kind === "rebrand")
    expect(registered.map((f) => f.id)).toEqual(REBRAND_RULES.map((r) => `rebrand.${r.id}`))
    expect(registered.map((f) => (f.kind === "rebrand" ? f.to : ""))).toEqual(REBRAND_RULES.map((r) => r.to))
  })
  test("全部上游底座 .txt 过真钩子:零无解释差异,且至少一份真的被改写了(不是空跑)", async () => {
    const files = readdirSync(PROMPT_DIR).filter((f) => f.endsWith(".txt")).sort()
    expect(files.length).toBeGreaterThanOrEqual(10)
    let changed = 0
    for (const f of files) {
      const input = [readFileSync(join(PROMPT_DIR, f), "utf8")]
      const output = await runSystem(input)
      expect(unexplainedSystem(input, output), f).toEqual([])
      if (output[0] !== input[0]) changed += 1
    }
    expect(changed).toBeGreaterThanOrEqual(1)
  })
  test("空输入与中性输入原样返回", async () => {
    expect(await runSystem([])).toEqual([])
    expect(await runSystem(["nothing to rebrand here"])).toEqual(["nothing to rebrand here"])
  })
  test("已知的坏:包一层真钩子再多推一段 / 多接几个字 —— 判官都点名", async () => {
    const hooks = await loadHooks()
    const real = hooks["experimental.chat.system.transform"] as SystemHook
    const input = [readFileSync(join(PROMPT_DIR, "anthropic.txt"), "utf8")]
    const pushed = { system: [...input] }
    await real({ model: {} }, pushed)
    pushed.system.push("rogue extra segment")
    expect(unexplainedSystem(input, pushed.system)).toEqual(["segment count 1 → 2"])
    const appended = { system: [...input] }
    await real({ model: {} }, appended)
    appended.system[0] += " rogue tail"
    expect(unexplainedSystem(input, appended.system)).toEqual(["segment 0 differs from registered substitutions"])
  })
})

// ── ③c 工具表咽喉 ───────────────────────────────────────────────────────────────

/** zod 4.1.8 实测:`.describe()` 后再 `.default()`,description 挂在 innerType 上 —— 顺链找。 */
function zodDescription(schema: unknown): string | undefined {
  let s = schema as { description?: unknown; _def?: { innerType?: unknown }; def?: { innerType?: unknown } } | undefined
  for (let i = 0; i < 8 && s; i++) {
    if (typeof s.description === "string") return s.description
    s = (s._def?.innerType ?? s.def?.innerType) as typeof s
  }
  return undefined
}
type ToolMap = Record<string, { description: string; args: Record<string, unknown> }>
/** 判官:每个工具的 description 与每个参数的 description 都必须是登记项;登记项也不许多出实际没有的工具。 */
function unexplainedTools(tools: ToolMap): string[] {
  const bad: string[] = []
  const byId = new Map(CONTEXT_INJECTIONS.filter((f) => f.kind === "text").map((f) => [f.id, f.kind === "text" ? f.text : ""]))
  for (const [name, t] of Object.entries(tools)) {
    if (byId.get(`tool.${name}.description`) !== t.description) bad.push(`tool.${name}.description`)
    for (const [arg, schema] of Object.entries(t.args))
      if (byId.get(`tool.${name}.args.${arg}`) !== zodDescription(schema)) bad.push(`tool.${name}.args.${arg}`)
  }
  const actualIds = new Set(
    Object.entries(tools).flatMap(([name, t]) => [`tool.${name}.description`, ...Object.keys(t.args).map((a) => `tool.${name}.args.${a}`)]),
  )
  for (const id of byId.keys()) if (id.startsWith("tool.") && !actualIds.has(id)) bad.push(`stale registration ${id}`)
  return bad
}

describe("③c 工具表咽喉:每个 description 都是登记项,登记项也不许有实际没有的工具", () => {
  test("真 AlphaExt 的四个工具:零无解释;且 TOOL_TEXT 的键集 == 实际工具名", async () => {
    const hooks = await loadHooks()
    const tools = hooks.tool as ToolMap
    expect(Object.keys(tools).sort()).toEqual(Object.keys(TOOL_TEXT).sort())
    expect(unexplainedTools(tools)).toEqual([])
  })
  test("zodDescription 先测出已知的形状:describe 后 default 也取得到", () => {
    const { tool } = require("@opencode-ai/plugin") as typeof import("@opencode-ai/plugin")
    expect(zodDescription(tool.schema.string().describe("d1").default(""))).toBe("d1")
    expect(zodDescription(tool.schema.boolean().describe("d2").default(false))).toBe("d2")
    expect(zodDescription(tool.schema.enum(["a", "b"]).describe("d3"))).toBe("d3")
    expect(zodDescription(tool.schema.string())).toBeUndefined()
  })
  test("已知的坏:多一个未登记的工具 / 改一个 description / 登记簿多一条 —— 判官各点名", async () => {
    const hooks = await loadHooks()
    const tools = hooks.tool as ToolMap
    expect(unexplainedTools({ ...tools, rogue: { description: "unregistered tool", args: {} } })).toEqual(["tool.rogue.description"])
    expect(unexplainedTools({ ...tools, alpha_ping: { ...tools.alpha_ping, description: tools.alpha_ping.description + "!" } })).toEqual([
      "tool.alpha_ping.description",
    ])
    const { alpha_ping: _drop, ...rest } = tools
    expect(unexplainedTools(rest)).toEqual(["stale registration tool.alpha_ping.description", "stale registration tool.alpha_ping.args.note"])
  })
})

// ── ③d tool.execute.after 咽喉 ───────────────────────────────────────────────────

type AfterHook = (input: { tool: string; sessionID: string; callID: string; args: unknown }, output: { title: string; output: string; metadata: unknown }) => Promise<void>

describe("③d tool.execute.after 咽喉:工具结果回模型的路上,alpha 一个字不加", () => {
  test("非云工具的结果原样;已知的坏:包一层再改 output —— 判官点名", async () => {
    const hooks = await loadHooks()
    const real = hooks["tool.execute.after"] as AfterHook
    const output = { title: "t", output: "tool said this", metadata: { a: 1 } }
    const before = clone(output)
    await real({ tool: "bash", sessionID: "s", callID: "c", args: {} }, output)
    expect(output).toEqual(before)
    const rogue: AfterHook = async (i, o) => {
      await real(i, o)
      o.output += "\n[alpha appended]"
    }
    const o2 = { title: "t", output: "tool said this", metadata: {} }
    await rogue({ tool: "bash", sessionID: "s", callID: "c", args: {} }, o2)
    expect(o2.output).not.toBe("tool said this")
  })
})

// ── ③e instructions 通路(`#1296`):ui-mac 写 cfg.instructions 的两份文件 ────────────────
// 真注入的咽喉在 ui-mac 那边(config-injection-throat.test.ts 跑真 injectAlphaConfig,8 组 env 矩阵
// 与这里登记的形状集合双向比对)。这里钉三件登记簿自己的事:登记形状、判官能测出已知的坏、
// 跨包 import 的前提(ui-mac 那两个内容模块零依赖)仍然成立。

const DEPENDENCY_LINE = /^\s*import\b|\brequire\(|^\s*export\s.*\sfrom\s/

describe("③e instructions 通路:登记形状 + 判官 + 跨包前提", () => {
  test("登记了 behavior 1 条 + identity 2^|AlphaCapabilities| 条,全在 sink=instruction;变体 id 可反推 caps、正文 = 生产 buildAlphaIdentity(caps)、两两不同", () => {
    const rows = CONTEXT_INJECTIONS.filter((f): f is Extract<typeof f, { kind: "text" }> => f.kind === "text" && f.sink === "instruction")
    const behavior = rows.find((f) => f.id === BEHAVIOR_FRAGMENT_ID)
    expect(behavior?.text).toBe(ALPHA_BEHAVIOR_MD)
    const identity = rows.filter((f) => f.id.startsWith(IDENTITY_FRAGMENT_ID))
    const capKeys = Object.keys(identityCapsFromId(IDENTITY_FRAGMENT_ID) ?? {})
    expect(capKeys.length).toBeGreaterThanOrEqual(2)
    expect(identity.length).toBe(2 ** capKeys.length)
    for (const f of identity) {
      const caps = identityCapsFromId(f.id)
      expect(caps, f.id).toBeDefined()
      expect(f.text, f.id).toBe(buildAlphaIdentity(caps))
    }
    expect(new Set(identity.map((f) => f.text)).size).toBe(identity.length)
    expect(rows.length).toBe(identity.length + 1)
  })
  test("判官 explainInstructionBody:逐字命中;已知的坏 —— 一字节之差 / 少一字节 / 其它 sink 的登记文字 / 空串 都不解释", () => {
    expect(explainInstructionBody(ALPHA_BEHAVIOR_MD)).toEqual({ ok: true, id: BEHAVIOR_FRAGMENT_ID, kind: "text" })
    expect(explainInstructionBody(buildAlphaIdentity({ websearch: true, cloudDispatch: false }))).toEqual({
      ok: true,
      id: `${IDENTITY_FRAGMENT_ID}+websearch`,
      kind: "text",
    })
    expect(explainInstructionBody(ALPHA_BEHAVIOR_MD + "!").ok).toBe(false)
    expect(explainInstructionBody(ALPHA_BEHAVIOR_MD.slice(0, -1)).ok).toBe(false)
    // agent prompt 是登记过的字,但它的 sink 是 system(顶替底座),不是 instruction 文件 —— 不许串格解释
    expect(explainInstructionBody(contextText("agent.general.prompt")).ok).toBe(false)
    expect(explainInstructionBody("").ok).toBe(false)
    expect(identityCapsFromId("agent.general.prompt")).toBeUndefined()
    expect(identityCapsFromId(`${IDENTITY_FRAGMENT_ID}+cloudDispatch`)).toEqual({ websearch: false, cloudDispatch: true })
  })
  test("跨包前提:ui-mac 那三个内容模块保持零 import / require(否则 ext 自包含 bundle 会把 main 世界拖进引擎,ADR-006)", () => {
    // 先证明手段能测出已知的坏:三种依赖写法各抓一行,普通 export 不误抓
    expect(['import * as fs from "node:fs"', 'const x = require("electron")', 'export { a } from "./b"'].filter((l) => DEPENDENCY_LINE.test(l))).toHaveLength(3)
    expect(["export function f() {}", "export const X = 1", 'const s = "from here"'].filter((l) => DEPENDENCY_LINE.test(l))).toHaveLength(0)
    for (const f of ["alpha-behavior.ts", "alpha-identity.ts", "alpha-agents.ts"]) {
      const src = readFileSync(join(REPO_ROOT, "packages", "ui-mac", "src", "main", f), "utf8")
      expect(src.length).toBeGreaterThan(100)
      expect(src.split("\n").filter((l) => DEPENDENCY_LINE.test(l)), `${f} 引入了依赖`).toEqual([])
    }
  })
})

// ── ③f agent 通路(`#1299`):ui-mac 写 cfg.agent.<name>.{prompt,description} 的三个 alpha agent ──────
// 真注入的咽喉在 ui-mac 那边(config-injection-throat.test.ts 跑真 injectAlphaConfig,cfg.agent 下每个新写入的
// 字符串叶子过判官,并与这里的登记集合双向比对)。这里只钉登记形状与判官 explainAgentText 的已知的坏。

describe("③f agent 通路:登记形状 + 判官 explainAgentText", () => {
  test("ui-mac 的每个 agent 各登记 prompt(sink=system)+ description(sink=agent-description),正文 = ALPHA_AGENT_TEXT 逐字;名字集合 = 内容模块键集", () => {
    expect([...UI_MAC_AGENT_NAMES].sort()).toEqual(Object.keys(ALPHA_AGENT_TEXT).sort())
    expect(UI_MAC_AGENT_NAMES.length).toBeGreaterThanOrEqual(3)
    for (const name of UI_MAC_AGENT_NAMES) {
      const prompt = CONTEXT_INJECTIONS.find((f) => f.id === uiMacAgentFragmentId(name, "prompt"))
      const description = CONTEXT_INJECTIONS.find((f) => f.id === uiMacAgentFragmentId(name, "description"))
      expect(prompt?.kind, name).toBe("text")
      expect(description?.kind, name).toBe("text")
      if (prompt?.kind !== "text" || description?.kind !== "text") throw new Error("unreachable")
      expect(prompt.sink).toBe("system")
      expect(description.sink).toBe("agent-description")
      expect(prompt.text).toBe(ALPHA_AGENT_TEXT[name].prompt)
      expect(description.text).toBe(ALPHA_AGENT_TEXT[name].description)
      expect(prompt.bytes).toBe(contextBytes(ALPHA_AGENT_TEXT[name].prompt))
    }
    // 六段字两两不同(否则「集合相等」可能是同一段字登记了六次)
    const texts = UI_MAC_AGENT_NAMES.flatMap((n) => [ALPHA_AGENT_TEXT[n].prompt, ALPHA_AGENT_TEXT[n].description])
    expect(new Set(texts).size).toBe(texts.length)
  })
  test("判官 explainAgentText:逐字命中对应 sink;已知的坏 —— 一字节之差 / 串格(description 当 prompt、instruction 文件当 prompt)/ 空串 都不解释", () => {
    const name = UI_MAC_AGENT_NAMES[0]!
    expect(explainAgentText("prompt", ALPHA_AGENT_TEXT[name].prompt)).toEqual({ ok: true, id: uiMacAgentFragmentId(name, "prompt"), kind: "text" })
    expect(explainAgentText("description", ALPHA_AGENT_TEXT[name].description)).toEqual({
      ok: true,
      id: uiMacAgentFragmentId(name, "description"),
      kind: "text",
    })
    // ext 自己的 agent prompt 也是 sink=system 的登记文字 —— 同一格,判官同样认(不是按 id 前缀认的)
    expect(explainAgentText("prompt", contextText("agent.general.prompt"))).toEqual({ ok: true, id: "agent.general.prompt", kind: "text" })
    expect(explainAgentText("prompt", ALPHA_AGENT_TEXT[name].prompt + "!").ok).toBe(false)
    expect(explainAgentText("prompt", ALPHA_AGENT_TEXT[name].prompt.slice(0, -1)).ok).toBe(false)
    expect(explainAgentText("prompt", ALPHA_AGENT_TEXT[name].description).ok).toBe(false)
    expect(explainAgentText("description", ALPHA_AGENT_TEXT[name].prompt).ok).toBe(false)
    expect(explainAgentText("prompt", ALPHA_BEHAVIOR_MD).ok).toBe(false)
    expect(explainAgentText("prompt", "").ok).toBe(false)
    expect(explainAgentText("description", "").ok).toBe(false)
  })
})

// ── AC2:超限响亮失败,不裁剪;单位是字节 ─────────────────────────────────────────

describe("AC2 上限:登记时超限即抛,不裁剪;计量单位是 UTF-8 字节", () => {
  test("64/65 边界:65 字节对 64 上限抛 ContextBudgetError(信息含 id、实测、上限);对 65 上限原样通过", () => {
    const text = "a".repeat(65)
    let err: unknown
    try {
      defineText({ id: "probe.boundary", sink: "system", text, maxBytes: 64 })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ContextBudgetError)
    expect((err as Error).message).toContain("probe.boundary")
    expect((err as Error).message).toContain("65 bytes")
    expect((err as Error).message).toContain("64 bytes")
    const ok = defineText({ id: "probe.boundary", sink: "system", text, maxBytes: 65 })
    expect(ok.text.length).toBe(65)
    expect(ok.bytes).toBe(65)
  })
  test("多字节:「中中」是 6 字节 2 字符 —— 上限 5 抛、上限 6 过(单位是字节不是字符)", () => {
    expect(contextBytes("中中")).toBe(6)
    expect(() => defineText({ id: "probe.cjk", sink: "system", text: "中中", maxBytes: 5 })).toThrow(ContextBudgetError)
    expect(defineText({ id: "probe.cjk", sink: "system", text: "中中", maxBytes: 6 }).bytes).toBe(6)
  })
  test("rebrand 只量 to(alpha 塞进去的字),from 是上游原文不计", () => {
    expect(() => defineRebrand({ id: "probe.rb", from: "x".repeat(500), to: "y".repeat(9), maxBytes: 8 })).toThrow(ContextBudgetError)
    expect(defineRebrand({ id: "probe.rb", from: "x".repeat(500), to: "y".repeat(8), maxBytes: 8 }).bytes).toBe(8)
  })
  test("模板:占位符必须恰好一个;渲染结果超限在渲染处抛(真登记项 + 超长技能名)", () => {
    expect(() => defineTemplate({ id: "probe.t0", sink: "command-template", template: "no placeholder", maxBytes: 64 })).toThrow(/exactly one/)
    expect(() => defineTemplate({ id: "probe.t2", sink: "command-template", template: "{name} and {name}", maxBytes: 64 })).toThrow(/exactly one/)
    const f = CONTEXT_INJECTIONS.find((x) => x.id === "command.factory-denied.template")
    expect(f?.kind).toBe("template")
    const cap = f && f.kind === "template" ? f.maxBytes : 0
    const ok = renderTemplate("command.factory-denied.template", { name: "customize-opencode" })
    expect(ok).toContain("customize-opencode")
    expect(() => renderTemplate("command.factory-denied.template", { name: "n".repeat(cap) })).toThrow(ContextBudgetError)
  })
  test("当前登记的每一条都在上限之内,且 id 唯一(模块能装载就已证明;这里把数字钉在断言里)", () => {
    const rows = inventory()
    expect(rows.length).toBeGreaterThanOrEqual(20)
    for (const r of rows) expect(r.bytes, r.id).toBeLessThanOrEqual(r.maxBytes)
    expect(new Set(CONTEXT_INJECTIONS.map((f) => f.id)).size).toBe(CONTEXT_INJECTIONS.length)
  })
})

// ── AC3:库存快照 ───────────────────────────────────────────────────────────────

describe("AC3 库存:一处列全,快照逐字节比对(alpha-check 第 [12/12] 步打印同一份)", () => {
  test("快照在位,且与 renderInventory() 逐字节相同 —— 改了任何片段就得重生快照并让评审读 diff", () => {
    expect(existsSync(SNAPSHOT), `快照缺失:${SNAPSHOT} —— 跑 bun packages/ext/scripts/context-injection-inventory.ts --write`).toBe(true)
    const expected = readFileSync(SNAPSHOT, "utf8")
    const actual = renderInventory()
    expect(actual, "库存与快照不一致 —— 跑 bun packages/ext/scripts/context-injection-inventory.ts --write 并把快照 diff 交给评审").toBe(expected)
  })
  test("快照列全了每一条登记项与每一条引用(不是摘要)", () => {
    const text = renderInventory()
    for (const f of CONTEXT_INJECTIONS) expect(text, f.id).toContain(f.id)
    for (const r of inventory()) expect(text).toContain(`${String(r.bytes).padStart(6)}  ${String(r.maxBytes).padStart(6)}`)
  })
})
