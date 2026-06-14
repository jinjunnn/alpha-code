# alpha-code

基于 **opencode** 的个人定制 Mac 编码 agent。**本仓库是 `anomalyco/opencode` 的 fork**;自有代码以"只增不改 upstream 文件"的纪律,作为**原生 workspace 成员**叠加进来,以便 fork-sync 零冲突地继承上游升级。

> opencode 自带的 `README.md` / `AGENTS.md` / `CONTEXT.md` 等保持上游原样**未改动**。本文件(`ALPHA.md`)是 alpha-code 的入口说明。

## 模型:fork + 只增不改
- **`dev` 分支** = `anomalyco/opencode:dev` 的纯镜像(永远 fast-forward,Sync fork 零冲突)。
- **`alpha` 分支**(产品分支)= `dev` + 自有新增文件。日常开发在 `alpha`。
- **自动同步**:`.github/workflows/sync-upstream.yml` 每天把 upstream 同步进 `dev`,再 merge 进 `alpha`。
- **纪律(北极星)**:**只新增文件,从不编辑 opencode 自身的任何文件** → 每次 sync 零冲突。这是 fork 模型能保持干净的唯一要求。

## 自有新增(都是新文件/新目录,不碰 upstream)
| 路径 | 作用 |
|---|---|
| `packages/ext/` | `@alpha-code/ext` —— 零改动 opencode 的后端扩展(server plugin + 自定义 tools)。原生 workspace 成员,`@opencode-ai/plugin` 走 `workspace:*`。 |
| `packages/ui-mac/` | 自有 Electron Mac 外壳:复用 `@opencode-ai/app` 的 `AppInterface` + 自定义 `Platform` + token 换肤(镜像 `packages/desktop` 的原生模式,无任何 symlink hack)。 |
| `.claude/rules/` | 项目宪法(6 文件,`/app:*` 方法论)。 |
| `docs/` | 架构理解 + 扩展接缝手册 + opencode code-graph(SVG)。 |
| `CLAUDE.md` | 速查 + 升级 runbook。 |

## 跑起来
```bash
bun install                                # 原生 workspace 安装
bun --cwd packages/ui-mac run dev          # 起 Mac 应用(predev 先构建内嵌 server)
```
electron 二进制若解析失败(workspace 非 hoisted),加:
```bash
ELECTRON_EXEC_PATH="$PWD/packages/ui-mac/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
```

## 升级 opencode
GitHub 网页 **Sync fork**,或 `gh repo sync jinjunnn/alpha-code --branch dev`,或等每日 Action。然后 `git checkout alpha && git merge dev`。详见 `.claude/rules/DECISIONS.md` 的 **ADR-005**。
