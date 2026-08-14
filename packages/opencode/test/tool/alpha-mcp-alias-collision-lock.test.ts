// #726 —— MCP 别名双射(基线 I1)的**装配级**反向判据。
//
// 大白话:MCP 服务器的工具要拼成一个模型看得见的名字,拼法把非 `[a-zA-Z0-9_-]` 的字符
// 全换成 `_`,所以 `foo.bar` 与 `foo_bar` 会拼成同一个名字 —— 后写的把先写的悄悄顶掉,
// 模型以为在调 A、实际调的是 B。这个洞已由 ADR-041 / #878 修好(三个装配点各建一本
// 「别名↔身份」账本,撞车当场抛 ToolAliasCollisionError)。
//
// 但**判据**当时留在了账本类上:唯一断言碰撞的用例是把 ToolAliasLedger 手工 `new` 出来测的,
// 从来没走过 `MCP.tools()`。把 `packages/opencode/src/mcp/index.ts` 里那行
// `aliases.add(alias, identity)` 删掉(返回值本来就丢弃、`packages/opencode` 不在任何 alpha
// typecheck 面内、没有任何测试喂得进碰撞),全仓仍然全绿 —— 也就是说那道闸门是假的。
// 本文件把判据挪到**生产咽喉**:起真的 MCP server、走真的 `MCP.tools()` 与真的 Code Mode
// 目录生成,断言碰撞在**装配时**响亮失败。
//
// 保证本身(删掉本文件会失去什么):
//   · 删掉 `mcp/index.ts` 的 `aliases.add(alias, identity)` ⇒ 不再有任何东西变红;
//   · 把「碰撞时覆盖」换成「碰撞时静默丢弃其中一个」⇒ 同样不再有东西变红
//     (所以断言收到 `ToolAliasCollisionError` **且错误里两个 canonical identity 都在**,
//      而不是只断「抛了」或「工具数变少了」—— 后两者粒度比缺陷粗一格);
//   · Code Mode 若另立一条不走账本的 catalog 路径 ⇒ 不再有东西变红;
//   · `groupByServer` 若改回「按最长 server 名前缀把别名拆回去」⇒ server `foo` 会整台从
//     目录里消失、它的工具被挂到 `foo_bar` 名下,而没有任何东西变红(2026-07-31 勘破 §3)。
//
// 两条写法上的纪律:
//   · 期望值一律**手写字面量**(`"mcp:foo:bar_baz"`),不从生产常量 import —— 后者是自指
//     等价链,改错生产的编码规则仍然全绿。
//   · 负向对照(「几乎撞但不撞」)必须在:没有它,一个「无条件抛」的实现能让全部正向用例
//     变绿,而所有用户的 MCP 工具全挂。
//
// 本文件是 alpha 自有新增文件,对 north-star 守卫是 `A`(新增),不触发 `--diff-filter=DMR`;
// 零改动任何上游生产文件。它登记在 `scripts/gate-files.tsv`(未登记 = 在 alpha 门里一条都
// 不跑 = 又一个假绿),文件名带 `lock` 因而同时落进 `gate-file-registry` 的「命名命中闸门词
// 必须已分类」那条:登记行被删掉时也会当场红。
//
// 基线:docs/design/2026-07-31-tool-identity-baseline.md 的 I1 行。

