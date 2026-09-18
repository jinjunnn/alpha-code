// alpha 自有文件(basename `alpha-*`,ADR-043 因子②;同时住在 ADR-033 §1 收编目录
// `packages/core/src/permission/**` 内)。
//
// REQ-131 / #1130 —— 引擎 tool policy 面(inventory 读 + record 写 + reset)的 **core 侧服务标签**。
// 接缝勘破见 docs/architecture/2026-09-17-tool-policy-transport-seam.md。
//
// 为什么标签住在 core、实现住在 opencode:
//   · 已收编的 v2 permission handler(`packages/server/src/handlers/permission.ts`)只能 import
//     core / protocol / schema(`packages/server/package.json` 的依赖面),拿不到 opencode 的标签;
//   · 而实现(`packages/opencode/src/permission/alpha-tool-inventory.ts` 的 `bridge`)依赖
//     ToolRegistry / MCP / Config / AlphaToolPolicy,全是 opencode 的实例态服务。
// 这与上游既有的 `packages/server/src/pty-environment.ts` ↔ `packages/opencode/src/plugin/pty-environment.ts`
// 是同一形态:server/core 侧声明标签与形状,opencode 侧提供实现并用 `InstanceStore.provide`
// 注入 `InstanceRef`。差别只有一处:那对是在 `httpapi/server.ts` 里 `Layer.provide` 进去的
// (上游文件),本标签的实现改由 `app` 组里一个已收编的顶层 node 合成暴露(session/prompt.ts)。
//
// 每个方法都按 v2 location 的 `directory` 解析引擎实例 —— 策略文档按 (account, workspace) 分区
// (#1128 §5),没有实例就没有分区,所以 directory 不是可选项。
import { Context, Effect, Schema } from "effect"
import type { ToolPolicyInventoryV1 } from "@opencode-ai/schema/alpha-tool-inventory"
import type { ToolPolicyRecord, ToolPolicySelector } from "@opencode-ai/schema/alpha-tool-policy"

/**
 * 写侧失败的 wire 前形态。`quarantined` = 文档待恢复,必须先 reset(handler 映射 409);
 * `io` = 落盘失败(handler 映射 500)。两者都不是「静默成功」。
 */
export class WriteError extends Schema.TaggedErrorClass<WriteError>()("AlphaToolPolicyApi.WriteError", {
  kind: Schema.Literals(["quarantined", "io"]),
  message: Schema.String,
}) {}

export interface Interface {
  readonly list: (input: { readonly directory: string }) => Effect.Effect<ToolPolicyInventoryV1>
  readonly setRecord: (input: {
    readonly directory: string
    readonly record: ToolPolicyRecord
  }) => Effect.Effect<void, WriteError>
  readonly removeRecord: (input: {
    readonly directory: string
    readonly selector: ToolPolicySelector
  }) => Effect.Effect<void, WriteError>
  readonly reset: (input: { readonly directory: string }) => Effect.Effect<{ readonly backup?: string }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/AlphaToolPolicyApi") {}

export * as AlphaToolPolicyApi from "./alpha-tool-policy-api"
