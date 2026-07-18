// ext-install-policy(shared)— REQ-104 #395/#397:fresh-intake 初始启用分类的**纯函数真源**。
// main 的落账决策(main/ext-install-policy.ts nextDesiredState,含既有记录当前策略优先)与
// renderer 的安装文案(「已安装但未启用」toast)共用此定义,不得各写一份。
//
// 优先序(#397 Codex 裁决钉死,逐条测试):
//   1. 目录安装(origin==="catalog")且携带**有效** curation activationPolicy → 按声明
//      (CONTRACT §3:显式声明,禁止从 tier/type 推导):
//        · session-grant → disabled(持久账本永不 enabled;会话级启用机制 = #408)
//        · reviewExpired(复审过期,排他截止)→ 一律先落 disabled,启用走显式确认(§7.2)
//        · default-enabled → enabled(合同保证仅 core 可携带)
//        · default-disabled → disabled
//   2. 否则 #395 原规则(未策展 / curation fail-closed 的永久兜底,#394 裁决 + v5 已批稿 Q1):
//        · cloud 例外恒 enabled(无本地运行面,receipts-only,UI 无启停开关 —— 默认关是
//          无法启用的死态;Codex r1 Major 2)
//        · 非目录 intake(imported/created/…)= enabled(用户显式选择的自有内容)
//        · 目录安装 source==="alpha"(Alpha 自产)= enabled;其余一律 disabled —— 含
//          "official":官方出品 ≠ 我们审过,供应链语义按第三方(owner 拍板 Q1 = A)
//   3. factory 注入零安装不落账,天然绕过。
// activationPolicy 只能来自 decodeEntryCuration 采信后的 curation(合同 §7.1 行 5);
// 未策展/校验失败不得携带此字段 —— 缺省即保守面。

import type { ActivationPolicy } from "./catalog-curation"

export type FreshIntakeFacts = {
  /** 落账 origin(catalog / created / imported / imported-claude / imported-agents)。 */
  origin: string
  /** 目录条目 source(official/community/alpha);非目录 intake 缺省。 */
  source?: string
  /** 扩展类型 —— cloud 例外的判定输入(Codex r1 Major 2)。 */
  kind?: string
  /** #397:有效 curation 的显式启用声明(仅 decodeEntryCuration 采信后传入)。 */
  activationPolicy?: ActivationPolicy
  /** #397:review.reviewBefore 已过期(排他截止)—— fresh install 一律先落 disabled。 */
  reviewExpired?: boolean
}

export function initialDesiredState(intake: FreshIntakeFacts): "enabled" | "disabled" {
  // #397 规则 1:目录条目的有效声明优先于一切来源推断(声明是合同面,cloud 例外亦让位)。
  if (intake.origin === "catalog" && intake.activationPolicy !== undefined) {
    if (intake.activationPolicy === "session-grant") return "disabled"
    if (intake.reviewExpired) return "disabled"
    return intake.activationPolicy === "default-enabled" ? "enabled" : "disabled"
  }
  // #395 规则 2(保守面,逐字保留)。
  if (intake.kind === "cloud") return "enabled"
  if (intake.origin !== "catalog") return "enabled"
  return intake.source === "alpha" ? "enabled" : "disabled"
}
