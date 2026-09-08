// context-injection — REQ-157 `#1284`:Alpha 往模型上下文里塞的每一段文字,都在这里登记并声明上限。
//
// 问题(票面 2026-09-08 实读):ext 至少从四处把 alpha 自己写的文字送进模型上下文 ——
//   · `alpha-prompts.ts` 经 config hook 写 `cfg.command.*.template` / `cfg.agent.*.prompt|description`
//     (引擎:`command/index.ts:98` 把 template 当用户回合;`agent/agent.ts:277` 的 prompt 在
//     `llm/request.ts:64` **整段顶替**底座提示词);
//   · `prompt-rebrand.ts` 经 `experimental.chat.system.transform` 改写 system 段(`to` 侧是 alpha 的字);
//   · `factory-deny.ts` 经 config hook 写被禁技能的占位 command(description + 含技能名的 template);
//   · `plugin.ts` 的四个 `tool()` —— description 与每个参数的 describe() 逐字进每次请求的工具表
//     (`tool/registry.ts:161`)。
// 四处都没有长度上限,也没有一处能列全「塞了什么、各多大」。这文件就是那一处。
//
// 三条纪律(每条都有判据钉着,见 context-injection.test.ts):
//   1. **登记即校验,超限即抛,绝不裁剪**(AC2)。`defineText/defineTemplate/defineRebrand` 在模块装载时
//      量 UTF-8 字节数,超过声明的 `maxBytes` 直接 throw。本模块被 plugin.ts import ⇒ 超限的片段让整个
//      ext 装不上(上游 `plugin/index.ts:237` 记 `failed to load plugin` 后继续),而不是悄悄截掉一段
//      发出去。这个状态在出货代码里到不了:ext 单测、库存快照测试、alpha-check 第 [12/12] 步三道门
//      都会先红。
//   2. **咽喉在测试,不在散文**(AC1)。「到达上下文的通路」从 `packages/plugin/src/index.ts` 的
//      `Hooks` 接口派生 —— 那是插件能碰引擎的**全部**方式。`HOOK_CONTEXT_CLASS` 给接口的每一个键分类;
//      测试把接口键集与分类键集比对(上游新增钩子即红),再把真 AlphaExt 实现了的「载上下文」钩子
//      逐个过咽喉:config 钩子跑完之后 cfg 里每一个字符串叶子都必须能被本登记簿解释(登记的文字、
//      模板的渲染实例、或声明过的**引用**);system.transform 的输出必须逐字等于「输入 + 登记过的
//      替换」;工具表里每个 description 都必须是登记项。绕过登记簿的注入 = 解释不了的叶子 = 红。
//   3. **计量单位是 UTF-8 字节,只此一种。** 不引入分词器(仓内没有,票面也不要精确 token);
//      字节 → token 的换算与编码器有关、本仓未实测,库存里不打印 token 数。
//
// 「引用」不是文字:`cfg.shell`(wrapper 路径)、`cfg.skills.paths`(目录)、`cfg.permission.skill.*`
// (`"deny"` 动词)、`cfg.mcp.*`(main 经 env 交来的 server 定义)—— 它们让引擎去别处装东西,
// 装进来的内容是用户/出厂技能/远端 server 的,预算归上游,不归本登记簿。它们仍然**必须**在这里
// 声明,否则 config 咽喉会把它们当成解释不了的叶子拦下 —— 声明的意义是「我知道这条通路存在」。
//
// 第五处不在 ext(`#1296`,REQ-157 的另一半):ui-mac 主进程经 `cfg.instructions` 注入的
// `alpha-identity.md` / `alpha-behavior.md`(`packages/ui-mac/src/main/alpha-config-injection.ts` 的
// `addInstruction` 两处)。引擎 `session/instruction.ts:135-150` 按路径读盘、`Instruction.system()` 给每份加一行
// `Instructions from: <path>` 后交给 `llm/request.ts:63-70` 拼进 system 段 —— 与 agent prompt 同一格。
// 登记簿是**同一份**(票面明令不造第二本):这里直接 import ui-mac 那两个**零依赖**的内容模块
// (`alpha-behavior.ts` 是一个字符串,`alpha-identity.ts` 是两个纯函数;测试钉住它们保持零 import ——
// 否则 ext 的自包含 bundle 会把 main 世界拖进引擎,ADR-006)。ui-mac 生产代码不 import 本登记簿:
// 它写自己的常量,咽喉在 `packages/ui-mac/src/main/instruction-injection-throat.test.ts` 跑真注入后逐字比对。
// identity 随能力探测变长(4 种形状,327–729 B):对 `AlphaCapabilities` 的每个布尔组合跑**生产**
// `buildAlphaIdentity` 各登记一条 —— 域常量按接口键集类型锁死,加一个能力字段而没扩域即 typecheck 红。
//
// 第六处也在 ui-mac(`#1299`,REQ-157 的最后一块):主进程经 `cfg.agent.<name>.{prompt,description}` 写进三个
// alpha agent(`alpha-automation` / `alpha-readonly` / `alpha-automation-standard`)的字 —— 与 ext 自己的
// `agent.general|explore|docs` 同一格(prompt 在 `request.ts:64` 整段顶替底座,description 进 subagent 清单),
// 2026-09-08 跑真 `injectAlphaConfig` 实测 1,427 B。同一份登记簿,同一个方向:import ui-mac 的零依赖内容模块
// `alpha-agents.ts`(一个 `as const` 对象),ui-mac 生产代码只取常量、不 import 本登记簿;咽喉在
// `packages/ui-mac/src/main/agent-injection-throat.test.ts`(跑真注入,cfg.agent 下每个新写入的字符串叶子
// 要么是本登记簿在对应 sink 的登记文字,要么是引擎的 permission / mode 动词,其它一律点名)。
//
// 仍不在本登记簿里、也不该在:项目自己的 `.code-puppy/plugins/*.js` 与 `alpha.jsonc`(用户的字,不是
// alpha 的);REQ-063 用户经导入门放进 `<alpha-root>/instructions/*.md` 的字(用户的);skills 正文与
// MCP 工具表(别人的字);ui-mac 写进 agent 的 permission / mode / hidden(动词与布尔,不是字)。

