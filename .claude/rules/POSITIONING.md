# 产品定位(POSITIONING)

> 最后更新:2026-06-14
> 回顾节奏:每次 `/app:retro` 时审视是否仍有效
> 说明:架构相关条目已确认;标 `〔待补〕` 的是产品层判断,需你确认/修正。

## 一句话定位
alpha-code 是一个**基于 opencode 的、个人定制的 Mac 编码 agent**:在**不改 opencode 源码**的前提下,叠加**自有独立 UI** 与**自有后端能力**,同时**无成本继承 opencode 的每次 upstream 升级**。

## 目标用户(画像化,不抽象说"用户")
- **角色**:深度 AI 编码工具使用者 / 个人开发者(`/Users/tide/app` 下 20+ 项目、熟悉 gstack、偏好 opus + multi-agent 协作的 power user)。当前 = 作者本人。
- **日常**:在 Mac 上用编码 agent 跑多项目;对 UI 展示逻辑与后端能力有强烈的个性化诉求。
- **当前痛点**:opencode 官方 Mac 前端的展示/交互不是"我的";想要自己的 UI 和若干自有后端能力,但**又不愿 fork 死**——一旦改源码,upstream 升级就接不住。
- **不是谁**:不是需要开箱即用、不碰配置的小白;不是多人协作/团队/企业用户。

## 解决什么具体问题
1. **隔离扩展**:在 opencode 之上加自有后端能力(工具/hooks/MCP/sidecar),**零改动**原仓库源码。
2. **独立前端**:做一套自己的 Mac UI(自有审美 + 优化过的展示逻辑),而不是被官方 UI 绑死。
3. **升级可继承**:opencode 升级后,只通过 `@opencode-ai/sdk` / `@opencode-ai/plugin` 两个契约层对接,自定义层不冲突。

## 明确不解决的问题
- 不解决 opencode 本身的 agent/会话/上下文引擎问题——那是上游的,直接白嫖。
- 不解决跨平台(web/tui/console/enterprise)——只聚焦 Mac desktop。

## 竞品 / 替代品
- 直接用官方 opencode desktop(放弃定制)。
- 硬 fork opencode 改源码(放弃升级继承)——alpha-code 正是要避免这条路。
- 从零自研编码 agent(放弃 opencode 成熟的 agent core)。

## 我们的差异化
**隔离架构**:定制只发生在 opencode 官方设计好的扩展接缝(`@opencode-ai/plugin` hooks、`.opencode/*` 文件、MCP、SDK 驱动的前端)上;opencode 源码作为 pinned submodule **只读**。升级 = 切 submodule ref + bump 两个契约版本。

## 〔待补〕需你确认
- 这是**纯个人工具**,还是有**对外发布**打算?(影响 NON_GOALS 的多用户条款)
- "自有后端能力"和"前端优化"的**前 2–3 个具体功能**是什么?(GOALS 需要这个才能落地)
