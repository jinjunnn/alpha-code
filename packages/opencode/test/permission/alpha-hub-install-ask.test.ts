// REQ-234 `#1531` I3 / I7 —— 「agent 请求安装 ⇒ 确认框一定会出现」在**引擎层**真的成立(alpha 自有测试;north-star:alpha-owned)。
//
// 为什么要这道闸:引擎默认规则是 `"*": "allow"`(agent/agent.ts),alpha 的默认配置也只把 edit / bash 改成 ask。工具里那句
// `ctx.ask({ permission: "hub_install" })` 在默认配置下**直接放行、不发布任何审批请求** —— renderer 那边就没有框可弹
// (基线 §2.3 / 审计 R1 第 1 条)。修法是 @alpha-code/ext 的 config 钩子在每次实例重建时把 `hub_install: ask` 钉到全局与每个
// agent 的末位(自动化 agent 钉 deny)。这里证明的是**引擎真的会问**,判据全部走生产:
//   · 真 `injectAlphaConfig`(ui-mac 主进程写给引擎的那份默认配置,带上 ext 插件路径 —— 与 sidecar fork 时同一调用);
//   · 引擎真 Plugin 服务装载**真 @alpha-code/ext**(源码入口)并跑它的 config 钩子(与 bootstrap.ts 同序:先 init 插件再读 agent);
//   · 真 `Permission.Service.ask`(与工具拿到的 `ctx.ask` 同一个服务),`ALPHA_PERMISSION_ASK_TIMEOUT_MS=300` 让「真的在等人批」
//     以具名 UnansweredError 落地。
// Npm 换成 noop(同 agent/plugin-agent-regression.test.ts):装载插件时引擎会为每个配置目录跑一次后台 npm 安装并让第一次
// 插件初始化等它 —— 那是网络,不是本判据(process-fence-engine.test.ts 的 60 秒假红就是它)。
//
// 每条判据先证明手段测得出已知的坏:
//   对照臂(不装 ext = 拿掉钉子)build + hub_install ⇒ 直接放行(passed-through)—— 这就是钉子要修的缺陷本身;
//   被测臂(装 ext)build + hub_install ⇒ UnansweredError(真的发布了请求、没人批、fail-closed);
//   alpha-automation + hub_install ⇒ DeniedError(无人值守的 agent 不弹一个没人看的框);
//   I7:回复 always 放行了这一次,下一次同一条目照样要问(always: [] ⇒ 不产生抵消后续请求的 grant)。
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Npm } from "@opencode-ai/core/npm"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { afterAll, beforeAll, expect } from "bun:test"
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
import { NpmTest } from "../fake/npm"
import { testEffect } from "../lib/effect"

// 生产注入函数经非字面量路径动态 import(理由同 alpha-composer-tiers.test.ts:不把 ui-mac main 的类型图拖进本包 typecheck)。
const INJECTION_MODULE = path.resolve(import.meta.dir, "..", "..", "..", "ui-mac", "src", "main", "alpha-config-injection.ts")
type InjectAlphaConfig = (userDataPath: string, extPluginPath?: string) => { ok: boolean }
const { injectAlphaConfig } = (await import(INJECTION_MODULE)) as { injectAlphaConfig: InjectAlphaConfig }
/** 真 @alpha-code/ext 的源码入口(bun 直接装载 TS;打包后是同一模块的自包含 bundle)。 */
const EXT_PLUGIN = path.resolve(import.meta.dir, "..", "..", "..", "ext", "src", "plugin.ts")

const TEST_TIMEOUT_MS = 300
process.env["ALPHA_PERMISSION_ASK_TIMEOUT_MS"] = String(TEST_TIMEOUT_MS)

const MANAGED = ["ALPHA_GLOBAL_DIR", "XDG_CONFIG_HOME", "ALPHA_OPENCODE_HOME", "XDG_DATA_HOME", "OPENCODE_CONFIG_CONTENT"] as const
const saved: Record<string, string | undefined> = {}
let tmp = ""
let userData = ""
beforeAll(() => {
  for (const k of MANAGED) saved[k] = process.env[k]
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alpha-1531-hub-ask-")))
  process.env.ALPHA_GLOBAL_DIR = path.join(tmp, "alpha-code-state", "env", "dev")
  process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg")
  process.env.ALPHA_OPENCODE_HOME = path.join(tmp, "opencode-home")
  process.env.XDG_DATA_HOME = path.join(tmp, "xdg-data")
  userData = path.join(tmp, "userdata")
  for (const d of [process.env.ALPHA_GLOBAL_DIR, process.env.XDG_CONFIG_HOME, process.env.ALPHA_OPENCODE_HOME, process.env.XDG_DATA_HOME, userData])
    fs.mkdirSync(d, { recursive: true })
})
afterAll(() => {
  for (const k of MANAGED) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** 本条用例的默认配置:每条用例在**读配置之前**重新注入一次(带或不带 ext)。 */
const injectDefaults = (withExt: boolean) =>
  Effect.sync(() => {
    delete process.env.OPENCODE_CONFIG_CONTENT
    const res = injectAlphaConfig(userData, withExt ? EXT_PLUGIN : undefined)
    if (!res.ok) throw new Error(`injectAlphaConfig failed: ${JSON.stringify(res)}`)
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
  ]),
  [
    [InstanceStore.bootstrapNode, noopBootstrap],
    [Npm.node, NpmTest.noop],
    [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })],
  ],
)
const it = testEffect(env)

