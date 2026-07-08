---
id: B13
title: DB 跨进程并发(SQLITE_BUSY → orDie)处置决策
type: debt
priority: P1
status: rejected
repo: A
created: 2026-07-03
sprint: —
source: 册 §6.2 / R2 / R6(降级)
---

## 背景/证据
上游 DB 层 `orDie`(`database.ts:27-36`),跨进程锁缺失;dev/packaged 不撞库靠 appId 归一 + 单实例锁的巧合;独立 opencode CLI、孤儿 sidecar 可绕过。R6 降级:`busy_timeout=5000` + WAL + 单实例锁 → 真并发写崩溃是低概率;orDie 只包 layer-open+migration。**上游归属(R2),alpha 无直接修点。**

## 验收标准
1. 并发场景清单文档化(CLI 同库、孤儿 sidecar、多渠道)+ 各自实际风险评估;
2. 决策记录:接受(靠 busy_timeout/单实例锁)或 alpha 侧启动锁探测(检测他进程占库时诚实提示);
3. 与 B14(备份)联动:崩溃后有恢复路径。

## 关联
B14、C17、D8(同 DB 域)、R2 归属纪律。
