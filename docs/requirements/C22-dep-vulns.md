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

## 分桶 + 处置(2026-07-04,/loop — 复扫,验收①②部分)
`bun audit` 复扫结论:**进发布产物的高危面收敛为单一包 = DOMPurify 3.3.1**(其余绝大多数在 docs/云/vite-dev 工具链,仅 `bun run dev` 期暴露,打包 app 不触发)。
- **DOMPurify 3.3.1**:一批 moderate/low(IN_PLACE 净化绕过 / hook 污染 `DEFAULT_ALLOWED_*` / ADD_TAGS·USE_PROFILES 绕过 → XSS)。位于 **`packages/ui`(ADR-020 冻结)+ 上游 `session-ui`**;app 渲染模型 markdown 经其净化 → **在发布产物内**。
- **处置 = 不能 bump(验收④命中)**:`packages/ui` 已冻结、`session-ui` 是上游 —— 改其 `package.json` 破 north-star / 冻结纪律(NON_GOALS catalog 版本约束 + ADR-020)。**唯一吸收通道 = ADR-020 re-freeze**(采纳含已修 DOMPurify 的更新上游 ui 时),或接受风险。
- **可利用性(未深挖上游用法)**:命中的多是 IN_PLACE / 自定义 hook / ADD_TAGS 配置态特有;若上游以默认配置净化模型输出则多数不适用 → 暴露面**推测偏低但未证实**(需读冻结 ui 的 DOMPurify 调用,超本轮范围)。
- **验收③(定期复扫)**:挂 B7 发版 checklist(与种子资产守卫同处,B7 验收② PR #85 已落)。
- **为何不无人值守修**:唯一「修法」是动冻结/上游包(破北极星)或 re-freeze(受控升级,需用户按 ADR-020 §5 走)——均非机械小修。
