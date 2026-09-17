// north-star:alpha-owned
//
// ADR-045 / alpha-code#427 的前提探针:长期记忆要进对话,v1 引擎(ADR-036 裁定的**唯一**会话发送代次)
// 今天给插件留了哪两条能把一段文本送进 system prompt 的口子,以及它们各自的真实行为。
//
// 这不是 Memory 的功能测试(那归 alpha-code#425 的 wiring test);它钉住的是 ADR-045 据以选路的
// **两条地面真相**,上游 sync 把任何一条改掉,这里先红:
//
//   ① 稳定接缝:插件的 `config` 钩子(非 experimental)可以往**本实例**的 `cfg.instructions[]` 推一条
//      绝对路径;`Instruction.system()`(prompt.ts:1303 每一步都调它)把该文件正文以
//      `Instructions from: <path>\n<body>` 的形状交给 system 段;**文件每次调用都重读**,删掉文件 ⇒
//      下一次调用就不再出现(不重启、不重建 config)—— 这一条正是 AC6/AC8「删除后立即不再进入对话」
//      在引擎侧的物理基础。
//   ② experimental 接缝:`experimental.chat.system.transform` 在装着的这个版本里仍然存在、仍然接受
//      `{ sessionID, model }`(request.ts:74 就是这样调它的)、仍然让插件改写 `output.system[]`。
//      ADR-045 **不**让 Memory 走它(NON_GOALS#4),但把它登记为退路 —— 退路也得先证明还在。
//
// 判据形状照 test/plugin/trigger.test.ts(上游):真 Config、真 Plugin 装载、file:// 插件、临时 instance。
// 不 mock Config —— mock 了就测不出「钩子改的和 Instruction 读的是不是同一个对象」这一格。
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Npm } from "@opencode-ai/core/npm"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Account } from "../../src/account/account"
import { Auth } from "../../src/auth"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin/index"
import { Instruction } from "../../src/session/instruction"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Plugin.node, Instruction.node, CrossSpawnSpawner.node]), [
    [Auth.node, AuthTest.empty],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
    [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true, disableClaudeCodePrompt: true })],
  ]),
)

const SYSTEM_HOOK = "experimental.chat.system.transform"
// 一个仓里别处不会出现的针,含一个故意不存在的假针做对照(证明 includes 不是幻觉命中)。
const MARKER = "ALPHA-427-MEMORY-PROBE: the user prefers tabs over spaces"
const FAKE_MARKER = "ALPHA-427-MEMORY-PROBE-NEVER-WRITTEN"

/** 往临时 instance 写一个 file:// 插件并把它挂进 opencode.json(与上游 trigger.test.ts 同形)。 */
function withPlugin<A, E, R>(source: string, self: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const test = yield* TestInstance
    const file = path.join(test.directory, "plugin.ts")
    yield* Effect.promise(() => Bun.write(file, source))
    yield* Effect.promise(() =>
      Bun.write(
        path.join(test.directory, "opencode.json"),
        JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: [pathToFileURL(file).href] }, null, 2),
      ),
    )
    return yield* self
  })
}

const writeMemoryFile = Effect.fn("probe.writeMemoryFile")(function* () {
  const test = yield* TestInstance
  // 放在 instance 目录**之外**的子目录也行,这里用 instance 下的 alpha-memory-context/ 只为便于清理;
  // 文件名刻意不叫 AGENTS.md / CLAUDE.md —— 它不能经项目 walk-up 那条路进来,只能经 cfg.instructions。
  const dir = path.join(test.directory, "alpha-memory-context")
  const file = path.join(dir, "project-a.md")
  yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
  yield* Effect.promise(() => fs.writeFile(file, `${MARKER}\n`))
  return file
})

const pluginPushingInstruction = (file: string) =>
  [
    "export default async () => ({",
    "  config: async (cfg) => {",
    `    cfg.instructions = [...(cfg.instructions ?? []), ${JSON.stringify(file)}]`,
    "  },",
    "})",
    "",
  ].join("\n")

describe("alpha-code#427 memory injection seam probe (v1 engine, installed version)", () => {
  it.instance(
    "① stable seam: plugin `config` hook → cfg.instructions[] → Instruction.system() carries the file body, re-read per call, gone right after delete",
    () =>
      Effect.gen(function* () {
        const file = yield* writeMemoryFile()
        return yield* withPlugin(
          pluginPushingInstruction(file),
          Effect.gen(function* () {
            const plugin = yield* Plugin.Service
            // 生产顺序:插件装载(含 config 钩子)先于任何一次 prompt step。
            yield* plugin.init()
            const instruction = yield* Instruction.Service

            const first = yield* instruction.system()
            const hits = first.filter((segment) => segment.includes(MARKER))
            expect(hits).toHaveLength(1)
            expect(hits[0]!.startsWith(`Instructions from: ${file}\n`)).toBe(true)
            expect(first.some((segment) => segment.includes(FAKE_MARKER))).toBe(false)

            // 同一实例、不重启、不重建 config:文件一删,下一次调用就读不到。
            yield* Effect.promise(() => fs.rm(file))
            const second = yield* instruction.system()
            expect(second.some((segment) => segment.includes(MARKER))).toBe(false)

            // 再写回去 ⇒ 再出现。证明是**每次调用重读**,不是「删掉后缓存失效」这种一次性行为。
            yield* Effect.promise(() => fs.writeFile(file, `${MARKER}\n`))
            const third = yield* instruction.system()
            expect(third.filter((segment) => segment.includes(MARKER))).toHaveLength(1)
          }),
        )
      }),
  )

  it.instance(
    "① control (known bad): without the config hook the same file is never read — the seam is the hook, not the filename",
    () =>
      Effect.gen(function* () {
        yield* writeMemoryFile()
        return yield* withPlugin(
          "export default async () => ({})\n",
          Effect.gen(function* () {
            const plugin = yield* Plugin.Service
            yield* plugin.init()
            const instruction = yield* Instruction.Service
            const system = yield* instruction.system()
            expect(system.some((segment) => segment.includes(MARKER))).toBe(false)
          }),
        )
      }),
  )

  it.instance(
    "② experimental seam still present: experimental.chat.system.transform receives { sessionID, model } and its output.system edits land",
    () =>
      withPlugin(
        [
          "export default async () => ({",
          `  ${JSON.stringify(SYSTEM_HOOK)}: async (input, output) => {`,
          `    output.system.push(${JSON.stringify(MARKER)})`,
          '    output.system.push("seen-session:" + String(input.sessionID))',
          "  },",
          "})",
          "",
        ].join("\n"),
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          const out = { system: ["base prompt"] }
          // 形参形状与 request.ts:74 逐字相同;上游把 sessionID 从 input 里拿掉,这一行先在 typecheck 上红。
          yield* plugin.trigger(
            SYSTEM_HOOK,
            {
              sessionID: "ses_alpha427probe",
              model: { providerID: ProviderV2.ID.anthropic, modelID: ModelV2.ID.make("claude-sonnet-4-6") },
            },
            out,
          )
          expect(out.system).toEqual(["base prompt", MARKER, "seen-session:ses_alpha427probe"])
        }),
      ),
  )
})
