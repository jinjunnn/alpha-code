# 架构约束(ARCHITECTURE)

> 最后更新:2026-07-03
> 回顾节奏:每次 `/app:retro` 时审视是否仍有效
> 2026-06-18:产品转多用户/多租户,本文"规模/下游"已据 ADR-010/011 修订。
> 2026-07-03(C6 去漂移):删 submodule/pinned-`7efade2` 陈述(ADR-005 fork,已 `merge dev` 追平上游);「薄定制层<5%」拆为**后端守 / 前端接管**(ADR-016)。
> 2026-07-09(ADR-026):桌面平台扩为 **macOS + Windows**,原「本地 Mac 应用」表述据此更新;平台差异收敛纪律见 ADR-026(platform seam + 路径同构)。

## 技术栈
- **语言**:TypeScript(消费侧),少量 JS。
- **运行时**:Bun 1.3.x(opencode 同款,见根 `package.json` packageManager);Node(经 Electron)。
- **框架**:SolidJS(前端,复用 `@opencode-ai/app` + `@opencode-ai/ui`)、Effect v4(opencode 内部,我方只消费类型)、Electron(桌面外壳,macOS+Windows,复用 `packages/desktop` 模式;ADR-026)、可选 Hono/Bun(自有 sidecar)。
- **数据存储**:复用 opencode 自带 SQLite(会话/历史),不另起主存储;sidecar 如需自有状态再议。
- **部署**:本地桌面应用(macOS 首发 + Windows,ADR-026;Linux 不做),`electron-builder`(`package:mac` / `package:win`)。

## 硬性约束(不可协商)
1. **上游源码只读(fork,只增不改)**:本仓库是 `anomalyco/opencode` 的 fork(**非 submodule**,ADR-005 已取代 ADR-001);`packages/{opencode,core,server,tui,sdk}` 等上游文件**只读**,永不修改。升级 = `git merge dev`(`dev` 为上游纯镜像)+ 契约 diff 适配。CI 守卫(`alpha-ci.yml` north-star guard):`git diff --diff-filter=DMR origin/dev...HEAD -- packages/{opencode,core,server,tui,sdk}` 非空即红。**注:此后端只读铁律不受 ADR-016 前端接管影响**(前端接管是**新增** alpha 文件,不改上游源码)。**ADR-020(2026-07-03)修订**:`packages/{app,ui}` 已冻结、不随上游同步,移出守卫范围;冻结包对 alpha 仍**保持只读**(唯一写操作 = 受控 re-freeze,见 ADR-020 §5)。**ADR-027(2026-07-12)修订**:冻结基点升级为 `frontend-freeze-base-2`(含 AppInterface typed surface seam;还原步 loud-fail 校验 seam 存活)。
2. **前后端只走契约**:自有前端与 opencode 后端之间,只经 `@opencode-ai/sdk`(v1 `/…` + v2 `/api/*`)+ 单条 SSE `GET /api/event` + 每终端一条 PTY WS。**禁止**直 import `@opencode-ai/core` 内部模块当运行时用(类型除外)。
3. **后端只用零-fork 接缝**:自有后端能力只能落在 `.opencode/tool/*`、plugin hooks(`.opencode/plugin(s)/*` 或 config `plugin[]`)、MCP(config `mcp.servers`)、声明式 `.opencode/{agent,command,skill,theme}`。**新增 HTTP 接口走自有 sidecar 进程**,不改 `@opencode-ai/server`。

## 边界与外部依赖
- **上游(我们依赖)**:opencode @ `anomalyco/opencode`(分支 `dev`,fork 定期 `merge dev → alpha` 追平,**无 pinned commit**;`sync-upstream.yml` 每日自动同步);契约包 `@opencode-ai/sdk`、`@opencode-ai/plugin`(随上游演进,npm 当前 `1.17.13`)。
  - ⚠️ 关键事实:`@opencode-ai/server` 与 `opencode` 在该仓库是 `private:true` → **复用前端(app/ui)或内嵌 server 必须从 fork 内的 workspace 源码构建,不能纯 npm 装**。`sdk` / `plugin` 是公开 MIT 契约。
