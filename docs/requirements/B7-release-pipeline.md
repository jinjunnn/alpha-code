---
id: B7
title: 发布流水线制度化:CI 断言版本/种子资产/断网首启
type: debt
priority: P1
status: ready
repo: A
created: 2026-07-03
sprint: —
source: 册 §一 P1 / T2.6
---

## 背景/证据
「预 bundle + 种子预置 + 真实版本注入 + 断网首启验收」未固化为流水线守卫;ADR-006「两个运行时世界」已咬人 3 次(raw-TS crash、`@local` 必败安装、resolve hook 补丁),每次逐案救火。已有部分:DISTRIBUTION.md 权威 runbook + S7 部分断言 + A4 的 patch-server-version drift-tripwire。**验收 = 制度存在,而非单点修复。**

## 验收标准
1. CI 断言:打包产物版本号非 `local`/`0.0.0`;
2. CI 断言:种子资产(plugin 依赖树 / rg / models.json / skills)在 extraResources 完整(T2.3 落地后);
3. 断网首启 smoke 进 CI 或发版手册必做步骤;
4. 「新增运行时下载物必须过预置或钉版本评审」写进 DISTRIBUTION.md 发版 checklist;
5. 守卫可证明拦截:故意注入 `0.0.0` 构建 → CI 红。

## 关联
A4/A5(其实例)、T2.1-T2.3、B8、DISTRIBUTION.md。
