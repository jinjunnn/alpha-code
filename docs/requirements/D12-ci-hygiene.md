---
id: D12
title: CI 卫生:上游 cron workflow 在 fork 禁用 + lint gate + e2e 范围
type: debt
priority: P3
status: ready
repo: A
created: 2026-07-03
sprint: —
source: 册 §7b(核查扫漏)
---

## 背景/证据
~20+ 继承的上游 cron workflow 在 fork 误触(`beta`/`publish` 卡 queued = Actions 分钟燃烧 + 潜在误发布);全仓无 lint gate;e2e 仅 `packages/app`。注意:**不能编辑上游 workflow 文件**(北极星)——用仓库 Actions 设置禁用或 fork 检测条件天然失败。

## 验收标准
1. 上游 cron workflow 在本 fork 不再消耗 Actions 分钟(仓库设置逐个 disable,记录清单;不改 yml 文件);
2. 误发布风险确认封死(publish 类 workflow 无凭证即失败的现状取证);
3. lint gate 决策(采用与否 + 范围)记录;e2e 范围现状记录(alpha 自有面用 bun test 覆盖即可,不复活上游 e2e)。

## 关联
B18(alpha-ci 已建)、B10(守卫)、ADR-005(不改上游文件)。
