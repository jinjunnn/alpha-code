// REQ-236 C1(`alpha-code#1573`)—— 工具类 × 三档矩阵在**规则层**逐格按方案判(alpha 自有测试;north-star:alpha-owned)。
// 方案 docs/design/req236-permissions-and-provenance.md §2.2 R1–R12(修完之后的预期)。
//
// 手法与 alpha-composer-tiers.test.ts 相同,全部走生产:
//   · 真 `injectAlphaConfig`(ui-mac 主进程写给引擎的那份 config,临时盘)→ 真 `Agent.Service` 拿到三档载体
//     (「全部批准」= 引擎默认 build、「请求审批」= codepuppy-ask、「只读」= codepuppy-readonly)的规则集;
//   · 能力轴:真 `Permission.Service.ask`(工具体内 `ctx.ask` 的同一个服务);
//   · 身份轴:真 `AlphaToolPolicyGate.decide` + `confirm` + 真 `AlphaToolPolicy`(真 store,生产 `setRecord` 写设置);
//   · R9/R10 的 subject 由**生产形状**的云 MCP 定义(真 `materializeCloudMcpConfig`,`{file:}` 引用)与装载后 entry
//     (引用已被引擎换成令牌字面量)经真 `authorityForMcp` 派生,binding 用真 `mcpBindingDigest`(与 session/tools.ts 同口径)。
// `ALPHA_PERMISSION_ASK_TIMEOUT_MS=300`:「真的在问、没人答」以 `UnansweredError` 落地。
//
// 每格的判定:PASS = 直接放行;ASK = 真进了待批、没人答、fail-closed;DENY = 具名拒绝。
// 入口层(规则表全绿也可能被入口绕过)在 alpha-tier-delegation.test.ts;R9–R11 只读格「本会话已有放行」状态归 #1574。
// 进程围栏(工作区外写)、出网围栏、能力总闸不是规则层,不在本文件判。
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { canonicalToolIdentity, type ToolIdentity } from "@opencode-ai/schema/tool-identity"
import type { ToolPolicySubject } from "@opencode-ai/schema/alpha-tool-policy"
import { afterAll, beforeAll, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { materializeCloudMcpConfig } from "../../../ui-mac/src/main/cloud-sidecar-config"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { authorityForMcp } from "../../src/mcp"
import { Permission } from "../../src/permission"
import {
  AlphaToolPolicy,
  deriveBindingDigest,
  mcpBindingDigest,
  subjectBindingDigest,
} from "../../src/permission/alpha-tool-policy"
import { AlphaToolPolicyGate } from "../../src/permission/alpha-tool-policy-gate"
import { Plugin } from "../../src/plugin"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Provider } from "../../src/provider/provider"
import { SessionID } from "../../src/session/schema"
import { Skill } from "../../src/skill"
import { TaskTool } from "../../src/tool/task"
import { testEffect } from "../lib/effect"

const INJECTION_MODULE = path.resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "ui-mac",
  "src",
  "main",
  "alpha-config-injection.ts",
)
const { injectAlphaConfig } = (await import(INJECTION_MODULE)) as {
  injectAlphaConfig: (userDataPath: string) => { ok: boolean }
}

// 期限在 beforeAll 里压到 300ms、afterAll 还原(模块顶层赋值会串到同进程的别的文件)。
const TEST_TIMEOUT_MS = 30_000
const MANAGED = [
  "ALPHA_GLOBAL_DIR",
  "XDG_CONFIG_HOME",
  "ALPHA_OPENCODE_HOME",
  "XDG_DATA_HOME",
  "OPENCODE_CONFIG_CONTENT",
  "ALPHA_PERMISSION_ASK_TIMEOUT_MS",
] as const
const saved: Record<string, string | undefined> = {}
let tmp = ""
beforeAll(() => {
  for (const k of MANAGED) saved[k] = process.env[k]
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alpha-1573-matrix-")))
  process.env.ALPHA_GLOBAL_DIR = path.join(tmp, "alpha-code-state", "env", "dev")
  process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg")
  process.env.ALPHA_OPENCODE_HOME = path.join(tmp, "opencode-home")
  process.env.XDG_DATA_HOME = path.join(tmp, "xdg-data")
  delete process.env.OPENCODE_CONFIG_CONTENT
  process.env.ALPHA_PERMISSION_ASK_TIMEOUT_MS = "300"
  const userData = path.join(tmp, "userdata")
  for (const d of [
    process.env.ALPHA_GLOBAL_DIR,
    process.env.XDG_CONFIG_HOME,
    process.env.ALPHA_OPENCODE_HOME,
    process.env.XDG_DATA_HOME,
    userData,
  ])
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
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Permission.node,
      AlphaToolPolicy.node,
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
  ),
)

