---
id: D12
title: CI 卫生:上游 cron workflow 在 fork 禁用 + lint gate + e2e 范围
type: debt
priority: P3
status: archived
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
B18(alpha-ci 已建)、B10(守卫)、ADR-005(不改上游文件)、REQ-009(CI 提速已拆出单列)。

## 验证记录(2026-07-03,live)
**根因确诊**:26 个继承的上游 workflow 中,`test`/`pr-management`/`beta` 等要求 `runs-on: blacksmith-4vcpu-ubuntu-2404`(或 matrix host label)—— Blacksmith 是上游 anomalyco 订阅的第三方 runner 池,**本 fork 无此 runner** → 每次 `pull_request`/`schedule` 触发即 `queued` 挂死 1–2h(表现为「CI 一直卡/连不通」)。非 API/限流问题(rate_limit 5000/5000),`alpha-ci` 本体一直 ~40s 绿。

**处置**(仓库 Actions 设置,**零改 yml**,ADR-005 北极星不破):
1. 逐个 `gh workflow disable` **禁用 26 个上游 workflow**,仅保留本仓自有 **`alpha-ci`** + **`sync-upstream`** active。禁用清单:beta, close-issues, close-prs, compliance-close, containers, deploy, docs-locale-sync, docs-update, duplicate-issues, generate, nix-eval, nix-hashes, notify-discord, opencode, pr-management, pr-standards, publish, publish-github-action, publish-vscode, release-github-action, review, stats, storybook, test, triage, typecheck。
2. `gh run cancel` 清掉 20 个挂死 queued run。
3. 复验:PR #35 = MERGEABLE(3 个 required check 全绿),重跑 `alpha-ci` ~30s 全绿,无僵尸 check 并列。

**验收对照**:①✅ 上游 workflow 禁用记录清单(本节);②✅ publish/beta/release 类已禁用=误发布通道封死(强于「无凭证即失败」);③ lint gate 决策=**不新增独立 lint gate**(alpha-ci 已覆盖 typecheck+test),e2e 现状=不复活上游 e2e(alpha 面 bun test 覆盖即可)。
**逃生**:任何一个要恢复 = `gh workflow enable <name>.yml`(可逆,未删文件)。
