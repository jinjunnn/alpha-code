// ext-install-policy(shared)— REQ-104 #395:fresh-intake 初始启用分类的**纯函数真源**
// (#394 裁决 + v5 已批稿 Q1)。main 的落账决策(ext-install-policy.ts 的 nextDesiredState,
// 含既有记录当前策略优先)与 renderer 的安装文案(「已安装但未启用」toast)共用此定义,不得各写一份。
//
//   · 目录安装(origin==="catalog"):source==="alpha"(Alpha 自产)= enabled;其余一律 disabled
//     —— 含 "official":官方出品 ≠ 我们审过,供应链语义按第三方(owner 拍板 Q1 = A)。
//   · 非目录 intake(imported/created/…):enabled —— 用户显式选择的自有内容。
//   · factory 注入零安装不落账,天然绕过。

export type FreshIntakeFacts = {
  /** 落账 origin(catalog / created / imported / imported-claude / imported-agents)。 */
  origin: string
  /** 目录条目 source(official/community/alpha);非目录 intake 缺省。 */
  source?: string
}

export function initialDesiredState(intake: FreshIntakeFacts): "enabled" | "disabled" {
  if (intake.origin !== "catalog") return "enabled"
  return intake.source === "alpha" ? "enabled" : "disabled"
}
