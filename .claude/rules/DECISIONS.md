# 决策日志(DECISIONS)— 索引

> 架构决策记录(ADR)索引。**每条 ADR 一个文件**,见 `.claude/rules/adrs/`。
> 新增:在 `adrs/` 加 `ADR-0NN-<slug>.md`(必带 frontmatter:`id/title/status/date`,可选 `supersedes/superseded-by/related`),并在下表追加一行。
> 不删除既有 ADR,只改其 `status` + 在文件内追加"撤回/修订"。`status` ∈ `accepted | trial | superseded | proposed`。

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
| [ADR-015](adrs/ADR-015-prompt-optimization-strategy.md) | 提示词优化策略:底座只读 + 能力感知 identity + Tier-3 行为层(含合并验证) | accepted | 2026-06-23 |
| [ADR-016](adrs/ADR-016-frontend-takeover.md) | 前端全面接管:alpha 自有组件重建前端 + 复用重型引擎 + 放弃前端升级隔离北极星(取代 ADR-003) | accepted | 2026-06-24 |
| [ADR-017](adrs/ADR-017-desktop-auth-deeplink.md) | 桌面授权深链:scheme 必须进 Info.plist + PKCE 落盘抗冷启动 | accepted | 2026-06-25 |
| [ADR-018](adrs/ADR-018-req-lifecycle.md) | 需求生命周期与文档流:单一真源 `docs/BACKLOG.md` + 两档流程 + Sprint 契约 + 归档纪律 | accepted | 2026-07-03 |
| [ADR-019](adrs/ADR-019-alpha-workdir.md) | `.alpha` 项目工作目录:alpha harness 产物全量收敛(桥接细节由 REQ-004 验证回填) | accepted | 2026-07-03 |
| [ADR-020](adrs/ADR-020-frontend-freeze.md) | 前端冻结:packages/{app,ui} 钉 frontend-freeze-base,每日 sync 只进引擎(E 路径,REQ-013 拍板;修订 ADR-004 守卫范围) | accepted | 2026-07-03 |
| [ADR-021](adrs/ADR-021-cloud-data-boundary.md) | 代码上云数据边界:diff-only 优先 + secrets 过滤 + 体积上限 + consent 挂钩 B16(C9,S11 T3;§2 三校验已实现,S14) | accepted | 2026-07-04 |
| [ADR-022](adrs/ADR-022-automations.md) | 自动化定时任务:本地调度器 + 只读 agent 静态权限档 + `.alpha` 落盘(REQ-021 A1;A2/A3 分期) | accepted(2026-07-05 真机批 PASS,REQ-016 S16;到点触发+readonly deny 零 ask+错过 skip) | 2026-07-04 |

> 📦 **ADR-010/011/013(云平台内部决策)已迁至 `alpha-platform/.claude/rules/adrs/`**(2026-06-22)。本仓只保留"本地→云派发接缝"(见 [ADR-002](adrs/ADR-002-backend-seams.md));文中其余处对它们的引用视为跨项目引用。
