---
id: C17
title: schema 版本兼容守卫(旧 app × 新 DB 预检)
type: debt
priority: P2
status: archived
repo: A
created: 2026-07-03
sprint: 2026-07-05-s17-deep-decisions
source: 册 §6.3 / R2(上游 DB)
status_note: 2026-07-07 在场批打包态真机 verified(退出路径单列观察);证据 audits/2026-07-07-inperson-batch
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

## 实施与验证记录(2026-07-05,S17 T3 shipped)
- **设计**:[designs/2026-07-05-db-safety-belt.md](../designs/2026-07-05-db-safety-belt.md)(机制事实 F1–F7 全实证:水位=`migration` 表 id;app 支持面=`migration.gen.ts` 清单≡迁移文件名;`applyOnly` 不查未知 id——风险代码级确认)。
- **实现**:`ui-mac/src/main/db-safety.ts`(纯核)+ `db-safety-boot.ts`(electron 接线)+ 构建期 `gen-db-expected.ts`(支持面 JSON 进包,零运行时 import core,硬约束②)。初次 spawn 前预检:超前 → 阻断对话框〔退出推荐/备份后继续/直接继续〕(验收①,不静默继续);将前进 → pre-migration 自动备份;守卫故障 fail-open。
- **验收③(降级场景)fixture 级已验**:34 单测含真 sqlite3 集成——构造含未知迁移 id 的库 → `db-ahead` 判定 + 损坏签名(exit 26)+ 恢复往返。**打包态对话框演练(原生 UI,CDP 拍不到)→ 真机批残单**;verified 届时翻。
- 验收②(恢复路径)= 损坏检出即指向最近备份恢复(B14 联动),已落地同 PR。
