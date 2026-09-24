// `#1413` —— composer 运行权限三档在**引擎层**各自做它名字说的事(alpha 自有测试;north-star:alpha-owned)。
//
// 票面根因(勘破 docs/architecture/2026-09-23-runtime-permission-tiers.md §3):composer「请求审批」档提交时
// 不带 agent,落到引擎默认 agent `build`,而 build 的规则集基底是 `"*": "allow"` —— 真 `Permission.ask` 对
// `bash` / `edit` 直接放行不弹框,「逐次询问」这个副标题是假的。修法是主进程多注入一个 hidden agent
// `alpha-ask`(= build + edit/bash 改 ask),composer 选「请求审批」时强制带上它。
//
// 这道闸罩的是**引擎真的会问**,不是 renderer 发了什么字段。那一半的闸是 ui-mac 的 shell-commands.test.ts
// (已登记:真壳逐档点选,提交层的 agent 三个互不相同);composer-state 的纯核单测另有 AC4 三份请求体的断言,
// 但那是覆盖,不是闸 —— 删掉它,shell-commands 那条照样红。判据全部走生产:
//   · 真 `injectAlphaConfig`(ui-mac 主进程写给引擎的那份 config,零 mock,临时盘)→ 真 `Agent.Service`
//     拿到 `alpha-ask` / `build` / `alpha-readonly` 的规则集;
//   · 真 `Permission.Service.ask`(与 `session/tools.ts` 给工具的 `ctx.ask` 同一个服务、同一个方法),
//     `ALPHA_PERMISSION_ASK_TIMEOUT_MS=300` 让「真的在等人批」在 300 ms 内以具名失败落地,而不是挂住。
//
// 每条判据先证明手段测得出已知的坏(正样本 / 反样本),再判未知的好:
//   AC1  alpha-ask + bash / edit ⇒ `UnansweredError`(instanceof RejectedError:真的问了、没人答、fail-closed);
//        对照臂 build + 同样两个动作 ⇒ 直接返回(PASSED-THROUGH,今天「全部批准」的行为);
//        反样本 alpha-readonly + bash ⇒ `DeniedError`(readonly 是 deny 不是 ask,行为逐字不变 = AC3);
//        正样本 build + external_directory ⇒ `UnansweredError`(证明探针连 build 的 ask 也读得出来)。
//   AC1' 批了就走:alpha-ask + bash,`reply: once` 之后 Exit 成功 —— 「问」不是「拒」。
//   矩阵 alpha-ask 与 build 对每一把内置权限键的 `evaluate` 结果**只在 edit / bash 上不同**,工具表(`disabled`)
//        逐字相同 —— 「请求审批」= 默认档 + 多问一句,不多不少;alpha-ask 没有 prompt(有就顶掉底座)。
//
// 变异实测(交付时实跑,结论写进 PR):把 alpha-config-injection.ts 里 alpha-ask 的 `bash: "ask"` 改成
// `"allow"` ⇒ AC1 的 bash 臂与矩阵臂当场红;删掉 `question: "allow"` ⇒ 矩阵臂红(question 从工具表消失)。
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Provider } from "../../src/provider/provider"
import { SessionID } from "../../src/session/schema"
import { Skill } from "../../src/skill"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { EditTool } from "../../src/tool/edit"
import { GlobTool } from "../../src/tool/glob"
import { GrepTool } from "../../src/tool/grep"
import { LspTool } from "../../src/tool/lsp"
import { PlanExitTool } from "../../src/tool/plan"
import { QuestionTool } from "../../src/tool/question"
import { ReadTool } from "../../src/tool/read"
import { ShellTool } from "../../src/tool/shell"
import { SkillTool } from "../../src/tool/skill"
import { TaskTool } from "../../src/tool/task"
import { TodoWriteTool } from "../../src/tool/todo"
import { WebFetchTool } from "../../src/tool/webfetch"
import { WebSearchTool } from "../../src/tool/websearch"
import { WriteTool } from "../../src/tool/write"
import { testEffect } from "../lib/effect"

