---
id: B14
title: 会话 DB 备份/导出(损坏恢复路径)
type: feature
priority: P1
status: in-sprint
repo: A
created: 2026-07-03
sprint: 2026-07-05-s17-deep-decisions
source: 册 §6.2 / R2
---

## 背景/证据
整个 DB 层 orDie,无 integrity_check/隔离重建/备份副本 → DB 损坏 = 服务启动失败,只能手删文件;无任何会话 export/import。恢复本体在上游改不了(R2);**备份/导出可在 ui-mac main 做纯文件操作**(alpha 自有)。

## 验收标准
1. 定期/手动备份:app 在 DB 关闭态(或 WAL checkpoint 后)复制副本到 userData 备份目录,保留 N 份滚动;
2. 会话导出入口(至少整库文件级导出;结构化导出可后续);
3. 启动检测 DB 打不开时:提示恢复(指向最近备份)而非裸「服务启动失败」;
4. 与 C16(数据清除)、C17(版本预检)入口同屏。

## 关联
B13、C16、C17、B8(运行时管理器可挂此入口)。
