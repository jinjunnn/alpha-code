# 当前目标(GOALS)

> 最后更新:2026-07-05(REQ-008 拍板:〔待补〕功能目标收口 + 非技术用户线注记;「当前周期」段刷新归 S17 T6 retro)
> 回顾节奏:每次 `/app:retro` 时审视是否仍有效
> 2026-06-18:产品转多用户/多租户,新增云平台目标线(G4),见下。

## 当前周期(sprint / quarter)
Sprint 1(2026-06-14 起)地基已达标(后端接缝 + 前端接管 + 升级守卫);当前处于**分发就绪 + 工程健康**阶段(register S1–S7:启动性能 / 分发签名 / 升级守卫 / 测试)。里程碑:**首个签名+公证发布 v0.1.0(2026-07-03,`jinjunnn/alpha-code`)**。

## 北极星指标(1 个)
**指标名**:升级隔离健康度(Upgrade-Isolation Health)
**定义**:每次 opencode upstream bump 后,为让 alpha-code 重新跑通所需**改动的自有代码行数**与**冲突文件数**。
**当前值**:**已首次升级并达标**——2026-07-03 `merge dev → alpha`(546 commits)**零冲突**,仅 1 处后端契约适配(WSL `probeAddable`);见 `docs/retros/2026-07-02-upstream-sync-546.md`。
**目标值**:**冲突文件数 = 0**;自有(后端)代码改动仅限 `@opencode-ai/sdk` / `@opencode-ai/plugin` 契约 diff 的适配。
**测量方式**:CI 守卫(`alpha-ci.yml` north-star guard)`git diff --diff-filter=DMR origin/dev...HEAD -- packages/{opencode,core,server,app,ui,tui,sdk}` 非空即红;升级时记录适配行数到 `docs/retros/`。
**范围(ADR-016)**:此北极星仅衡量**后端 / 上游源码**升级隔离;**前端已由 ADR-016 全面接管、放弃升级隔离,不计入**。

> 说明:把"升级零摩擦"设为北极星,因为它是你的第一诉求("以便 opencode 升级之后也可以直接使用它的升级能力")。若你更看重"自定义功能覆盖度",可在 `/app:challenge` 时改。
> ⚠️ 2026-06-18 补充:北极星只衡量**本地 fork** 的升级隔离;**云多租户平台([[ADR-010]]/[[ADR-011]])是独立 codebase**,不在本指标内,需自己的成功度量(见 G4)。别让云线的进度/失败干扰这个本地北极星。

## 本周期 Top 3 目标(按优先级)
1. **后端隔离扩展跑通**:落地 `@alpha-code/ext`(server plugin + 自定义 tool + MCP 清单),被 opencode 运行时自动发现并调用,**零改 opencode 源码**。
2. ✅ **独立 Mac 前端跑通**(已超原 B+A/ADR-003 计划):**ADR-016 起 alpha 自有组件全面接管前端**(不再仅 token 换肤),自有 Electron 外壳连内嵌 server;复用重型引擎(终端/diff/流式)+ CSS 换肤。
3. ✅ **升级纪律就位**:fork + 只增不改(ADR-005,取代 submodule)+ `alpha-ci.yml` **north-star guard**(上游源码 DMR diff 非空即红,ADR-004 已实测)+ 每日 `sync-upstream.yml` + 契约 diff review(见 `docs/retros/` + `DISTRIBUTION.md`)。

## 新增目标线:云多租户平台 MVP(2026-06-18,pivot 触发)
> 由"个人工具 → 多用户/多租户"pivot 引入;**依赖 [[ADR-010]]/[[ADR-011]] 从 `proposed` 转 `accepted`**。
> 优先级〔待你定〕:作为 **Sprint 2 headline**,还是**提进本周期 Top-3**(则现 Top-3 须砍一项)?默认按 Sprint 2 排,不抢本周期本地地基。

**G4 — 云作业平台最小闭环跑通**:本地 opencode agent 经 `.opencode/skill` 产出 task contract → MCP `cloud.dispatch` 服务端硬校验 → Upstash Workflow 编排 → Tier-1(ECS + Anthropic API)执行**一个真实非编码任务**(如深度调研)→ 结果回流本地。

## 每个目标的成功条件(可验证)
- G1 成功条件:`opencode` 运行时启动后,`alpha-code` 的自定义工具出现在 agent 可用工具列表并能成功 execute;`git diff opencode/packages` 为空。
- G2 成功条件:自有 Electron 应用能启动、连上内嵌 opencode server、用自定义主题渲染至少 1 个自有改造过的屏幕。
- G3 成功条件:CI 含"opencode 源码零改动"守卫;`docs/` 有一页"如何升级 opencode"的 runbook。
- G4 成功条件:一个真实任务**端到端跑通并返回结构化结果**;`cloud.dispatch` 的 schema 硬校验能拒残缺契约;有界 agent 的 token/wall-clock 上限实测生效;**本地侧零改 opencode 源码**(只经 MCP/sidecar 接缝)。
  - MVP 明确不做:Tier-3 容器、租户计费、团队协作、出口锁死完整实现(先挂降级三件套占位)。

## 〔已收口〕具体功能目标(2026-07-05,REQ-008 D4/D5 拍板)
- **后端前 3 功能(已兑现,承认事实收口)**:① 云派发 pipeline(G4/B3/REQ-020,dispatch→云执行→artifact 回流已 verified)② 自动化定时任务(REQ-021 A1,ADR-022 accepted)③ 扩展供给链/连接器生态(ADR-014 v3 accepted)。**第 4 候补**:B14+C17 DB 安全带(S17 T3 在做)。
- **前端优化余项 = REQ-005 清单**(重型引擎换肤完成度 + timeline 尾项核验);此后前端新想法走正常 REQ 立项,GOALS 不再挂开放槽。
- **非技术用户线(D3 拍板连带)**:当前唯一承诺 = 规范文档(REQ-026);新手引导/支持面等重投入暂不设目标。

## 放弃条件(什么时候承认这个目标不该做了)
- 若发现 opencode 的扩展接缝无法覆盖 80% 的定制需求、被迫频繁改源码 → 重新评估"隔离"前提,考虑直接 fork 或换基座。
- 若 upstream `dev` 分支动得太快、每次升级适配成本 > 自己从零维护成本 → 重估北极星。
- (G4 云线)若云端运维/安全成本 > 收益,或多租户需求未兑现 → 砍云线,回归纯本地多用户分发;[[ADR-010]]/[[ADR-011]] 转 `superseded`。
