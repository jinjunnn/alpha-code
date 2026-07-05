---
id: REQ-028
title: composer 真只读档:引擎 plan agent 通道 + 切换 UX
type: feature
priority: P2
status: registered
repo: A
created: 2026-07-05
sprint: —
source: C28 拍板(2026-07-05,S17 T4)拆出
---

## 背景(为什么)
C28 实证:原 PermChip「只读」档与「请求审批」引擎行为完全相同(都只触发 `permissions.autoaccept.disable`),宣称「禁止写/执行」不成立 → 按拍板已移除。**真只读载体存在**:引擎内置 `plan` agent(`agent.ts:157`,`edit "*": deny` + task deny)。本需求 = 把「只读」以真实现形式接回。

## 已勘探的通道(C28 brief F4a/F5)
- ❌ 后台 session 级设置:上游 submit 每次显式带 `draft.agent`(frozen 内部 store)→ 被覆盖;
- ⚠️ `command.trigger("agent.cycle")` 循环切换 + DOM 观察判停:可达但脆——label 文本耦合、受 `settings.visibility.customAgents()` 门控、循环序列含 alpha-automation(ADR-022 primary 注入);
- 🔭 备选:config 注入 alpha 自有 readonly agent(ADR-022 §4 同款静态权限档)+ 同样的 cycle 切换;或等上游出现直设 agent 命令(sync 时复查命令面)。

## 验收标准
1. 选「只读」后,edit/写类操作在会话中**真被 deny**(实测,非文案);
2. 切换失败态诚实呈现(cycle 判停失败 → 明示回退,不装成功);
3. `customAgents` 可见性门控关闭时的行为明确(隐藏档位或提示开启);
4. chip 状态与引擎实际 agent 一致(观察源可靠)。

## 非目标
effort 接入(→ [[REQ-029]]);上游 tabs/prompt store 直连(provider 拓扑不可达,[[alpha-composer-provider-topology]])。

## 关联
[[C28]](拍板来源)· ADR-022 §4(静态权限档先例)· debates/2026-07-05-c28-honest-controls-brief.md(F4a/F5 实证)。

## 验证记录
_verify 时补。_
