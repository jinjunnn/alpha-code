---
id: C28
title: placebo 控件诚实化 + 崩溃屏接管设计(边界下沉)
type: ux
priority: P2
status: in-sprint
repo: A
created: 2026-07-03
sprint: 2026-07-05-s17-deep-decisions
source: 册 §7b / §7h(顶层边界已证伪撤回)/ §7i
---

## 背景/证据
① placebo 控件:composer「只读」映射到 autoaccept-off(opencode 无运行时只读)、effort(低/中/高/超高)按注释可能不改推理——用户可见控件静默不做其宣称的事;② 崩溃屏:顶层 ErrorBoundary 方案**已实测证伪撤回**(上游 `@opencode-ai/app` 自带更内层边界,alpha 顶层永不生效,册 §7h);品牌部分已由 C29 修。剩余=若要 alpha 分支型崩溃恢复,边界须下沉到 AppInterface 内紧裹 alpha children。

## 验收标准
1. 「只读」「effort」两控件:行为与宣称一致(真实现/改文案/移除,三选一,逐个决策记录);
2. 崩溃屏接管出设计结论:下沉边界方案(位置/恢复交互)或「接受上游边界(已去品牌)」,二选一记录;
3. 若做下沉边界:强制 throw 注入实测 alpha 边界先于上游命中(册 §7h 的失败教训 = 必须比上游更内层)。

## 关联
C29(已修品牌角)、upstream-crash-screen-errorboundary(memory)、A5(版本显示已修)。
