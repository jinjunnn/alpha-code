---
id: B14
title: 会话 DB 备份/导出(损坏恢复路径)
type: feature
priority: P1
status: archived
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

## 实施与验证记录(2026-07-05,S17 T3 shipped)
- **备份引擎**(验收①):readonly 会话 `VACUUM INTO` + **必验**(integrity_check==ok 且水位可读,验不过即删产物)——实证 `-readonly` 下 `.backup` 会 exit 0 但不写文件(静默假成功),故形态与验证均为硬要求;滚动保 5 份于 `<userData>/alpha-db-backups/`;自动触发 = pre-migration 时点(引擎将前进迁移前,降级逃生快照)。
- **导出**(验收②):「数据」菜单 → save dialog → VACUUM INTO 用户路径 + 同套验证(整库文件级)。
- **损坏恢复**(验收③):启动预检检出损坏(exit 26 签名)→ 对话框指向最近备份〔恢复/退出/仍要启动〕;恢复=损坏件改名保留 + WAL 残件连带隔离(防污染)+ 备份复制回位——不再是裸「服务启动失败」。
- **验收④(与 C16/C17 同屏)**:C17 预检已同 PR 联动;设置页数据管理同屏入口随 C16(S17 stretch)落,本批入口=应用菜单。
- 34 单测(含真 sqlite3 集成:备份→轮转→恢复往返);**verified 待真机**(菜单实操 + 原生对话框演练 → 真机批)。