import path from "node:path"
import { afterEach, describe, expect } from "bun:test"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { ListToolsRequestSchema, type Tool as MCPToolDef } from "@modelcontextprotocol/sdk/types.js"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Cause, Effect, Exit } from "effect"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "@/mcp"
import { ToolRegistry } from "@/tool/registry"
import { TestConfig } from "../fixture/config"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/**
 * 一台**真的** streamable-HTTP MCP server,`tools/list` 回给定的工具名。
 * 形状照 mcp lifecycle 那套夹具(真 `Server` + `WebStandardStreamableHTTPServerTransport`
 * + `Bun.serve({ port: 0 })`,整体包在 `Effect.acquireRelease` 里)。
 *
 * 为什么不手搓一个 `Record<string, McpTool>` 喂给内层函数:那正是本票之所以未完成的形态
 * —— 自己拼一条等价链,删掉生产接线仍然全绿。工具名必须由**服务器自己在线上发布**,
 * 这也是第三方唯一能单方面控制、不需要用户改配置的那一半。
 *
 * `inputSchema` 是 MCP SDK `ToolSchema` 的必填字段,而我们的 `TolerantListToolsResultSchema`
 * 只放松了 `outputSchema`:少写它的话客户端解析当场抛,`McpCatalog.defs` 把错误吞成
 * `Effect.void`,最后 `MCP.tools()` 返回 `{}` —— 红的样子会被读成「账本没被调用」。
 */
function collidingServer(names: readonly string[]) {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const listed: MCPToolDef[] = names.map((name) => ({
        name,
        description: `remote ${name}`,
        inputSchema: { type: "object", properties: {} },
      }))
      const protocol = new Server(
        { name: "alpha-alias-collision", version: "1.0.0" },
        { capabilities: { tools: {} } },
      )
      protocol.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools: listed }))
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
      })
      await protocol.connect(transport)
      const http = Bun.serve({ port: 0, fetch: (request) => transport.handleRequest(request) })
      return {
        url: http.url.toString(),
        close: async () => {
          await protocol.close().catch(() => {})
          http.stop(true)
        },
      }
    }),
    (server) => Effect.promise(server.close),
  )
}

const remote = (url: string) => ({ type: "remote" as const, url, oauth: false as const })

/**
 * 断言:这次装配**响亮失败**,失败的是别名双射校验,而且错误里**两个 canonical identity
 * 都点了名**。返回 message 供调用方再断具体字面量。
 *
 * 为什么不止断布尔:一个「碰撞时静默丢掉其中一个」的错误实现同样不会覆盖,却仍然让模型
 * 拿不到被丢掉的那个工具 —— 用户可观察的行为仍然是错的。只断「抛了」或「工具少了」会放它过去。
 */
function collisionMessage(exit: Exit.Exit<unknown, unknown>): string {
  expect(Exit.isFailure(exit)).toBe(true)
  if (!Exit.isFailure(exit)) throw new Error("expected a failed Exit")
  const squashed = Cause.squash(exit.cause)
  expect(squashed).toBeInstanceOf(Error)
  const error = squashed as Error
  expect(error.name).toBe("ToolAliasCollisionError")
  return error.message
}

const it = testEffect(LayerNode.compile(MCP.node))

const codeModeReplacements = [
  [
    Config.node,
    TestConfig.layer({
      directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".opencode")])),
    }),
  ],
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalCodeMode: true })],
] as const

// `MCP.node` 必须**显式进 group**:`LayerNode.compile` 的依赖走 `Layer.provide`,不把依赖
// 暴露到成功类型里,所以只 group `[ToolRegistry.node, Agent.node]` 的话上下文里没有
// `MCP.Service`,装不上碰撞 server。compile 内部的共享 cache 保证被 group 暴露的这份
// 与 ToolRegistry 自己消费的是**同一个** MCP 实例。
// 这里刻意**不** mock `MCP.Service`:mock 掉之后删生产接线仍然全绿,那就又是一道假闸门。
const withCodeMode = testEffect(
  LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node, MCP.node]), codeModeReplacements),
)

afterEach(async () => {
  await disposeAllInstances()
})

