---
id: REQ-008
title: 产品定位〔待补〕决策批:一次性收口 rules 里的开放产品判断
type: spike
priority: P2
status: registered
repo: X
created: 2026-07-03
sprint: —
---

## 背景(为什么)
`.claude/rules` 里挂着多处〔待补〕产品决策,自 2026-06-18 pivot 后未收口;它们决定 NON_GOALS 措辞、GOALS 排期与 C 仓形态,拖着会持续产生 [DRIFT] 噪音。

## 决策清单(逐条拍板)
1. **团队协作**:做「共享 workspace/会话」还是只「多个独立租户共享云」?(POSITIONING〔待补〕+ NON_GOALS#明确不服务)
2. **企业租户**(合同/SSO/合规)是否纳入 roadmap?(NON_GOALS)
3. **用户下沉**:多用户分发后是否服务「零配置非技术用户」?(POSITIONING)
4. **后端前 2–3 个具体功能**是什么?(GOALS〔待补〕:自定义 tool / MCP 能力 / sidecar 接口——现有候选:cloud dispatch 快捷 tool、B14 备份导出、E 系列连接器)
5. **前端优化的具体点**收口(GOALS〔待补〕——ADR-016 后大多已兑现,余项与 REQ-005 对齐)
6. ~~**G4 优先级**:Sprint 2 headline 还是提进 Top-3?(GOALS 未决)~~ → **已拍板(2026-07-03,S11 开工提案随批)**:G4 提优先、作 S11 headline(Track A:B3+REQ-004+C9);GOALS 的 G4 优先级〔待你定〕就此收口,余 5 条仍待整批拍板。

## 验收标准
1. 六条各有明确结论(做/不做/推迟 + 理由),经 `/app:challenge` 或直接决策会话;
2. POSITIONING / GOALS / NON_GOALS 相应〔待补〕标记清除、正文更新;涉及架构的落 ADR;
3. GLOSSARY 若引入新术语同步。

## 非目标
- 不在本项内实施任何功能,只做决策与 rules 更新。

## 方案 / 关联
关联:REQ-001(双版本策略是 3 的输入)、B3/G4、REQ-005。

## 验证记录
_verify 时补。_
