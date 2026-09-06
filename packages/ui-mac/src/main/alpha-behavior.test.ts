// `#1240`(REQ-154 T5)—— alpha-behavior 质量基线的**执行级**闸门。
//
// 本票只承诺一个**结构事实**:那段质量基线经生产注入链路落进 `instructions`,且落进去的字节
// **与当前用的是哪个模型无关**。它**不**承诺「输出会更长/更好」—— 方案基线
// (docs/design/req-153-output-capability.md §6.1)记着那条行为结果零 A/B 实测。
//
// 为什么「与模型无关」需要一条真判据,而不是一句注释:上游 `session/system.ts:29-42` 按
// `model.api.id` 子串路由底座提示词(25 个网关模型 16 个落 `default.txt`),于是「这条要求
// 到底覆盖了几个模型」是一个真会变的量。本文件跑**真的** `injectAlphaConfig`,用三个**分别
// 落在三份不同底座**上的模型 id 各跑一遍,断言写出的 `alpha-behavior.md` 逐字节相同 ——
// 任何按模型分叉的实现都会当场红。「这三个 id 真的落三份底座」不靠我记得:下面的 drift 锁
// 直接读上游 `system.ts` 的路由原文(同 `packages/ext/src/prompt-rebrand.test.ts` 的做法)。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { ALPHA_BEHAVIOR_MD } from "./alpha-behavior"
import { injectAlphaConfig } from "./alpha-config-injection"

const MANAGED = [
  "ALPHA_JSONC_TRUTH_DISABLE",
  "ALPHA_LEGACY_INSTALL_ROOT",
  "ALPHA_GLOBAL_DIR",
  "ALPHA_OPENCODE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_MODELS_PATH",
  "ALPHA_IDENTITY_DISABLE",
  "ALPHA_BEHAVIOR_DISABLE",
  "ALPHA_MODELS_DISABLE",
  "ALPHA_AUTOMATION_DISABLE",
  "ALPHA_READONLY_DISABLE",
  "ALPHA_WEBSEARCH_DISABLE",
  "ALPHA_CLOUD_MCP_URL",
  "ALPHA_CLOUD_MCP_ARM",
  "ALPHA_CLOUD_MCP_DEF",
  "ALPHA_CLOUD_MCP_SERVER",
  "ALPHA_BASE_URL",
  "ALPHA_DEFAULT_MODEL",
  "OPENCODE_ENABLE_EXA",
  "OPENCODE_EXPERIMENTAL",
] as const

const saved: Record<string, string | undefined> = {}
let tmp = ""
let userData = ""

beforeEach(() => {
  for (const k of MANAGED) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alpha-behavior-")))
  process.env.ALPHA_GLOBAL_DIR = path.join(tmp, "alpha-code-state", "env", "dev")
  process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg")
  process.env.ALPHA_OPENCODE_HOME = path.join(tmp, "opencode-home")
  process.env.XDG_DATA_HOME = path.join(tmp, "xdg-data")
  userData = path.join(tmp, "userdata")
  for (const d of [
    process.env.ALPHA_GLOBAL_DIR,
    process.env.XDG_CONFIG_HOME,
    process.env.ALPHA_OPENCODE_HOME,
    process.env.XDG_DATA_HOME,
    userData,
  ])
    fs.mkdirSync(d, { recursive: true })
})

