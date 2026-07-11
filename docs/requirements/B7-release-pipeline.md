---
id: B7
title: 发布流水线制度化:CI 断言版本/种子资产/断网首启
type: debt
github_issue: https://github.com/jinjunnn/alpha-code/issues/175
repo: A
created: 2026-07-03
source: 册 §一 P1 / T2.6
---

> [!CAUTION]
> **冻结的验收记录(2026-07-11 cutover)。** 当前状态、优先级、负责人和
> Iteration 只在 [alpha-code#175](https://github.com/jinjunnn/alpha-code/issues/175)
> 与 [Alpha Delivery](https://github.com/users/jinjunnn/projects/2) 维护；
> 本文件不再回填可变交付状态。

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

## 部分 shipped(验收②,PR #85,/loop 2026-07-04)
- **验收②(种子资产完整)= shipped**:`scripts/assert-seed-assets.sh` 断言 `electron-builder` `extraResources` 的**源**资产存在且非空 —— REQ-023 vendored agent(`code-reviewer.md`)/ plugin(`opencode-notify`)、builtin skills、`NOTICE.txt`(B15 许可证合规)、签名 entitlements/icon;新增 advisory `seed-assets` job 调它(与 alpha-ci 既有 job 同模式,加入 required-checks 前不阻塞)。构建产物(`ext/dist`)由 build 自身产出,不在此断言。
- **递延(需 build+launch,→ 真机批 / release-pipeline)**:验收①版本断言(非 `local`/`0.0.0`,release-time 打包产物才有真版本,不宜 per-PR)、③断网首启 smoke、⑤故意注入 `0.0.0`→CI 红(依赖①);验收④ DISTRIBUTION.md checklist 行随①③一并补。
- **判断**:seed-asset 守卫是 B7 唯一「CI 可自证、决策无关」的切片,先落;其余属发版流水线/真机验收,不可无人值守做。
