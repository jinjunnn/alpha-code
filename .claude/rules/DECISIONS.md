# 决策日志(DECISIONS)

> 架构决策记录(ADR)。每做一个重要决策就在顶部插一条。不删除,只追加"撤回/修订"记录。

---

## ADR-005: 架构 pivot —— 从 submodule 隔离改为 fork + 只增不改
**日期**:2026-06-14
**状态**:✅ 采纳(**取代 ADR-001 的 submodule 机制;ADR-002/003 的扩展/前端策略仍有效**)
**复盘状态**:未复盘

### 背景
ADR-001 把 opencode 作 submodule、自有代码在其外。实践中这套"workspace 外复用"持续踩坑:`@opencode-ai/{app,ui}` 只能 symlink + vite alias(alias 绕过 `exports` map → 深子路径如 `/index.css` 解析失败)、solid-js 双实例、Tailwind content-scan 扫不到 app 源码 → **production 构建产出 0 字节 CSS(UI 散架)**。根因:自有前端不是 opencode workspace 的原生成员。用户已在 GitHub 建好 fork `jinjunnn/alpha-code`。

### 决策
改用 **fork 模型**:本仓库 = `anomalyco/opencode` 的 fork;自有包(`packages/ext`、`packages/ui-mac`)是**原生 workspace 成员**。
- 分支:`dev` = upstream 纯镜像(fast-forward);`alpha` = `dev` + 自有新增(产品分支)。
- 同步:`.github/workflows/sync-upstream.yml` 每天同步 dev → merge 进 alpha。
- **铁律(取代"submodule 只读")**:**只新增文件,从不编辑 opencode 既有文件** → fork-sync 永远零冲突,同时拿到原生构建。

