---
id: D8
title: DB WAL 周期 TRUNCATE(上游,处置决策)
type: debt
priority: P3
status: rejected
repo: A
created: 2026-07-03
sprint: —
source: 册 §6.4 / R2(上游)
---

## 背景/证据
WAL 仅在 open 时 PASSIVE checkpoint,无周期 TRUNCATE(长会话 WAL 常驻 ~4MB)。DB 层在上游(R2)。

## 验收标准
1. 影响评估(4MB 级常驻是否值得动作);
2. 决策记录:接受,或 alpha 侧在 B14 备份动作前后顺带 checkpoint(纯 SQL,不改上游代码);
3. 结论并入 B14 或关闭本条。

## 关联
B14、B13、R2 归属纪律。