// 三档的载体(列序 = 方案表的列序)。
const TIERS = ["build", "codepuppy-ask", "codepuppy-readonly"] as const
type Tier = (typeof TIERS)[number]
type Verdict = "PASS" | "ASK" | "DENY"
type Row = readonly [Verdict, Verdict, Verdict]

const ruleset = (tier: Tier) =>
  Effect.gen(function* () {
    const agent = yield* (yield* Agent.Service).get(tier)
    if (!agent) throw new Error(`agent "${tier}" is not injected`)
    return agent.permission
  })

const classify = (exit: Exit.Exit<unknown, unknown>): Verdict | string => {
  if (Exit.isSuccess(exit)) return "PASS"
  const error = Cause.squash(exit.cause)
  if (error instanceof Permission.UnansweredError) return "ASK"
  if (error instanceof PermissionV1.DeniedError) return "DENY"
  return `OTHER: ${Cause.pretty(exit.cause).split("\n")[0]}`
}

let seq = 0
const sid = () => SessionID.make(`ses_1573_matrix_${++seq}`)

/** 能力轴一问(工具体内 `ctx.ask` 的形状)。 */
const ability = (tier: Tier, permission: string, pattern: string) =>
  Effect.gen(function* () {
    const perm = yield* Permission.Service
    return yield* perm
      .ask({
        sessionID: sid(),
        permission,
        patterns: [pattern],
        always: [pattern],
        metadata: {},
        ruleset: yield* ruleset(tier),
      })
      .pipe(Effect.exit)
  })

/** 身份轴一问(session/tools.ts 的 identityGate 调的同一个闸:decide → 钩子 → confirm;规则层没有钩子)。 */
const identity = (tier: Tier, subject: ToolPolicySubject) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const gate = {
      policy: yield* AlphaToolPolicy.Service,
      subject: Effect.succeed(subject),
      ruleset: yield* ruleset(tier),
    }
    return yield* AlphaToolPolicyGate.decide(gate).pipe(
      Effect.flatMap((decision) =>
        AlphaToolPolicyGate.confirm(decision, {
          ...gate,
          permission,
          sessionID: sid(),
          tool: { messageID: "msg_1573_matrix", callID: `call_1573_matrix_${seq}` },
          metadata: {},
        }),
      ),
      Effect.exit,
    )
  })

/** 内置/宿主工具一次调用:先身份轴(包在执行外层),再能力轴(工具体内)。 */
const call = (tier: Tier, subject: ToolPolicySubject | undefined, permission: string, pattern: string) =>
  Effect.gen(function* () {
    if (subject) {
      const gate = yield* identity(tier, subject)
      if (!Exit.isSuccess(gate)) return classify(gate)
    }
    return classify(yield* ability(tier, permission, pattern))
  })

/** 逐档跑一格,打印一行实测记录(PR / 日志里直接读得到)。 */
const row = (label: string, cell: (tier: Tier) => Effect.Effect<Verdict | string, never, any>) =>
  Effect.gen(function* () {
    const out: (Verdict | string)[] = []
    for (const tier of TIERS) out.push(yield* cell(tier))
    console.log(`MATRIX ${label}: ${out.join(" | ")}`)
    return out
  })

const builtin = (name: string): ToolPolicySubject =>
  AlphaToolPolicyGate.builtinSubject({ source: "builtin", origin: "", name }, { kind: "not-asserted" })
const host = (name: string): ToolPolicySubject =>
  AlphaToolPolicyGate.builtinSubject({ source: "host", origin: "", name }, { kind: "not-asserted" })

// ── R9/R10/R11 的生产形状主体 ────────────────────────────────────────────────────────────────────────
const CLOUD_URL = "https://api.codepuppy.example/mcp"
/** 注入面写进 `ALPHA_CLOUD_MCP_DEF` 的那份(`{file:}` 引用,真 materializeCloudMcpConfig)。 */
const CLOUD_DEF = materializeCloudMcpConfig(CLOUD_URL, "{file:/userdata/secrets/ALPHA_MCP_TOKEN}")
/** 引擎装载后的 entry:`ConfigVariable.substitute` 已把引用换成令牌字面量(方案 §1.6 生产分支)。 */
const CLOUD_ENTRY = { ...CLOUD_DEF, headers: { Authorization: "Bearer test-mcp-access-token" } }
const CLOUD_ENV = { ALPHA_CLOUD_MCP_SERVER: "cloud", ALPHA_CLOUD_MCP_DEF: JSON.stringify(CLOUD_DEF) }
const THIRD_PARTY_ENTRY = { type: "remote" as const, url: "https://mcp.vendor.example/v1", oauth: false as const }

