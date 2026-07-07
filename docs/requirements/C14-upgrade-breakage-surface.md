---
id: C14
title: 升级静默破坏面收敛:薄 re-export 层 + COUPLING 清单机制化
type: debt
priority: P2
status: verified
repo: A
created: 2026-07-03
sprint: 2026-07-03-s11-cloud-loop
source: 册 §6.3 / R7(升级:实际 5-6× 于初报)
---

## 背景/证据
file-diff 守卫看不见的耦合:实测 **232 个** `data-slot/aria-controls` 选择器(688 处)、**16 处 `as any`** 抹 SDK 契约、3 个 warn-only 构建期子串补丁(打偏照发)、base64 路由复刻、`/global/event` 事件字符串。ADR-016 待办①(收敛内部 provider 借用为薄 re-export 层)未建。

## 验收标准
1. `alpha-ui/providers/*` 薄 re-export 层建立:上游内部 context/hook 借用收敛到单处(断则一处断、loud);
2. CSS 选择器 COUPLING 清单机制化:各注入 CSS 顶部清单齐全 + sync 后重指 runbook 写进 PROCESS/DISTRIBUTION(REQ-005 的 timeline 清单是首例);
3. 16 处 `as any` 逐个处置:改正式类型或注释锚定的上游契约(sync 时可 grep 复核);
4. warn-only 补丁(patch-upstream/brand-i18n)打偏时 loud-fail 或 CI 断言命中数。

## 关联
ADR-016 待办①、REQ-005、B10(守卫盲区互补)、ADR-015 合并验证。
