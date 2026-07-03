---
id: REQ-009
title: alpha-ci 提速:guard partial clone + bun 依赖缓存
type: debt
priority: P2
status: ready
repo: A
created: 2026-07-03
sprint: —
source: PR #34 实测痛点(2026-07-03)
---

## 背景/证据
alpha-ci 每轮数分钟,且 `cancel-in-progress: true` 下每次 push 从零重跑 → 每个 PR 都在付等待税。耗时构成(`alpha-ci.yml` 实测):① `upstream-guard` 用 `fetch-depth: 0` **全历史 checkout**(本仓携带 opencode 完整历史,克隆最重);② `typecheck` 与 `test` 两个 job **各自冷 `bun install`**(27 包 monorepo,无缓存);③ 测试本身仅 61ms。

## 验收标准
1. guard job:全历史 clone 改 **partial clone**(`actions/checkout` 的 `filter: blob:none`,保留提交图)——merge-base 三点 diff 语义不变;
2. typecheck/test job:bun 依赖缓存(`actions/cache` 缓存 bun install cache,key 挂 `bun.lock`)——缓存命中时 `bun install` 秒级;
3. **守卫不被提速改坏**:构造一个改上游文件的测试提交,guard 仍红(防回归用例,验完即删);
4. 实测前后对比:单轮 alpha-ci 总时长压到 **≤2 分钟**(记录数字进本文验证记录);
5. 只改 alpha 自有 workflow(`alpha-ci.yml`),零碰上游文件。

## 非目标
- 不动上游继承的 cron workflow(那是 D12:仓库设置禁用,不改 yml);
- 不上自托管 runner。

## 方案 / 关联
D12(CI 卫生,cron 禁用/lint/e2e 留在那边)、B18(alpha-ci 本体)、B7(发版流水线断言将叠加在同一 workflow,先提速再加料)。

## 验证记录
_verify 时补。_
