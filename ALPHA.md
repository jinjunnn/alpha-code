# alpha-code

基于 **opencode** 的桌面编码 agent 产品(macOS + Windows,面向多用户分发)。**本仓库是 `anomalyco/opencode` 的 fork**;自有代码以"只增不改 upstream 文件"的纪律,作为**原生 workspace 成员**叠加进来,以便 fork-sync 零冲突地继承上游升级。

> opencode 自带的 `README.md` / `AGENTS.md` / `CONTEXT.md` 等保持上游原样**未改动**。本文件(`ALPHA.md`)是 alpha-code 的入口说明。

## 关联仓库与交付治理

`alpha-code` 只拥有桌面产品与本地运行时集成。关联仓库:

- [`alpha-work`](https://github.com/jinjunnn/alpha-work):产品组合目标、跨仓父需求与治理标准;
- [`alpha-platform`](https://github.com/jinjunnn/alpha-platform):模型网关、云执行、计量与多租户强制;
- [`alpha-web`](https://github.com/jinjunnn/alpha-web):公共站点、身份、计费体验与 Catalog;
- [`alpha-code-plugin`](https://github.com/jinjunnn/alpha-code-plugin):Claude Code plugin 包装与分发。

活跃需求、Bug、任务和验收状态只在
[`alpha-code` Issues](https://github.com/jinjunnn/alpha-code/issues) 与
[`Alpha Delivery`](https://github.com/users/jinjunnn/projects/2) 管理。跨仓
Outcome 的父 Issue 在 `alpha-work`;本仓只保留本仓拥有的 Issue。长期目标见
[`.claude/rules/GOALS.md`](.claude/rules/GOALS.md),统一规范见
[`alpha-work`](https://github.com/jinjunnn/alpha-work/tree/main/governance)。本地
Markdown 不再复制活跃 backlog、优先级、负责人或 Sprint 状态。

## 模型:fork + 只增不改
- **`dev` 分支** = `anomalyco/opencode:dev` 的纯镜像(永远 fast-forward,Sync fork 零冲突)。
- **`alpha` 分支**(产品分支)= `dev` + 自有新增文件。日常开发在 `alpha`。
- **自动同步**:`.github/workflows/sync-upstream.yml` 每天把 upstream 同步进 `dev`,再 merge 进 `alpha`。
- **纪律(北极星)**:**只新增文件,从不编辑 opencode 自身的任何文件** → 每次 sync 零冲突。这是 fork 模型能保持干净的唯一要求。
- **上游 roadmap 不是 Alpha backlog**:`specs/v2/`、
  `packages/opencode/specs/effect/`、`packages/codemode/` 与
  `packages/llm/example/` 中的 TODO、Status 和 checklist 随 `dev` 镜像，仅描述
  upstream 工作，不是 Alpha 的交付状态。不得为治理而改写这些上游文件或把
  其未完成项批量迁入 Alpha；只有当某项成为 Alpha 发布/采用门槛时，才在
  `alpha-code` 新建验收 Issue，引用准确的 upstream revision，并纳入 Alpha
  Delivery。

## 自有新增(都是新文件/新目录,不碰 upstream)
| 路径 | 作用 |
|---|---|
| `packages/ext/` | `@alpha-code/ext` —— 零改动 opencode 的后端扩展(server plugin + 自定义 tools)。原生 workspace 成员,`@opencode-ai/plugin` 走 `workspace:*`。 |
| `packages/ui-mac/` | 自有 Electron Mac 外壳:复用 `@opencode-ai/app` 的 `AppInterface` + 自定义 `Platform` + token 换肤(镜像 `packages/desktop` 的原生模式,无任何 symlink hack)。 |
| `packages/ui-mac/src/renderer/{brand,theme-alpha,logo-alpha}.*` | 品牌层(全部新增,零改 upstream):`brand.ts` 是品牌色单一来源(图标橙 `#F87814` + 奶油 `#FBF4EC`);`theme-alpha.ts` 是 orng 主题的品牌重皮("Alpha" 主题,`registerTheme` 注册进选择器、首启动 `localStorage` 设默认);`logo-alpha.tsx` 是 α 版 Splash(替换我方 `index.tsx` 的 import)。 |
| `.claude/rules/` | 项目宪法(6 文件,`/app:*` 方法论)。 |
| `docs/` | 架构理解 + 扩展接缝手册 + opencode code-graph(SVG)。 |
| `CLAUDE.md` | 速查 + 升级 runbook。 |

## 跑起来(开 app)
```bash
bun install                          # 一次性:原生 workspace 安装
cd packages/ui-mac && bun run dev    # 开 Mac 应用窗口
```
- 首次启动较慢:`predev` 先构建内嵌 opencode server(~20MB bundle,约 30–60s),然后弹出 Electron 窗口。
- 退出:窗口 `Cmd+Q`,或终端 `Ctrl+C`。
- `bun run dev` 已自动解析 electron 二进制(`scripts/launch.ts`),**无需手动设 `ELECTRON_EXEC_PATH`**。

## 使用须知 / 已知坑
- **别把 fork 仓库本身当工作项目打开**:`/Users/tide/app/alpha-code`(及 opencode 仓库)带 upstream 维护者的生 TS 工具(`.opencode/tool/*.ts` import `@opencode-ai/plugin`),桌面端 Electron-Node 加载它们会 Die → **聊天无任何反馈**。日常用 `/Users/tide/app` 下的真实项目即可。根因与运行时分裂见 `.claude/rules/DECISIONS.md` 的 **ADR-006**。
- **免费模型要先登录 opencode**:`opencode` provider(Zen 网关,默认小模型 `big-pickle` 等)走 OAuth 登录;没登录则只有自己配的 provider(如 deepseek)可用。app 选择器或 CLI `opencode auth login` 均可,app/CLI 共用 `~/.local/share/opencode/auth.json`。
- **自有 `@alpha-code/ext` 必须预 bundle 成自包含 JS**(把 `@opencode-ai/plugin` 内联),否则会撞上同一道 Node 加载生 TS 的墙。见 **ADR-006**。

## 升级 opencode
GitHub 网页 **Sync fork**,或 `gh repo sync jinjunnn/alpha-code --branch dev`,或等每日 Action。然后 `git checkout alpha && git merge dev`。详见 `.claude/rules/DECISIONS.md` 的 **ADR-005**。