### 后果
- ✅ 原生构建:`ui-mac` 镜像 `packages/desktop`,`@opencode-ai/*` 走 `workspace:*`/`catalog:`,**无 symlink/alias/dedupe hack**。实测 production 产出 475KB CSS(此前 0)、Electron 原生起窗。
- ✅ 升级仍干净:只增不改 → merge dev 零冲突。北极星(冲突文件数=0)不变,守卫从"submodule diff 为空"变为"alpha 相对 dev 的 diff 只含新增文件"。
- ⚠️ 代价:仓库带 opencode 全历史(NON_GOALS#3 原"不维护硬分叉"已据此修订为"维护 fork 但守只增纪律")。
- ⚠️ electron 在非 hoisted workspace 里 electron-vite 解析不到 → 需 `ELECTRON_EXEC_PATH`(已记录于 ALPHA.md)。

### 撤回/修订记录
- 取代 ADR-001 的"submodule + 自有代码在外"机制。ADR-001 保留作历史。

---

## ADR-004: 升级隔离纪律 — CI 守卫 opencode 源码零改动
**日期**:2026-06-14
**状态**:🔄 试行
**复盘状态**:未复盘

### 背景
隔离架构的成败取决于"没人偷偷改 opencode 源码"。需要机械守卫,不能靠自觉。

### 决策
1. `opencode/` 为 git submodule,钉死 commit `7efade2`。
2. CI/pre-push 检查:`git -C opencode status --porcelain` 为空,且 submodule 指针只能整体跳 ref(不能有工作树改动)。
3. 升级流程:切 submodule 新 ref → review `packages/sdk/openapi.json` 与 `packages/plugin/src/index.ts`、`tui.ts` 三处契约 diff → bump 自有依赖版本 → 跑 `bun turbo typecheck` → 记录到 `docs/retros/`。

### 后果
- ✅ 升级摩擦可量化、可守卫。
- ⚠️ 唯一例外(新增 /api 路由)必须走 `patches/` 补丁层,且补丁失效会 loud-fail。

---

## ADR-003: 前端走 B+A(挂 AppInterface + 自定义 Platform + token 换肤),保留 Electron
**日期**:2026-06-14
**状态**:✅ 采纳
**复盘状态**:未复盘

### 背景
要"独立 UI",但官方 `@opencode-ai/app` 已含 300 文件的 state/sync/SSE/permission/diff 层。三档可选:A 仅换肤 / B 复用渲染器换外壳 / C 全新 SDK 渲染器。

### 考虑的方案
- 方案 A:只覆盖 CSS token。改不了布局,算不上独立 UI。
- 方案 B:挂 `AppInterface`(`packages/app/src/app.tsx` ~L380)+ 自定义 `Platform`(`context/platform.tsx`,~40 方法的单一 host 接缝),复用全部状态层,屏幕逐个替换。
- 方案 C:只依赖 `@opencode-ai/sdk` 自建一切。最干净边界,但要重写状态层,成本最大。

### 决策
选择 **B + A**(用户拍板):挂 `AppInterface` + 自定义 `Platform` + token 主题,屏幕按需逐个替换;Mac 外壳**保留 Electron**,复用 `packages/desktop` 的 sidecar + `window.api` 模式。

### 后果
- ✅ 最快起步,白嫖状态/同步/事件层,升级摩擦小。
- ✅ 保留向 C 渐进迁移的路(逐屏替换)。
- ⚠️ 若改官方 `pages/*` 屏幕视觉,会在升级时重新 merge 大文件——故视觉改造优先走 token + 自有组件,不改 `pages/*` 内部。
- ⚠️ 复用 app/ui + 内嵌 server 需从 submodule **源码构建**(它们 private)。

---

## ADR-002: 后端走 plugin/tool/MCP/sidecar,绝不 fork server 路由
**日期**:2026-06-14
**状态**:✅ 采纳
**复盘状态**:未复盘

### 背景
opencode `server` 路由是 `HttpApi.make(...).add(Group)` 编译期静态组装,**插件层无挂路由口子**。新增 HTTP 接口要改 `api.ts`+`server.ts`(高 churn,升级必冲突)。但工具/hooks/MCP 都是零-fork 接缝。

### 决策
- 自有后端能力 = `@alpha-code/ext` 包(server plugin `{id, server}` + 自定义 tools)+ 必要时 MCP server,经 `.opencode/opencode.jsonc` 的 `plugin[]` / `mcp` 引用。
- 需要给自有 UI 的新 HTTP 接口 → **自有 sidecar 进程**(Hono/Bun),内部用 `@opencode-ai/sdk` 调 opencode。
- 仅当确需与官方同端口/同鉴权的 `/api/*` 路由时,才走 `patches/` 补丁层(见 ADR-004 例外)。

### 后果
- ✅ 后端定制零改 opencode 源码。
- ⚠️ 上下文注入目前只有 `experimental.chat.{system,messages}.transform`(core 的 `SystemContextRegistry` 不对外开放)——按 NON_GOALS#4 标注风险使用。

---

## ADR-001: opencode 以 pinned submodule 引入,自有代码在其外
**日期**:2026-06-14
**状态**:✅ 采纳
**复盘状态**:未复盘

### 背景
要既隔离又能继承升级。opencode 当前是 `anomalyco/opencode` 全量克隆。

### 考虑的方案
- 方案 A:vendored 目录(拷进来)。无版本追踪,升级靠手动。
- 方案 B:git submodule 钉死 ref,自有代码在 submodule 外。
- 方案 C:纯 npm 依赖 `@opencode-ai/*`。但 server/opencode 是 private,前端复用/内嵌 server 走不通。

### 决策
选择 **B**:`opencode/` = submodule @ `7efade2`(已就地注册,未重新下载)。自有代码全在 `packages/` 等同级目录。升级 = `git -C opencode checkout <ref>` + bump 契约版本。

### 后果
- ✅ 隔离 + 可追踪升级 + 可 diff 审查。
- ✅ opencode 当作只读上游,不在其历史里提交自有改动。
- ⚠️ upstream 只有 `dev` 分支、无 tag、正处 Effect 大迁移——pin 必须谨慎,升级前先看契约 diff。
