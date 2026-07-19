// ext-session-toggle — REQ-104 #408 PR-C:会话开关的**纯派生层**(零 IPC、零样式)。
// 真源:main 内存 grant 登记(window.api.ext.sessionGrants,会话边界 = sidecar 运行期)+
// renderer 本地的连接结果(grant ok ≠ 已连接 —— 连接真伪单独呈现,不谎报)。
// 本层只做展示/路由决策,供 extension-hub / extension-detail 消费与单测。

import type { SessionGrantWire, SessionGrantRefusalCode } from "../../shared/ext-session-grant-wire"

/** grant 的展示键 = (catalogId, directory) —— 与 main 登记处同键(directory 是 enforcement 空间)。 */
export const sessionGrantKeyOf = (catalogId: string, directory: string): string => `${catalogId}\u0000${directory}`

export function findSessionGrant(
  grants: readonly SessionGrantWire[],
  catalogId: string,
  directory: string | undefined,
): SessionGrantWire | undefined {
  if (!directory) return undefined
  return grants.find((g) => g.id === catalogId && g.directory === directory)
}

/** 会话行/详情开关的状态机(grant 在场 = 开;连接结果单独如实呈现):
 *  off            → 开关灭,状态语「每次会话单独开启 · 会话结束自动关闭」
 *  on             → 琥珀开关亮,ok 点,「本次会话已启用 · 会话结束自动关闭」
 *  on-no-link     → 开关亮但连接未成功:warn 点 + 如实提示(绝不把「已授权」谎报成「已连接」) */
export type SessionToggleView = {
  on: boolean
  textKey: "alpha.ext.sessionOffRow" | "alpha.ext.sessionOnRow" | "alpha.ext.sessionOnNoLink"
  tone: "ok" | "warn" | "muted"
}

export function sessionToggleView(
  grant: SessionGrantWire | undefined,
  link: "connected" | "failed" | undefined,
): SessionToggleView {
  if (!grant) return { on: false, textKey: "alpha.ext.sessionOffRow", tone: "muted" }
  if (link === "failed") return { on: true, textKey: "alpha.ext.sessionOnNoLink", tone: "warn" }
  return { on: true, textKey: "alpha.ext.sessionOnRow", tone: "ok" }
}

/** main 拒绝码 → UI 路由(#397 纪律:按机器码路由,不解析 reason;用户语言、零开发术语)。
 *  expired-review = 既有确认对话框(携 confirmExpiredReview 重试);其余 toast。 */
export type SessionRefusalRoute =
  | { kind: "expired-confirm" }
  | { kind: "toast"; tone: "info" | "error"; textKey: "alpha.ext.sessionKindUnsupportedToast" | "alpha.ext.sessionRefusedToast" }

export function sessionRefusalRoute(code: SessionGrantRefusalCode | undefined): SessionRefusalRoute {
  if (code === "expired-review-confirmation-required") return { kind: "expired-confirm" }
  if (code === "session-grant-kind-unsupported")
    return { kind: "toast", tone: "info", textKey: "alpha.ext.sessionKindUnsupportedToast" }
  // 泛拒(未装/身份失配/advisory/目录不可核实…):main reason 已是固定安全文案,UI 统一给
  // 用户语言泛化提示(细节在 main 日志,不进 UI —— 零开发术语)。
  return { kind: "toast", tone: "error", textKey: "alpha.ext.sessionRefusedToast" }
}

/** 引擎 global.disposed 后的 re-assert 计划(Codex 裁决:renderer 消费 disposed 信号重走 grant
 *  通道)。事件带 directory 时只重断言该 instance 空间的 grant;缺失则全量(幂等,grant 通道
 *  即重校验入口)。 */
export function grantsToReassert(
  grants: readonly SessionGrantWire[],
  disposedDirectory: string | undefined,
): SessionGrantWire[] {
  if (!disposedDirectory) return [...grants]
  return grants.filter((g) => g.directory === disposedDirectory)
}