import { ALPHA_AGENT_TEXT } from "../../ui-mac/src/main/alpha-agents"
import { ALPHA_BEHAVIOR_MD } from "../../ui-mac/src/main/alpha-behavior"
import { buildAlphaIdentity, type AlphaCapabilities } from "../../ui-mac/src/main/alpha-identity"
import {
  ALPHA_DOCS_DESCRIPTION,
  ALPHA_DOCS_PROMPT,
  ALPHA_EXPLORE_PROMPT,
  ALPHA_GENERAL_PROMPT,
  ALPHA_INIT_DESCRIPTION,
  ALPHA_INIT_TEMPLATE,
  ALPHA_REVIEW_DESCRIPTION,
  ALPHA_REVIEW_TEMPLATE,
} from "./alpha-prompts"
import { REBRAND_RULES } from "./prompt-rebrand"

/** 计量单位:UTF-8 字节。全模块只此一处量长度。 */
export function contextBytes(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

/** 片段落在模型上下文的哪一格(库存按这一列读)。 */
export type ContextSink =
  | "system" // system 段:agent prompt 整段顶替底座(request.ts:64)/ rebrand 改写底座
  | "agent-description" // task 工具的 subagent 清单与 @ 菜单
  | "command-template" // 用户敲 /command 时成为用户回合(command/index.ts:98)
  | "command-description" // 斜杠菜单
  | "tool-description" // 每次请求的工具表(tool/registry.ts:161)
  | "tool-arg-description" // 同上,参数 schema 的 description
  | "instruction" // ui-mac 写进 cfg.instructions 的文件:引擎 session/instruction.ts:135-150 读盘,request.ts:63-70 拼进 system 段

export type TextFragment = {
  readonly kind: "text"
  readonly id: string
  readonly sink: ContextSink
  readonly text: string
  readonly bytes: number
  readonly maxBytes: number
}

/** 含 `{name}` 单占位符的模板;上限约束的是**渲染结果**(在 `renderTemplate` 处再量一次)。 */
export type TemplateFragment = {
  readonly kind: "template"
  readonly id: string
  readonly sink: ContextSink
  readonly template: string
  /** 模板本体(含占位符)的字节数 —— 库存打印用;渲染实例的字节 = 本数 − 6 + name 的字节。 */
  readonly bytes: number
  readonly maxBytes: number
}

/** system 段子串替换:alpha 塞进去的字是 `to`,`from` 是上游底座逐字节原文(drift 锁在 prompt-rebrand.test.ts)。 */
export type RebrandFragment = {
  readonly kind: "rebrand"
  readonly id: string
  readonly sink: "system"
  readonly from: string
  readonly to: string
  readonly bytes: number
  readonly maxBytes: number
}

/** 不带 alpha 文字、但确实经 config hook 写进 cfg 的通路。pointer 是 JSON Pointer 前缀。 */
export type ReferenceEntry = {
  readonly kind: "reference"
  readonly id: string
  readonly pointer: string
  readonly note: string
}

export type ContextInjection = TextFragment | TemplateFragment | RebrandFragment | ReferenceEntry

export class ContextBudgetError extends Error {
  constructor(
    readonly id: string,
    readonly bytes: number,
    readonly maxBytes: number,
  ) {
    super(
      `[@alpha-code/ext] context injection "${id}" is ${bytes} bytes, over its declared limit of ${maxBytes} bytes — refusing to inject (never truncated; raise the limit in context-injection.ts and regenerate the inventory snapshot)`,
    )
    this.name = "ContextBudgetError"
  }
}

const TEMPLATE_PARAM = "{name}"

export function defineText(input: { id: string; sink: ContextSink; text: string; maxBytes: number }): TextFragment {
  const bytes = contextBytes(input.text)
  if (bytes > input.maxBytes) throw new ContextBudgetError(input.id, bytes, input.maxBytes)
  return Object.freeze({ kind: "text", id: input.id, sink: input.sink, text: input.text, bytes, maxBytes: input.maxBytes })
}

export function defineTemplate(input: { id: string; sink: ContextSink; template: string; maxBytes: number }): TemplateFragment {
  const parts = input.template.split(TEMPLATE_PARAM)
  if (parts.length !== 2)
    throw new Error(`[@alpha-code/ext] context injection template "${input.id}" must contain exactly one ${TEMPLATE_PARAM} placeholder`)
  const bytes = contextBytes(input.template)
  if (bytes > input.maxBytes) throw new ContextBudgetError(input.id, bytes, input.maxBytes)
  return Object.freeze({ kind: "template", id: input.id, sink: input.sink, template: input.template, bytes, maxBytes: input.maxBytes })
}

export function defineRebrand(input: { id: string; from: string; to: string; maxBytes: number }): RebrandFragment {
  const bytes = contextBytes(input.to)
  if (bytes > input.maxBytes) throw new ContextBudgetError(input.id, bytes, input.maxBytes)
  return Object.freeze({ kind: "rebrand", id: input.id, sink: "system", from: input.from, to: input.to, bytes, maxBytes: input.maxBytes })
}

export function defineReference(input: { id: string; pointer: string; note: string }): ReferenceEntry {
  if (!input.pointer.startsWith("/")) throw new Error(`[@alpha-code/ext] reference "${input.id}" pointer must be a JSON Pointer (got ${input.pointer})`)
  return Object.freeze({ kind: "reference", id: input.id, pointer: input.pointer, note: input.note })
}

// ── 上限口径 ──────────────────────────────────────────────────────────────────
// 按类给天花板,每条仍然显式写自己的数(改数 = 改这一行 + 快照 diff,评审看得见):
//   · rebrand 替换句 ≤ 512 B;· description 类 ≤ 1 KiB;· prompt / template 正文 ≤ 8 KiB。
// 2026-09-08 实测(bytes 列在快照里):最大的是 review 模板 4672 B,离 8 KiB 顶还有 43%。
const CAP_REBRAND = 512
const CAP_DESCRIPTION = 1024
const CAP_BODY = 8192
// `#1296`:identity 说明(产品名 + 本会话能力事实)按设计要小,且每个会话、每个模型都带 —— 1 KiB 顶。
// 2026-09-08 实测最大形状(两项能力全开)729 B = 71%;再加一行能力事实(~150 B)仍在顶内。
const CAP_IDENTITY = 1024

// ── ui-mac instructions 通路(`#1296`)────────────────────────────────────────────
// identity 正文是 caps 的函数。域 = `AlphaCapabilities` 的键集(**类型锁**:`Record<keyof Required<…>, true>`
// 要求接口每个键都在此列出 —— ui-mac 明天加一个能力字段而这里没扩域,ext typecheck 当场红),
// 每个布尔组合跑一次**生产** `buildAlphaIdentity`,各登记一条;id 后缀列出打开的能力键。
// 「登记的形状集合 == 生产真能写出的形状集合」的双向锁在 ui-mac 那边的咽喉测试(跑真 injectAlphaConfig
// 的 8 组 env 矩阵),不在这里 —— 这里若只对着自己算一遍,就是与被测对象同源的自指等价链。
const IDENTITY_CAPS_DOMAIN: Record<keyof Required<AlphaCapabilities>, true> = Object.freeze({
  websearch: true,
  cloudDispatch: true,
})
export const IDENTITY_FRAGMENT_ID = "instruction.alpha-identity"
export const BEHAVIOR_FRAGMENT_ID = "instruction.alpha-behavior"

/** 由 identity 变体 id 反推它登记时用的 caps(咽喉测试用它把「解释出的 id」翻回能力事实)。 */
export function identityCapsFromId(id: string): AlphaCapabilities | undefined {
  if (id !== IDENTITY_FRAGMENT_ID && !id.startsWith(IDENTITY_FRAGMENT_ID + "+")) return undefined
  const on = new Set(id === IDENTITY_FRAGMENT_ID ? [] : id.slice(IDENTITY_FRAGMENT_ID.length + 1).split("+"))
  const caps: Record<string, boolean> = {}
  for (const k of Object.keys(IDENTITY_CAPS_DOMAIN)) caps[k] = on.has(k)
  return caps as AlphaCapabilities
}

function identityFragments(): TextFragment[] {
  const keys = Object.keys(IDENTITY_CAPS_DOMAIN) as (keyof AlphaCapabilities)[]
  const out: TextFragment[] = []
  for (let mask = 0; mask < 1 << keys.length; mask++) {
    const caps: Record<string, boolean> = {}
    const on: string[] = []
    keys.forEach((k, i) => {
      caps[k] = Boolean(mask & (1 << i))
      if (caps[k]) on.push(k)
    })
    const id = on.length ? `${IDENTITY_FRAGMENT_ID}+${on.join("+")}` : IDENTITY_FRAGMENT_ID
    out.push(defineText({ id, sink: "instruction", text: buildAlphaIdentity(caps as AlphaCapabilities), maxBytes: CAP_IDENTITY }))
  }
  return out
}

// ── ui-mac agent 通路(`#1299`)─────────────────────────────────────────────────────
// 三个 alpha agent 的 prompt / description 从 ui-mac 的零依赖内容模块取。id 形状与 ext 自己的 agent 片段
// 同形(`agent.<name>.prompt|description`);名字集合 = `ALPHA_AGENT_TEXT` 的键集,与生产写出的
// `cfg.agent` 键集的双向相等由 ui-mac 咽喉(跑真 injectAlphaConfig)钉住,这里不自算。
export const UI_MAC_AGENT_NAMES = Object.freeze(Object.keys(ALPHA_AGENT_TEXT)) as readonly (keyof typeof ALPHA_AGENT_TEXT)[]
export function uiMacAgentFragmentId(name: keyof typeof ALPHA_AGENT_TEXT, field: "prompt" | "description"): string {
  return `agent.${name}.${field}`
}
function uiMacAgentFragments(): TextFragment[] {
  const out: TextFragment[] = []
  for (const name of UI_MAC_AGENT_NAMES) {
    out.push(defineText({ id: uiMacAgentFragmentId(name, "prompt"), sink: "system", text: ALPHA_AGENT_TEXT[name].prompt, maxBytes: CAP_BODY }))
    out.push(
      defineText({ id: uiMacAgentFragmentId(name, "description"), sink: "agent-description", text: ALPHA_AGENT_TEXT[name].description, maxBytes: CAP_DESCRIPTION }),
    )
  }
  return out
}

/** 工具表文字(`plugin.ts` 的 `tool()` 从这里取,不再内联字面量)。 */
export const TOOL_TEXT = {
  alpha_reload: {
    description:
      "Schedule a reload of the opencode engine's extension registry (skills / agents / commands / plugins) without restarting the app. Call this after creating or editing a skill or agent on disk. The reload runs right after the current reply finishes (an immediate reload would cut this reply off), so the new skill/agent is available from the NEXT message in this session.",
    args: { reason: "What was created/changed (for the tool log)" },
  },
  alpha_register: {
    description:
      "Register a project-scoped extension entry into <project>/.code-puppy/alpha.jsonc (the ONLY alpha directory in a project — never create .opencode). " +
      "Use type=agent|command with an entry object (agent: {description,prompt,mode,...}; command: {template,description,...}); " +
      "type=mcp with the connector config (loading executable connectors additionally requires the user's per-project consent dialog); " +
      "type=skill takes no entry — it registers the ./.code-puppy/skills path; write the skill itself to .code-puppy/skills/<name>/SKILL.md. " +
      "Plugins are NOT registered here: drop a self-contained ESM .js into .code-puppy/plugins/ (raw TypeScript is rejected). " +
      "The change is validated, written atomically, and auto-reloaded after this reply finishes (available from the NEXT message).",
    args: {
      type: "Extension kind to register",
      name: "Entry name (letters/digits/._- , max 64 chars); ignored for type=skill",
      entry: 'The entry as a JSON object string, e.g. {"description":"...","prompt":"..."}; empty for type=skill',
    },
  },
  alpha_echo: {
    description:
      "Echo back the provided text. Proof that a Code Puppy plugin-registered tool is available with zero opencode source edits.",
    args: { text: "The text to echo back", shout: "Uppercase the echoed text" },
  },
  alpha_ping: {
    description: "Health-check tool: returns 'pong' plus the session directory. Proof that the Code Puppy extension is loaded.",
    args: { note: "Optional note echoed back with the pong" },
  },
} as const

/** REQ-067 被禁技能的占位 command(`factory-deny.ts` 从这里取)。 */
export const FACTORY_DENY_COMMAND_DESCRIPTION = "(已禁用)该技能已由 alpha 出厂默认禁用"
export const FACTORY_DENY_COMMAND_TEMPLATE =
  "该技能({name})已由 alpha 出厂默认禁用。请告知用户:此技能不可用;定制 Code Puppy 请改用 /customize-alpha;如需恢复,到 定制中心 → 已安装 → 内置(上游) 解除禁用。不要尝试其它方式执行该技能。"

function toolFragments(): TextFragment[] {
  const out: TextFragment[] = []
  for (const [name, t] of Object.entries(TOOL_TEXT)) {
    out.push(defineText({ id: `tool.${name}.description`, sink: "tool-description", text: t.description, maxBytes: CAP_DESCRIPTION }))
    for (const [arg, desc] of Object.entries(t.args))
      out.push(defineText({ id: `tool.${name}.args.${arg}`, sink: "tool-arg-description", text: desc, maxBytes: CAP_DESCRIPTION }))
  }
  return out
}

// rebrand 规则本体(from/to/file)住在 prompt-rebrand.ts —— drift 锁按 file 断言 from 仍在上游原文。
// 这里只给每条 `to` 声明上限;两边 id 集合 1:1 由 context-injection.test.ts 钉住(多一条少一条都红)。
function rebrandFragments(): RebrandFragment[] {
  return REBRAND_RULES.map((r) => defineRebrand({ id: `rebrand.${r.id}`, from: r.from, to: r.to, maxBytes: CAP_REBRAND }))
}

/** 登记簿本体。顺序 = 库存打印顺序(按 kind 再按 id 排序在 inventory() 里做,这里只求全)。 */
export const CONTEXT_INJECTIONS: readonly ContextInjection[] = Object.freeze([
  // ── alpha-prompts.ts:config hook set-if-absent 接管 ─────────────────────────
  defineText({ id: "command.init.template", sink: "command-template", text: ALPHA_INIT_TEMPLATE, maxBytes: CAP_BODY }),
  defineText({ id: "command.init.description", sink: "command-description", text: ALPHA_INIT_DESCRIPTION, maxBytes: CAP_DESCRIPTION }),
  defineText({ id: "command.review.template", sink: "command-template", text: ALPHA_REVIEW_TEMPLATE, maxBytes: CAP_BODY }),
  defineText({ id: "command.review.description", sink: "command-description", text: ALPHA_REVIEW_DESCRIPTION, maxBytes: CAP_DESCRIPTION }),
  defineText({ id: "agent.general.prompt", sink: "system", text: ALPHA_GENERAL_PROMPT, maxBytes: CAP_BODY }),
  defineText({ id: "agent.explore.prompt", sink: "system", text: ALPHA_EXPLORE_PROMPT, maxBytes: CAP_BODY }),
  defineText({ id: "agent.docs.prompt", sink: "system", text: ALPHA_DOCS_PROMPT, maxBytes: CAP_BODY }),
  defineText({ id: "agent.docs.description", sink: "agent-description", text: ALPHA_DOCS_DESCRIPTION, maxBytes: CAP_DESCRIPTION }),
  // ── factory-deny.ts:被禁技能的占位 command ───────────────────────────────────
  defineText({ id: "command.factory-denied.description", sink: "command-description", text: FACTORY_DENY_COMMAND_DESCRIPTION, maxBytes: CAP_DESCRIPTION }),
  defineTemplate({ id: "command.factory-denied.template", sink: "command-template", template: FACTORY_DENY_COMMAND_TEMPLATE, maxBytes: CAP_DESCRIPTION }),
  // ── plugin.ts:工具表 ───────────────────────────────────────────────────────────
  ...toolFragments(),
  // ── prompt-rebrand.ts:system.transform 子串替换 ────────────────────────────────
  ...rebrandFragments(),
  // ── ui-mac alpha-config-injection.ts:cfg.instructions 文件(`#1296`)────────────────
  defineText({ id: BEHAVIOR_FRAGMENT_ID, sink: "instruction", text: ALPHA_BEHAVIOR_MD, maxBytes: CAP_BODY }),
  ...identityFragments(),
  // ── ui-mac alpha-config-injection.ts:cfg.agent.<name>.{prompt,description}(`#1299`)──
  ...uiMacAgentFragments(),
  // ── 引用(无 alpha 文字;声明是为了 config 咽喉能认出它们)──────────────────────
  defineReference({ id: "ref.shell", pointer: "/shell", note: "REQ-138 引擎 shell 围栏 wrapper 路径(shell-sandbox.ts)" }),
  defineReference({ id: "ref.skills.paths", pointer: "/skills/paths", note: "出厂技能目录 + skill generation live 目录(factory-paths.ts / gen-skill-paths.ts);技能正文是别人的字" }),
  defineReference({ id: "ref.permission.skill", pointer: "/permission/skill", note: "REQ-067 出厂禁项的 \"deny\" 动词(factory-deny.ts)" }),
  defineReference({ id: "ref.mcp", pointer: "/mcp", note: "云 MCP server 定义,main 经 env 交来(cloud-websearch-kill.ts);工具表是远端 server 的字" }),
])

const BY_ID: ReadonlyMap<string, ContextInjection> = new Map(CONTEXT_INJECTIONS.map((f) => [f.id, f]))
if (BY_ID.size !== CONTEXT_INJECTIONS.length) {
  const seen = new Set<string>()
  const dup = CONTEXT_INJECTIONS.map((f) => f.id).find((id) => (seen.has(id) ? true : (seen.add(id), false)))
  throw new Error(`[@alpha-code/ext] duplicate context injection id: ${dup}`)
}

/** 取登记过的文字。id 不存在 = 编程错误,抛。 */
export function contextText(id: string): string {
  const f = BY_ID.get(id)
  if (!f || f.kind !== "text") throw new Error(`[@alpha-code/ext] no text context injection registered as "${id}"`)
  return f.text
}

/** 渲染模板;渲染结果超过声明上限同样抛(AC2 对模板的那一半)。 */
export function renderTemplate(id: string, params: { name: string }): string {
  const f = BY_ID.get(id)
  if (!f || f.kind !== "template") throw new Error(`[@alpha-code/ext] no template context injection registered as "${id}"`)
  const rendered = f.template.split(TEMPLATE_PARAM).join(params.name)
  const bytes = contextBytes(rendered)
  if (bytes > f.maxBytes) throw new ContextBudgetError(f.id, bytes, f.maxBytes)
  return rendered
}

export type Explanation = { ok: true; id: string; kind: ContextInjection["kind"] } | { ok: false }

/**
 * config 咽喉的判官:cfg 里某个 JSON Pointer 处的字符串叶子,能不能由登记簿解释。
 * 三种解释:逐字等于某条登记文字;是某条模板的渲染实例(前后缀逐字匹配);落在某条引用的 pointer 前缀下。
 * 解释不了 ⇒ 这是一条绕过登记簿的注入。
 */
export function explainConfigString(pointer: string, value: string): Explanation {
  for (const f of CONTEXT_INJECTIONS) {
    if (f.kind === "text" && f.text === value) return { ok: true, id: f.id, kind: f.kind }
    if (f.kind === "template") {
      const [head, tail] = f.template.split(TEMPLATE_PARAM)
      if (value.length >= head.length + tail.length && value.startsWith(head) && value.endsWith(tail)) return { ok: true, id: f.id, kind: f.kind }
    }
    if (f.kind === "reference" && (pointer === f.pointer || pointer.startsWith(f.pointer + "/"))) return { ok: true, id: f.id, kind: f.kind }
  }
  return { ok: false }
}

/**
 * instructions 咽喉的判官(`#1296`):一份落盘 instruction 文件的正文,能不能由登记簿解释 ——
 * 只有一种解释:逐字等于某条 sink=instruction 的登记文字(identity 的 4 种形状各是一条)。
 * 不按 pointer 放行(`/instructions` 不是引用:ext 的 config 咽喉把往这个键塞东西当已知的坏);
 * 用户自己的字(继承的 instructions、REQ-063 导入目录)由 ui-mac 咽喉按来源排除,不进这里。
 */
export function explainInstructionBody(body: string): Explanation {
  for (const f of CONTEXT_INJECTIONS)
    if (f.kind === "text" && f.sink === "instruction" && f.text === body) return { ok: true, id: f.id, kind: f.kind }
  return { ok: false }
}

/**
 * agent 咽喉的判官(`#1299`):写进 `cfg.agent.<name>.prompt` / `.description` 的一段字,能不能由登记簿解释 ——
 * 只有一种解释:逐字等于某条**对应 sink** 的登记文字(prompt ↔ `system`,description ↔ `agent-description`)。
 * 不串格:把 description 的字写进 prompt、把 instruction 文件的字写进 prompt,都不解释 —— 一段字登记时
 * 声明的是它在**哪一格**的上限,换格就不是同一笔账。
 */
export function explainAgentText(field: "prompt" | "description", value: string): Explanation {
  const sink: ContextSink = field === "prompt" ? "system" : "agent-description"
  for (const f of CONTEXT_INJECTIONS) if (f.kind === "text" && f.sink === sink && f.text === value) return { ok: true, id: f.id, kind: f.kind }
  return { ok: false }
}

/** system.transform 咽喉的参照物:把登记过的替换按登记顺序施加在一段 system 文本上。 */
export function applyRegisteredRebrands(segment: string): string {
  let t = segment
  for (const f of CONTEXT_INJECTIONS) if (f.kind === "rebrand" && t.includes(f.from)) t = t.split(f.from).join(f.to)
  return t
}

// ── 钩子面分类:`packages/plugin/src/index.ts` `Hooks` 接口的每一个键 ─────────────────
// "context" = 这个钩子能把字节送进模型上下文(改 cfg 里会变成提示词/工具表的键、改 system、改
// messages、改工具结果、改工具定义、改 compaction 提示);"no-context" = 只碰参数/头/权限/事件。
// 键集必须与接口 1:1(context-injection.test.ts 从源码解析比对):上游加一个钩子,这里不分类即红。
export const HOOK_CONTEXT_CLASS = Object.freeze({
  dispose: "no-context",
  event: "no-context",
  config: "context",
  tool: "context",
  auth: "no-context",
  provider: "no-context",
  "chat.message": "context",
  "chat.params": "no-context", // 温度/topP/maxOutputTokens/provider options —— 参数,不是内容
  "chat.headers": "no-context",
  "permission.ask": "no-context",
  "command.execute.before": "context",
  "tool.execute.before": "no-context", // 改的是模型→工具方向的 args;模型看到的调用已经发出
  "shell.env": "no-context",
  "tool.execute.after": "context", // 工具结果回到模型
  "experimental.chat.messages.transform": "context",
  "experimental.chat.system.transform": "context",
  "experimental.provider.small_model": "no-context",
  "experimental.session.compacting": "context",
  "experimental.compaction.autocontinue": "no-context",
  "experimental.text.complete": "context",
  "tool.definition": "context",
} as const satisfies Record<string, "context" | "no-context">)

export type InventoryRow = {
  id: string
  kind: "text" | "template" | "rebrand"
  sink: ContextSink
  bytes: number
  maxBytes: number
}

/** AC3:当前登记的全部片段、实测字节、上限。按 kind 再按 id 排序,与环境无关。 */
export function inventory(): InventoryRow[] {
  const order = { text: 0, template: 1, rebrand: 2 } as const
  const rows: InventoryRow[] = []
  for (const f of CONTEXT_INJECTIONS) {
    if (f.kind === "reference") continue
    rows.push({ id: f.id, kind: f.kind, sink: f.sink, bytes: f.bytes, maxBytes: f.maxBytes })
  }
  return rows.sort((a, b) => order[a.kind] - order[b.kind] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** AC3 的可打印形态(alpha-check 第 [12/12] 步打印它;快照测试逐字节比对它)。 */
export function renderInventory(): string {
  const rows = inventory()
  const idW = Math.max(...rows.map((r) => r.id.length), 2)
  const sinkW = Math.max(...rows.map((r) => r.sink.length), 4)
  const lines: string[] = []
  lines.push("Alpha context injections (packages/ext + packages/ui-mac) — unit: UTF-8 bytes; limit enforced at registration, over-limit throws (never truncates)")
  lines.push(`${"id".padEnd(idW)}  ${"kind".padEnd(8)}  ${"sink".padEnd(sinkW)}  ${"bytes".padStart(6)}  ${"limit".padStart(6)}  used`)
  let total = 0
  let totalCap = 0
  for (const r of rows) {
    total += r.bytes
    totalCap += r.maxBytes
    const used = r.maxBytes === 0 ? "n/a" : `${Math.round((r.bytes / r.maxBytes) * 100)}%`
    lines.push(`${r.id.padEnd(idW)}  ${r.kind.padEnd(8)}  ${r.sink.padEnd(sinkW)}  ${String(r.bytes).padStart(6)}  ${String(r.maxBytes).padStart(6)}  ${used.padStart(4)}`)
  }
  lines.push(`fragments: ${rows.length}; injected bytes: ${total}; declared limits total: ${totalCap}`)
  lines.push("references (paths / verbs / definitions supplied by others — carry no Alpha text, not counted):")
  for (const f of CONTEXT_INJECTIONS) if (f.kind === "reference") lines.push(`  ${f.id.padEnd(22)} ${f.pointer.padEnd(18)} ${f.note}`)
  const ctx = Object.entries(HOOK_CONTEXT_CLASS)
    .filter(([, c]) => c === "context")
    .map(([k]) => k)
  lines.push(`context-bearing plugin hooks (from packages/plugin Hooks): ${ctx.join(", ")}`)
  const instr = rows.filter((r) => r.sink === "instruction").map((r) => r.id)
  lines.push(
    `instruction files (ui-mac main writes them into cfg.instructions; engine session/instruction.ts reads them into the system segment; identity has one row per reachable capability shape): ${instr.join(", ")}`,
  )
  const agents = UI_MAC_AGENT_NAMES.flatMap((n) => [uiMacAgentFragmentId(n, "prompt"), uiMacAgentFragmentId(n, "description")])
  lines.push(
    `ui-mac agents (main writes cfg.agent.<name>.{prompt,description}; prompt replaces the base system prompt at llm/request.ts:64, description enters the subagent list): ${agents.join(", ")}`,
  )
  return lines.join("\n") + "\n"
}