const mcpSubject = (
  origin: string,
  name: string,
  entry: typeof CLOUD_ENTRY | typeof THIRD_PARTY_ENTRY,
): ToolPolicySubject => ({
  identity: { source: "mcp", origin, name },
  authority: authorityForMcp(origin, entry, CLOUD_ENV),
  bindingDigest: mcpBindingDigest(origin, entry),
})
const CLOUD = mcpSubject("cloud", "cloud_dispatch", CLOUD_ENTRY)
const THIRD_PARTY = mcpSubject("vendor", "create_issue", THIRD_PARTY_ENTRY)
const PLUGIN: ToolPolicySubject = {
  identity: { source: "plugin", origin: "acme", name: "search" } satisfies ToolIdentity,
  authority: { kind: "not-asserted" },
  bindingDigest: deriveBindingDigest({ kind: "plugin-loader", origin: "acme", generation: 1 }),
}
const canonical = (subject: ToolPolicySubject) => canonicalToolIdentity(subject.identity)

const tableHides = (tier: Tier, tools: readonly string[]) =>
  Effect.gen(function* () {
    return [...Permission.disabled(tools, yield* ruleset(tier))].sort()
  })

it.instance(
  "R1–R5 内置读 / 工作区外 / .env / 改文件 / 运行命令",
  () =>
    Effect.gen(function* () {
      expect(yield* row("R1 read src/index.ts", (t) => call(t, builtin("read"), "read", "src/index.ts"))).toEqual([
        "PASS",
        "PASS",
        "PASS",
      ] satisfies Row)
      expect(
        yield* row("R2 external_directory", (t) =>
          call(t, builtin("read"), "external_directory", "/Users/nobody/Downloads/*"),
        ),
      ).toEqual(["ASK", "ASK", "DENY"] satisfies Row)
      expect(yield* row("R3 read .env", (t) => call(t, builtin("read"), "read", "app/.env"))).toEqual([
        "ASK",
        "ASK",
        "DENY",
      ] satisfies Row)
      expect(yield* row("R4 edit", (t) => call(t, builtin("edit"), "edit", "src/index.ts"))).toEqual([
        "PASS",
        "ASK",
        "DENY",
      ] satisfies Row)
      expect(yield* row("R5 bash", (t) => call(t, builtin("bash"), "bash", "ls"))).toEqual([
        "PASS",
        "ASK",
        "DENY",
      ] satisfies Row)
      // R4/R5 只读格「且不进工具表」;另两档不藏。
      expect(yield* tableHides("codepuppy-readonly", ["apply_patch", "bash", "edit", "write"])).toEqual([
        "apply_patch",
        "bash",
        "edit",
        "write",
      ])
      expect(yield* tableHides("codepuppy-ask", ["apply_patch", "bash", "edit", "write"])).toEqual([])
      expect(yield* tableHides("build", ["apply_patch", "bash", "edit", "write"])).toEqual([])
    }),
  { git: true },
  TEST_TIMEOUT_MS,
)

it.instance(
  "R6a–R6d 委派:派给其它助手 全部批准放行 / 请求审批询问 / 只读拒绝;派给同档自身放行;task 工具三档都留在表里",
  () =>
    Effect.gen(function* () {
      const task = (target: string) => (t: Tier) => call(t, builtin(TaskTool.id), TaskTool.id, target)
      // R6a 模型派子任务(task.ts 的 ctx.ask:patterns = [subagent_type])。
      expect(yield* row("R6a task general", task("general"))).toEqual(["PASS", "ASK", "DENY"] satisfies Row)
      expect(yield* row("R6a task explore", task("explore"))).toEqual(["PASS", "ASK", "DENY"] satisfies Row)
      // R6b 点名助手:prompt.ts E2 用同一条求值决定跳不跳过 task 的询问 —— 只有 allow 才跳。
      const evaluate = (target: string) =>
        Effect.gen(function* () {
          const out: string[] = []
          for (const t of TIERS) out.push(Permission.evaluate(TaskTool.id, target, yield* ruleset(t)).action)
          console.log(`MATRIX R6b evaluate task ${target}: ${out.join(" | ")}`)
          return out
        })
      expect(yield* evaluate("general")).toEqual(["allow", "ask", "deny"])
      // R6c 命令自带其它助手(E4 的目标 = 命令的 agent,例如 build)。
      expect(yield* row("R6c task build", task("build"))).toEqual(["PASS", "ASK", "DENY"] satisfies Row)
      // R6d 直接子任务:目标是本档 ⇒ 放行(以只读档运行的 /review),其它助手同 R6a。
      expect(yield* call("codepuppy-readonly", builtin(TaskTool.id), TaskTool.id, "codepuppy-readonly")).toBe("PASS")
      expect(yield* call("codepuppy-ask", builtin(TaskTool.id), TaskTool.id, "codepuppy-ask")).toBe("PASS")
      expect(yield* evaluate("codepuppy-readonly")).toEqual(["allow", "ask", "allow"])
      // task 工具三档都留在表里(只读档按 pattern 判,不整把移除),否则同档子任务也派不出去。
      for (const t of TIERS) expect(yield* tableHides(t, [TaskTool.id])).toEqual([])
    }),
  { git: true },
  TEST_TIMEOUT_MS,
)

