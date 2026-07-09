---
id: REQ-079
title: 定制中心供给面 curation — 浏览面撤下引擎原生 agent 平铺,只展示 catalog 精选可安装项
type: ux
priority: P1
repo: X
created: 2026-07-09
status: shipped
source: 用户拍板方向(2026-07-09):「内置 agent 不需要显示,只提供一些必要的 agent/skill,让用户自己添加」
---

## 背景(实查,2026-07-09)

定制中心 Agent tab 现状 = 引擎 `app.agents()` 全量(滤 hidden)标「内置」平铺(use-extensions.ts:214-223,extension-hub.tsx:874 `a.native`)+ catalog agent 卡仅 2 条(code-reviewer / bug-triage)。即 build/plan/general/explore 等**引擎原生 agent 占据浏览面主体**,与「浏览面 = 可安装的精选」心智相悖。

撤下无功能损失的依据:
- 内部三 agent(alpha-automation 系)已 hidden,不在此列(REQ-055);
- **治理面板已有原生 agent 的完整管理入口**(已安装 → 内置,governance-panel.tsx:hide/disable/override)——管理职能本就不在浏览面。

## 验收标准

1. Agent tab 浏览面不再平铺引擎原生内置 agent;原生 agent 的查看/管理唯一入口 = 治理面板(既有,不新建)。
2. catalog agent/skill 精选照常展示、可安装;「已安装」tab 语义不变(receipts ⨝ SDK)。
3. 精选清单 = 现有 catalog 条目(code-reviewer / bug-triage)+ [[REQ-080]](office 三连 + office-docs)/ [[REQ-082]](cloud-dispatch)增补;**是否删减现有条目 / 是否再补充新条目 = 开工时提案**(待拍板残点,见 BACKLOG 队列)。
4. CDP 截图核验([[visual-verify-required]]):Agent tab 撤平铺前后对比 + 治理面板入口可达。

## 非目标

- 不动治理面板(管理面已够);
- 不动 composer @ 引用的 agent 列表(那是装配语义,REQ-073 拍板,与浏览面无关);
- 不新增 catalog schema 字段(向后兼容纪律,ADR-023);
- command 不单列(ADR-014 O2 不变)。

## 关联

- [[ADR-014]](定制中心 IA)· [[REQ-055]](内部 agent 隐藏先例)· [[REQ-080]] / [[REQ-082]](精选增补来源)
