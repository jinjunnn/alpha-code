# 架构约束(ARCHITECTURE)

> 最后更新:2026-06-14
> 回顾节奏:每次 `/app:retro` 时审视是否仍有效

## 技术栈
- **语言**:TypeScript(消费侧),少量 JS。
- **运行时**:Bun 1.3.x(opencode 同款,见根 `package.json` packageManager);Node(经 Electron)。
- **框架**:SolidJS(前端,复用 `@opencode-ai/app` + `@opencode-ai/ui`)、Effect v4(opencode 内部,我方只消费类型)、Electron(Mac 外壳,复用 `packages/desktop` 模式)、可选 Hono/Bun(自有 sidecar)。
- **数据存储**:复用 opencode 自带 SQLite(会话/历史),不另起主存储;sidecar 如需自有状态再议。
- **部署**:本地 Mac 应用,`electron-builder`(`package:mac`)。

## 硬性约束(不可协商)
1. **`opencode/` 子模块只读**:钉死 commit(当前 `7efade2`),永不修改其 `packages/**`。升级 = 切 submodule ref + bump 契约版本。CI 守卫 `git diff opencode/packages` 必须为空。
2. **前后端只走契约**:自有前端与 opencode 后端之间,只经 `@opencode-ai/sdk`(v1 `/…` + v2 `/api/*`)+ 单条 SSE `GET /api/event` + 每终端一条 PTY WS。**禁止**直 import `@opencode-ai/core` 内部模块当运行时用(类型除外)。
3. **后端只用零-fork 接缝**:自有后端能力只能落在 `.opencode/tool/*`、plugin hooks(`.opencode/plugin(s)/*` 或 config `plugin[]`)、MCP(config `mcp.servers`)、声明式 `.opencode/{agent,command,skill,theme}`。**新增 HTTP 接口走自有 sidecar 进程**,不改 `@opencode-ai/server`。

## 边界与外部依赖
- **上游(我们依赖)**:opencode @ `anomalyco/opencode` commit `7efade2`(分支 `dev`);契约包 `@opencode-ai/sdk`、`@opencode-ai/plugin` @ `1.17.6`。
  - ⚠️ 关键事实:`@opencode-ai/server` 与 `opencode` 在该仓库是 `private:true` → **复用前端(app/ui)或内嵌 server 必须从 submodule 源码构建,不能纯 npm 装**。`sdk` / `plugin` 是公开 MIT 契约。
- **下游(依赖我们)**:无(个人工具)。
- **外部 API/服务**:LLM provider(经 opencode 配置,不在 alpha-code 重做);自有 sidecar 如接外部服务再列。

## 禁区(明确不做的架构选择)
- 改 `opencode/packages/core|server|app/src/pages|ui/src/components` 内部(高 churn,升级必冲突)。
- 手改生成代码:`packages/sdk/js/src/**`、`packages/sdk/openapi.json`(只能 codegen 重生)。
- 把核心后端行为长期建立在 `experimental.*` hook / `/experimental/*` 路由上(unstable by name)。
- 引入与 opencode `catalog` 冲突的 `effect` / `solid-js` / `@opentui/*` 版本。

## ADR 列表(详见 DECISIONS.md)
- ADR-001:opencode 以 pinned submodule 引入,自有代码在其外 → DECISIONS#ADR-001
- ADR-002:后端走 plugin/tool/MCP/sidecar,绝不 fork server 路由 → DECISIONS#ADR-002
- ADR-003:前端走 B+A(挂 AppInterface + 自定义 Platform + token 换肤),保留 Electron 复用 desktop → DECISIONS#ADR-003
- ADR-004:升级隔离纪律(CI 守卫 opencode 源码零改动)→ DECISIONS#ADR-004

## 性能与规模预期
- **当前规模**:单用户、单机 Mac、个位数并发会话。
- **6 个月预期**:仍为个人工具;自有代码控制在"薄定制层"(目标 < opencode 自身体量的 5%)。
- **性能底线**:前端定制不得使官方屏幕交互明显变慢;sidecar 不阻塞 agent 主回路。

## D2 架构图索引
- `docs/diagrams/opencode-codegraph.d2` / `.svg` — opencode 27 包分层 code-graph(已生成)
- `docs/diagrams/01-overview.d2` — alpha-code 自有架构俯瞰(`/app:design-arch` 生成,待做)
