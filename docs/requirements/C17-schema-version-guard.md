---
id: C17
title: schema 版本兼容守卫(旧 app × 新 DB 预检)
type: debt
priority: P2
status: registered
repo: A
created: 2026-07-03
sprint: —
source: 册 §6.3 / R2(上游 DB)
---

## 背景/证据
旧 app 打开被新版迁移过的 DB 无检测(`migration.ts:43-80` applyOnly),新 `NOT NULL` 列破坏旧写入;无 app↔DB 版本校验。DB 层在上游(R2);alpha 可做**启动前版本预检**(纯文件/PRAGMA 读取)。

## 验收标准
1. 启动时读 DB migration 水位 vs app 内嵌 server 支持范围,超前则诚实提示(建议升级 app / 指向备份),不静默继续;
2. 与 B14 备份联动:预检失败时给恢复路径;
3. 降级场景实测:新 DB + 旧 app 不再未定义行为。

## 关联
B13、B14、A4(版本链)、opencode-channel-db-persistence(memory)。

## 跳过记录(2026-07-04,/loop 自动批 — deferred)
本轮跳过(非干净小修):①「app 内嵌 server 支持的 migration 范围」判定需内省上游 migration 列表 = **上游 DB 内部耦合**(R2),水位读法与「支持范围」需设计;③「新 DB × 旧 app 不再未定义行为」需构造降级场景 = 近真机验证;且与 B14 备份联动。→ 需先定「支持范围探测」设计 + 耦合评估 + 场景测试,非无人值守简单批。
