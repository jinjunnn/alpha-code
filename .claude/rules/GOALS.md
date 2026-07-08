# 当前目标(GOALS)

> 最后更新:2026-07-08(新增 G6 去 opencode 化 · 提示词与系统原语主权线;上一版 2026-07-05:REQ-008 收口 + G5)
> 回顾节奏:每次 `/app:retro` 时审视是否仍有效
> 2026-06-18:产品转多用户/多租户,新增云平台目标线(G4),见下。

## 当前周期(sprint / quarter)
> 2026-07-05 刷新(S17 T6 retro;上一版停在「Sprint 1 / 分发就绪」表述)。
S12–S16(2026-07-04~05)完成**定制中心 v3 全量(M1–M4)+ 自动化 A1**并经 prod 真机批 verified(ADR-014 v3 / ADR-022 转 accepted;A6 verified 解 R3);S17(2026-07-05)清**思考债**:定位五连拍收口、本地门根治(REQ-015/REQ-027 双假绿事故)、DB 安全带(C17+B14)、崩溃边界下沉+控件诚实化(C28)、垃圾项目治理(B4/B12)、21 项归档。当前阶段:**发布深化**——真机 verified 残单待下一真机批;**B16(PIPL)重启条件临近**(非技术用户入画像 + 云派发已实际可用)。里程碑:**v0.1.0 签名+公证首发(2026-07-03,`jinjunnn/alpha-code`)**。

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

## 新增目标线:多 harness 能力(G5,2026-07-05 用户拍板)
**G5 — alpha-code 背后拥有 opencode / Claude Code / Codex 三个 harness 的能力**,分期演进:
- **现状**:云侧已双 harness(alpha-platform `harness/{coding-claudecode,noncoding-openai}.ts`,gateway `/v1/messages` Anthropic-wire ingress 即为此建)。
- **第一阶段 = 本地 harness-as-executor**([[REQ-035]],**parked 待用户启动**):opencode 仍是唯一交互会话引擎,Claude Code / Codex 经 tool/MCP 接缝作被委托执行器,零改上游;委托给 Claude Code 的任务在其体内原生享有其生态内容(与 ADR-023 转换器互补)。
- **长期目标 = 会话级并轨(UI 直驱三引擎)**:用户已定此为演进方向;**启动硬前置** = `/app:challenge` + POSITIONING/GOALS 修订(定位级变更:「基于 opencode」→「多 harness 编排」)+ 承载方案 spike(翻译 sidecar 实现 opencode SDK 子集 vs 每 harness 独立 UI)+ 独立 ADR。**当前不排期、不计入 Top-3、不影响北极星语义**(北极星仍只衡量 opencode 上游升级隔离)。

## 新增目标线:去 opencode 化 · 提示词与系统原语主权(G6,2026-07-08 用户拍板)
**G6 — 用户可感知面全面「alpha 化」:opencode 只留 plugin/tool/hook 等引擎接缝,系统提示词与系统级 skill/command(及 agent 的内容层)由 alpha 承载**,分期推进(权威决策 = [[ADR-015]] 2026-07-08 修订 + [[ADR-024]]):
- **第一期(路线A,REQ-062)— 品牌转写 + 轻量内容接管**:ext 插件 `experimental.chat.system.transform` 对 system 段运行时转写 opencode 自指(底座工程内容照旧白嫖,= ADR-007 brand-i18n 的提示词版);identity 删 "built on opencode";`/init` `/review` config 同名覆盖换 alpha 模板;customize-alpha skill 接替已禁的 customize-opencode;**general/explore 子 agent 同名 prompt 重写为 alpha 自写**(单一任务型 prompt,无逐模型负担,直接接管)。A 期收口 = 会话内全部 agent 的 LLM 可见文本零 opencode 痕迹。
- **第一期并行(REQ-063,ADR-024)— 外部生态继承 default-deny**:`.claude`/`.agents` skills 与 CLAUDE.md 默认不继承(sidecar 注入上游 disable flags);打开项目检测到外来内容 → 信任门弹窗 → 同意 = 安装期转换导入 `.alpha`(非重开继承);全局存量一次性迁移门为发布闸。
- **第二期(路线B,REQ-064,parked)— 受控替换底座 + 内置 agent 内容全面接管**:config `agent.build.prompt` / `agent.plan.prompt` 整体替换 provider 底座(alpha 自有系统提示词);compaction/title/summary 内部机件 prompt 按质量评估同名覆盖——至此**全部内置 agent 的内容层由 alpha 承载**(用户 2026-07-08 追加拍板);激活条件 = 路线A 稳定 + 自有 prompt 逐模型质量评估过关 + ADR-015 再修订(接管即放弃底座白嫖,等同 ADR-016/020 前端抉择)。
- **诚实边界(机制事实,已源码钉死)**:内置 command 只能同名换芯、不能移除(schema 无 disable,菜单条目仍在);build/plan 是引擎默认主档、compaction/title/summary 是内部机件(治理 HARD_PROTECTED)——**「重写」一律 = 同名覆盖 prompt/模板内容(名字与引擎接线保留),不走「禁用 + 另建」**(plan 模式切换/task 委托/UI 默认档按名字焊死,禁用后果未验证且无收益);general/explore 子档机制上可禁,但同名重写同样优先;environment 块无 flag 可禁(本就无品牌,不构成障碍)。
- **G6 成功条件**:真机会话内 agent 稳定自称 alpha-code、system 上下文无 opencode 自指(转写审计可证);新打开含 `.claude`/`.agents` 的项目零静默继承(consent 门实测);全程零改上游文件(北极星守卫不波动);逃生开关(`ALPHA_PROMPT_REBRAND_DISABLE` / `ALPHA_ECOSYSTEM_INHERIT`)各自独立可回退。

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
