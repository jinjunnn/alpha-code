# 决策日志(DECISIONS)— 索引

> 架构决策记录(ADR)索引。**每条 ADR 一个文件**,见 `.claude/rules/adrs/`。
> 新增:在 `adrs/` 加 `ADR-0NN-<slug>.md`(必带 frontmatter:`id/title/status/date`,可选 `supersedes/superseded-by/related`),并在下表追加一行。
> 不删除既有 ADR,只改其 `status` + 在文件内追加"撤回/修订"。`status` ∈ `accepted | trial | superseded | proposed`。
> 跨仓决策的所有权与引用规则见 [alpha-work:ADR-003](https://github.com/jinjunnn/alpha-work/blob/main/governance/ADR-003-cross-repository-decision-ownership.md)，统一导航见 [Alpha 跨仓架构决策登记簿](https://github.com/jinjunnn/alpha-work/blob/main/governance/architecture-decision-registry.md)；本仓只维护其拥有边界的 ADR，不复制父仓或兄弟仓正文。

| ADR | 标题 | 状态 | 日期 |
|-----|------|------|------|
| [ADR-001](adrs/ADR-001-opencode-submodule.md) | opencode pinned submodule 引入 | superseded → ADR-005 | 2026-06-14 |
| [ADR-002](adrs/ADR-002-backend-seams.md) | 后端走 plugin/tool/MCP/sidecar | accepted | 2026-06-14 |
| [ADR-003](adrs/ADR-003-frontend-appinterface.md) | 前端 B+A(AppInterface + Platform + token) | superseded → ADR-016 | 2026-06-14 |
| [ADR-004](adrs/ADR-004-upgrade-isolation-ci.md) | 升级隔离 CI 守卫 | accepted(2026-07-03 首次 546-commit 同步实测守住,`alpha-ci.yml` guard 已上线) | 2026-06-14 |
| [ADR-005](adrs/ADR-005-fork-pivot.md) | pivot 到 fork + 只增不改 | accepted | 2026-06-14 |
| [ADR-006](adrs/ADR-006-runtime-worlds.md) | 两个运行时世界,ext 必须预 bundle | accepted | 2026-06-15 |
| [ADR-007](adrs/ADR-007-brand-transform.md) | 品牌化 build-time transform | accepted | 2026-06-15 |
| [ADR-008](adrs/ADR-008-sidebar.md) | Codex 风格左边栏(Portal + SDK + CSS 接缝) | accepted | 2026-06-17 |
| [ADR-009](adrs/ADR-009-websearch-default.md) | websearch 默认放开 + alpha.env 秘钥落点 | accepted | 2026-06-18 |
| [ADR-012](adrs/ADR-012-ui-mac-channel.md) | ui-mac 发布默认 prod 渠道,dev/beta 保留不删 | accepted | 2026-06-18 |
| [ADR-014](adrs/ADR-014-extension-hub.md) | 定制中心:Skills/MCP/Plugins 市场 + alpha 自建套件 + 零-fork 安装(2026-07-04 v3 修订:全类型通用化 —— 账本/`.alpha`桥/免重启 dispose/密钥 file 化;O1-O4 拍板) | accepted(2026-07-05 v3 桌面真机批 PASS,REQ-016 S16;四类装卸+桥+净除全通) | 2026-06-22 |
| [ADR-015](adrs/ADR-015-prompt-optimization-strategy.md) | 提示词优化策略:底座只读 + 能力感知 identity + Tier-3 行为层(含合并验证)(2026-07-08 修订:G6 去 opencode 化——路线A 品牌转写 hook 获批 REQ-062,路线B 受控替换底座 parked REQ-064) | accepted | 2026-06-23 |
| [ADR-016](adrs/ADR-016-frontend-takeover.md) | 前端全面接管:alpha 自有组件重建前端 + 复用重型引擎 + 放弃前端升级隔离北极星(取代 ADR-003) | accepted | 2026-06-24 |
| [ADR-017](adrs/ADR-017-desktop-auth-deeplink.md) | 桌面授权深链:scheme 必须进 Info.plist + PKCE 落盘抗冷启动 | accepted | 2026-06-25 |
| [ADR-018](adrs/ADR-018-req-lifecycle.md) | 历史本地需求流程；已由 `alpha-work/governance/ADR-001-github-delivery-sot.md` 取代 | superseded | 2026-07-03 |
| [ADR-019](adrs/ADR-019-alpha-workdir.md) | `.alpha` 项目工作目录 + 环境级全局根(2026-07-19 #428 修订:`<appData>/alpha-code-state/env/{dev,prod,beta}`,共享 CAS 为兄弟目录;退休 home 根零迁移/零 dual-read) | accepted | 2026-07-03 |
| [ADR-020](adrs/ADR-020-frontend-freeze.md) | 前端冻结:packages/{app,ui} 钉 frontend-freeze-base,每日 sync 只进引擎(E 路径,REQ-013 拍板;修订 ADR-004 守卫范围)。**2026-07-21 被 ADR-034 supersede**(冻结丢弃上游前端更新 + 擦 alpha seam,与 owner「持续白嫖上游前端」诉求冲突) | **superseded by ADR-034** | 2026-07-03 |
| [ADR-021](adrs/ADR-021-cloud-data-boundary.md) | 代码上云数据边界:diff-only 优先 + secrets 过滤 + 体积上限 + consent 挂钩 B16(C9,S11 T3;§2 三校验已实现 S14;§4 两挂钩点 B16 落地 S25) | accepted | 2026-07-04 |
| [ADR-022](adrs/ADR-022-automations.md) | 自动化定时任务:本地调度器 + 只读 agent 静态权限档 + `.alpha` 落盘(REQ-021 A1;A2/A3 分期) | accepted(2026-07-05 真机批 PASS,REQ-016 S16;到点触发+readonly deny 零 ask+错过 skip) | 2026-07-04 |
| [ADR-023](adrs/ADR-023-external-ecosystem-adaptation.md) | 外部生态适配 = 安装期转换器(不做运行时模拟)+ 插件包分发分层(npm 正源 / C 侧清单与精选资产) | accepted | 2026-07-05 |
| [ADR-024](adrs/ADR-024-ecosystem-inheritance-default-deny.md) | 外部生态继承默认拒绝(.claude/.agents/CLAUDE.md)+ 打开项目 consent 导入门(consent = 安装期转换导入 `.alpha`,非重开继承;全局存量一次性迁移门为发布闸) | accepted | 2026-07-08 |
| [ADR-025](adrs/ADR-025-user-workspace-alpha-dir.md) | `~/Alpha` 用户默认工作目录:可见数据主目录的目录契约与写入治理(lazy 供给 + 无项目态默认落点 + Journal/Memory/Outputs 契约 + 内置技能 `alpha-workspace`;2026-07-09 同日三残点拍板收口)。**2026-07-19 修订(ADR-031)**:§6 治理边界两条被窄修订 —— ① Memory 面允许用户显式发起的选择性云发布(其余 `~/Alpha` 仍不做同步/备份);② 「不删改用户文件」拆为「自动写入仍只追加」+「用户显式请求且指明范围可删 Memory 文件」 | accepted | 2026-07-09 |
| [ADR-026](adrs/ADR-026-windows-platform-support.md) | Windows 平台支持:桌面扩为 macOS+Windows(撤回 NON_GOALS#6 Mac-only)+ 平台差异收敛(路径全平台同构零特例 / platform seam 单点分发 / 安全诚实降级 / 发布链分工;审计实证无硬崩点、核心 2–4 人日) | accepted | 2026-07-09 |
| [ADR-027](adrs/ADR-027-alpha-product-kernel.md) | Alpha Product Kernel:AppInterface typed surface seam(home/newSession/session 窄叶 override)进入冻结前端,基点铸 `frontend-freeze-base-2`(ADR-029 L3 re-freeze,还原步 loud-fail 校验 seam 存活;修订 ADR-016/020) | accepted | 2026-07-12 |
| [ADR-028](adrs/ADR-028-extension-registry-v2.md) | Extension Package & Registry v2:ManifestV2/InstallRecordV2 严格 schema + main-only 安装计划(renderer 零安装权)+ 项目作用域闭环 fail-closed(Phase 0 信任修复 / Phase 1 ManifestV2 分期;ADR-029 全 L0;REQ-100 只留窄事务钩子接缝) | accepted | 2026-07-12 |
| [ADR-029](adrs/ADR-029-upstream-sovereignty-ladder.md) | 上游主权阶梯:「零改上游」铁律不修宪,主权升级走四级枚举通道(L0 接缝 → L1 变换 → L2 补丁 loud-fail → L3 冻结接管;逐案 ADR、永不设 L4 直接编辑;既有例外归位记账) | accepted(2026-07-12 同日拍板) | 2026-07-12 |
| [ADR-030](adrs/ADR-030-project-scope-generation-recall.md) | 收回 project-scope catalog/seed 受管安装:planner decode 后统一 policy guard fail-closed 拒(skill/agent 对称;wire 形状保留),新增安装策略与遗留可管理 kind 拆分,残留显式检测 + generation-aware 清理(journal 在场 fail-closed);项目技能能力走 `.alpha/skills` 非 generation 路径(#362 DECIDE,Codex 裁决) | accepted | 2026-07-15 |
| [ADR-031](adrs/ADR-031-hybrid-user-memory.md) | 混合用户记忆——本地优先、选择性云发布与有界上下文 | proposed | 2026-07-19 |
| [ADR-033](adrs/ADR-033-permission-kernel-takeover.md) | Permission 内核接管:REQ-090 #433 的 permission 引擎/契约面走 L3 冻结接管(ADR-029 §3;文件级守卫 `:(exclude)` 例外 + 生成文件整类移出;4 个 B 类连带退回 seam;放弃上游 permission 白嫖=单向门;逐文件审计 `docs/audits/2026-07-21-north-star-guard-upstream-delta.md`;#456 owner 拍板) | accepted | 2026-07-21 |
| [ADR-034](adrs/ADR-034-frontend-rolling-pin.md) | 前端滚动 pin(B 方案):packages/{app,ui} 从「冻结钉 tag」迁到「pin + 补丁序列」持续白嫖上游前端(**supersede ADR-020**,反转 ADR-016 前提);`frontend-pin.lock` + `alpha-frontend.patch` SOT;日常 sync `apply_alpha_frontend_delta`(pin+补丁,不擦 seam/不丢上游);月更 bump 升 pin(人门禁,见 `frontend/README.md`);owner 2026-07-21 拍板 | accepted | 2026-07-21 |
| [ADR-035](adrs/ADR-035-websearch-tool-takeover.md) | web search 工具失败面接管:`packages/opencode/src/tool/{websearch,mcp-websearch}.ts` 两个**源文件**走 ADR-029 L3 文件级 `:(exclude)`,解锁 #489 失败诚实(禁伪成功 / 任何非 2xx LOUD / 结构化零命中与 provider error 分辨 / 传输有界);上游测试文件**不接管**(新增断言落 alpha 自有 `test/tool/alpha-websearch-failure.test.ts`,避免整文件 exclude 连带放行 `registry.ts` 的 `webSearchEnabled` 断言);云路径 `catalog.ts` / `code-mode.ts` 已 loud,**刻意不收编**,且云侧无状态透传(归 alpha-platform#105);顺带把 `scripts/alpha-check.sh` 的守卫与 `alpha-ci.yml` 恢复 1:1(此前无 exclude 表、自 ADR-033 起恒假红);放弃这两文件上游白嫖=单向门,owner 2026-07-25 拍板 | accepted | 2026-07-25 |
| [ADR-036](adrs/ADR-036-single-engine-generation-for-session-send.md) | 会话发送保持**单一引擎代次**:会话页 composer 与时间线续钮从 v2 durable 队列(`c.v2.session.prompt`)改回 v1 `session.promptAsync`,与首页 `startChat` 同一条;档位随每条消息走 `PromptInput.agent`,v2 的 switchAgent + 权威读 + CAS 回滚账本一并退役。理由是事实而非偏好:`packages/core`(v2)**没有 MCP 运行时**、**没有 alpha ext 插件的钩子挂载点**(`tool.execute.before/after`、`experimental.chat.system.transform`),而云搜索/kill switch/prompt 接管/工厂拒绝/skill 注入整个主权层都建在 v1 钩子上;#652 实测 v2 受理 8 次 failed 8 次零成功且 UI 零投影。REQ-125 的 UI 成果(直挂 composer/审批停靠/任务卡/上下文 ring/斜杠登记)全部保留;v2 读侧(模型目录、switchModel、PermissionV2 feed)不受限。重新迁移的准入判据三条见 ADR §决策 3。owner 2026-07-28 拍板 | accepted | 2026-07-28 |
| [ADR-037](adrs/ADR-037-engine-generation-switch-is-its-own-change.md) | **引擎代次切换是一次独立变更**(类级规矩,不裁决具体链路):把任一产品链路从一代引擎 API 改到另一代 —— **含部分链路、含「只改一个入口」、含反向退回** —— 必须独立成票、独立成 PR、独立决策(ADR)、独立验证,不得作为功能提交的附带项;切换前必须交一份**能力清点表**,逐项用 `file:line` 或可复现命令证明「新代次有没有这条链路依赖的能力」(强制六轴:凭证面/工具运行时/插件钩子挂载点/事件投影面/持久化面/审批面),**缺项的唯一合法处置是不切**;合并闸的判据只认**端到端可观测行为**(跑生产代码 + 走用户入口 + 断言渲染/落库/真实请求 + 自己先反向绕过一遍确认转红),typecheck 绿、整包全绿、对抗审计过、源码文本断言、schema 有字段、HTTP 200 一律不算;同一流程的全部入口必须同代次,**半代次迁移禁止**。每条决策附「如何检验某个 PR」。立规代价来自 #652:PR#569 把切换夹带进 UI 重构,产出「每个会话只能发第一条消息」并活了四天,期间 2526 条测试全绿且过了对抗审计 —— 逐条解剖见 [`docs/audits/2026-07-28-652-engine-generation-split-incident.md`](../../docs/audits/2026-07-28-652-engine-generation-split-incident.md) | accepted | 2026-07-28 |

> 🔒 **编号预留**:产品所有权专项(见 [GitHub Issues](https://github.com/jinjunnn/alpha-code/issues) 与 [Alpha Delivery](https://github.com/users/jinjunnn/projects/2) §5)预留的 ADR-027/ADR-028 均已于 2026-07-12 按号落笔,预留清空;新 ADR 从 ADR-032 起编号。

> 📦 **ADR-010/011/013(云平台内部决策)已迁至 `alpha-platform/.claude/rules/adrs/`**(2026-06-22)。本仓只保留"本地→云派发接缝"(见 [ADR-002](adrs/ADR-002-backend-seams.md));文中其余处对它们的引用视为跨项目引用。
