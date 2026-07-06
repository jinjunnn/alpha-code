---
id: B6
title: 装载 @alpha-code/ext 主接缝(=G1,ext 休眠激活)
type: feature
priority: P1
status: verified
repo: A
created: 2026-07-03
sprint: 2026-07-03-s10-hardening
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

## 采纳方案(2026-07-03,PR #46)
- bundle 进包:electron-builder extraResources `../ext/dist/plugin.js → <resources>/alpha-ext/`(prebuild/predev 本就构建 ext,ADR-006 自包含 ESM);
- 路径解析 `alpha-ext-plugin.ts`(electron-free 纯逻辑,单测 4 用例):packaged=resourcesPath/alpha-ext,dev=仓内 dist;`ALPHA_EXT_DISABLE=1` 逃生;缺文件返回 reason → main loud warn(anti-B11);
- 传输走 StartCommand(不走 env,免动 A6 白名单);sidecar `injectAlphaConfig` 合并进 V1 `plugin`(单数)数组,保留用户自有 plugin。

## 验证记录
- 2026-07-03:typecheck + 143 tests 绿(+4);**运行时证明(G1 成功条件:alpha_ping 进工具表且可执行,兼验 ADR-006 zod 跨实例 caveat)→ 真机批**。
