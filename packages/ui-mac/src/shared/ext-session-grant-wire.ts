// #408(REQ-104):session-grant 会话级启用的 IPC wire 契约(preload/types 与 main 共用)。
//
// 语义(Codex 裁决 2026-07-18):
//   · 时间边界 = 当前 embedded sidecar 的一次连续运行(exit / 主动 kill / respawn / 崩溃均结束
//     全部 grant);grant 纯 main 内存(sidecar 代际栅栏),**零持久面** —— 不写账本、不写
//     config、不进注入 env(#397 注入面对 session-grant 恒 disabled 的不变量原样保持)。
//   · enforcement 空间 = directory(引擎 MCP 热状态属 per-directory InstanceState):授予/撤销/
//     re-assert 都必须操作同一 directory;同一条目在多个 directory 激活 = 多条 grant 记录。
//   · 生效 = renderer 在 ok 后对同 directory 调引擎 POST /mcp/:name/connect(原生热连);
//     引擎 global.disposed 后 renderer 须经 grant 通道 re-assert(重校验失败即开关回落,
//     绝不静默保持「已启用」)。
//   · 本票只支持 kind=mcp(引擎唯一的瞬态激活面);agent/skill/plugin 一律
//     `session-grant-kind-unsupported`。

export type SessionGrantWire = {
  /** catalog entry id(全局账本 catalog 记录的 id)。 */
  id: string
  kind: "mcp"
  name: string
  /** 授予时冻结的安装版本(身份四元组的一部分;re-assert 重校验同口径)。 */
  version: string
  /** 引擎 instance 空间(绝对路径)—— connect/status/disconnect/re-assert 必须同 directory。 */
  directory: string
  grantedAt: string
}

/** 机器可判别拒绝码(renderer 据此路由确认对话/诚实文案,不解析 reason 字符串 —— #397 纪律)。 */
export type SessionGrantRefusalCode =
  /** 复审过期:带 confirmExpiredReview:true 重试(合同 §7.2「新启用需显式确认」,含会话启用)。 */
  | "expired-review-confirmation-required"
  /** 非 mcp 条目:引擎无瞬态激活面,本票如实拒绝(不假生效、不落盘绕行)。 */
  | "session-grant-kind-unsupported"
  /** 其余一切 fail-closed 拒绝(未安装/身份失配/advisory/未策展/会话已结束…),reason 带详情。 */
  | "session-grant-refused"

export type SessionGrantResultWire =
  | { ok: true; grant: SessionGrantWire }
  | { ok: false; reason: string; code: SessionGrantRefusalCode }

/** 会话结束事件载荷(main → renderer):收到即把全部会话开关归位(grant 已整体失效)。 */
export type SessionGrantsEndedEventWire = { reason: "sidecar-stop" | "sidecar-exit" }
