// REQ-131 / #1130 —— Settings「工具」节的 IPC wire(main ↔ preload ↔ renderer)。
//
// 数据形状**不在这里重述**:inventory / record / selector 全部是引擎 wire 契约
// (`@opencode-ai/schema/alpha-tool-inventory` / `alpha-tool-policy`)的类型再导出,renderer 与
// main 拿到的就是引擎 decode 过的那份;本文件只补 IPC 一层的结果包装(成功 / 稳定失败码)。
// 失败码是闭集且不携带路径、栈或引擎原文 —— renderer 只需要决定「显示哪句人话」。
import type {
  EffectiveToolPolicyReasonV1,
  EffectiveToolPolicyV1,
  ToolPolicyInventoryServiceV1,
  ToolPolicyInventoryToolV1,
  ToolPolicyInventoryV1,
} from "@opencode-ai/schema/alpha-tool-inventory"
import type {
  ToolClass,
  ToolPolicyRecord,
  ToolPolicySelector,
  ToolPolicyState,
} from "@opencode-ai/schema/alpha-tool-policy"

export type {
  EffectiveToolPolicyReasonV1,
  EffectiveToolPolicyV1,
  ToolClass,
  ToolPolicyInventoryServiceV1,
  ToolPolicyInventoryToolV1,
  ToolPolicyInventoryV1,
  ToolPolicyRecord,
  ToolPolicySelector,
  ToolPolicyState,
}

/**
 * 读侧失败:
 *  · `engine-unavailable` —— 引擎进程还没就绪 / 已退出;
 *  · `not-wired`          —— 引擎回 503:这台引擎没接 tool policy 面(standalone server);
 *  · `invalid-shape`      —— 引擎回了 200 但形状不合 wire 契约(main 侧再 decode 一次自证);
 *  · `request-failed`     —— 传输失败或其它非 2xx。
 * 四种都 fail-closed:renderer 不显示任何清单、也不放宽任何工具。
 */
export type ToolPolicyReadFailureCode = "engine-unavailable" | "not-wired" | "invalid-shape" | "request-failed"

export type ToolPolicyInventoryResult =
  | { ok: true; inventory: ToolPolicyInventoryV1 }
  | { ok: false; code: ToolPolicyReadFailureCode }

/**
 * 写侧失败(在读侧之上再加三种):
 *  · `quarantined`    —— 引擎回 409:策略文档待恢复,先「重置为安全默认」;
 *  · `invalid-record` —— 引擎回 400:记录不合 schema(例:service 层 enabled 未带 bindingDigest);
 *  · `write-failed`   —— 引擎回 500:落盘失败。
 */
export type ToolPolicyWriteFailureCode = ToolPolicyReadFailureCode | "quarantined" | "invalid-record" | "write-failed"

export type ToolPolicyWriteResult = { ok: true } | { ok: false; code: ToolPolicyWriteFailureCode }

export type ToolPolicyResetResult =
  | { ok: true; backup?: string }
  | { ok: false; code: ToolPolicyReadFailureCode | "write-failed" }

export type ToolPolicyApi = {
  inventory: (input: { directory: string }) => Promise<ToolPolicyInventoryResult>
  setRecord: (input: { directory: string; record: ToolPolicyRecord }) => Promise<ToolPolicyWriteResult>
  removeRecord: (input: { directory: string; selector: ToolPolicySelector }) => Promise<ToolPolicyWriteResult>
  reset: (input: { directory: string }) => Promise<ToolPolicyResetResult>
}
