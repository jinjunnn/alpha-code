---
title: replacing opencode (逐步替换上游前端的方法论)
kind: design
status: active
owners:
  - alpha-code product and design maintainers
last_reviewed: 2026-07-21
review_after: 2027-01-16
---

# Replacing opencode — 逐步替换上游前端的方法论

alpha-code 是 opencode 的 fork:`packages/ui-mac`(Electron 壳,alpha 自有)挂载
上游 `packages/app`,再逐面地覆盖/接管。ADR-034(前端滚动 pin)之后,alpha **持续
白嫖上游前端更新**——所以替换是**选择性**的:alpha 只接管它想拥有的面/组件,其余
继续吃上游。本文是"如何把一个 opencode 面变成 alpha 面"的稳定方法论;它不持有任何
排期/优先级/进度(那些归 GitHub Issues + Alpha Delivery Project)。

先读 [`principles.md`](principles.md)(设计宪法)与 [`patterns.md`](patterns.md)
(四种组合手法)——本文是它们的**操作层**,不重复其内容。

## 一、替换是一条阶梯,不是一次翻新

一个面从上游走到全 alpha,经由 [`patterns.md`](patterns.md) 的手法**逐级**推进,
每级都保留"崩了回落上游叶子"的路径(`surface-boundary.tsx` +
`SURFACE_RELEASE_STATES: legacy → auto-fallback → alpha`):

```
opencode(纯上游,零改)
  → reskin(CSS 重贴皮,lineage=partial)          只改样子,不碰逻辑/DOM 结构
  → takeover / injection(注入上游锚点,lineage=hybrid)  改行为,注入稳定锚点,不 fork 上游组件
  → seam surface(AppSurfaces 接管,lineage=alpha-ized)   完全自有渲染,带 upstream 回退
```

规则(承 [`patterns.md`](patterns.md)):**reskin 不得长成逻辑 fork**;当一个面必须
改行为、必须真正 alpha 化,就升到 seam surface,而不是把 reskin CSS 越堆越厚。
rollout 是**状态**不是 flag day——上游路径一直可达,直到 alpha 版被证明。

## 二、目标维度:不是每个面都要变 alpha

替换的前提是先回答"**这个面的目标终态是什么**":

- **`target: alpha`** —— 值得拥有(品牌/差异化/上游形态不合 alpha 产品),计划走到
  seam surface。
- **`target: partial`** —— 只需 alpha 皮/少量注入,长期以 reskin/takeover 形态共存,
  不追求完全接管(拥有成本 > 收益)。
- **`target: opencode`** —— 明确**继续白嫖上游**,不打算 alpha 化(如 Command
  palette 之类低差异化面);上游改进直接受益。

**目标维度是持久的设计意图,落在可执行 SOT**:
`packages/ui-mac/src/shared/frontend-surface-manifest.ts` 的 `target` 字段(带测试),
并镜像到 [`../PAGE-MAP.md`](../PAGE-MAP.md) 的 current→target 列。判断"还剩哪些要替、
终态是什么"看这两处;**"先替谁、什么时候替"是活的排期,归 Issues/Project,不进本目录**。

## 三、方法:先扩组件库,再批量替换面

替换面的最大隐性成本是"边替边造轮子"。因此**顺序是先组件、后页面**:

1. **先补 primitive(design-first)**。盘点上游 `packages/app` 还在高频使用、而
   alpha 设计系统([`components.md`](components.md))尚缺的 primitive(Select/Menu/
   Tabs/Table/Checkbox/Radio/Switch/Combobox/Popover…),按"解锁最多面替换"排序,
   **先出设计稿(`frontend-design` skill,基于现状增量)再实现**,补进
   `alpha-ui/` + [`components.md`](components.md) + [`gallery.html`](gallery.html)。
   一个 primitive 落地即在明暗双主题、可见焦点、`prefers-reduced-motion` 三态齐备
   (承 [`components.md`](components.md) §Adding a component)。
2. **再批量替换面**。primitive 就位后,替一个面 = **组合已有积木**,而不是从零。
   同一批 primitive 通常一次解锁多个面(如 Menu+Popover 同时服务 slash-menu/
   model-picker/command-palette)。

## 四、每替换一个面的配方(固化)

对一个 `target: alpha` 的面,逐步走这五步,**每步产物落其规范位置**:

1. **登记**:在 [`../PAGE-MAP.md`](../PAGE-MAP.md) 建/改该面的行(current 状态 + target
   + code entry + owning REQ);实际工作在 GitHub Issues 立 `[REQ-xxx]` 父票(走
   `requirement-management` skill),不在 Markdown 记 backlog。
2. **设计**:在 [`../current/`](../current/)`<page>/design.html` **基于现状增量**设计
   (审计现有实现 + 最新已批稿,稿内含"与上一稿关系"块),对齐 [`principles.md`]
   (principles.md)/[`color.md`](color.md)/[`tokens.md`](tokens.md)。不凭需求措辞
   凭空重画 IA。
3. **评审**:owner 真机视觉批准 = 升 Ready / 进实现的门(视觉类 AC 的验收基线)。
4. **实现**:按阶梯选手法(reskin→takeover→seam),在 seam 后实现、**带 fallback**
   (`surface-boundary.tsx`);只用 `--a-*` token,零改上游 token/DOM(承
   [`principles.md`](principles.md) #5/#6)。
5. **固化**:翻 `frontend-surface-manifest.ts` 的 `lineage`(+ 更新测试),PAGE-MAP
   行同步;到达批准里程碑时,从 current 切一个**日期快照**冻结
   (`2026-…-<name>/`),append-only。

## 五、SOT 一览(什么落在哪)

| 内容 | 落点 | 性质 |
| --- | --- | --- |
| 替换方法论(本文) | `docs/design/system/replacing-opencode.md` | 持久框架 |
| 每面 current/target 终态 | `frontend-surface-manifest.ts`(`target`)+ [`../PAGE-MAP.md`](../PAGE-MAP.md) | 持久设计意图,带测试 |
| 活稿设计 | [`../current/`](../current/)`<page>/design.html` | 可编辑活稿 |
| 组件库缺口/新增 | [`components.md`](components.md) + [`gallery.html`](gallery.html) + `alpha-ui/` | 设计系统资产 |
| **先替谁、排期、优先级、进度** | **GitHub Issues + Alpha Delivery Project** | **活的交付状态,不进 Markdown** |

方向承 ADR-016(前端接管)/ADR-027(AppSurfaces seam)/ADR-029(主权阶梯)/
ADR-034(滚动 pin,持续白嫖上游)。更干净的终局(C:app/ui 零 delta、定制全走
ui-mac 组合)可在替换稳定后滑行过去。
