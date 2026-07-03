---
id: C22
title: 依赖漏洞治理(bun audit 158:2 critical / 45 high)
type: debt
priority: P2
status: registered
repo: A
created: 2026-07-03
sprint: —
source: 册 §6.3 / R6(发布面小)
---

## 背景/证据
`bun audit` 全仓 158(2 critical/45 high),多数在 docs/云-dev 工具链;发布相关的少数中,vite dev-server 系列仅 `bun run dev` 期暴露,打包 app 不触发。

## 验收标准
1. 复扫并按「发布产物 / dev-only / 上游锁定」分桶,产暴露面清单;
2. critical/high 且进发布产物的逐条处置(升级/豁免理由);
3. 定期复扫机制(发版 checklist 一项,挂 B7);
4. 上游 catalog 锁定的版本不擅自 bump(NON_GOALS 技术约束),记录等上游。

## 关联
B7(发版 checklist)、NON_GOALS(catalog 版本纪律)。
