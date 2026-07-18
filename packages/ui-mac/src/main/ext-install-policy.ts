// ext-install-policy — REQ-104 #395:fresh-intake 初始启用策略(#394 裁决 + v5 已批稿 Q1)。
//
// 单一分类器,唯一决策点(裁决必改:不得在各 planner 分支散落 source 判断):
//   · 目录安装(origin==="catalog"):source==="alpha"(Alpha 自产)= enabled;其余一律 disabled
//     —— 含 "official":官方出品 ≠ 我们审过,供应链语义按第三方(v5 稿 Q1 = A,owner 拍板)。
//   · 非目录 intake(imported/created/imported-claude/imported-agents):enabled —— 用户显式
//     选择的自有内容,不属「第三方非默认启用」面;票面 AC 与已批设计稿均只约束目录安装。
//     (对 #394 裁决字面「其余全部 disabled」的有意收窄:裁决的分析对象是 catalog source,
//     未讨论用户导入的 UX;把用户刚导入的技能默认关掉是惊吓不是防护。合并 review 复核此偏离。)
//   · factory 注入(出厂技能)零安装、不落账,天然绕过本分类器(裁决必改第 6 条)。
//   · 存量不回溯:已有记录的更新/回滚/重装一律「当前策略优先」(nextDesiredState 先查 prior)。
//
// v1→v2 迁移(ext-receipt-v2 migrateReceipt)不经此模块:v1 时代安装本就在跑,迁移如实保留
// enabled(存量不回溯的同一原则)。

import type { DesiredState, InstallRecordV2 } from "./ext-receipt-v2"
import { findRecordV2 } from "./ext-receipt-v2"
import { initialDesiredState, type FreshIntakeFacts } from "../shared/ext-install-policy"

// 纯分类器上移 shared(renderer 安装文案共用同一真源);此处 re-export 保持既有导入面。
export { initialDesiredState, type FreshIntakeFacts } from "../shared/ext-install-policy"

/** 落账用启用态:有既有记录 = 当前策略优先(更新/重装绝不翻用户手动设过的状态);
 *  无记录 = 按 fresh-intake 分类。plan 期读账、锁内提交 —— fresh 场景同名并发装由既有
 *  fresh 门拒绝,窗口内不存在被翻的用户状态。
 *  #397(Codex 裁决必改①):session-grant 在 prior 之前判 —— 持久账本 enabled 的
 *  session-grant 本身非法(会话级启用 = #408 瞬态,绝不落盘),prior 不得把它保留/复活;
 *  prior 只对 default-enabled/default-disabled(及未策展保守面)保留。 */
export function nextDesiredState(root: string, kind: InstallRecordV2["kind"], name: string, intake: FreshIntakeFacts): DesiredState {
  if (intake.origin === "catalog" && intake.activationPolicy === "session-grant") return "disabled"
  const prior = findRecordV2(root, kind, name)
  if (prior) return prior.desiredState
  // kind 由本函数补入(cloud 例外判定,Codex r1 Major 2)—— 调用方无须逐点携带。
  return initialDesiredState({ ...intake, kind })
}