describe("MCP 别名碰撞在装配时 fail-closed (#726 / 基线 I1)", () => {
  it.instance("同一台 server 同时发布 foo.bar 与 foo_bar ⇒ MCP.tools() 当场失败", () =>
    Effect.gen(function* () {
      const server = yield* collidingServer(["foo.bar", "foo_bar"])
      const mcp = yield* MCP.Service
      yield* mcp.add("srv", remote(server.url))

      const message = collisionMessage(yield* mcp.tools().pipe(Effect.exit))
      expect(message).toContain("mcp:srv:foo.bar")
      expect(message).toContain("mcp:srv:foo_bar")
    }),
  )

  it.instance("两台 server a.b 与 a_b 各发布 x ⇒ MCP.tools() 当场失败", () =>
    Effect.gen(function* () {
      const dotted = yield* collidingServer(["x"])
      const underscored = yield* collidingServer(["x"])
      const mcp = yield* MCP.Service
      yield* mcp.add("a.b", remote(dotted.url))
      yield* mcp.add("a_b", remote(underscored.url))

      const message = collisionMessage(yield* mcp.tools().pipe(Effect.exit))
      expect(message).toContain("mcp:a.b:x")
      expect(message).toContain("mcp:a_b:x")
    }),
  )

  it.instance("边界歧义 (foo, bar_baz) vs (foo_bar, baz) ⇒ MCP.tools() 当场失败", () =>
    Effect.gen(function* () {
      const shortName = yield* collidingServer(["bar_baz"])
      const longName = yield* collidingServer(["baz"])
      const mcp = yield* MCP.Service
      yield* mcp.add("foo", remote(shortName.url))
      yield* mcp.add("foo_bar", remote(longName.url))

      const message = collisionMessage(yield* mcp.tools().pipe(Effect.exit))
      expect(message).toContain("mcp:foo:bar_baz")
      expect(message).toContain("mcp:foo_bar:baz")
    }),
  )

  it.instance("近似但不碰撞的一对必须双双存活,且各自带住自己的身份", () =>
    Effect.gen(function* () {
      const shortName = yield* collidingServer(["bar_baz"])
      const longName = yield* collidingServer(["other"])
      const mcp = yield* MCP.Service
      yield* mcp.add("foo", remote(shortName.url))
      yield* mcp.add("foo_bar", remote(longName.url))

      const tools = yield* mcp.tools()
      expect(Object.keys(tools).sort()).toEqual(["foo_bar_baz", "foo_bar_other"])
      expect(tools["foo_bar_baz"]?.identity).toEqual({ source: "mcp", origin: "foo", name: "bar_baz" })
      expect(tools["foo_bar_other"]?.identity).toEqual({ source: "mcp", origin: "foo_bar", name: "other" })
    }),
  )

  withCodeMode.instance("Code Mode 走同一咽喉:两台碰撞 server ⇒ ToolRegistry.tools() 当场失败", () =>
    Effect.gen(function* () {
      const shortName = yield* collidingServer(["bar_baz"])
      const longName = yield* collidingServer(["baz"])
      const mcp = yield* MCP.Service
      yield* mcp.add("foo", remote(shortName.url))
      yield* mcp.add("foo_bar", remote(longName.url))

      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const exit = yield* registry
        .tools({
          providerID: ProviderV2.ID.opencode,
          modelID: ModelV2.ID.make("test"),
          agent: yield* agents.defaultInfo(),
        })
        .pipe(Effect.exit)

      const message = collisionMessage(exit)
      expect(message).toContain("mcp:foo:bar_baz")
      expect(message).toContain("mcp:foo_bar:baz")
    }),
  )

  withCodeMode.instance("Code Mode 近似不碰撞:两台 server 在目录里各占独立命名空间", () =>
    Effect.gen(function* () {
      const shortName = yield* collidingServer(["bar_baz"])
      const longName = yield* collidingServer(["other"])
      const mcp = yield* MCP.Service
      yield* mcp.add("foo", remote(shortName.url))
      yield* mcp.add("foo_bar", remote(longName.url))

      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const tools = yield* registry.tools({
        providerID: ProviderV2.ID.opencode,
        modelID: ModelV2.ID.make("test"),
        agent: yield* agents.defaultInfo(),
      })

      const execute = tools.find((tool) => tool.id === "execute")
      expect(execute?.description).toContain("tools.foo.bar_baz(")
      expect(execute?.description).toContain("tools.foo_bar.other(")
    }),
  )
})