it.instance(
  "R7–R8 本机网页/搜索、宿主工具(MCP 资源)三档放行",
  () =>
    Effect.gen(function* () {
      expect(
        yield* row("R7 webfetch", (t) => call(t, builtin("webfetch"), "webfetch", "https://example.com/doc")),
      ).toEqual(["PASS", "PASS", "PASS"] satisfies Row)
      expect(yield* row("R7 websearch", (t) => call(t, builtin("websearch"), "websearch", "bun test docs"))).toEqual([
        "PASS",
        "PASS",
        "PASS",
      ] satisfies Row)
      expect(
        yield* row("R8 list_mcp_resources", (t) => call(t, host("list_mcp_resources"), "read", "mcp:cloud:*")),
      ).toEqual(["PASS", "PASS", "PASS"] satisfies Row)
      expect(
        yield* row("R8 read_mcp_resource", (t) => call(t, host("read_mcp_resource"), "read", "mcp:cloud:*")),
      ).toEqual(["PASS", "PASS", "PASS"] satisfies Row)
    }),
  { git: true },
  TEST_TIMEOUT_MS,
)

it.instance(
  "R9–R11 云 / 第三方 MCP / 插件:默认询问三档都问;设置里启用后前两档放行,只读档仍问(AC4)",
  () =>
    Effect.gen(function* () {
      const policy = yield* AlphaToolPolicy.Service
      console.log(`MATRIX R9 cloud authority (from production-shaped DEF): ${CLOUD.authority.kind}`)
      for (const [label, subject] of [
        ["R9 cloud", CLOUD],
        ["R10 third-party", THIRD_PARTY],
        ["R11 plugin", PLUGIN],
      ] as const) {
        // 状态一:设置为默认询问(无记录 ⇒ 文档轴四类默认 ask)。
        expect(yield* row(`${label} default`, (t) => identity(t, subject).pipe(Effect.map(classify)))).toEqual([
          "ASK",
          "ASK",
          "ASK",
        ] satisfies Row)
        // 状态二:设置里已启用(生产写入口 setRecord,tool 层 enabled 带当前 binding digest)。
        yield* policy.setRecord({
          selector: { level: "tool", canonical: canonical(subject) },
          state: "enabled",
          bindingDigest: subjectBindingDigest(subject)!,
        })
        expect(yield* row(`${label} enabled`, (t) => identity(t, subject).pipe(Effect.map(classify)))).toEqual([
          "PASS",
          "PASS",
          "ASK",
        ] satisfies Row)
      }
      // 每一问都收口了,没有残留的待批(ASK 是真问了、到点 fail-closed,不是挂着)。
      expect(yield* (yield* Permission.Service).list()).toEqual([])
    }),
  { git: true },
  TEST_TIMEOUT_MS,
)

it.instance(
  "R12 设置里停用 ⇒ 三档都具名拒绝(内置、MCP、插件各一)",
  () =>
    Effect.gen(function* () {
      const policy = yield* AlphaToolPolicy.Service
      for (const [label, subject] of [
        ["R12 builtin webfetch", builtin("webfetch")],
        ["R12 third-party", THIRD_PARTY],
        ["R12 plugin", PLUGIN],
      ] as const) {
        yield* policy.setRecord({ selector: { level: "tool", canonical: canonical(subject) }, state: "disabled" })
        expect(yield* row(label, (t) => identity(t, subject).pipe(Effect.map(classify)))).toEqual([
          "DENY",
          "DENY",
          "DENY",
        ] satisfies Row)
      }
    }),
  { git: true },
  TEST_TIMEOUT_MS,
)
