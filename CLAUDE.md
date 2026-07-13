# alpha-code (fork of anomalyco/opencode)

基于 opencode 的桌面编码 agent 产品(macOS 首发 + Windows,ADR-026;面向多用户分发)。**本仓库是 opencode 的 fork**;自有代码以"只增不改 upstream 文件"的纪律作为原生 workspace 成员叠加。入口说明见 `ALPHA.md`。

> opencode 自身的 `AGENTS.md` / `README.md` / `CONTEXT.md` 是上游的,**保持未改动**。这份 `CLAUDE.md` 是 alpha-code 追加的。

## Project Rules(/app:* 方法论)

**定位**:基于 opencode fork 的桌面编码 agent 产品(macOS 首发 + Windows,ADR-026;面向多用户 + 云多租户)—— 本地不改 opencode 自身文件,以原生 workspace 成员叠加自有 UI 与后端,fork-sync 零冲突继承上游;云平台为独立运行时(见独立项目 alpha-platform 的 .claude/rules)。
**北极星**:升级隔离健康度 —— 每次 upstream sync 后冲突文件数 = 0。
**明确不做**:① 编辑任何 opencode 自身的文件(只新增);② 重写 agent core/session/context 引擎;③ 给 upstream 提 PR(这是个人 fork)。
**硬约束**:① 只新增文件,绝不改 opencode 既有文件(否则 fork-sync 冲突);② 前后端只走 `@opencode-ai/sdk` 契约;③ 后端走 plugin/tool/MCP,新 HTTP 接口走 sidecar 不改 server。

**详细文件**:`.claude/rules/{POSITIONING,GOALS,NON_GOALS,ARCHITECTURE,DECISIONS,GLOSSARY}.md`

所有 `/app:*` 命令会先读这些文件;产物若偏离会标 `[DRIFT]`。

## 分支与同步(ADR-005)
- **自有代码只在 `alpha`**;`dev` 是上游只读镜像,从不在其上改动。日常只在 `alpha` 工作。**仓库只此两个分支。**
- `dev` = `anomalyco/opencode:dev` 纯镜像(永远 fast-forward)。
- `alpha` = `dev` + 自有新增(产品/开发分支)。
- 自动:`.github/workflows/sync-upstream.yml` 每天同步 dev → merge 进 alpha。
- 手动升级:`gh repo sync jinjunnn/alpha-code --branch dev` → `git checkout alpha && git merge dev`。

## 关键事实速查
- opencode = 27 包 Bun monorepo;脊柱 = `@opencode-ai/sdk`(契约)+ `@opencode-ai/core`(地基)。
- 自有包是**原生 workspace 成员**(`packages/ext`、`packages/ui-mac`),`@opencode-ai/*` 走 `workspace:*` / `catalog:` —— 无 symlink hack。
- `ui-mac` 镜像 `packages/desktop` 的原生 Electron 模式;Tailwind/CSS/solid 原生解析(实测产物 475KB CSS)。
- 新增 `/api/*` 路由是唯一会改 upstream 文件的场景 → 用 sidecar 规避。
- 架构理解见 `docs/architecture/understanding.md`;扩展接缝手册见 `docs/architecture/extension-seams.md`;code-graph 见 `docs/architecture/diagrams/opencode-codegraph.svg`。
- **交付治理**:GitHub Issues + [`Alpha Delivery`](https://github.com/users/jinjunnn/projects/2) 是活跃需求、状态、优先级与 Sprint 的唯一真源。单仓工作建在 `jinjunnn/alpha-code`;跨仓父需求建在 `jinjunnn/alpha-work`。旧交付追踪器(BACKLOG、requirements、sprints,已退役至 `docs/archive/DEPRECATED.md`)是迁移前历史,不得再翻状态或从中抽取新 Sprint。统一规则见 `jinjunnn/alpha-work/governance/delivery-standard.md`;用户可见发布历史仍写 `CHANGELOG.md`。

## 跑起来
```
bun install
bun run --cwd packages/ui-mac dev   # electron 解析失败时加 ELECTRON_EXEC_PATH(见 ALPHA.md);flag 须在 run 后(REQ-027)
bash scripts/alpha-check.sh          # push 前自检:北极星守卫 + typecheck + 单测(与 alpha-ci 1:1)
```

## CI(规范见 `docs/runbooks/ci.md`)
**本地先跑,CI 兜底**。push 前必过 `scripts/alpha-check.sh`。GitHub 上只有 `alpha-ci`(三关,required)+ `sync-upstream` 两个 workflow active;继承的 ~26 个上游 workflow 已禁用(要 Blacksmith runner,本 fork 没有 → 永久 queued,即"CI 卡"真因)。排查手册见 `docs/runbooks/ci.md` §5。
