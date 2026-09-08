// REQ-157 `#1296` —— ui-mac 经 cfg.instructions 注入模型上下文的咽喉(父票 `#1284` AC1 / AC3 的 ui-mac 半场)。
//
// `#1295` 的登记簿与咽喉只罩 packages/ext 的四个钩子;ui-mac 主进程另有一条路:injectAlphaConfig 把
// alpha-identity.md / alpha-behavior.md 写进 userData 并推进 config.instructions[],引擎
// session/instruction.ts:135-150 按路径读盘、Instruction.system() 给每份加一行 `Instructions from: <path>`、
// llm/request.ts:63-70 拼进 system 段。ext 侧的咽喉结构上看不见它。
//
// 本文件跑**真的** injectAlphaConfig(生产 composition,零模块 mock,真临时盘),把它推进 instructions 的
// 每一份文件正文与**同一份**登记簿(packages/ext/src/context-injection.ts,经相对路径 import —— 与本目录
// 其它测试对 ext 的用法同形;ui-mac 生产代码本身不 import ext)逐字比对。
//
// 判官只看 alpha 的字:
//   · 继承来的 OPENCODE_CONFIG_CONTENT.instructions(用户 / 上一层的)不判 —— 只判 hook 新推进去的;
//   · REQ-063 `<alpha-root>/instructions/*.md`(用户经导入门放进去的字)按**目录来源**排除,不按 pointer 放行
//     (`/instructions` 若成为登记簿的 pointer 引用,ext 那边「往 instructions 塞东西即红」的已知的坏就失效了)。
// 每个判据都先用一个已知的坏证明判官看得见(多推一个未登记文件、路径不存在、落盘正文多一个字节)。
// 双向锁:8 组 env(websearch 的三个输入 × 代付)跑出的 identity 形状集合 == 登记簿的 identity 变体集合 ——
// 登记簿多一条生产写不出的形状、或生产写出一条没登记的形状,都红。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  BEHAVIOR_FRAGMENT_ID,
  CONTEXT_INJECTIONS,
  explainInstructionBody,
  IDENTITY_FRAGMENT_ID,
  identityCapsFromId,
} from "../../../ext/src/context-injection"
import { injectAlphaConfig } from "./alpha-config-injection"
import { secretFilePath } from "./alpha-secret-files"

// 注入读到的每一个 env 输入 + 它自己写出的 env 输出:逐个快照 / 清空 / 还原(与本目录其它跑真注入的测试同一份清单)。
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
let alphaRoot = ""

beforeEach(() => {
  for (const k of MANAGED) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alpha-instr-throat-")))
  alphaRoot = path.join(tmp, "alpha-code-state", "env", "dev")
  process.env.ALPHA_GLOBAL_DIR = alphaRoot
  process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg")
  process.env.ALPHA_OPENCODE_HOME = path.join(tmp, "opencode-home")
  process.env.XDG_DATA_HOME = path.join(tmp, "xdg-data")
  userData = path.join(tmp, "userdata")
  for (const d of [alphaRoot, process.env.XDG_CONFIG_HOME, process.env.ALPHA_OPENCODE_HOME, process.env.XDG_DATA_HOME, userData])
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

type Verdict = { pointer: string; file: string; reason: "body not registered" | "unreadable" }
type Judgement = { bad: Verdict[]; explained: string[]; user: string[] }

/** 判官:hook 新推进 instructions 的每个路径,除了用户导入目录里的,正文都必须由登记簿逐字解释。 */
function judge(before: readonly string[], after: readonly string[], importedDir: string): Judgement {
  const had = new Set(before)
  const out: Judgement = { bad: [], explained: [], user: [] }
  const insideImported = (file: string) => {
    const rel = path.relative(importedDir, file)
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
  }
  after.forEach((file, i) => {
    if (had.has(file)) return
    if (insideImported(file)) {
      out.user.push(file)
      return
    }
    const pointer = `/instructions/${i}`
    let body: string
    try {
      body = fs.readFileSync(file, "utf8")
    } catch {
      out.bad.push({ pointer, file, reason: "unreadable" })
      return
    }
    const e = explainInstructionBody(body)
    if (e.ok) out.explained.push(e.id)
    else out.bad.push({ pointer, file, reason: "body not registered" })
  })
  return out
}

type Run = Judgement & { before: string[]; after: string[]; importedDir: string }

/** 跑一次生产注入,返回引擎会看到的 instructions 与判官的裁决。 */
function run(inherited?: string[]): Run {
  const before = inherited ?? []
  if (inherited) process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ instructions: inherited })
  const result = injectAlphaConfig(userData, undefined, "stable")
  expect(result).toEqual({ ok: true })
  const cfg = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT!) as { instructions?: string[] }
  const after = cfg.instructions ?? []
  const importedDir = path.join(alphaRoot, "instructions")
  return { before, after, importedDir, ...judge(before, after, importedDir) }
}