// 生产注入函数经**非字面量**路径动态 import:运行时仍是 ui-mac 主进程那份真函数,但 tsgo 不会顺着它把整张
// ui-mac main 模块图(electron 类型:process.resourcesPath、ReadableStreamDefaultReadResult…)拖进 opencode 的
// typecheck —— 静态 import 实测让本包 typecheck 多出 3 条与本票无关的 TS 红(alpha-artifact-download.ts /
// ext-fs-installer.ts)。本仓其它 opencode 侧 alpha 测试只静态 import ui-mac 的叶模块,同一个理由。
const INJECTION_MODULE = path.resolve(import.meta.dir, "..", "..", "..", "ui-mac", "src", "main", "alpha-config-injection.ts")
type InjectAlphaConfig = (userDataPath: string) => { ok: boolean }
const { injectAlphaConfig } = (await import(INJECTION_MODULE)) as { injectAlphaConfig: InjectAlphaConfig }

// 期限压到 300ms:被测的是「会不会挂起等人批」,不是「300 秒有多长」(与 alpha-ask-deadline.test.ts 同一招)。
const TEST_TIMEOUT_MS = 300
process.env["ALPHA_PERMISSION_ASK_TIMEOUT_MS"] = String(TEST_TIMEOUT_MS)

// 生产注入读的每个 env 都钉进临时盘 —— 不读宿主机真实配置(owner 机器上的 alpha.jsonc 不参与本闸)。
const MANAGED = ["ALPHA_GLOBAL_DIR", "XDG_CONFIG_HOME", "ALPHA_OPENCODE_HOME", "XDG_DATA_HOME", "OPENCODE_CONFIG_CONTENT"] as const
const saved: Record<string, string | undefined> = {}
let tmp = ""
beforeAll(() => {
  for (const k of MANAGED) saved[k] = process.env[k]
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alpha-1413-tiers-")))
  process.env.ALPHA_GLOBAL_DIR = path.join(tmp, "alpha-code-state", "env", "dev")
  process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg")
  process.env.ALPHA_OPENCODE_HOME = path.join(tmp, "opencode-home")
  process.env.XDG_DATA_HOME = path.join(tmp, "xdg-data")
  delete process.env.OPENCODE_CONFIG_CONTENT
  const userData = path.join(tmp, "userdata")
  for (const d of [process.env.ALPHA_GLOBAL_DIR, process.env.XDG_CONFIG_HOME, process.env.ALPHA_OPENCODE_HOME, process.env.XDG_DATA_HOME, userData])
    fs.mkdirSync(d, { recursive: true })
  const res = injectAlphaConfig(userData)
  if (!res.ok) throw new Error(`injectAlphaConfig failed: ${JSON.stringify(res)}`)
})
afterAll(() => {
  for (const k of MANAGED) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  fs.rmSync(tmp, { recursive: true, force: true })
})

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = AppNodeBuilder.build(
  LayerNode.group([
    Permission.node,
    EventV2Bridge.node,
    CrossSpawnSpawner.node,
    InstanceStore.node,
    Agent.node,
    Plugin.node,
    Provider.node,
    Auth.node,
    Config.node,
    Skill.node,
    RuntimeFlags.node,
  ]),
  [[InstanceStore.bootstrapNode, noopBootstrap]],
)
const it = testEffect(env)

/** 生产值,不是手写清单:各内置工具模块导出的 `.id`。 */
const BUILTIN_TOOL_IDS = [
  ApplyPatchTool,
  EditTool,
  GlobTool,
  GrepTool,
  LspTool,
  PlanExitTool,
  QuestionTool,
  ReadTool,
  ShellTool,
  SkillTool,
  TaskTool,
  TodoWriteTool,
  WebFetchTool,
  WebSearchTool,
  WriteTool,
].map((t) => t.id)
/** 引擎内置权限键(工具 id 之外的那几把:`agent/agent.ts` defaults 里出现的)+ 一把未知键(看 `*` 兜底)。 */
const PERMISSION_KEYS = [...BUILTIN_TOOL_IDS, "external_directory", "doom_loop", "plan_enter", "some_unknown_tool_xyz"]

