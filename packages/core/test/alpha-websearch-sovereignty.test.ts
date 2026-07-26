// #223 R3 Blocker 1 —— V2 Core `websearch` 副本的主权最终闸,走**真实 V2 链路**回归。
//
// 打包 sidecar 的 HttpApi 同时挂载 V2 Session 路由与 Location 服务
// (`packages/opencode/src/server/routes/instance/httpapi/server.ts`),`location-services.ts`
// 装载 `BuiltInTools`,于是 `packages/core/src/tool/websearch.ts` 是第二份**活的**同名注册。
// R2 只收了 legacy 那一份,R3 因此判 Blocker 1 未闭合。
//
// 这里不测「函数返回什么」,而是把 V2 真实的注册 → `ToolRegistry.materialize()` → `settle()`
// 全链跑一遍(harness 与上游 `tool-websearch.test.ts` 同源),断言:
//   ① 闸开时 settle 结算为模型可见 error,HTTP 客户端一次都没被打到;
//   ② 闸开时 `PermissionV2.assert` 根本没被调用 —— 也就是说没有任何 ruleset/授权能参与决策;
//   ③ 即使 materialize 传入把 websearch 显式 allow 的 ruleset(= 后置 agent/session 授权的
//      V2 等价物),照样拒;
//   ④ fail-closed 取值矩阵:只有缺省/空串/"0" 放行。
//
// 本文件是 alpha 自有的新增文件(不修改上游 `tool-websearch.test.ts`,北极星守卫的
// `--diff-filter=DMR` 对新增文件天然不触发)。

import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { SessionV2 } from "@opencode-ai/core/session"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { WebSearchTool } from "@opencode-ai/core/tool/websearch"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { toolIdentity, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_alpha_websearch_sovereignty")
const payload = (text: string) => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } })

const requests: string[] = []
const assertions: PermissionV2.AssertInput[] = []

afterEach(() => {
  delete process.env[WebSearchTool.LOCAL_WEBSEARCH_DENY_ENV]
  requests.length = 0
  assertions.length = 0
})

const call = (id: string) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "websearch", input: { query: "alpha sovereignty" } },
})

describe("#223 V2 core websearch 主权最终闸(真实 ToolRegistry 链路)", () => {
  const it = harness()

  it.effect("闸关时照常执行并真的出网(基线:这条链是活的)", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toContain("websearch")
      const settled = yield* settleTool(registry, call("live"))
      expect(settled.result).toEqual({ type: "text", value: "live results" })
      expect(requests).toHaveLength(1)
      expect(assertions).toHaveLength(1)
    }),
  )

  it.effect("闸开时结算为模型可见 error,零出网、零 permission 参与", () =>
    Effect.gen(function* () {
      process.env[WebSearchTool.LOCAL_WEBSEARCH_DENY_ENV] = "1"
      const registry = yield* ToolRegistry.Service
      const settled = yield* settleTool(registry, call("denied"))
      expect(settled.result).toEqual({ type: "error", value: WebSearchTool.LOCAL_WEBSEARCH_DENIED_MESSAGE })
      expect(requests).toEqual([])
      // 关键:permission 层根本没被咨询 —— 没有任何 ruleset 或授权能改变这个结果。
      expect(assertions).toEqual([])
    }),
  )

  it.effect("显式 allow 的 ruleset(后置 agent/session 授权的 V2 等价物)也顶不掉", () =>
    Effect.gen(function* () {
      process.env[WebSearchTool.LOCAL_WEBSEARCH_DENY_ENV] = "1"
      const registry = yield* ToolRegistry.Service
      const allowEverything: PermissionV2.Ruleset = [
        { action: "websearch", resource: "*", effect: "deny" },
        { action: "*", resource: "*", effect: "allow" },
        { action: "websearch", resource: "*", effect: "allow" },
      ]
      const materialized = yield* registry.materialize(allowEverything)
      expect(materialized.definitions.map((tool) => tool.name)).toContain("websearch")
      expect((yield* materialized.settle(call("allowed-anyway"))).result).toEqual({
        type: "error",
        value: WebSearchTool.LOCAL_WEBSEARCH_DENIED_MESSAGE,
      })
      expect(requests).toEqual([])
    }),
  )

  for (const [value, denied] of [
    ["", false],
    ["0", false],
    ["1", true],
    ["true", true],
    ["no", true],
    ["false", true],
  ] as const)
    it.effect(`fail-closed 取值矩阵:${JSON.stringify(value)} → ${denied ? "deny" : "allow"}`, () =>
      Effect.gen(function* () {
        process.env[WebSearchTool.LOCAL_WEBSEARCH_DENY_ENV] = value
        const registry = yield* ToolRegistry.Service
        const settled = yield* settleTool(registry, call(`matrix-${value || "empty"}`))
        if (denied) {
          expect(settled.result).toEqual({ type: "error", value: WebSearchTool.LOCAL_WEBSEARCH_DENIED_MESSAGE })
          expect(requests).toEqual([])
        } else {
          expect(settled.result).toEqual({ type: "text", value: "live results" })
          expect(requests).toHaveLength(1)
        }
      }),
    )
})

function harness() {
  const httpLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request.url)
        return HttpClientResponse.fromWeb(request, new Response(payload("live results"), { status: 200 }))
      }),
    ),
  )
  const permission = Layer.succeed(
    PermissionV2.Service,
    PermissionV2.Service.of({
      assert: (input) => Effect.sync(() => assertions.push(input)),
      ask: () => Effect.die("unused"),
      reply: () => Effect.die("unused"),
      get: () => Effect.die("unused"),
      forSession: () => Effect.die("unused"),
      list: () => Effect.die("unused"),
    }),
  )
  const websearchConfig = Layer.succeed(
    WebSearchTool.ConfigService,
    WebSearchTool.ConfigService.of({ provider: "exa", enableExa: true, enableParallel: false }),
  )
  return testEffect(
    AppNodeBuilder.build(
      LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, WebSearchTool.configNode, WebSearchTool.node]),
      [
        [PermissionV2.node, permission],
        [LayerNodePlatform.httpClient, httpLayer],
        [WebSearchTool.configNode, websearchConfig],
        [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      ],
    ),
  )
}
