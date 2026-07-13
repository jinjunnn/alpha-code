# REQ-079 精选清单提案(2026-07-09,S38 开工提案 —— ✅ 已拍板)

> **拍板(用户,2026-07-09 当日)**:三条提案照准 —— ① 保留 code-reviewer / bug-triage 不删减;
> ② 本批不新增 agent 条目;③ 出厂技能不重复上架 catalog。
> **连带观察项一并拍板:改文案** —— 精选卡来源 chip「自建」(source="alpha" 复用 sourceAlpha 键)
> 与用户自建 agent 语义混淆:catalog/云连接器语境改「alpha 出品」(en "By alpha"),用户自建 agent
> 两处用点(卡片 pill / 详情来源行)拆新键 `agentSelf` 保留「自建」。补丁 PR 见 BACKLOG 行内。

> 背景:BACKLOG 待拍板队列「现有 catalog 条目(code-reviewer/bug-triage)是否删减 / 是否再补充」。
> 本批已实现的部分不在此列:撤原生平铺(已拍板)、REQ-080 三连 + office-docs、REQ-082 cloud-dispatch(出厂)。

## 提案

1. **保留 code-reviewer / bug-triage 两条 catalog agent,不删减。**
   理由:与治理面板零重复(它们是可安装可卸载的 alpha 精选,不是引擎内置);撤平铺后 Agent tab
   浏览面若一条不剩会退化成空页,两条精选恰是「可安装的精选」语义的最小示范;卸载净除链路
   (receipts)已真机验证过,维护成本≈0。
2. **本批不再新增 agent 条目。**
   理由:精选的信用来自「每条都能说清为什么在架」;当前没有第三条有同等把握的候选。
   watchlist 照旧(paperjsx 属连接器线,归 REQ-080 档)。
3. **出厂技能不重复上架 catalog**(cloud-dispatch / office-docs 不建 skill 条目)。
   理由:出厂件零安装即可用,catalog 条目只对「关掉出厂注入(ALPHA_FACTORY_SKILLS_DISABLE)
   的用户」有意义——该人群是显式高级用户,自建通道齐备;skill-creator 在架属历史资产复用特例
   (S18 X1),不外推。

## 若拍板不同意

- 删两条 agent → Agent tab 浏览面只剩自建节,空态文案需同步改(一行改动);
- 要求补充条目 → 按「能说清为什么在架」逐条过 `_verify` 供应链核查后单独上架(C 侧单 PR,零 A 发版)。