const rulesetOf = (name: string) =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const a = yield* agents.get(name)
    if (!a) throw new Error(`agent "${name}" is not injected — the composer would send a name the engine does not know`)
    return a
  })

type Verdict = { kind: "passed-through" } | { kind: "unanswered" } | { kind: "denied" } | { kind: "other"; detail: string }

/** 真 Permission.ask,按 Exit 分类:成功 = 放行;UnansweredError = 真的问了、没人答、fail-closed;DeniedError = 规则 deny。 */
const tryAsk = (agentName: string, permission: string, pattern: string, sid: string) =>
  Effect.gen(function* () {
    const agent = yield* rulesetOf(agentName)
    const perm = yield* Permission.Service
    const exit = yield* perm
      .ask({
        sessionID: SessionID.make(sid),
        permission,
        patterns: [pattern],
        metadata: {},
        always: [pattern],
        ruleset: agent.permission,
      })
      .pipe(Effect.exit)
    const verdict: Verdict = Exit.isSuccess(exit)
      ? { kind: "passed-through" }
      : Cause.squash(exit.cause) instanceof Permission.UnansweredError
        ? { kind: "unanswered" }
        : Cause.squash(exit.cause) instanceof PermissionV1.DeniedError
          ? { kind: "denied" }
          : { kind: "other", detail: Cause.pretty(exit.cause).split("\n")[0] ?? "" }
    // 一行一格的实测记录(PR / CI 日志里直接读得到,不用反推断言):ASK <agent> <permission> "<pattern>" -> <verdict>
    console.log(`ASK ${agentName} ${permission} ${JSON.stringify(pattern)} -> ${verdict.kind}${verdict.kind === "other" ? `: ${verdict.detail}` : ""}`)
    return verdict
  })

it.instance(
  "AC1:选「请求审批」(alpha-ask)时 bash 与 edit 各弹一次审批、不批就不执行;对照臂「全部批准」(build)同样两个动作不弹框",
  () =>
    Effect.gen(function* () {
      // 先证明手段测得出已知的坏,再判未知的好。
      // 正样本:build 的 external_directory 出厂就是 ask —— 探针必须读出「真的在问」。
      expect(yield* tryAsk("build", "external_directory", "/Users/nobody/Downloads/x", "ses_1413_pos")).toEqual({ kind: "unanswered" })
      // 反样本:alpha-readonly 的 bash 是 deny —— 探针必须读出「被拒」,而且不是「在问」(AC3:只读逐字不变)。
      expect(yield* tryAsk("alpha-readonly", "bash", "ls", "ses_1413_neg_bash")).toEqual({ kind: "denied" })
      expect(yield* tryAsk("alpha-readonly", "edit", "src/index.ts", "ses_1413_neg_edit")).toEqual({ kind: "denied" })

      // 对照臂(「全部批准」= 引擎默认 build):两个动作直接放行 —— 这就是此前「请求审批」的真实行为。
      expect(yield* tryAsk("build", "bash", "rm -rf node_modules && bun install", "ses_1413_build_bash")).toEqual({ kind: "passed-through" })
      expect(yield* tryAsk("build", "edit", "src/index.ts", "ses_1413_build_edit")).toEqual({ kind: "passed-through" })

      // 被测臂(「请求审批」= alpha-ask):同样两个动作,真的进了待批队列、没人批就 fail-closed。
      expect(yield* tryAsk("alpha-ask", "bash", "rm -rf node_modules && bun install", "ses_1413_ask_bash")).toEqual({ kind: "unanswered" })
      expect(yield* tryAsk("alpha-ask", "edit", "src/index.ts", "ses_1413_ask_edit")).toEqual({ kind: "unanswered" })

      // 挂起态不残留(每一次 unanswered 都清了 pending)。
      const permission = yield* Permission.Service
      expect(yield* permission.list()).toHaveLength(0)
    }),
  { git: true },
)

