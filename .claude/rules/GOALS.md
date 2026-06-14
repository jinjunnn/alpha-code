# 当前目标(GOALS)

> 最后更新:2026-06-14
> 回顾节奏:每次 `/app:retro` 时审视是否仍有效

## 当前周期(sprint / quarter)
Sprint 1 — 2026-06-14 起,结束日 〔待补〕(建议 2 周)

## 北极星指标(1 个)
**指标名**:升级隔离健康度(Upgrade-Isolation Health)
**定义**:每次 opencode upstream bump 后,为让 alpha-code 重新跑通所需**改动的自有代码行数**与**冲突文件数**。
**当前值**:N/A(尚未首次升级)
**目标值**:**冲突文件数 = 0**;自有代码改动仅限 `@opencode-ai/sdk` / `@opencode-ai/plugin` 契约 diff 的适配。
**测量方式**:CI 守卫 `git diff opencode/packages` 必须为空;升级时记录适配行数到 `docs/retros/`。

> 说明:把"升级零摩擦"设为北极星,因为它是你的第一诉求("以便 opencode 升级之后也可以直接使用它的升级能力")。若你更看重"自定义功能覆盖度",可在 `/app:challenge` 时改。

## 本周期 Top 3 目标(按优先级)
1. **后端隔离扩展跑通**:落地 `@alpha-code/ext`(server plugin + 自定义 tool + MCP 清单),被 opencode 运行时自动发现并调用,**零改 opencode 源码**。
2. **独立 Mac 前端骨架跑通**:用 B+A 方案——复用 `AppInterface` + 自定义 `Platform` + token 主题,跑起一个自有 Electron 外壳(复用 `packages/desktop` 模式),连上内嵌 server。
3. **升级纪律就位**:submodule 钉死 `7efade2` + CI 守卫(opencode 源码 diff 非空即失败)+ SDK/plugin 契约 diff 的 review 流程文档化。

## 每个目标的成功条件(可验证)
- G1 成功条件:`opencode` 运行时启动后,`alpha-code` 的自定义工具出现在 agent 可用工具列表并能成功 execute;`git diff opencode/packages` 为空。
- G2 成功条件:自有 Electron 应用能启动、连上内嵌 opencode server、用自定义主题渲染至少 1 个自有改造过的屏幕。
- G3 成功条件:CI 含"opencode 源码零改动"守卫;`docs/` 有一页"如何升级 opencode"的 runbook。

## 〔待补〕需你确认的具体功能目标
- 后端"新增基础功能"具体是哪 2–3 个?(例:某个自定义工具 / 某个 MCP 能力 / 某个 sidecar 接口)
- 前端"优化 Mac 展示逻辑"具体优化什么?(例:会话列表 / diff 视图 / 某个交互)

## 放弃条件(什么时候承认这个目标不该做了)
- 若发现 opencode 的扩展接缝无法覆盖 80% 的定制需求、被迫频繁改源码 → 重新评估"隔离"前提,考虑直接 fork 或换基座。
- 若 upstream `dev` 分支动得太快、每次升级适配成本 > 自己从零维护成本 → 重估北极星。
