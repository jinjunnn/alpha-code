// #1578 AC5(REQ-236 §2.6-7,编排器 2026-10-30 裁决沿用 owner「路一」)—— 随应用交付的第一方扩展插件,只有受信随包清单
// 列出的自有工具、且装载端核验模块摘要一致时,authority 才是 alpha-bundled;项目插件合并进来的工具、摘要不符或不在
// 清单里的工具仍是 not-asserted。工具保留插件来源(identity.source = plugin)。
//
// 链路全是生产的:真 Plugin layer 按路径插件装载一个文件(spec = 绝对路径,与 main 注入 ext 的形状相同)→ 真
// ToolRegistry 铸 binding → 真 SessionTools.resolve 在注册咽喉写显示快照(随首个 ToolPart 持久化的那一份)。
// 被装载的插件模仿 ext 的结构:自有工具 + 用 ext 真 `mergeHooks`(packages/ext/src/plugin-fanout.ts)并进来的
// 「项目插件」工具(一个与自有工具同名、一个新名字)。清单按 ext 构建写出的形状手写(packages/ext/scripts/build.ts:
// 模块 sha256 + 自有工具名),经 main 注入的那一个 env 键指过去。
//
// 删掉行为时会红的那一处写在每条用例上方。本文件 alpha 自有(`alpha-*`,ADR-043)。

import { afterEach, describe, expect } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { ModelV2 } from "@opencode-ai/core/model"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { ToolDisplaySnapshotV1 } from "@opencode-ai/schema/tool-identity"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { AlphaToolPolicy } from "@/permission/alpha-tool-policy"
import { Plugin } from "@/plugin"
import { bundledPluginTools, EXT_BUNDLED_MANIFEST_ENV } from "@/plugin/alpha-bundled-plugin"
import type { Provider } from "@/provider/provider"
import { MessageID, SessionID } from "@/session/schema"
import type { Session } from "@/session/session"
import type { SessionProcessor } from "@/session/processor"
import { SessionTools } from "@/session/tools"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import type { TaskPromptOps } from "@/tool/task"
import { TestConfig } from "../fixture/config"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const FANOUT = path.join(import.meta.dir, "..", "..", "..", "ext", "src", "plugin-fanout.ts")
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alpha-1578-plugin-")))

/** 一个「随包扩展」:自有 alpha_echo / alpha_ping,外加经 ext 真 mergeHooks 并进来的项目插件 alpha_echo(同名)与 lint_project。 */
function writeExtension() {
  const dir = path.join(scratch, crypto.randomUUID(), "alpha-ext")
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "plugin.js")
  fs.writeFileSync(
    file,
    [
      `import { mergeHooks } from ${JSON.stringify(pathToFileURL(FANOUT).href)}`,
      "const own = { tool: {",
      "  alpha_echo: { description: 'own echo', args: {}, execute: async () => 'OWN' },",
      "  alpha_ping: { description: 'own ping', args: {}, execute: async () => 'pong' },",
      "} }",
      "const project = { tool: {",
      "  alpha_echo: { description: 'project echo', args: {}, execute: async () => 'PROJECT' },",
      "  lint_project: { description: 'project lint', args: {}, execute: async () => 'lint' },",
      "} }",
      "export default async () => mergeHooks(own, [project])",
      "",
    ].join("\n"),
  )
  return file
}

/** ext 构建写出的清单形状;`extraByte` = 清单证明的是比装载的模块多一个字节的那份内容。 */
function writeManifest(plugin: string, tools: string[], options: { extraByte?: boolean; dir?: string } = {}) {
  const dir = options.dir ?? path.join(scratch, crypto.randomUUID())
  fs.mkdirSync(dir, { recursive: true })
  const bytes = Buffer.concat([fs.readFileSync(plugin), Buffer.from(options.extraByte ? " " : "")])
  const file = path.join(dir, "bundled-tools.json")
  fs.writeFileSync(file, JSON.stringify({ moduleSha256: createHash("sha256").update(bytes).digest("hex"), tools }))
  return file
}

let pluginSpec = ""
let policyAccount = "anonymous"
const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      ToolRegistry.node,
      MCP.node,
      Agent.node,
      Permission.node,
      AlphaToolPolicy.node,
      Plugin.node,
      Truncate.node,
      RuntimeFlags.node,
    ]),
    [
      [
        Config.node,
        TestConfig.layer({
          get: () =>
            Effect.sync(() => ({ plugin_origins: [{ spec: pluginSpec, source: "OPENCODE_CONFIG_CONTENT", scope: "global" as const }] })),
        }),
      ],
      [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true, experimentalCodeMode: false })],
      [AlphaToolPolicy.node, AlphaToolPolicy.layer({ account: Effect.sync(() => policyAccount) })],
    ],
  ),
)

const saved = process.env[EXT_BUNDLED_MANIFEST_ENV]
afterEach(async () => {
  await disposeAllInstances()
  if (saved === undefined) delete process.env[EXT_BUNDLED_MANIFEST_ENV]
  else process.env[EXT_BUNDLED_MANIFEST_ENV] = saved
})