it.instance(
  "AC1':「请求审批」是问不是拒 —— alpha-ask 的 bash 请求进 pending,用户 reply once 之后放行",
  () =>
    Effect.gen(function* () {
      const agent = yield* rulesetOf("alpha-ask")
      const permission = yield* Permission.Service
      const fiber = yield* permission
        .ask({
          sessionID: SessionID.make("ses_1413_reply"),
          permission: "bash",
          patterns: ["git status"],
          metadata: {},
          always: ["git status"],
          ruleset: agent.permission,
        })
        .pipe(Effect.forkScoped)
      // 真的进了待批队列(以 list() 里出现为证,而不是「没放行」)。
      const pending = yield* Effect.gen(function* () {
        while (true) {
          const list = yield* permission.list()
          if (list.length > 0) return list
          yield* Effect.sleep("5 millis")
        }
      }).pipe(
        Effect.timeoutOrElse({
          duration: TEST_TIMEOUT_MS,
          orElse: () => Effect.fail(new Error("alpha-ask 的 bash 请求没有进入 pending —— 它没有在问")),
        }),
      )
      expect(pending[0]!.permission).toBe("bash")
      expect(pending[0]!.patterns).toEqual(["git status"])
      yield* permission.reply({ requestID: pending[0]!.id, reply: "once" })
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  { git: true },
)

it.instance(
  "矩阵:alpha-ask 与 build 只在 edit / bash 上不同(其余每一把键逐字相同、工具表逐字相同、没有 prompt);alpha-readonly 仍是 deny",
  () =>
    Effect.gen(function* () {
      const ask = yield* rulesetOf("alpha-ask")
      const build = yield* rulesetOf("build")
      const readonly = yield* rulesetOf("alpha-readonly")

      const row = (a: Agent.Info) => Object.fromEntries(PERMISSION_KEYS.map((k) => [k, Permission.evaluate(k, "*", a.permission).action]))
      const askRow = row(ask)
      const buildRow = row(build)
      const diff = PERMISSION_KEYS.filter((k) => askRow[k] !== buildRow[k]).sort()
      expect(diff).toEqual(["bash", "edit"])
      expect(askRow.bash).toBe("ask")
      expect(askRow.edit).toBe("ask")
      expect(buildRow.bash).toBe("allow")
      expect(buildRow.edit).toBe("allow")
      // 「请求审批」不许比默认档少工具:question 在 build 上是 allow,alpha-ask 也必须是。
      expect(askRow.question).toBe("allow")
      // 出厂仍会问的三类不因本票放宽(边界:「全部批准」是给默认行为一个诚实的名字,不是新增权限)。
      for (const a of [ask, build]) {
        expect(Permission.evaluate("external_directory", "/Users/nobody/Downloads/x", a.permission).action).toBe("ask")
        expect(Permission.evaluate("doom_loop", "*", a.permission).action).toBe("ask")
        expect(Permission.evaluate("read", "foo/.env", a.permission).action).toBe("ask")
      }
      // 工具表:两者从模型工具表里隐藏的内置工具集合逐字相同(ask 不是 deny,不会让 edit/bash 消失)。
      const hidden = (a: Agent.Info) => [...Permission.disabled(BUILTIN_TOOL_IDS, a.permission)].sort()
      expect(hidden(ask)).toEqual(hidden(build))
      expect(hidden(ask)).not.toContain("bash")
      expect(hidden(ask)).not.toContain("edit")
      // 没有 prompt:有就会在 llm/request.ts:64 顶掉整份底座提示词。
      expect(ask.prompt).toBeUndefined()
      expect(ask.hidden).toBe(true)
      expect(ask.mode).toBe("primary")

      // AC3:alpha-readonly 逐字不变 —— edit/bash deny,且从工具表里消失。
      expect(Permission.evaluate("edit", "*", readonly.permission).action).toBe("deny")
      expect(Permission.evaluate("bash", "*", readonly.permission).action).toBe("deny")
      expect(hidden(readonly)).toEqual(expect.arrayContaining(["apply_patch", "bash", "edit", "write"]))
    }),
  { git: true },
)

// 生产默认期限不被本文件的 env 覆盖所改写(与 alpha-ask-deadline.test.ts 同一条防线,这里只核一次)。
test("本文件的 300ms 只是测试覆盖,生产默认期限仍是 5 分钟", () => {
  expect(Permission.ASK_TIMEOUT_MS_DEFAULT).toBe(300_000)
})