afterEach(() => {
  for (const k of MANAGED) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

/** 跑一次生产注入,返回引擎会看到的 instructions 与真正落盘的 behavior 正文。 */
function inject(): { instructions: string[]; model: unknown; behaviorFile: string; behaviorBody: string | null } {
  const result = injectAlphaConfig(userData, undefined, "stable")
  expect(result).toEqual({ ok: true })
  const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT!) as { instructions?: string[]; model?: unknown }
  const behaviorFile = path.join(userData, "alpha-behavior.md")
  return {
    instructions: config.instructions ?? [],
    model: config.model,
    behaviorFile,
    behaviorBody: fs.existsSync(behaviorFile) ? fs.readFileSync(behaviorFile, "utf8") : null,
  }
}

// 三个模型 id,分别落在上游 `system.ts` 路由的三个不同分支(claude / gpt / 兜底 default)。
// 下面的 drift 锁证明这三条分支今天仍然存在 —— 否则「跨三份底座都成立」是一句空话。
const ROUTED_MODELS = [
  { model: "deepseek/deepseek-chat", route: "default.txt(兜底)" },
  { model: "alpha/claude-sonnet-4-5", route: "anthropic.txt" },
  { model: "alpha/gpt-5", route: "gpt.txt" },
] as const

describe("drift 锁 —— 上游按 model.api.id 分叉底座这件事仍然成立", () => {
  const systemTs = fs.readFileSync(
    path.join(import.meta.dir, "../../../opencode/src/session/system.ts"),
    "utf8",
  )
  for (const needle of [
    'model.api.id.includes("claude")',
    'model.api.id.includes("gpt")',
    "return [PROMPT_DEFAULT]",
  ]) {
    test(`system.ts 仍含 ${needle}`, () => {
      expect(systemTs.includes(needle)).toBe(true)
    })
  }
})

describe("alpha-behavior 质量基线 —— 注入链路(#1240)", () => {
  test("基线段的每个咽喉小节都在正文里(删一节即红)", () => {
    for (const section of ["## Shape of a substantial deliverable", "## Tables, lists, prose", "## Chinese typography"]) {
      expect(ALPHA_BEHAVIOR_MD.includes(section)).toBe(true)
    }
    // 逐条要求的咽喉句。断言前先把软换行折平 —— 否则重排一次段落就假红,
    // 而假红门会被训练成「忽略它」(本仓 `#754` 的形态)。
    const flat = ALPHA_BEHAVIOR_MD.replace(/\s+/g, " ")
    for (const requirement of [
      "Lead with the conclusion or the outcome, then the evidence",
      "one heading level for the main parts, at most one more beneath",
      "A table when every row carries the same fields",
      "A list when the items are peers, and there are at least three of them",
      "Use full-width punctuation",
      "Half-width digits, and a space between a number and its unit",
      "Do not claim a typeface you did not set",
    ]) {
      expect(flat, `质量基线少了这条要求:${requirement}`).toContain(requirement)
    }
  })

  test("additive-only:基线段不试图撤销基座里的压制指令(ADR-015 no hard overrides)", () => {
    // 一个 instruction 文件在 `request.ts:62-70` 是**追加**进同一个串的,删不掉任何东西。
    // 写「忽略上面那条」只会制造自相矛盾的 system 段,故明令不得出现祈使式撤销。
    for (const forbidden of ["ignore the", "disregard the", "override the base", "do not follow the base"]) {
      expect(ALPHA_BEHAVIOR_MD.toLowerCase().includes(forbidden)).toBe(false)
    }
  })

  test("生产注入:behavior 文件真落盘、真进 instructions,且正文 = ALPHA_BEHAVIOR_MD", () => {
    process.env.ALPHA_DEFAULT_MODEL = ROUTED_MODELS[0].model
    const r = inject()
    expect(r.behaviorBody).toBe(ALPHA_BEHAVIOR_MD)
    expect(r.instructions).toContain(r.behaviorFile)
  })

  test("与模型无关:三份不同底座路由下,落盘的 behavior 正文逐字节相同", () => {
    const bodies: string[] = []
    const models: unknown[] = []
    for (const { model } of ROUTED_MODELS) {
      // 每一轮换一份 userData,确保读到的是**这一轮**写出来的文件,而不是上一轮的残留。
      userData = fs.mkdtempSync(path.join(tmp, "ud-"))
      delete process.env.OPENCODE_CONFIG_CONTENT
      process.env.ALPHA_DEFAULT_MODEL = model
      const r = inject()
      expect(r.instructions, `${model} 的 instructions 少了 behavior 文件`).toContain(r.behaviorFile)
      bodies.push(r.behaviorBody!)
      models.push(r.model)
    }
    // 先证明这三轮**确实换了模型**(否则「三轮相同」是同义反复)。
    expect(models).toEqual(ROUTED_MODELS.map((m) => m.model))
    expect(new Set(bodies).size).toBe(1)
    expect(bodies[0]).toBe(ALPHA_BEHAVIOR_MD)
  })

  test("逃生门仍然真:ALPHA_BEHAVIOR_DISABLE=1 → 文件不写、不进 instructions", () => {
    process.env.ALPHA_BEHAVIOR_DISABLE = "1"
    const r = inject()
    expect(r.behaviorBody).toBeNull()
    expect(r.instructions).not.toContain(r.behaviorFile)
    // 反证:identity 那份仍在 —— 说明红的不是「整个 instructions 通路没跑」。
    expect(r.instructions.some((f) => f.endsWith("alpha-identity.md"))).toBe(true)
  })
})