/** 生产注册咽喉:真 SessionTools.resolve,记下每个工具写进显示快照的那一份。 */
const resolveSnapshots = Effect.gen(function* () {
  policyAccount = `t-${crypto.randomUUID()}`
  const displays = new Map<string, ToolDisplaySnapshotV1>()
  const agents = yield* Agent.Service
  yield* SessionTools.resolve({
    agent: yield* agents.defaultInfo(),
    model: {
      id: ModelV2.ID.make("test-model"),
      providerID: ProviderV2.ID.make("test"),
      api: { id: "test-model" },
      capabilities: { toolcall: true },
    } as unknown as Provider.Model,
    session: {
      id: SessionID.create(),
      projectID: ProjectV2.ID.make("alpha-1578"),
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    } as unknown as Session.Info,
    processor: {
      message: { id: MessageID.ascending() },
      updateToolCall: () => Effect.void,
      completeToolCall: () => Effect.void,
      registerToolDisplay: (technicalId: string, display: ToolDisplaySnapshotV1) => displays.set(technicalId, display),
    } as unknown as Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall" | "registerToolDisplay">,
    bypassAgentCheck: false,
    messages: [],
    promptOps: {} as TaskPromptOps,
  })
  const registry = yield* ToolRegistry.Service
  const descriptions = new Map((yield* registry.all()).map((tool) => [tool.id, tool.description]))
  return { displays, descriptions }
})

const NOT_ASSERTED = { kind: "not-asserted" }

describe("#1578 AC5 first-party extension plugin tools", () => {
  // 删掉 registry 里按清单给 authority(或 plugin/index.ts 里的核验)⇒ alpha_echo / alpha_ping 回到 not-asserted,当场红;
  // 把核验改成「插件名单里有就给」而不看清单 ⇒ lint_project 也被铸,当场红。
  it.instance("listed own tools of a module whose digest matches get alpha-bundled; the merged-in project tool does not", () =>
    Effect.gen(function* () {
      const plugin = writeExtension()
      pluginSpec = plugin
      process.env[EXT_BUNDLED_MANIFEST_ENV] = writeManifest(plugin, ["alpha_echo", "alpha_ping"])
      const { displays, descriptions } = yield* resolveSnapshots
      for (const name of ["alpha_echo", "alpha_ping"]) {
        const display = displays.get(name)!
        expect(display.identity).toEqual({ source: "plugin", origin: plugin, name })
        expect(display.authority).toEqual({
          kind: "alpha-bundled",
          bindingId: "plugin:alpha-ext",
          evidenceDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        })
        expect(display.location).toEqual({ kind: "local" })
      }
      // 项目插件带进来的新工具:同一个扩展的 hooks 里,但不在清单 ⇒ not-asserted,来源仍是这个插件。
      expect(displays.get("lint_project")!.identity).toEqual({ source: "plugin", origin: plugin, name: "lint_project" })
      expect(displays.get("lint_project")!.authority).toEqual(NOT_ASSERTED)
      // 项目插件的同名 alpha_echo 进不来:合并时自有键优先,带 alpha-bundled 的那一个是扩展自己的定义。
      expect(descriptions.get("alpha_echo")).toBe("own echo")
    }),
  )

  // 把摘要比较删掉 ⇒ 这里两个自有工具也被铸,当场红。
  it.instance("a manifest attesting a module one byte different proves nothing", () =>
    Effect.gen(function* () {
      const plugin = writeExtension()
      pluginSpec = plugin
      process.env[EXT_BUNDLED_MANIFEST_ENV] = writeManifest(plugin, ["alpha_echo", "alpha_ping"], { extraByte: true })
      const { displays } = yield* resolveSnapshots
      for (const name of ["alpha_echo", "alpha_ping", "lint_project"]) expect(displays.get(name)!.authority).toEqual(NOT_ASSERTED)
    }),
  )

  // 插件不能替自己作证:没有 main 注入的 env 时,放在插件旁边、摘要正确的清单不被读取。
  it.instance("without the injected manifest env, a correct manifest next to the plugin is not consulted", () =>
    Effect.gen(function* () {
      const plugin = writeExtension()
      pluginSpec = plugin
      writeManifest(plugin, ["alpha_echo", "alpha_ping", "lint_project"], { dir: path.dirname(plugin) })
      delete process.env[EXT_BUNDLED_MANIFEST_ENV]
      const { displays } = yield* resolveSnapshots
      for (const name of ["alpha_echo", "alpha_ping", "lint_project"]) expect(displays.get(name)!.authority).toEqual(NOT_ASSERTED)
    }),
  )
})

// 装载端的结构化 source:npm 包即使字节与清单一致也不是随包扩展(不按 origin 字符串或安装路径判断)。
describe("#1578 AC5 loader source", () => {
  it.live("an npm-sourced module with matching bytes is not bundled; the same bytes as a file plugin are", () =>
    Effect.sync(() => {
      const plugin = writeExtension()
      const env = { [EXT_BUNDLED_MANIFEST_ENV]: writeManifest(plugin, ["alpha_ping"]) }
      expect(bundledPluginTools({ source: "npm", entry: pathToFileURL(plugin).href }, env, fs.readFileSync)).toBeUndefined()
      expect(bundledPluginTools({ source: "file", entry: pathToFileURL(plugin).href }, env, fs.readFileSync)?.tools).toEqual(
        new Set(["alpha_ping"]),
      )
    }),
  )
})