- **下游(依赖我们)**:多用户/多租户(本地各跑实例 + 共享云平台);见 [[ADR-010]]/[[ADR-011]]。
- **产品三后端拓扑(2026-06-22 补,见 [[ADR-013]] 与 `agent-harness-architecture.md` §0.5)**:产品面 = **三个独立后端**,运行时/信任域/发布节奏各异,**仅 A 在本仓**:
  - **A 本地 sidecar** — 本仓 `packages/ui-mac`(Electron `utilityProcess`)。桌面 UI 要、opencode server 没有的本地 HTTP;websearch 直连;alpha-secrets。✅ 已存在,见 [[ADR-002]]/[[ADR-009]]。
  - **B 云控制面 + MCP 工具网关 + 模型代理** — 独立仓 `alpha-platform`(AWS ECS/Fargate + Upstash)。`cloud.dispatch` 服务端硬校验、host tool 密钥 + capability token、模型代理网关(hybrid 代付,见 [[ADR-013]])、Box 沙箱、run ledger(Redis)、多租户认证/配额/计费。❌ 新建,**不在升级隔离北极星内**(自负安全/计费/运维),见 [[ADR-010]]/[[ADR-011]]。
  - **C 分发/官网后端** — 独立仓 `alpha-web`(Vercel + 对象存储)。营销/下载页、electron 自动更新 feed(`latest-mac.yml`,挂 [[ADR-012]] prod 渠道)、Mac 签名/公证、注册登录/license/计费门户。❌ 新建。
  - **依赖方向**:`alpha-code`(A) ──经 provider `baseURL` + `@opencode-ai/sdk` + MCP `cloud.dispatch`──▶ `alpha-platform`(B);`alpha-web`(C)签发身份/license,`alpha-platform`(B)校验之做配额/计费;C 喂自动更新 feed 给 `alpha-code` 的 electron updater。**B/C 共享 identity**;三者契约只走 HTTP/SDK,**绝不源码级耦合**(保 fork-sync 零冲突)。
- **外部 API/服务**:LLM provider(经 opencode 配置,不在 alpha-code 重做);自有 sidecar 如接外部服务再列。

## 禁区(明确不做的架构选择)
- 改 `opencode/packages/core|server|app/src/pages|ui/src/components` 内部(高 churn,升级必冲突)。
- 手改生成代码:`packages/sdk/js/src/**`、`packages/sdk/openapi.json`(只能 codegen 重生)。
- 把核心后端行为长期建立在 `experimental.*` hook / `/experimental/*` 路由上(unstable by name)。
- 引入与 opencode `catalog` 冲突的 `effect` / `solid-js` / `@opentui/*` 版本。

## ADR 列表(索引见 `DECISIONS.md`,每条一个文件在 `adrs/`)
- ADR-001:opencode pinned submodule 引入(已被 ADR-005 取代)→ adrs/ADR-001-opencode-submodule.md
- ADR-002:后端走 plugin/tool/MCP/sidecar,绝不 fork server 路由 → adrs/ADR-002-backend-seams.md
- ADR-003:前端走 B+A(挂 AppInterface + 自定义 Platform + token 换肤)→ adrs/ADR-003-frontend-appinterface.md
- ADR-004:升级隔离纪律(CI 守卫 opencode 源码零改动)→ adrs/ADR-004-upgrade-isolation-ci.md
- ADR-005:pivot 到 fork + 只增不改 → adrs/ADR-005-fork-pivot.md
- ADR-006:两个运行时世界,自有 ext 必须预 bundle → adrs/ADR-006-runtime-worlds.md
- ADR-007:前端品牌化 build-time transform → adrs/ADR-007-brand-transform.md
- ADR-008:Codex 风格左边栏 → adrs/ADR-008-sidebar.md
- ADR-009:websearch 默认放开 + alpha.env → adrs/ADR-009-websearch-default.md
- ADR-012:ui-mac 发布默认 prod 渠道,dev/beta 保留不删 → adrs/ADR-012-ui-mac-channel.md
- ADR-014(proposed):定制中心 — Skills/MCP/Plugins 可视化市场 + alpha 自建套件 + 零-fork 安装 → adrs/ADR-014-extension-hub.md(设计:`docs/design/extension-hub.md`)
- ADR-015(accepted):提示词优化策略 — 上游底座只读 + 能力感知 identity(Tier-1)+ 行为层 alpha-behavior(Tier-3)+ 合并验证纪律 → adrs/ADR-015-prompt-optimization-strategy.md

## 性能与规模预期
- **规模假设(2026-06-18 修订)**:本地 = 多用户各自单机;**云平台 = 多租户共享**,并发不再是个位数,需按租户配额/隔离/容量规划(见 [[ADR-011]]);原"单用户"假设作废。
- **6 个月预期**:面向多用户的产品 + 云多租户平台。**分层定位(ADR-016 修订,取代原全局"薄定制层")**:① **后端**仍守「薄定制层」——只经 SDK / plugin / tool / MCP / sidecar 接缝叠加,升级隔离健康度是其北极星,「< opencode 体量 5%」目标**仅对后端成立**;② **前端**已由 ADR-016 **全面接管**(alpha 自有组件重建 UI),是**厚定制层**,**放弃前端升级隔离**,「<5%」**不再适用于前端**(只继承后端/引擎层升级)。云平台为独立 codebase、不计入。
- **性能底线**:前端定制不得使官方屏幕交互明显变慢;sidecar 不阻塞 agent 主回路。

## D2 架构图索引
- `docs/architecture/diagrams/opencode-codegraph.d2` / `.svg` — opencode 27 包分层 code-graph(已生成)
- `docs/architecture/diagrams/01-overview.d2` — alpha-code 自有架构俯瞰(`/app:design-arch` 生成,待做)
