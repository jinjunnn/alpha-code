---
id: B6
title: 装载 @alpha-code/ext 主接缝(=G1,ext 休眠激活)
type: feature
priority: P1
status: ready
repo: A
created: 2026-07-03
sprint: —
source: 册 §一 P1 / T5.1-5.2 / E 册 G1
---

## 背景/证据
`packages/ext/dist/plugin.js`(410KB)已构建但未装进 .app(`sidecar.ts:140-142`);alpha 自有 tool 实际为 0,Tier-2「能力扩展走 harness」(ADR-015)无载体。GOALS G1 未完成。

## 验收标准(= GOALS G1)
1. dist → extraResources → 注入 `plugin[]`,opencode 运行时自动发现;
2. 自定义 tool 出现在 agent 可用工具列表并成功 execute;
3. ADR-006 纪律:预 bundle 自包含 ESM、跨实例 zod 路径校验通过(打包态实测,非仅 dev);
4. 首批 ≥1 个实用 tool(候选:cloud dispatch 快捷 tool / 本地实用 tool);
5. 北极星守卫绿(零改上游)。

## 关联
G1、ADR-002/006/015、B3(dispatch tool 候选)、REQ-004/ADR-019(若 tool 走 .alpha 桥接)。
