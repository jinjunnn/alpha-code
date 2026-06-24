# 决策日志(DECISIONS)— 索引

> 架构决策记录(ADR)索引。**每条 ADR 一个文件**,见 `.claude/rules/adrs/`。
> 新增:在 `adrs/` 加 `ADR-0NN-<slug>.md`(必带 frontmatter:`id/title/status/date`,可选 `supersedes/superseded-by/related`),并在下表追加一行。
> 不删除既有 ADR,只改其 `status` + 在文件内追加"撤回/修订"。`status` ∈ `accepted | trial | superseded | proposed`。

| ADR | 标题 | 状态 | 日期 |
|-----|------|------|------|
| [ADR-001](adrs/ADR-001-opencode-submodule.md) | opencode pinned submodule 引入 | superseded → ADR-005 | 2026-06-14 |
| [ADR-002](adrs/ADR-002-backend-seams.md) | 后端走 plugin/tool/MCP/sidecar | accepted | 2026-06-14 |
| [ADR-003](adrs/ADR-003-frontend-appinterface.md) | 前端 B+A(AppInterface + Platform + token) | superseded → ADR-016 | 2026-06-14 |
| [ADR-004](adrs/ADR-004-upgrade-isolation-ci.md) | 升级隔离 CI 守卫 | trial | 2026-06-14 |
| [ADR-005](adrs/ADR-005-fork-pivot.md) | pivot 到 fork + 只增不改 | accepted | 2026-06-14 |
| [ADR-006](adrs/ADR-006-runtime-worlds.md) | 两个运行时世界,ext 必须预 bundle | accepted | 2026-06-15 |
| [ADR-007](adrs/ADR-007-brand-transform.md) | 品牌化 build-time transform | accepted | 2026-06-15 |
| [ADR-008](adrs/ADR-008-sidebar.md) | Codex 风格左边栏(Portal + SDK + CSS 接缝) | accepted | 2026-06-17 |
| [ADR-009](adrs/ADR-009-websearch-default.md) | websearch 默认放开 + alpha.env 秘钥落点 | accepted | 2026-06-18 |
| [ADR-012](adrs/ADR-012-ui-mac-channel.md) | ui-mac 发布默认 prod 渠道,dev/beta 保留不删 | accepted | 2026-06-18 |
| [ADR-014](adrs/ADR-014-extension-hub.md) | 定制中心:Skills/MCP/Plugins 市场 + alpha 自建套件 + 零-fork 安装 | trial | 2026-06-22 |
| [ADR-015](adrs/ADR-015-prompt-optimization-strategy.md) | 提示词优化策略:底座只读 + 能力感知 identity + Tier-3 行为层(含合并验证) | accepted | 2026-06-23 |
| [ADR-016](adrs/ADR-016-frontend-takeover.md) | 前端全面接管:alpha 自有组件重建前端 + 复用重型引擎 + 放弃前端升级隔离北极星(取代 ADR-003) | accepted | 2026-06-24 |

> 📦 **ADR-010/011/013(云平台内部决策)已迁至 `alpha-platform/.claude/rules/adrs/`**(2026-06-22)。本仓只保留"本地→云派发接缝"(见 [ADR-002](adrs/ADR-002-backend-seams.md));文中其余处对它们的引用视为跨项目引用。
