---
id: B22
title: message-timeline.tsx:481 会话时间线崩溃(先复验再修)
type: bug
priority: P1
status: ready
repo: A
created: 2026-07-03
sprint: —
source: 册 §7b(06-30 flag,PR#18/19/20 未涉)
---

## 背景/证据
上游 virtualizer memo 崩溃,疑被 alpha `timeline-inject` DOM 注入扰动 → 会话主界面崩溃级。546-commit upstream sync(2026-07-03)后**尚未代码复验**——上游可能已改该文件,现症可能变化。

## 验收标准
1. 546-sync 后复现测试:确认崩溃是否仍在(记录复现步骤或「无法复现」证据);
2. 仍在则修复:timeline-inject 与上游 virtualizer memo 兼容(遵守 ADR-016 CSS-only 优先纪律);
3. 回归用例进 qa(长会话滚动/流式中滚动);
4. 崩溃时上游 ErrorBoundary 呈现已去 OpenCode 化(C29 已修)复核。

## 关联
C14(注入耦合面)、C29、REQ-005(timeline 验收同场)。
