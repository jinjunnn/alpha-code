---
id: REQ-007
title: ADR-015 待办收尾:per-agent prompt 优化清单 + Tier-3 桌面实测
type: docs
priority: P3
status: registered
repo: A
created: 2026-07-03
sprint: —
source: ADR-015 🔭 待办①③
---

## 背景/证据
ADR-015 三条待办:① per-agent prompt 优化的具体清单(随 Tier-2 harness 清单排期)——未做;② 合并验证接进 sync-upstream.yml(prompt tripwire)——**已完成**(S7/T7.5);③ Tier-3 首个实例(alpha-behavior 回答长度校准)上线后桌面实测——未做。

## 验收标准
1. per-agent prompt 优化清单产出(`.opencode/agent/*.md` 逐个:triage / duplicate-pr + 新增候选),每条含目标行为与验证方式;
2. Tier-3 回答长度校准桌面实测:explain/analyze 类问题回答长度如期校准、routine 操作仍简洁(截图/记录,[[visual-verify-required]]);
3. 实测结论记 `docs/retros/`;矛盾则按 ADR-015 合并验证纪律调整 alpha-behavior。

## 关联
ADR-015、E 册(Tier-2 清单)、alpha-behavior.ts / alpha-identity.ts。
