// alpha 自有测试夹具(basename `alpha-*`;ADR-043 谓词因子②)。
//
// #1129:策略文档轴的 **in-memory 句柄** —— 生产的纯合成核 `resolveToolPolicy`(#1128)
// 套一层可变 records。给没有 Instance 的纯 mock rig(code-mode 系列)用:量的是
// 「调用方每次都真的问了这个 resolver」;真 store 的读写/quarantine/分区语义由
// `test/permission/alpha-tool-policy.test.ts` 与 doc-axis 闸(带真 instance)各自钉住。
//
// records 传**可变数组引用**:重读判据(#724 §6 executor 调用时重读)靠调用后改它。
import { Effect, Layer } from "effect"
import type { ToolPolicyRecord } from "@opencode-ai/schema/alpha-tool-policy"
import { AlphaToolPolicy, resolveToolPolicy } from "../../src/permission/alpha-tool-policy"

export function inMemoryToolPolicy(records: ToolPolicyRecord[]): AlphaToolPolicy.Interface {
  const managed = { status: "ok", ruleset: [], sources: [] } as const
  const partition = { account: "anonymous", workspace: "in-memory" }
  const user = () => ({ status: "ok", records: [...records] }) as const
  return {
    resolve: (subject, caps) =>
      Effect.sync(() =>
        resolveToolPolicy({
          subject,
          caps: { managed, entitlement: caps?.entitlement, hardDeny: caps?.hardDeny },
          user: user(),
        }),
      ),
    snapshot: () =>
      Effect.sync(() => ({
        partition,
        managed,
        user: user(),
        load: { status: "ok" as const, doc: { version: 1 as const, partition, records: [...records] } },
      })),
    inspect: () => Effect.die(new Error("inMemoryToolPolicy: not wired in this rig")),
    setRecord: () => Effect.die(new Error("inMemoryToolPolicy: not wired in this rig")),
    removeRecord: () => Effect.die(new Error("inMemoryToolPolicy: not wired in this rig")),
    reset: () => Effect.die(new Error("inMemoryToolPolicy: not wired in this rig")),
  }
}

export function inMemoryToolPolicyLayer(records: ToolPolicyRecord[] = []) {
  return Layer.succeed(AlphaToolPolicy.Service, AlphaToolPolicy.Service.of(inMemoryToolPolicy(records)))
}