/** 与 bootstrap.ts 同序:先 init 插件(ext 的 config 钩子在这里改 cfg),再读 agent 的规则集。 */
const loadPlugins = Effect.gen(function* () {
  const plugin = yield* Plugin.Service
  yield* plugin.init()
})

const rulesetOf = (name: string) =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const agent = yield* agents.get(name)
    if (!agent) throw new Error(`agent "${name}" is not injected`)
    return agent.permission
  })

type Verdict = { kind: "passed-through" } | { kind: "unanswered" } | { kind: "denied" } | { kind: "other"; detail: string }

/** 真 Permission.ask,载荷与 hub_install 工具的 ctx.ask 同形(always 恒空)。 */
const askHubInstall = (agentName: string, catalogId: string, sid: string) =>
  Effect.gen(function* () {
    const ruleset = yield* rulesetOf(agentName)
    const permission = yield* Permission.Service
    const exit = yield* permission
      .ask({
        sessionID: SessionID.make(sid),
        permission: "hub_install",
        patterns: [catalogId],
        always: [],
        metadata: { alphaHub: { catalogId, requestId: `req_${sid}` } },
        ruleset,
      })
      .pipe(Effect.exit)
    const verdict: Verdict = Exit.isSuccess(exit)
      ? { kind: "passed-through" }
      : Cause.squash(exit.cause) instanceof Permission.UnansweredError
        ? { kind: "unanswered" }
        : Cause.squash(exit.cause) instanceof PermissionV1.DeniedError
          ? { kind: "denied" }
          : { kind: "other", detail: Cause.pretty(exit.cause).split("\n")[0] ?? "" }
    console.log(`ASK ${agentName} hub_install ${JSON.stringify(catalogId)} -> ${verdict.kind}`)
    return verdict
  })

it.instance(
  "对照臂(拿掉钉子):不装 ext 的默认配置下,build 的 hub_install 直接放行 —— 不发布请求、没有框",
  () =>
    Effect.gen(function* () {
      yield* injectDefaults(false)
      yield* loadPlugins
      expect(yield* askHubInstall("build", "mcp:github", "ses_1531_control")).toEqual({ kind: "passed-through" })
    }),
  { git: true },
)

it.instance(
  "I3:装上真 ext 的默认配置下,build 的 hub_install 真的进待批(UnansweredError);alpha-automation 是 deny",
  () =>
    Effect.gen(function* () {
      yield* injectDefaults(true)
      yield* loadPlugins
      expect(yield* askHubInstall("build", "mcp:github", "ses_1531_build")).toEqual({ kind: "unanswered" })
      expect(yield* askHubInstall("alpha-automation", "mcp:github", "ses_1531_auto")).toEqual({ kind: "denied" })
      const permission = yield* Permission.Service
      expect(yield* permission.list()).toHaveLength(0)
    }),
  { git: true },
)

it.instance(
  "I7:回复 always 只放行这一次 —— 下一次同一条目的 hub_install 照样要问",
  () =>
    Effect.gen(function* () {
      yield* injectDefaults(true)
      yield* loadPlugins
      const ruleset = yield* rulesetOf("build")
      const permission = yield* Permission.Service
      const sessionID = SessionID.make("ses_1531_always")
      const first = yield* permission
        .ask({ sessionID, permission: "hub_install", patterns: ["mcp:github"], always: [], metadata: { alphaHub: { catalogId: "mcp:github", requestId: "req_always_1" } }, ruleset })
        .pipe(Effect.forkScoped)
      const pending = yield* Effect.gen(function* () {
        while (true) {
          const list = yield* permission.list()
          if (list.length > 0) return list
          yield* Effect.sleep("5 millis")
        }
      }).pipe(
        Effect.timeoutOrElse({
          duration: TEST_TIMEOUT_MS,
          orElse: () => Effect.fail(new Error("hub_install 没有进入 pending —— 它没有在问")),
        }),
      )
      expect(pending[0]!.permission).toBe("hub_install")
      expect(pending[0]!.metadata).toMatchObject({ alphaHub: { catalogId: "mcp:github", requestId: "req_always_1" } })
      yield* permission.reply({ requestID: pending[0]!.id, reply: "always" })
      expect(Exit.isSuccess(yield* Fiber.await(first))).toBe(true)
      expect(yield* askHubInstall("build", "mcp:github", "ses_1531_always")).toEqual({ kind: "unanswered" })
    }),
  { git: true },
)
