# 非目标(NON_GOALS)

> 最后更新:2026-06-18
> 回顾节奏:每次 `/app:retro` 时审视是否仍有效
> 这是 scope creep 的第一道防线。`/app:challenge` 与 `app-drift-detector` 会**主动引用**这里否决偏离。

## 明确不做的事

1. **不改 `opencode/packages/**` 源码** — 理由:任何源码改动都会在 upstream 升级时冲突,直接违背北极星。唯一例外:确需新增 `/api/*` HTTP 路由时,走 `patches/` 补丁层并集中到单一插入点(见 DECISIONS ADR-002),且必须显式记录。
2. **不重写 agent core / session / context / tool 引擎** — 理由:这是 opencode `@opencode-ai/core` 的职责,白嫖即可,重写=自找维护地狱。
3. **不编辑 opencode 既有的任何文件** — 理由(修订自 ADR-005):本仓库现在**是** opencode 的 fork(不是"避免 fork"),但只能**新增**文件;一旦改动 upstream 既有文件,fork-sync 就会冲突,直接违背北极星。等价于原来的"opencode 只读",只是现在在 fork 内部执行。
4. **不把核心后端行为长期压在 `experimental.*` plugin hook 上** — 理由:这些 hook 官方标注 unstable、会改签名;可用于过渡,但凡依赖必须在 DECISIONS 标注风险与回退方案。
5. **不前端绕过 SDK 直连 core 内部模块** — 理由:`@opencode-ai/sdk` 是唯一稳定契约;绕过它=把自己焊死在 opencode 内部实现上。
6. **不支持非 Mac 平台 / 不复活 web/tui/console/enterprise 形态** — 理由:聚焦,避免被 opencode 的 27 包全形态拖住。

## 明确不服务的用户群
> 修订(2026-06-18):产品转向**多用户分发 + 云端多租户**(见 ADR-010/011),原"个人 Mac 工具"前提作废。
- ~~团队 / 多人协作 / 企业租户~~ → **多个独立租户/用户现为目标**(云执行平台为所有租户共享)。〔待补〕**团队协作**(共享 workspace/会话)与**企业租户**(合同/SSO/合规)是否纳入,另议;未定前不主动做。
- 要求零配置开箱即用的非技术用户〔待补:多用户分发后是否下沉至此群〕。

## 明确不追求的指标
- opencode 上游已覆盖的功能数量(那不是我们的功劳,会干扰北极星)。
- 自定义代码总量(越多越偏离"薄定制层"的初衷)。

## 明确不引入的技术
- 与 opencode `catalog`(根 package.json)冲突的 `effect` / `solid-js` / `@opentui/*` 版本 — 理由:版本漂移会让消费侧编译崩。
- 第二套 agent 框架 / 第二个 LLM 编排层 — 理由:opencode 的 `llm` + `core` 已经是基座。

## 撤回条件(什么时候可以把某条从 NON_GOALS 删除)
- 条款 1/2/3:若决定彻底脱离 opencode upstream(放弃升级继承),整套隔离前提失效,本文件需重写。
- 条款 4:若 opencode 把对应 hook 转正(去掉 `experimental.` 前缀),可解除风险标注。
