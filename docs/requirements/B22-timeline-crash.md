---
id: B22
title: message-timeline.tsx:481 会话时间线崩溃(先复验再修)
type: bug
priority: P1
status: parked
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

## 复验记录(2026-07-04,/loop — 代码级复验;真机复现待批)
546-sync 后**代码级**复验(验收①要求的真机复现仍需真机,离线不可做):
- 崩溃点 `packages/app/src/pages/session/timeline/message-timeline.tsx:481` 现为 `virtualItemByKey` createMemo(`@tanstack/solid-virtual` 的 key→virtualItem 映射)。上游该文件 546-sync 后已变动,**原始崩溃现症/行号可能已不同** → 验收①「是否仍在」必须真机跑一次才能定。
- **疑源收敛**(alpha `timeline-inject.tsx` 对上游 Solid 虚拟行的 DOM 注入 vs virtualizer 行回收/reconcile):
  1. `decorateDirOutput`(:134)`display:none` 隐藏 Solid 子节点 + append 自有 grid —— **最可疑**(改了 Solid 拥有的子树,virtualizer 回收该行 `removeChild` 时可能对不上 → `NotFoundError`);
  2. `decorateTurns`(:366)在 `session-turn` 的 parent 里 `insertBefore` divider —— 动了 virtualizer 容器的直接子节点,风险次高;
  3. 各 `insertBefore/appendChild` 进虚拟行内 trigger/content(decorate/BashExit/foldCommand)—— 改行内部,风险较低。
- **修复方向(待真机复现确认后)**:注入只进 alpha 完全拥有的 wrapper、绝不重排 Solid 子节点;实测崩溃后加 try/catch 防御性 removeChild;CSS-only 可行处优先(ADR-016)。
- **为何不无人值守修**:崩溃类修复必须能复现才能证明修好;盲改可能修了不存在的崩溃(上游已变)或引入新崩溃。→ 真机批(REQ-005/REQ-016 时间线同场)。