/** 代付态(cloudDispatch=true):云 MCP URL + 登录铸 mcp_access 凭证文件同在(alpha-config-injection.ts 的 platformPays)。 */
function givenPlatformPays() {
  const file = secretFilePath(userData, "ALPHA_MCP_TOKEN")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, "mcp-token-value", { mode: 0o600 })
  process.env.ALPHA_CLOUD_MCP_URL = "https://cloud.example/mcp"
}

/** 换一份干净的 userData 与 config 起点(同一测试内多轮注入时,读到的必须是这一轮写出的文件)。 */
function freshRound() {
  userData = fs.mkdtempSync(path.join(tmp, "ud-"))
  delete process.env.OPENCODE_CONFIG_CONTENT
}

const REGISTERED_IDENTITY = CONTEXT_INJECTIONS.filter(
  (f): f is Extract<typeof f, { kind: "text" }> => f.kind === "text" && f.sink === "instruction" && f.id.startsWith(IDENTITY_FRAGMENT_ID),
)
// 默认 env(OPENCODE_ENABLE_EXA 未设 ⇒ keyless websearch 开;未代付)下 identity 的形状。
const DEFAULT_IDENTITY_ID = `${IDENTITY_FRAGMENT_ID}+websearch`

describe("ui-mac instructions 咽喉:injectAlphaConfig 推进 cfg.instructions 的每份文件正文都必须由登记簿解释", () => {
  test("默认 env:两份文件真落盘、真进 instructions、零无解释;解释出的正是 identity(websearch 形状)+ behavior", () => {
    const r = run()
    expect(r.after.map((f) => path.basename(f))).toEqual(["alpha-identity.md", "alpha-behavior.md"])
    for (const f of r.after) expect(fs.existsSync(f), f).toBe(true)
    expect(r.bad).toEqual([])
    expect(r.explained).toEqual([DEFAULT_IDENTITY_ID, BEHAVIOR_FRAGMENT_ID])
    expect(r.user).toEqual([])
  })

  test("能力矩阵 8 组 env:每组零无解释;生产写出的 identity 形状集合 == 登记簿的 identity 变体集合(双向,正文逐字)", () => {
    const seen = new Map<string, string>()
    for (const websearchDisabled of [false, true])
      for (const keyless of [false, true])
        for (const cloud of [false, true]) {
          freshRound()
          delete process.env.ALPHA_CLOUD_MCP_URL
          delete process.env.ALPHA_WEBSEARCH_DISABLE
          if (websearchDisabled) process.env.ALPHA_WEBSEARCH_DISABLE = "1"
          process.env.OPENCODE_ENABLE_EXA = keyless ? "1" : "0"
          if (cloud) givenPlatformPays()
          const label = JSON.stringify({ websearchDisabled, keyless, cloud })
          const r = run()
          expect(r.bad, label).toEqual([])
          const identityId = r.explained.find((id) => id.startsWith(IDENTITY_FRAGMENT_ID))
          expect(identityId, label).toBeDefined()
          // 解释出的 id 翻回能力事实,必须与 env 推出的事实一致 —— 不是「随便命中了某条登记项」
          expect(identityCapsFromId(identityId!), label).toEqual({
            websearch: !websearchDisabled && (keyless || cloud),
            cloudDispatch: cloud,
          })
          seen.set(identityId!, fs.readFileSync(r.after.find((f) => f.endsWith("alpha-identity.md"))!, "utf8"))
        }
    // 先证明矩阵真的驱动出了不止一种形状(否则「集合相等」可能是 8 轮同一份)
    expect(seen.size).toBeGreaterThanOrEqual(2)
    // 双向:生产写出的形状 id 集合 == 登记簿 identity 变体 id 集合;正文逐字
    expect([...seen.keys()].sort()).toEqual(REGISTERED_IDENTITY.map((f) => f.id).sort())
    for (const f of REGISTERED_IDENTITY) expect(seen.get(f.id), f.id).toBe(f.text)
  })

  test("用户的字不判:继承的 instructions 与 REQ-063 导入目录都放行 —— 同一份判官在同一轮仍点名 rogue", () => {
    const importedDir = path.join(alphaRoot, "instructions")
    fs.mkdirSync(importedDir, { recursive: true })
    const imported = path.join(importedDir, "CLAUDE.md")
    fs.writeFileSync(imported, "# user's imported global instructions\n")
    const inherited = "/Users/someone/AGENTS.md"
    const r = run([inherited])
    // 生产真的把两类用户的字都带上了(证明「放行」不是「没出现」)
    expect(r.after).toContain(inherited)
    expect(r.after).toContain(imported)
    expect(r.user).toEqual([imported])
    expect(r.bad).toEqual([])
    expect(r.explained).toEqual([DEFAULT_IDENTITY_ID, BEHAVIOR_FRAGMENT_ID])
    // 多一个不在导入目录、不在登记簿的文件 —— 点名它,而且只点它
    const rogue = path.join(userData, "alpha-extra.md")
    fs.writeFileSync(rogue, "rogue instruction written around the registry\n")
    expect(judge(r.before, [...r.after, rogue], importedDir).bad).toEqual([
      { pointer: `/instructions/${r.after.length}`, file: rogue, reason: "body not registered" },
    ])
  })

  test("已知的坏 ①:多推一个未登记文件的路径 —— 判官点名那个 pointer;路径不存在同样点名,不静默跳过", () => {
    const r = run()
    const rogue = path.join(userData, "alpha-extra.md")
    fs.writeFileSync(rogue, "rogue")
    expect(judge(r.before, [...r.after, rogue], r.importedDir).bad).toEqual([{ pointer: "/instructions/2", file: rogue, reason: "body not registered" }])
    const ghost = path.join(userData, "ghost.md")
    expect(judge(r.before, [...r.after, ghost], r.importedDir).bad).toEqual([{ pointer: "/instructions/2", file: ghost, reason: "unreadable" }])
  })

  test("已知的坏 ②:落盘的 alpha-behavior.md 多一个字节 —— 逐字比对,不是「像」;identity 那份不受牵连", () => {
    const r = run()
    const behavior = r.after.find((f) => f.endsWith("alpha-behavior.md"))!
    fs.appendFileSync(behavior, "!")
    const verdict = judge(r.before, r.after, r.importedDir)
    expect(verdict.bad).toEqual([{ pointer: "/instructions/1", file: behavior, reason: "body not registered" }])
    expect(verdict.explained).toEqual([DEFAULT_IDENTITY_ID])
  })

  test("逃生门:ALPHA_IDENTITY_DISABLE / ALPHA_BEHAVIOR_DISABLE 各自缺席那一份,剩下的仍解释得通(判官不靠「恰好两份」)", () => {
    process.env.ALPHA_IDENTITY_DISABLE = "1"
    let r = run()
    expect(r.after.map((f) => path.basename(f))).toEqual(["alpha-behavior.md"])
    expect(r.bad).toEqual([])
    expect(r.explained).toEqual([BEHAVIOR_FRAGMENT_ID])

    delete process.env.ALPHA_IDENTITY_DISABLE
    process.env.ALPHA_BEHAVIOR_DISABLE = "1"
    freshRound()
    r = run()
    expect(r.after.map((f) => path.basename(f))).toEqual(["alpha-identity.md"])
    expect(r.bad).toEqual([])
    expect(r.explained).toEqual([DEFAULT_IDENTITY_ID])
  })
})
